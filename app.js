// app.js (substitua o conteúdo atual pelo abaixo, mantendo sua estrutura de pastas/views)
const express = require("express");
const session = require("express-session");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
// mercadopago v2 exports a default MercadoPagoConfig and named clients
const { default: MercadoPagoConfig, Preference, Payment } = require('mercadopago'); // ADICIONADO (SDK v2)

require('dotenv').config(); // se você usa .env localmente

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG MERCADO PAGO (SDK v2)
if (!process.env.MP_ACCESS_TOKEN) {
  console.warn('Aviso: MP_ACCESS_TOKEN não definido. Pagamentos não funcionarão até definir a variável de ambiente.');
}
// cria instância de configuração e clientes necessários
const mpConfig = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || '' });
const mpPreferenceClient = new Preference(mpConfig);
const mpPaymentClient = new Payment(mpConfig);

// Expõe os clients do Mercado Pago para que as rotas possam usar via `req.app.locals`
app.locals = app.locals || {};
app.locals.mpPreferenceClient = mpPreferenceClient;
app.locals.mpPaymentClient = mpPaymentClient;
app.locals.mpConfig = mpConfig;

// session middleware
const sessionMiddleware = session({
  secret: 'chave-super-secreta', // troque por algo seguro em produção
  resave: false,
  saveUninitialized: false
});

app.use(sessionMiddleware);

// view engine e static
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "app/views"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// Middleware: infer a simple `currentPage` value from the URL path
// so EJS templates can use `<%= currentPage %>` safely without throwing.
app.use((req, res, next) => {
  try {
    // Example: '/' -> 'home', '/login' -> 'login', '/perfil_prof' -> 'perfil_prof'
    const p = req.path === '/' ? 'home' : req.path.split('/').filter(Boolean)[0] || '';
    res.locals.currentPage = p;
  } catch (err) {
    res.locals.currentPage = '';
  }
  next();
});
app.use(express.static(path.join(__dirname, "app/public")));

// rotas
const rotaPrincipal = require("./app/routes/router");
app.use("/", rotaPrincipal);

// cria servidor HTTP e Socket.IO
const server = http.createServer(app);
const io = new Server(server);

// armazenamento simples em memória (apenas demo)
// roomsMessages: histórico de mensagens por sala
const roomsMessages = {}; // { roomName: [ {user, text, time} ] }
// preferenceMap: mapear preference_id -> room e meta para direcionar notificações
const preferenceMap = {}; // { preferenceId: { room, descricao, createdBy } }
const paymentsStore = require('./app/lib/paymentsStore');

// Socket.IO
io.on("connection", (socket) => {
  console.log("Usuário conectado:", socket.id);

  // Video call signaling
  socket.on('join', room => {
    socket.join(room);
    socket.to(room).emit('peer-joined', socket.id);
  });

  socket.on('signal', ({ to, from, data }) => {
    io.to(to).emit('signal', { from, data });
  });

  // Chat handlers (existing code)
  socket.on("joinRoom", ({ room, user }) => {
    socket.join(room);
    console.log(`${user} entrou na sala ${room}`);

    // enviar histórico da sala (se houver)
    const history = roomsMessages[room] || [];
    socket.emit("roomHistory", history);

    // avisar aos outros que entrou
    socket.to(room).emit("systemMessage", { text: `${user} entrou no chat.`, time: Date.now() });
  });

  socket.on("chatMessage", ({ room, user, text }) => {
    const cleanText = String(text).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const msg = { user, text: cleanText, time: Date.now() };

    roomsMessages[room] = roomsMessages[room] || [];
    roomsMessages[room].push(msg);
    if (roomsMessages[room].length > 200) roomsMessages[room].shift();

    io.to(room).emit("newMessage", msg);
  });

  // ---------- NOVO: criação de cobrança via Mercado Pago ----------
  // data: { room, valor, descricao, createdBy (nome do user) }
  socket.on('requestPayment', async (data) => {
    try {
      // Proteção: não tenta criar preferência se token não configurado
      if (!process.env.MP_ACCESS_TOKEN || !mpConfig || !mpConfig.accessToken) {
        socket.emit('systemMessage', { text: 'Pagamento não configurado no servidor (MP_ACCESS_TOKEN ausente).', time: Date.now() });
        return;
      }
      const { room, valor, descricao, createdBy } = data; // 'createdBy' agora é o nome/id do usuário

      // Validação mínima
      const amount = Number(valor);
      if (!room || !amount || amount <= 0) {
        socket.emit('systemMessage', { text: 'Valor inválido para cobrança.', time: Date.now() });
        return;
      }

      const siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;
      const isProduction = process.env.NODE_ENV === 'production';
      const preferenceId = `${room}-${Date.now()}`;

      const preference = {
        items: [
          {
            title: descricao || 'Pagamento Regimath',
            quantity: 1,
            currency_id: "BRL",
            unit_price: amount
          }
        ],
        back_urls: {
          success: `${siteUrl}/pagamento/sucesso?room=${room}`, // Retorno com a room para contexto
          failure: `${siteUrl}/pagamento/erro?room=${room}`,
          pending: `${siteUrl}/pagamento/pendente?room=${room}`
        },
        auto_return: "approved",
        external_reference: preferenceId,
        metadata: { room, createdBy } // Salva o nome do usuário/prof
      };

      // Cria preferência usando o cliente do SDK v2
      const mpResponse = await mpPreferenceClient.create({ body: preference });

      // Busca defensivamente a ID e a URL de checkout
      const respBody = mpResponse.body || mpResponse || {};
      const prefId = respBody.id || null;

      // Mapeia o ID da preferência com o room para o Webhook
      if (prefId) {
        preferenceMap[prefId] = { room, descricao, createdBy };
      }

      // Escolhe a URL correta de acordo com o ambiente
      const checkoutUrl = isProduction ? respBody.init_point : respBody.sandbox_init_point;

      if (!checkoutUrl) {
        throw new Error('URL de checkout não encontrada na resposta do MP.');
      }

      // Emite ao room um evento com o link (aluno verá o botão)
      io.to(room).emit('paymentRequest', {
        descricao,
        valor: amount,
        link: checkoutUrl,
        preferenceId: prefId,
        remetente: createdBy, // Nome do usuário que solicitou (professor)
        time: Date.now()
      });

      // Confirmação ao solicitante
      socket.emit('systemMessage', { text: `Cobrança criada: R$ ${amount.toFixed(2)} - Enviada no chat.`, time: Date.now() });

    } catch (err) {
      console.error('Erro criando preferência MP:', err?.message || err);
      socket.emit('systemMessage', { text: 'Erro ao gerar pagamento. Tente novamente mais tarde.', time: Date.now() });
    }
  });

  // ---------- Handler de disconnect ----------
  socket.on("disconnecting", () => {
    const rooms = Array.from(socket.rooms).filter(r => r !== socket.id);
    rooms.forEach(room => {
      socket.to(room).emit('peer-left', socket.id);
      socket.to(room).emit("systemMessage", { 
        text: "Um usuário saiu da sala.", 
        time: Date.now() 
      });
    });
  });

  socket.on("disconnect", () => {
    console.log("Usuário saiu:", socket.id);
  });
});

