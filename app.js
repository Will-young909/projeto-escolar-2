
require('dotenv').config();

const express = require("express");
const session = require("express-session");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { default: MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const chatStore = require('./app/lib/chatStore');
const paymentsStore = require('./app/lib/paymentsStore');

// --- Importação de Rotas ---
const rotaPrincipal = require("./app/routes/router");
const adminRoutes = require("./app/routes/adminRoutes");
const iaRouter = require("./app/routes/ia_router");
const mlRouter = require("./app/routes/mlRoutes");
const trilhaAdaptativaRouter = require("./app/routes/trilhaAdaptativaRoutes"); // Rota da Trilha Adaptativa

const app = express();
const PORT = process.env.APP_PORT;

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

app.locals.mpPreferenceClient = mpPreferenceClient;
app.locals.mpPaymentClient = mpPaymentClient;

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

app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

app.use(express.static(path.join(__dirname, "app/public")));

// --- Registro das Rotas ---
app.use("/", rotaPrincipal);
app.use("/admin", adminRoutes);
app.use("/ia", iaRouter);
app.use("/api/ml", mlRouter);
app.use("/api/trilha-adaptativa", trilhaAdaptativaRouter); // Rota da Trilha Adaptativa registrada

const server = http.createServer(app);
const io = new Server(server);

// --- Lógica de Socket.IO e Webhook ---
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.on("connection", (socket) => {
  const session = socket.request.session;
  const currentUser = session.user_aluno || session.user_prof;

  if (!currentUser || !currentUser.id) {
    return socket.disconnect(true);
  }
  
  console.log(`Usuário autenticado conectado: ${currentUser.nome} (ID: ${currentUser.id})`);

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
    socket.to(room).emit("systemMessage", { text: `${currentUser.nome} entrou no chat.`, time: Date.now() });
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


  socket.on('join', (room) => {
    if (!room) return;
    const existingPeers = Array.from(io.sockets.adapter.rooms.get(room) || []).filter(id => id !== socket.id);
    socket.join(room);
    existingPeers.forEach(peerId => {
      socket.emit('peer-joined', peerId);
      socket.to(peerId).emit('peer-joined', socket.id);
    });
    socket.data.videoRoom = room;
  });

  socket.on('signal', ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('end-call', (room) => {
    if (!room) return;
    socket.to(room).emit('peer-left', socket.id);
    socket.leave(room);
  });

  socket.on('requestPayment', async (data) => {
    try {
      if (!MP_ACCESS_TOKEN) {
        socket.emit('systemMessage', { text: 'Pagamento não configurado no servidor.', time: Date.now() });
        return;
      }
      const { room, valor, descricao } = data;
      const amount = Number(valor);
      if (!room || !amount || amount <= 0) return;

      const siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;
      
      const preference = {
        items: [{
          title: descricao || 'Pagamento Regimath',
          quantity: 1,
          currency_id: "BRL",
          unit_price: amount
        }],
        back_urls: {
          success: `${siteUrl}/pagamento/sucesso?room=${room}`,
          failure: `${siteUrl}/pagamento/erro?room=${room}`,
          pending: `${siteUrl}/pagamento/pendente?room=${room}`
        },
        auto_return: "approved",
        notification_url: `${siteUrl}/webhook/mercadopago`,
        metadata: { room, createdBy: currentUser.id }
      };

      const mpResponse = await mpPreferenceClient.create({ body: preference });
      const prefId = mpResponse.id || null;

      if (prefId) {
        await paymentsStore.addPreference({
          preferenceId: prefId,
          room,
          descricao,
          valor: amount,
          createdBy: currentUser.id,
          status: 'pending',
          createdAt: new Date().toISOString()
        });
      }

      const checkoutUrl = process.env.NODE_ENV === 'production' ? mpResponse.init_point : mpResponse.sandbox_init_point;
      if (!checkoutUrl) throw new Error('URL de checkout não encontrada.');

      io.to(room).emit('paymentRequest', {
        descricao,
        valor: amount,
        link: checkoutUrl,
        preferenceId: prefId,
        remetente: currentUser.nome,
        remetenteId: currentUser.id,
        time: Date.now()
      });

    } catch (err) {
      console.error('Erro criando preferência MP:', err?.message || err);
      socket.emit('systemMessage', { text: 'Erro ao gerar pagamento. Tente mais tarde.', time: Date.now() });
    }
  });

  socket.on("disconnecting", () => {
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        socket.to(room).emit("systemMessage", { text: `${currentUser.nome} saiu da sala.`, time: Date.now() });
        socket.to(room).emit('peer-left', socket.id);
      }
    });
  });
});



server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});