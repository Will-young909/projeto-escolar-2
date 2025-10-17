// app.js (trecho principal / substitua a parte de server.listen atualmente)
const express = require("express");
const session = require("express-session");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

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

// (Opcional) compartilhar session com sockets se quiser autenticar pelo session cookie
// aqui, para simplicidade, o client envia username/room ao conectar.

// armazenamento simples em memória (apenas demo)
const roomsMessages = {}; // { roomName: [ {user, text, time} ] }

// Socket.IO
io.on("connection", (socket) => {
  console.log("Usuário conectado:", socket.id);

  // Video call handlers
  socket.on("join-room", (room) => {
    socket.join(room);
    socket.to(room).emit("user-connected", socket.id);

    socket.on("offer", (data) => socket.to(room).emit("offer", data));
    socket.on("answer", (data) => socket.to(room).emit("answer", data));
    socket.on("ice-candidate", (data) => socket.to(room).emit("ice-candidate", data));
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

  socket.on("disconnect", () => {
    socket.rooms.forEach(room => {
      socket.to(room).emit("user-disconnected", socket.id);
    });
    console.log("Usuário saiu:", socket.id);
  });
});

app.get("/video/:room", (req, res) => {
  const room = req.params.room;
  res.render("pages/video_call", { room });
});

// inicializa servidor
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});