// Endpoint público para webhooks do Mercado Pago
// OBS: configure esta URL no painel do Mercado Pago (ou use notificações por preferência)
app.post('/webhook/mercadopago', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    // O Mercado Pago pode enviar body com topic e id
    const { topic, id } = req.body;

    if (!id) {
      res.status(200).send('no id');
      return;
    }

    // Se for tópico payment, buscar payment
    if (topic === 'payment' || topic === 'merchant_order' || topic === 'payment.created') {
      // Adicionado console.log para debugging em produção
      console.log(`[MP Webhook] Recebido ID ${id} (Tópico: ${topic})`);
      
        try {
        // usa o cliente Payment do SDK v2
        const paymentRes = await mpPaymentClient.get({ id });
        const payment = paymentRes.body || paymentRes || {};

        // Checar se approved
        if (payment.status === 'approved' || payment.status === 'paid') {
          
          // 1. Tentar descobrir o ID da Preferência/Room pelo mapeamento interno (mais rápido)
          const prefId = payment.order?.preference_id || payment.preference_id || null;
          let room = null;
          
          if (prefId && preferenceMap[prefId]) {
            room = preferenceMap[prefId].room;
          } 
          
          // 2. Fallback: procurar no metadata (mais seguro, pois é salvo no MP)
          if (!room && payment.metadata && payment.metadata.room) {
            room = payment.metadata.room;
          }

          const amount = payment.transaction_amount || payment.total_paid_amount || 0;
          const payerEmail = payment.payer?.email || 'Pagador Desconhecido';

          const payload = {
            id,
            prefId,
            amount,
            payer: payerEmail,
            status: payment.status,
            time: Date.now()
          };

          // Atualiza persistência local se possível
          try {
            if (prefId) {
              await paymentsStore.updateByPreferenceId(prefId, {
                paymentId: id,
                status: payment.status,
                amount,
                payer: payerEmail,
                updatedAt: new Date().toISOString()
              });
            } else {
              await paymentsStore.updateByPaymentId(id, {
                status: payment.status,
                amount,
                payer: payerEmail,
                updatedAt: new Date().toISOString()
              });
            }
          } catch (e) {
            console.warn('Não foi possível atualizar persistência do pagamento:', e?.message || e);
          }

          if (room) {
            // Envia a confirmação SÓ para a sala correta
            io.to(room).emit('paymentConfirmed', payload);
            console.log(`[MP Webhook] Pagamento confirmado em ${room}. R$ ${amount.toFixed(2)}`);
          } else {
            console.warn(`[MP Webhook] Pagamento confirmado, mas ROOM não encontrada. ${id}`);
            // Opcional: emitir para todos se a room não for encontrada (menos ideal)
            // io.emit('paymentConfirmed', payload); 
          }
        }
      } catch (err) {
        console.error('Erro ao buscar pagamento no MP (webhook):', err?.message || err);
      }
    }

    // responder 200 rapidamente
    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook MP error', err?.message || err);
    res.status(500).send('erro');
  }
});

// inicializa servidor
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
