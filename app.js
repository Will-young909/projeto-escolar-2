
require('dotenv').config();

const express = require("express");
const session = require("express-session");
const http = require("http");
const fs = require('fs');
const { Server } = require("socket.io");
const path = require("path");
const crypto = require('crypto');
const { default: MercadoPagoConfig, Preference, Payment, PaymentRefund } = require('mercadopago');
const pool = require('./config/pool');
const { buildMercadoPagoPreference } = require('./app/services/mercadoPagoPreferenceBuilder');
const PaymentSettlementService = require('./app/services/PaymentSettlementService');
const PagamentoModel = require('./app/models/PagamentoModel');
const RefundService = require('./app/services/RefundService');
const { getSaoPauloDateTime } = require('./app/utils/brasiliaTime');

const chatStore = require('./app/lib/chatStore');
const paymentsStore = require('./app/lib/paymentsStore');

// --- Importação de Rotas ---
const rotaPrincipal = require("./app/routes/router");
const adminRoutes = require("./app/routes/adminRoutes");
const passwordRoutes = require("./app/routes/password");
const iaRouter = require("./app/routes/ia_router");
const mlRouter = require("./app/routes/mlRoutes");
const trilhaAdaptativaRouter = require("./app/routes/trilhaAdaptativaRoutes"); // Rota da Trilha Adaptativa

const app = express();
const PORT = process.env.APP_PORT;

const DenunciaService = require('./app/services/DenunciaService');
const FinanceService = require('./app/services/FinanceService');

// --- Auto-reativação periódica de suspensões expiradas ---
let reativandoSuspensoes = false;
async function autoReativarSuspensoesExpiradas() {
    if (reativandoSuspensoes) return;
    reativandoSuspensoes = true;
    try {
        await DenunciaService.autoReativarSuspensoesExpiradas();
    } catch (err) {
        console.error('Erro na auto-reativação de suspensões:', err);
    } finally {
        reativandoSuspensoes = false;
    }
}

let limpandoDenuncias = false;
async function cleanupDenunciasResolvidas() {
    if (limpandoDenuncias) return;
    limpandoDenuncias = true;
    try {
        const { deleted } = await DenunciaService.cleanupDenunciasResolvidas();
        if (deleted > 0) console.log(`[DENUNCIAS] ${deleted} denúncia(s) resolvida(s)/rejeitada(s) removida(s) após 7 dias.`);
    } catch (err) {
        console.error('Erro na limpeza de denúncias resolvidas/rejeitadas:', err);
    } finally {
        limpandoDenuncias = false;
    }
}

let limpandoTransacoes = false;
async function cleanupTransacoesAntigas() {
    if (limpandoTransacoes) return;
    limpandoTransacoes = true;
    try {
        const { deletedPayments, deletedRepasses } = await FinanceService.cleanupOldTransactions();
        if (deletedPayments > 0 || deletedRepasses > 0) {
            console.log(`[FINANCEIRO] Limpeza mensal: ${deletedPayments} pagamento(s) e ${deletedRepasses} repasse(s) antigos removidos.`);
        }
    } catch (err) {
        console.error('Erro na limpeza mensal de transações:', err);
    } finally {
        limpandoTransacoes = false;
    }
}

// --- Configurações de Sessão e Mercado Pago ---
const SESSION_SECRET = process.env.SESSION_SECRET;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

if (!SESSION_SECRET) {
  console.warn('ALERTA DE SEGURANÇA: A variável de ambiente SESSION_SECRET não está definida. Usando uma chave fraca e temporária.');
}

if (!MP_ACCESS_TOKEN) {
  console.warn('Aviso: MP_ACCESS_TOKEN não definido. Pagamentos não funcionarão.');
}

const mpConfig = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN || '' });
const mpPreferenceClient = new Preference(mpConfig);
const mpPaymentClient = new Payment(mpConfig);
const mpPaymentRefundClient = new PaymentRefund(mpConfig);

app.locals.mpPreferenceClient = mpPreferenceClient;
app.locals.mpPaymentClient = mpPaymentClient;
app.locals.mpPaymentRefundClient = mpPaymentRefundClient;

const sessionMiddleware = session({
  secret: SESSION_SECRET || 'fallback-secret-key-for-dev',
  resave: false,
  saveUninitialized: false
});

