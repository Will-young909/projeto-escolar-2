const express = require("express");
const session = require("express-session");
const app = express();
const porta = 3000;

app.use(session({
    secret: 'seuSegredoAqui',
    resave: false,
    saveUninitialized: false
}));

app.use(express.static("./app/public"));

app.set("view engine", "ejs");
app.set("views", "./app/views");

app.use(express.json());
app.use(express.urlencoded({extended:true}));

app.use((req, res, next) => {
    res.locals.session = req.session;
    next();
});

const rotaPrincipal = require("./app/routes/router");
app.use("/", rotaPrincipal);

app.listen(porta, ()=>{
    console.log(`Servidor onLine\nhttp://localhost:${porta}`);
})