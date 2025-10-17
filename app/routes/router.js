const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();


router.get('/', (req, res) => {
    res.render('pages/home');
});

router.get('/cadastro', (req, res) => {
    res.render('pages/cadastro', { erros: {}, dados: {} });
});

router.post('/cadastro', [
    body('email')
        .isEmail().withMessage('Por favor, insira um email válido.')
        .normalizeEmail(),
    body('nome').notEmpty().withMessage('O nome é obrigatório.'),
    body('senha')
        .isLength({ min: 6 }).withMessage('A senha deve ter pelo menos 6 caracteres.'),
    body('confirmar')
        .custom((value, { req }) => value === req.body.senha).withMessage('As senhas não coincidem.'),
    body('tipo').notEmpty().withMessage('Selecione um tipo (Aluno ou Professor).'),
], (req, res) => {
    const erros = validationResult(req);
    
    if (!erros.isEmpty()) {
        return res.render('pages/cadastro', { erros: erros.mapped(), dados: req.body });
    }

    // Cria sessões separadas para aluno e professor
    if (req.body.tipo === "aluno") {
        req.session.user_aluno = {
            nome: req.body.nome,
            email: req.body.email,
            tipo: req.body.tipo
        };
        return res.redirect('/');
    } else {
        req.session.user_prof = {
            nome: req.body.nome,
            email: req.body.email,
            tipo: req.body.tipo
        };
        return res.redirect('/');
    }
});

router.get('/login', (req, res) => {
  res.render('pages/login', { erros: {}, dados: {} });
});

router.post('/login', [
    body('email')
        .isEmail().withMessage('Por favor, insira um email válido.')
        .normalizeEmail(),
    body('senha')
        .isLength({ min: 6 }).withMessage('A senha deve ter pelo menos 6 caracteres.'),
    body('tipo').notEmpty().withMessage('Selecione um tipo (Aluno ou Professor).'),
], (req, res) => {
    const erros = validationResult(req);
    
    if (!erros.isEmpty()) {
        return res.render('pages/login', { erros: erros.mapped(), dados: req.body });
    }

    // Cria sessões separadas para aluno e professor
    if (req.body.tipo === "aluno") {
        req.session.user_aluno = {
            email: req.body.email,
            tipo: req.body.tipo
        };
        return res.redirect('/');
    } else {
        req.session.user_prof = {
            email: req.body.email,
            tipo: req.body.tipo
        };
        return res.redirect('/');
    }
});

router.get('/forgot', (req, res) => {
    res.render('pages/forgot_password', { erros: {}, dados: {} });
});

router.post('/forgot', [
    body('email')
        .isEmail().withMessage('Por favor, insira um email válido.')
        .normalizeEmail(),
    body('senha')
        .isLength({ min: 6 }).withMessage('A senha deve ter pelo menos 6 caracteres.'),
    body('confirmar')
        .custom((value, { req }) => value === req.body.senha).withMessage('As senhas não coincidem.'),
    body('tipo').notEmpty().withMessage('Selecione um tipo (Aluno ou Professor).'),
], (req, res) => {
    const erros = validationResult(req);
    
    if (!erros.isEmpty()) {
        return res.render('pages/forgot_password', { erros: erros.mapped(), dados: req.body });
    }

    // Cria sessões separadas para aluno e professor
    if (req.body.tipo === "aluno") {
        req.session.user_aluno = {
            email: req.body.email,
            tipo: req.body.tipo
        };
        return res.redirect('/');
    } else {
        req.session.user_prof = {
            email: req.body.email,
            tipo: req.body.tipo
        };
        return res.redirect('/');
    }
});

router.get('/perfil_aluno', (req, res) => {
    if (!req.session.user_aluno) {
        return res.redirect('/login');
    }
    res.render('pages/perfil_aluno', { user: req.session.user_aluno });
});

router.get('/perfil_prof', (req, res) => {
    if (!req.session.user_prof) {
        return res.redirect('/login');
    }
    res.render('pages/perfil_prof', { user: req.session.user_prof });
});

router.get('/exibir_prof/:id', (req, res) => {
    const professorId = req.params.id;

    // Aqui você buscaria as informações do professor pelo ID
    const professor = {
        id: professorId,
        nome: "Nome do Professor",
        foto: "/imagens/professor.jpg",
        descricao: "Descrição do professor.",
        aulaPrevia: "#",
        status: "disponivel",
        aulas: [
            { data: "2025-01-01", hora: "10:00" },
            { data: "2025-01-02", hora: "14:00" }
        ]
    };

        // Comentários: armazenados por sessão em req.session.prof_comentarios
        // Estrutura: { [professorId]: [ { usuario, texto, data }, ... ] }
        if (!req.session.prof_comentarios) req.session.prof_comentarios = {};
        const comentariosDoProfessor = req.session.prof_comentarios[professorId] || [
            { usuario: 'Adiel', texto: 'Ótimo professor!' }
        ];

        professor.comentarios = comentariosDoProfessor;

        res.render('pages/exibir_prof', { professor });
});

// Rota para adicionar comentário a um professor
router.post('/exibir_prof/:id/comentar', (req, res) => {
    const professorId = req.params.id;
    const texto = (req.body.texto || '').trim();

    // Exige que o usuário esteja logado (aluno ou professor)
    const usuario = (req.session.user_aluno && (req.session.user_aluno.nome || req.session.user_aluno.email))
                             || (req.session.user_prof && (req.session.user_prof.nome || req.session.user_prof.email));

    if (!usuario) {
        // Opcional: redirecionar para login ou aceitar como anônimo
        return res.redirect('/login');
    }

    if (!texto) {
        return res.redirect(`/exibir_prof/${professorId}`);
    }

    if (!req.session.prof_comentarios) req.session.prof_comentarios = {};
    if (!req.session.prof_comentarios[professorId]) req.session.prof_comentarios[professorId] = [];

    req.session.prof_comentarios[professorId].push({
        usuario,
        texto,
        data: new Date().toISOString()
    });

    return res.redirect(`/exibir_prof/${professorId}`);
});

// router.js (adicione estas rotas onde faz sentido)
router.get('/chat', (req, res) => {
  const user = req.session.user_aluno || req.session.user_prof || { nome: 'Visitante' };
  const room = 'global';
  res.render('pages/chat', { user, room });
});


router.get('/logout', (req, res) => {
    // Limpa ambas as sessões
    req.session.user_aluno = null;
    req.session.user_prof = null;
    req.session.destroy(() => {
        res.redirect('/');
    });
});



module.exports = router;