app.use(sessionMiddleware);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "app/views"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Gravações legadas nunca podem ser acessadas por URL direta de arquivo.
// Todo acesso passa por /gravacao/stream/:id (autenticado e autorizado).
app.use('/recordings', (req, res) => res.status(404).send('Não encontrado.'));
app.use('/recordings/', (req, res) => res.status(404).send('Não encontrado.'));

app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

app.use(express.static(path.join(__dirname, "app/public")));

// --- Registro das Rotas ---
app.use("/", rotaPrincipal);
app.use("/", passwordRoutes);
app.use("/admin", adminRoutes);
app.use("/ia", iaRouter);
app.use("/api/ml", mlRouter);
app.use("/api/trilha-adaptativa", trilhaAdaptativaRouter); // Rota da Trilha Adaptativa registrada

const server = http.createServer(app);
const io = new Server(server);
app.locals.io = io;

// --- Lógica de Socket.IO e Webhook ---
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

async function registrarSaidaDaAula(agendamentoId, papel) {
  const colunaSaida = papel === 'aluno' ? 'aluno_saiu_em' : 'professor_saiu_em';
  const colunaEntrada = papel === 'aluno' ? 'aluno_entrou_em' : 'professor_entrou_em';
  const connection = await pool.getConnection();
  let aulaConcluida = null;
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE agendamentos
       SET ${colunaSaida} = COALESCE(${colunaSaida}, NOW())
       WHERE id = ? AND status = 'ativo' AND ${colunaEntrada} IS NOT NULL`,
      [agendamentoId]
    );
    const [appointments] = await connection.query(
      `SELECT id, aluno_id, professor_id, aluno_entrou_em, aluno_saiu_em,
              professor_entrou_em, professor_saiu_em
       FROM agendamentos WHERE id = ? FOR UPDATE`,
      [agendamentoId]
    );
    const appointment = appointments[0];
    if (
      appointment &&
      appointment.aluno_entrou_em && appointment.aluno_saiu_em &&
      appointment.professor_entrou_em && appointment.professor_saiu_em
    ) {
      const [result] = await connection.query(
        `UPDATE agendamentos SET status = 'concluido'
         WHERE id = ? AND status = 'ativo'`,
        [agendamentoId]
      );
      if (result.affectedRows > 0) aulaConcluida = appointment;
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  if (aulaConcluida) {
    io.to(`user:${aulaConcluida.aluno_id}`).emit('appointmentCompleted', { agendamentoId });
    io.to(`user:${aulaConcluida.professor_id}`).emit('appointmentCompleted', { agendamentoId });
    await PaymentSettlementService.releaseCompletedAppointment(agendamentoId);
  }
}

io.on("connection", (socket) => {
  const session = socket.request.session;
  const currentUser = session.user_aluno || session.user_prof;

  if (!currentUser || !currentUser.id) {
    return socket.disconnect(true);
  }
  
  console.log(`Usuário autenticado conectado: ${currentUser.nome} (ID: ${currentUser.id})`);
  socket.join(`user:${currentUser.id}`);

  socket.on("joinRoom", async ({ room }) => {
    const roomUsers = room.replace('chat_','').split('-');
    
    if (!roomUsers.includes(String(currentUser.id))) {
      console.warn(`Tentativa de acesso não autorizado à sala ${room} pelo usuário ${currentUser.id}`);
      return;
    }

    socket.join(room);
    console.log(`${currentUser.nome} (ID: ${currentUser.id}) entrou na sala ${room}`);

    const history = await chatStore.getRoomHistory(room);
    socket.emit("roomHistory", history);
  });

  socket.on("chatMessage", async ({ room, text }) => {
    const roomUsers = room.replace('chat_','').split('-');
    
    if (!roomUsers.includes(String(currentUser.id))) {
      return;
    }

    const cleanText = String(text).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const msg = { user: currentUser, text: cleanText, time: Date.now() };

    await chatStore.saveMessage(room, msg);
    io.to(room).emit("newMessage", msg);
  });


  socket.on('join', async (room) => {
    if (!room) return;
    try {
    if (typeof room !== 'string') return;
    if (room.startsWith('chat_')) {
      const participants = room.replace('chat_', '').split('-');
      if (!participants.includes(String(currentUser.id))) return;
      const existingPeers = Array.from(io.sockets.adapter.rooms.get(room) || []).filter(id => id !== socket.id);
      socket.join(room);
      existingPeers.forEach(peerId => socket.to(peerId).emit('peer-joined', socket.id));
      socket.data.videoRoom = room;
      return;
    }

    const saoPauloNow = getSaoPauloDateTime();
    const [appointments] = await pool.query(
      `SELECT ag.id, ag.aluno_id, ag.professor_id
       FROM agendamentos ag
       JOIN horarios_disponiveis h ON h.id = ag.horario_id
       WHERE ag.sala_id = ? AND ag.status = 'ativo'
         AND (ag.aluno_id = ? OR ag.professor_id = ?)
         AND ? >= TIMESTAMP(ag.data, h.hora_inicio) - INTERVAL 10 MINUTE
         AND ? <= TIMESTAMP(ag.data, h.hora_inicio) + INTERVAL 50 MINUTE
       LIMIT 1`,
      [room, currentUser.id, currentUser.id, saoPauloNow, saoPauloNow]
    );
    if (appointments.length === 0) {
      console.warn(`Tentativa de entrada não autorizada na sala ${room} pelo usuário ${currentUser.id}`);
      return;
    }
    const appointment = appointments[0];
    const papel = String(appointment.aluno_id) === String(currentUser.id) ? 'aluno' : 'professor';
    const colunaEntrada = papel === 'aluno' ? 'aluno_entrou_em' : 'professor_entrou_em';
    const colunaSaida = papel === 'aluno' ? 'aluno_saiu_em' : 'professor_saiu_em';
    await pool.query(
      `UPDATE agendamentos
       SET ${colunaEntrada} = COALESCE(${colunaEntrada}, NOW()),
           ${colunaSaida} = NULL
       WHERE id = ? AND status = 'ativo'`,
      [appointment.id]
    );

    const existingPeers = Array.from(io.sockets.adapter.rooms.get(room) || []).filter(id => id !== socket.id);
    socket.join(room);
    existingPeers.forEach(peerId => {
      socket.to(peerId).emit('peer-joined', socket.id);
    });
    socket.data.videoRoom = room;
    socket.data.agendamentoId = appointment.id;
    socket.data.papelAula = papel;
    } catch (error) {
      console.error(`Erro ao autorizar entrada na sala de vídeo ${room}:`, error);
      socket.emit('systemMessage', { text: 'Não foi possível entrar na sala de aula.', time: Date.now() });
    }
  });

  socket.on('signal', ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('end-call', async (room) => {
    if (!room || socket.data.videoRoom !== room) return;

    if (socket.data.agendamentoId && socket.data.papelAula) {
      try {
        await registrarSaidaDaAula(socket.data.agendamentoId, socket.data.papelAula);
      } catch (error) {
        console.error(`Erro ao registrar saída da aula ${socket.data.agendamentoId}:`, error);
      }
    }
    socket.to(room).emit('peer-left', socket.id);
    socket.leave(room);
    socket.data.videoRoom = null;
  });

  socket.on('requestPayment', async (data) => {
    try {
      if (!MP_ACCESS_TOKEN) {
        socket.emit('systemMessage', { text: 'Pagamento não configurado no servidor.', time: Date.now() });
        return;
      }
      const { room, valor, descricao, horarioId } = data || {};
      const amount = Number(valor);
      if (!room || !amount || amount <= 0) return;
      if (typeof room !== 'string' || !room.startsWith('chat_')) {
        socket.emit('systemMessage', { text: 'Sala de chat inválida para cobrança.', time: Date.now() });
        return;
      }
      const participants = room.replace('chat_', '').split('-').map(String);
      if (!participants.includes(String(currentUser.id))) {
        socket.emit('systemMessage', { text: 'Você não participa desta conversa.', time: Date.now() });
        return;
      }

      const [meRows] = await pool.query("SELECT id, 'professor' as tipo FROM professores WHERE id = ? UNION SELECT id, 'aluno' as tipo FROM alunos WHERE id = ?", [currentUser.id, currentUser.id]);
      const me = meRows.find(r => String(r.id) === String(currentUser.id));
      if (!me || me.tipo !== 'professor') {
        socket.emit('systemMessage', { text: 'Apenas professores podem solicitar pagamento pelo chat.', time: Date.now() });
        return;
      }

      const partnerId = participants.find(id => id !== String(currentUser.id));
      const [partnerRows] = await pool.query("SELECT id, nome FROM alunos WHERE id = ?", [partnerId]);
      const aluno = partnerRows[0];
      if (!aluno) {
        socket.emit('systemMessage', { text: 'A cobrança pelo chat deve ser enviada para um aluno.', time: Date.now() });
        return;
      }

      if (!horarioId) {
        socket.emit('systemMessage', { text: 'Selecione um horário disponível para agendar a aula.', time: Date.now() });
        return;
      }

      const [horarioRows] = await pool.query(
        "SELECT id, data, hora_inicio, hora_fim, preco, status FROM horarios_disponiveis WHERE id = ? AND professor_id = ? AND status = 'disponivel'",
        [horarioId, currentUser.id]
      );
      const horario = horarioRows[0];
      if (!horario) {
        socket.emit('systemMessage', { text: 'Horário indisponível. Atualize seus horários e tente novamente.', time: Date.now() });
        return;
      }
      const spNow = getSaoPauloDateTime();
      const todaySp = spNow.slice(0, 10);
      const timeSp = spNow.slice(11, 16);
      const d = horario.data instanceof Date
        ? `${horario.data.getFullYear()}-${String(horario.data.getMonth() + 1).padStart(2, '0')}-${String(horario.data.getDate()).padStart(2, '0')}`
        : String(horario.data).slice(0, 10);
      const hi = String(horario.hora_inicio).slice(0, 5);
      if (!(d > todaySp || (d === todaySp && hi > timeSp))) {
        socket.emit('systemMessage', { text: 'Esse horário já passou ou não está mais disponível.', time: Date.now() });
        return;
      }
      const finalAmount = Number(horario.preco);
      if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
        socket.emit('systemMessage', { text: 'O horário selecionado possui valor inválido.', time: Date.now() });
        return;
      }
      const finalDesc = `Aula com ${currentUser.nome} - ${d} ${hi}`;
      const lessonRef = { profId: String(currentUser.id), horarioId: Number(horario.id), alunoId: String(aluno.id), dataAula: d, horaAula: hi };

      const siteUrl = process.env.SITE_URL || `https://localhost:${PORT}`;
      const checkoutId = crypto.randomUUID();
      const externalRef = JSON.stringify({ checkoutId, ...lessonRef });
      const metadata = { checkoutId, room, createdBy: String(currentUser.id), alunoId: String(aluno.id), profId: lessonRef.profId, horarioId: lessonRef.horarioId, dataAula: lessonRef.dataAula, horaAula: lessonRef.horaAula };

      const preference = buildMercadoPagoPreference({
        items: [{
          title: finalDesc || 'Pagamento Regimath',
          quantity: 1,
          currency_id: "BRL",
          unit_price: finalAmount
        }],
        siteUrl,
        successUrl: `${siteUrl}/pagamento/sucesso?room=${encodeURIComponent(room)}`,
        failureUrl: `${siteUrl}/pagamento/erro?room=${encodeURIComponent(room)}`,
        pendingUrl: `${siteUrl}/pagamento/pendente?room=${encodeURIComponent(room)}`,
        notification_url: `${siteUrl}/webhook/mercadopago`,
        external_reference: externalRef,
        metadata
      });

      const mpResponse = await mpPreferenceClient.create({ body: preference });
      const prefId = mpResponse.id || null;

      if (prefId) {
        await paymentsStore.addPreference({
          checkoutId,
          preferenceId: prefId,
          room,
          descricao: finalDesc,
          valor: finalAmount,
          createdBy: String(currentUser.id),
          alunoId: String(aluno.id),
          professorId: String(currentUser.id),
          horarioId: lessonRef.horarioId,
          status: 'pending',
          createdAt: new Date().toISOString()
        });
        try {
          await PagamentoModel.create({
            checkout_id: checkoutId,
            preference_id: prefId,
            descricao: finalDesc,
            valor: finalAmount,
            criado_por: String(aluno.id),
            professor_id: String(currentUser.id),
            status: 'pending'
          });
        } catch (dbErr) {
          console.error('Erro ao persistir pagamento do chat no banco:', dbErr?.message || dbErr);
        }
      }

      const checkoutUrl = process.env.NODE_ENV === 'production' ? mpResponse.init_point : mpResponse.sandbox_init_point;
      if (!checkoutUrl) throw new Error('URL de checkout não encontrada.');

      const paymentPayload = {
        descricao: finalDesc,
        valor: finalAmount,
        link: checkoutUrl,
        checkoutId,
        preferenceId: prefId,
        remetente: currentUser.nome,
        remetenteId: String(currentUser.id),
        horarioId: lessonRef.horarioId,
        dataAula: lessonRef.dataAula,
        horaAula: lessonRef.horaAula,
        time: Date.now()
      };
      try { await chatStore.saveMessage(room, { type: 'payment', data: paymentPayload, time: paymentPayload.time }); } catch (_) {}
      io.to(room).emit('paymentRequest', paymentPayload);

    } catch (err) {
      console.error('Erro criando preferência MP:', err?.message || err);
      socket.emit('systemMessage', { text: 'Erro ao gerar pagamento. Tente mais tarde.', time: Date.now() });
    }
  });

  socket.on("disconnecting", async () => {
    if (socket.data.agendamentoId && socket.data.papelAula) {
      try {
        await registrarSaidaDaAula(socket.data.agendamentoId, socket.data.papelAula);
      } catch (error) {
        console.error(`Erro ao registrar desconexão da aula ${socket.data.agendamentoId}:`, error);
      }
    }
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        socket.to(room).emit('peer-left', socket.id);
      }
    });
  });
});



