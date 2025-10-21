const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

// Array simulando banco de dados de professores (mantive seu conteúdo)
const professores = [
    {
        id: 1,
        nome: "Mateus",
        foto: "/imagens/imagem_perfil.jpg",
        descricao: "Professor com 7 doutorados na USP, dei aula pra Einstein...",
        aulaPrevia: "#",
        status: "disponivel",
        aulas: [
            { data: "27-10-2025", hora: "10:00" },
            { data: "29-10-2025", hora: "14:00" }
        ]
    },
    {
        id: 2,
        nome: "Jonas",
        foto: "/imagens/imagem_perfil.jpg",
        descricao: "Professor com 5 doutorados na usp, dei aula pra Newton...",
        aulaPrevia: "#",
        status: "disponivel",
        aulas: [
            { data: "26-10-2025", hora: "15:00" },
            { data: "28-10-2025", hora: "14:00" }
        ]
    },
    {
        id: 3,
        nome: "Julia Barros",
        foto: "/imagens/imagem_perfil.jpg",
        descricao: "Graduada em Matemática pela Universidade Federal de Minas Gerais (UFMG)...",
        aulaPrevia: "#",
        status: "disponivel",
        aulas: [
            { data: "25-10-2025", hora: "09:00" },
            { data: "27-10-2025", hora: "16:00" }
        ]
    },
    {
        id: 4,
        nome: "Juléia Lopes",
        foto: "/imagens/imagem_perfil.jpg",
        descricao: "Professora que ensinou Tesla a inventar a luz",
        aulaPrevia: "#",
        status: "indisponivel",
        aulas: [
            { data: "30-10-2025", hora: "10:00" },
            { data: "31-10-2025", hora: "14:00" }
        ]
    },
    {
        id: 5,
        nome: "Joaquim Bandeira",
        foto: "/imagens/imagem_perfil.jpg",
        descricao: "Professor formado pelo EAD",
        aulaPrevia: "#",
        status: "disponivel",
        aulas: [
            { data: "28-10-2025", hora: "11:00" },
            { data: "29-10-2025", hora: "15:00" }
        ]
    }
];

router.get('/', (req, res) => {
    res.render('pages/home', { professores });
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
    const professorId = parseInt(req.params.id);

    // Busca o professor pelo ID no array
    const professor = professores.find(p => p.id === professorId);

    // Comentários: armazenados por sessão em req.session.prof_comentarios
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

// rota do chat (mantida) - passamos o user completo (aluno ou professor) com tipo
router.get('/chat', (req, res) => {
  const user = req.session.user_aluno || req.session.user_prof || { nome: 'Visitante', tipo: 'visitante' };
  const room = 'global';
  res.render('pages/chat', { user, room });
});

router.get('/politica', (req, res) => {
    res.render('pages/politica');
});

router.get('/termos', (req, res) => {
    res.render('pages/termos');
});

router.get('/aulas', (req, res) => {
    res.render('pages/aulas');
});

// GET exibe formulário (dados e erros são opcionais) — padronizado como nas outras rotas
router.get('/denuncia', (req, res) => {
    res.render('pages/denuncia', { erros: {}, dados: {} });
});

// POST valida e processa
router.post('/denuncia',
  // regras de validação
  [
    body('tipo').notEmpty().withMessage('O tipo de denúncia é obrigatório.'),
    body('titulo').trim().isLength({ min: 5 }).withMessage('O título deve ter ao menos 5 caracteres.'),
    body('descricao').trim().isLength({ min: 10 }).withMessage('A descrição deve ter ao menos 10 caracteres.'),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('E-mail inválido.'),
    body('evidencia').optional({ checkFalsy: true }).isURL().withMessage('Link de evidência inválido.'),
    body('anonimo').optional().toBoolean()
  ],
  (req, res) => {
    const errors = validationResult(req);
    const dados = {
      tipo: req.body.tipo,
      titulo: req.body.titulo,
      descricao: req.body.descricao,
      email: req.body.email,
      evidencia: req.body.evidencia,
      anonimo: req.body.anonimo ? true : false
    };

        if (!errors.isEmpty()) {
            // envia no mesmo formato do /login: erros.mapped()
            return res.status(422).render('pages/denuncia', { erros: errors.mapped(), dados });
        }

    // Se chegou aqui: dados válidos
    // Aqui você deve salvar no banco / enviar e-mail / criar ticket
    // Exemplo simples: console.log e resposta de sucesso
    console.log('Nova denúncia:', dados);

    // armazena dados na sessão para a página de sucesso e redireciona
    req.session.dados = dados;
    return res.redirect('/denuncia_sucesso');
  }
);

// Página simples de sucesso (crie views/denuncia_sucesso.ejs)
router.get('/denuncia_sucesso', (req,res)=>{
  res.render('pages/denuncia_sucesso', { dados: req.session.dados });
});


router.get('/logout', (req, res) => {
    // Limpa ambas as sessões
    req.session.user_aluno = null;
    req.session.user_prof = null;
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// Rotas simples para resultado do pagamento (visíveis após checkout)
router.get('/pagamento/sucesso', (req, res) => {
  res.render('pages/pagamento_sucesso');
});
router.get('/pagamento/erro', (req, res) => {
  res.render('pages/pagamento_erro');
});
router.get('/pagamento/pendente', (req, res) => {
  res.send('Pagamento pendente. Agradecemos a paciência.');
});

// Rota webhook do Mercado Pago (mantida)
// Veja o código completo em app.js para contexto

module.exports = router;