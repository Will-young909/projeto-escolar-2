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
  // data: { room, valor, descricao, payerEmail (opcional) }
  socket.on('requestPayment', async (data) => {
    try {
      // protege: não tenta criar preferência se token não configurado
      if (!process.env.MP_ACCESS_TOKEN || !mpConfig || !mpConfig.accessToken) {
        socket.emit('systemMessage', { text: 'Pagamento não configurado no servidor (MP_ACCESS_TOKEN ausente).', time: Date.now() });
        return;
      }
      const { room, valor, descricao, payerEmail } = data;

      // validação mínima
      const amount = Number(valor);
      if (!room || !amount || amount <= 0) {
        socket.emit('systemMessage', { text: 'Valor inválido para cobrança.', time: Date.now() });
        return;
      }

      const siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;

      const preference = {
        items: [
          {
            title: descricao || 'Pagamento Regimath',
            quantity: 1,
            currency_id: "BRL",
            unit_price: Number(amount)
          }
        ],
        payer: payerEmail ? { email: payerEmail } : undefined,
        back_urls: {
          success: `${siteUrl}/pagamento/sucesso`,
          failure: `${siteUrl}/pagamento/erro`,
          pending: `${siteUrl}/pagamento/pendente`
        },
        auto_return: "approved",
        external_reference: `${room}-${Date.now()}`, // referencia para você
        metadata: { room }
      };

  // cria preferência usando o cliente do SDK v2
  const mpResponse = await mpPreferenceClient.create({ body: preference });

  // o formato de resposta pode variar; busca id e init_point defensivamente
  const respBody = mpResponse && (mpResponse.body || mpResponse || mpResponse.response) || {};
  const prefId = respBody.id || respBody.preference_id || null;
  preferenceMap[prefId] = { room, descricao, createdBy: socket.id };

  const checkoutUrl = respBody.init_point || respBody.sandbox_init_point || null;

      // Emite ao room um evento com o link (aluno verá o botão)
      io.to(room).emit('paymentRequest', {
        descricao,
        valor: amount,
        link: checkoutUrl,
        preferenceId: prefId,
        createdBy: socket.id,
        time: Date.now()
      });

      // confirmação ao solicitante
      socket.emit('systemMessage', { text: `Cobrança criada: R$ ${amount.toFixed(2)}`, time: Date.now() });

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
    // Exemplo: { topic: 'payment', id: '12345' }
    const { topic, id } = req.body;

    // Preferência: buscar o pagamento/transaction para checar status
    if (!id) {
      // pode ser que MP envie diferente dependendo da integração
      res.status(200).send('no id');
      return;
    }

    // Se for tópico payment, buscar payment
    if (topic === 'payment' || topic === 'merchant_order' || topic === 'payment.created') {
      // buscar pagamento pelo id
      // tentativa segura: usar payment API
      try {
  // usa o cliente Payment do SDK v2
  const paymentRes = await mpPaymentClient.get({ id });
  const payment = (paymentRes && (paymentRes.body || paymentRes || paymentRes.response)) || null;

        // checar se approved
        if (payment && (payment.status === 'approved' || payment.status === 'paid')) {
          // tentar descobrir preference_id (pode vir em payment.order.preference_id ou payment.order.external_reference)
          const prefId = payment.order?.preference_id || payment.preference_id || null;

          // fallback: procurar no map por other fields (metadata)
          let room = null;
          if (prefId && preferenceMap[prefId]) {
            room = preferenceMap[prefId].room;
          } else if (payment.metadata && payment.metadata.room) {
            room = payment.metadata.room;
          }

          const amount = payment.transaction_amount || payment.total_paid_amount || payment.amount || 0;
          const payerEmail = payment.payer?.email || null;

          const payload = {
            id,
            prefId,
            amount,
            payer: payerEmail,
            status: payment.status,
            time: Date.now(),
            raw: payment
          };

          if (room) {
            io.to(room).emit('paymentConfirmed', payload);
          } else {
            // sem room mapeada: broadcast (menos ideal)
            io.emit('paymentConfirmed', payload);
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

// rota para pagina video (mantida)
app.get("/video/:room", (req, res) => {
  const room = req.params.room;
  res.render("pages/video_call", { room });
});

// inicializa servidor
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