server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});

let processandoAulas = false;
async function processarFinanceiroDeAulas() {
  if (processandoAulas) return;
  processandoAulas = true;
  try {
    const resultados = await RefundService.processarAulasNaoRealizadas({
      userType: 'system',
      refundClient: app.locals.mpPaymentRefundClient,
      paymentClient: app.locals.mpPaymentClient
    });
    for (const resultado of resultados) {
      if (resultado.error) {
        console.error(`Aula ${resultado.agendamentoId} aguarda processamento de reembolso:`, resultado.error);
        for (const estorno of resultado.paymentRefunds || []) {
          if (estorno.error) {
            console.error(
              `Falha no reembolso do pagamento ${estorno.paymentId} da aula ${resultado.agendamentoId}:`,
              JSON.stringify({
                httpStatus: estorno.httpStatus,
                providerCode: estorno.providerCode,
                error: estorno.error,
                causes: estorno.causes
              })
            );
          }
        }
      } else if (resultado.cancelada) {
        const ioServer = app.locals.io;
        ioServer.to(`user:${resultado.alunoId}`).emit('appointmentCancelled', { agendamentoId: resultado.agendamentoId });
        ioServer.to(`user:${resultado.professorId}`).emit('appointmentCancelled', { agendamentoId: resultado.agendamentoId });
      }
    }
    await PaymentSettlementService.releaseCompletedAppointments();
    const repassesPagos = await PaymentSettlementService.autoPagarRepassesDisponiveis();
    if (repassesPagos > 0) {
      console.log(`Repasses registrados automaticamente como pagos: ${repassesPagos}`);
    }
  } catch (error) {
    console.error('Erro no processamento automático financeiro das aulas:', error);
  } finally {
    processandoAulas = false;
  }
}

setTimeout(processarFinanceiroDeAulas, 5000);
const financeiroAulasTimer = setInterval(processarFinanceiroDeAulas, 60 * 1000);
financeiroAulasTimer.unref();

setTimeout(autoReativarSuspensoesExpiradas, 5000);
const suspensoesTimer = setInterval(autoReativarSuspensoesExpiradas, 5 * 60 * 1000);
suspensoesTimer.unref();
setTimeout(cleanupDenunciasResolvidas, 15000);
const denunciasCleanupTimer = setInterval(cleanupDenunciasResolvidas, 6 * 60 * 60 * 1000);
denunciasCleanupTimer.unref();
setTimeout(cleanupTransacoesAntigas, 30000);
const transacoesCleanupTimer = setInterval(cleanupTransacoesAntigas, 24 * 60 * 60 * 1000);
transacoesCleanupTimer.unref();