const express = require('express');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const router = express.Router();
const paymentsStore = require('../lib/paymentsStore');

// Função mock para buscar o nome de um professor/aluno (apenas para demo)
function getUserNameById(id) {
    if (id === 'prof123') return 'Professor João';
    if (id === 'aluno456') return 'Aluno Maria';
    return id; // Retorna o ID se não for encontrado
}

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

// Salt simples para demo. Em produção, use gerenciamento seguro de segredos.
const PASSWORD_SALT = process.env.PASSWORD_SALT || 'regimath_demo_salt';

function hashPassword(password) {
    return crypto.createHmac('sha256', PASSWORD_SALT).update(password).digest('hex');
}

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
        // Guardar a senha inicial em sessão para demo (não recomendado em produção)
        req.session.user_aluno = {
            nome: req.body.nome,
            email: req.body.email,
            tipo: req.body.tipo,
            initial_password: req.body.senha
        };
        return res.redirect('/');
    } else {
        // Guardar a senha inicial em sessão para demo (não recomendado em produção)
        req.session.user_prof = {
            nome: req.body.nome,
            email: req.body.email,
            tipo: req.body.tipo,
            // armazenar a senha original para preencher o modal caso nunca tenha sido alterada
            initial_password: req.body.senha
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

// POST: alterar senha (suporta professor e aluno)
router.post('/alterar-senha', [
    body('current_password').notEmpty().withMessage('Informe sua senha atual.'),
    body('new_password').isLength({ min: 6 }).withMessage('A nova senha precisa ter ao menos 6 caracteres.'),
], (req, res) => {
    // Suporta professor OU aluno
    const isProf = !!req.session.user_prof;
    const isAluno = !!req.session.user_aluno;
    if (!isProf && !isAluno) return res.redirect('/login');

    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        const renderPage = isProf ? 'pages/editar_perfil_prof' : 'pages/editar_perfil_aluno';
        const user = isProf ? req.session.user_prof : req.session.user_aluno;
        return res.render(renderPage, {
            user,
            erros: erros.mapped(),
            dados: req.body
        });
    }

    const { current_password, new_password } = req.body;
    const sessionUser = isProf ? req.session.user_prof : req.session.user_aluno;

    // Se houver senha armazenada na sessão, verifique
    if (sessionUser.password) {
        const hashedCurrent = hashPassword(current_password);
        if (hashedCurrent !== sessionUser.password) {
            const renderPage = isProf ? 'pages/editar_perfil_prof' : 'pages/editar_perfil_aluno';
            return res.render(renderPage, {
                user: sessionUser,
                erros: { current_password: { msg: 'Senha atual incorreta.' } },
                dados: req.body
            });
        }
    }

    // Atualiza a senha na sessão (demo). Em produção, salve no DB com hashing + salt por usuário.
    const updatedUser = {
        ...sessionUser,
        password: hashPassword(new_password),
        initial_password: undefined
    };

    if (isProf) {
        req.session.user_prof = updatedUser;
    } else {
        req.session.user_aluno = updatedUser;
    }

    req.session.save(err => {
        if (err) {
            console.error('Erro ao salvar sessão (alterar-senha):', err);
            const renderPage = isProf ? 'pages/editar_perfil_prof' : 'pages/editar_perfil_aluno';
            return res.render(renderPage, {
                user: isProf ? req.session.user_prof : req.session.user_aluno,
                erros: { general: { msg: 'Erro ao alterar senha. Tente novamente.' } },
                dados: req.body
            });
        }
        // Redireciona para perfil correspondente
        res.redirect(isProf ? '/perfil_prof' : '/perfil_aluno');
    });
});

// API: verifica senha atual via AJAX (retorna JSON)
router.post('/api/verify-current-password', [
    body('current_password').notEmpty().withMessage('Informe sua senha atual.'),
], (req, res) => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.status(400).json({ valid: false, msg: erros.array()[0].msg });
    }

    // Aceita professor ou aluno
    const user = req.session.user_prof || req.session.user_aluno;
    if (!user) return res.status(401).json({ valid: false, msg: 'Usuário não autenticado.' });

    const { current_password } = req.body;
    // Se houver senha já hash armazenada
    if (user.password) {
        const hashed = hashPassword(current_password);
        if (hashed === user.password) return res.json({ valid: true });
        return res.status(400).json({ valid: false, msg: 'Senha atual incorreta.' });
    }

    // Caso demo: se existir initial_password em texto claro
    if (user.initial_password) {
        if (current_password === user.initial_password) return res.json({ valid: true });
        return res.status(400).json({ valid: false, msg: 'Senha atual incorreta.' });
    }

    // Não há forma de verificar
    return res.status(400).json({ valid: false, msg: 'Não foi possível verificar a senha.' });
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

// ROTAS DE CHAT (Melhoria: Chat Dinâmico)
// Rota para entrar em um chat com um ID/Nome específico
router.get('/chat/:roomName', (req, res) => {
    const { roomName } = req.params;
    
    // Obter o usuário logado
    const user = req.session.user_aluno || req.session.user_prof || { nome: 'Visitante', tipo: 'visitante' };
    
    // Você pode usar o roomName para buscar o nome do interlocutor
    const interlocutorName = getUserNameById(roomName); 
    
    // Define o nome da sala, por exemplo, "chat_prof123"
    const room = `chat_${roomName}`;

    // Renderiza a view do chat, passando o nome da sala e o usuário logado
    res.render('pages/chat', { 
        user, 
        room,
        interlocutorName // Adiciona o nome do interlocutor para o título da página
    });
});

// Rota para chat global (mantida para compatibilidade)
router.get('/chat', (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof || { nome: 'Visitante', tipo: 'visitante' };
    const room = 'global';
    res.render('pages/chat', { user, room, interlocutorName: 'Sala Global' });
});

// rota para pagina video (mantida)
router.get("/video/:room", (req, res) => {
  const room = req.params.room;
  res.render("pages/video_call", { room });
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

// ROTAS DE PAGAMENTO
router.get('/pagamento', (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof || { nome: 'Visitante', tipo: 'visitante' };
    res.render('pages/pagamento', { user });
});

// Criar preferência de pagamento
router.get('/create_preference', async (req, res) => {
    try {
        const mpPreferenceClient = req.app && req.app.locals && req.app.locals.mpPreferenceClient;
        if (!mpPreferenceClient) return res.status(500).json({ error: 'Mercado Pago não configurado no servidor.' });

        // Configuração da preferência de pagamento
        const preference = {
            items: [
                {
                    title: 'Mensalidade Regimath',
                    description: 'Acesso a plataforma por 30 dias',
                    quantity: 1,
                    currency_id: 'BRL',
                    unit_price: 100
                }
            ],
            back_urls: {
                success: "http://localhost:3000/pagamento/sucesso",
                failure: "http://localhost:3000/pagamento/erro",
                pending: "http://localhost:3000/pagamento/pendente"
            },
            notification_url: "https://seu-dominio/webhook",
            auto_return: "approved",
            payer: req.session.user_aluno ? {
                name: req.session.user_aluno.nome,
                email: req.session.user_aluno.email
            } : undefined
        };

        const response = await mpPreferenceClient.create({ body: preference });
        const body = response && (response.body || response);

        // Persistir preferência (útil para reconciliação via webhook)
        try {
            await paymentsStore.addPreference({
                preferenceId: body && body.id,
                init_point: body && (body.init_point || body.sandbox_init_point),
                amount: preference.items[0].unit_price,
                status: 'created',
                payer: preference.payer && preference.payer.email,
                createdAt: new Date().toISOString(),
                raw: body
            });
        } catch (e) {
            console.warn('Não foi possível persistir preferência:', e?.message || e);
        }

        res.json({
            id: body && body.id,
            init_point: body && (body.init_point || body.sandbox_init_point),
            raw: body
        });
    } catch (error) {
        console.error('Erro ao criar preferência:', error);
        res.status(500).json({ error: 'Falha ao criar preferência', details: error.message });
    }
});

// Rota de sucesso do pagamento
router.get('/pagamento/sucesso', (req, res) => {
    const paymentId = req.query.payment_id;
    const status = req.query.status;
    const merchantOrderId = req.query.merchant_order_id;

    res.render('pages/pagamento_sucesso', {
        paymentId,
        status,
        merchantOrderId
    });
});

// Rota de erro do pagamento
router.get('/pagamento/erro', (req, res) => {
    res.render('pages/pagamento_erro', {
        error: req.query.error || 'Pagamento não aprovado'
    });
});

// Rota de pagamento pendente
router.get('/pagamento/pendente', (req, res) => {
    res.render('pages/pagamento_pendente', {
        paymentId: req.query.payment_id
    });
});

router.get('/dashboard_prof', (req, res) => {
    const user = req.session.user_prof;
    if (!user) {
        return res.redirect('/login');
    }
    res.render('pages/dashboard_prof', { user });
});

router.get('/dashboard_aluno', (req, res) => {
    const user = req.session.user_aluno;
    if (!user) {
        return res.redirect('/login');
    }
    res.render('pages/dashboard_aluno', { user });
});

router.get('/painel_adm', (req, res) => {
    res.render('pages/painel_adm', { professores });
});

// Exemplo de como sua rota deve buscar e renderizar (Node.js/Express)

router.get('/historico_chats', async (req, res) => {
    // Use session-based user (compatível com o restante da app)
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');

    // Dados simulados para histórico — em produção substitua por busca no banco
    const chatsSimulados = [
        {
            id: 'sala_a1b2',
            partnerName: user.tipo === 'aluno' ? 'Prof. João Silva' : 'Aluno Carlos',
            partnerRole: user.tipo === 'aluno' ? 'professor' : 'aluno',
            lastMessage: 'Claro, podemos começar a aula amanhã às 10h. O link da sala de vídeo é o mesmo.',
            lastActive: Date.now()
        },
        {
            id: 'sala_c3d4',
            partnerName: user.tipo === 'aluno' ? 'Prof. Maria Antunes' : 'Aluno Fernanda',
            partnerRole: user.tipo === 'aluno' ? 'professor' : 'aluno',
            lastMessage: 'Achei o exercício muito difícil, pode me ajudar com o passo 3?',
            lastActive: Date.now() - 86400000
        }
    ];

    res.render('pages/historico_chats', {
        chats: chatsSimulados,
        user
    });
});

router.get('/editar_perfil_aluno', (req, res) => {
    const user = req.session.user_aluno;;
    if (!user) {
        return res.redirect('/login');
    }
    res.render('pages/editar_perfil_aluno', { user, erros: {}, dados: {} });
});

router.get('/editar_perfil_prof', (req, res) => {
    const user = req.session.user_prof;;
    if (!user) {
        return res.redirect('/login');
    }
    res.render('pages/editar_perfil_prof', { user, erros: {}, dados: {} });
});

// POST: Editar perfil do professor com validação
router.post('/perfil/editar', async (req, res) => {
    // Suporta edição de professor e aluno. Validação condicional baseada na sessão.
    const isProf = !!req.session.user_prof;
    const isAluno = !!req.session.user_aluno;
    if (!isProf && !isAluno) return res.redirect('/login');

    // Executa validações dinamicamente usando express-validator's .run(req)
    if (isProf) {
        await body('nome').notEmpty().withMessage('O nome é obrigatório.').run(req);
        await body('email').isEmail().withMessage('Por favor, insira um email válido.').normalizeEmail().run(req);
        await body('descricao').optional({ checkFalsy: true }).trim().run(req);
        await body('disciplinas[]').custom((value) => {
            const disciplinas = Array.isArray(value) ? value : (value ? [value] : []);
            if (disciplinas.length === 0) {
                throw new Error('Adicione pelo menos uma matéria que você leciona.');
            }
            if (disciplinas.some(d => !d || !d.trim())) {
                throw new Error('Todas as matérias devem ser preenchidas.');
            }
            return true;
        }).run(req);
        await body('link_previa').optional({ checkFalsy: true }).isURL().withMessage('Link deve ser uma URL válida.').trim().run(req);
        await body('status').notEmpty().withMessage('Selecione um status de disponibilidade.').isIn(['disponivel','indisponivel']).withMessage('Status inválido.').run(req);
    } else if (isAluno) {
        // Validações mais simples para aluno
        await body('nome').notEmpty().withMessage('O nome é obrigatório.').isLength({ min: 3 }).withMessage('O nome deve ter pelo menos 3 caracteres.').run(req);
        await body('email').isEmail().withMessage('Por favor, insira um email válido.').normalizeEmail().run(req);
        await body('descricao').optional({ checkFalsy: true }).trim().run(req);
    }

    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        const renderPage = isProf ? 'pages/editar_perfil_prof' : 'pages/editar_perfil_aluno';
        const user = isProf ? req.session.user_prof : req.session.user_aluno;
        return res.render(renderPage, { user, erros: erros.mapped(), dados: req.body });
    }

    if (isProf) {
        // Processa disciplinas como array
        const disciplinas = Array.isArray(req.body.disciplinas) 
            ? req.body.disciplinas.map(d => d.trim()).filter(Boolean)
            : [req.body.disciplinas].map(d => d.trim()).filter(Boolean);

        // Atualiza a sessão do professor
        req.session.user_prof = {
            ...req.session.user_prof,
            nome: req.body.nome,
            email: req.body.email,
            descricao: req.body.descricao || req.session.user_prof.descricao,
            disciplinas: disciplinas,
            link_previa: req.body.link_previa || req.session.user_prof.link_previa,
            status: req.body.status
        };

        // Salva na sessão
        return req.session.save((err) => {
            if (err) {
                console.error('Erro ao salvar sessão:', err);
                return res.render('pages/editar_perfil_prof', {
                    user: req.session.user_prof,
                    erros: { general: { msg: 'Erro ao salvar perfil. Tente novamente.' } },
                    dados: req.body
                });
            }
            // Redireciona para a página de perfil com sucesso
            res.redirect('/perfil_prof');
        });
    }

    if (isAluno) {
        // Atualiza a sessão do aluno
        req.session.user_aluno = {
            ...req.session.user_aluno,
            nome: req.body.nome,
            email: req.body.email,
            descricao: req.body.descricao || req.session.user_aluno.descricao
        };

        return req.session.save((err) => {
            if (err) {
                console.error('Erro ao salvar sessão (aluno):', err);
                return res.render('pages/editar_perfil_aluno', {
                    user: req.session.user_aluno,
                    erros: { general: { msg: 'Erro ao salvar perfil. Tente novamente.' } },
                    dados: req.body
                });
            }
            res.redirect('/perfil_aluno');
        });
    }
});

router.get('/pesquisar_profs', (req, res) => {
    const query = (req.query.query || '').trim();
    let results;
    if (!query) {
        results = professores;
    } else {
        // normaliza strings removendo acentos e convertendo para minúsculas
        const normalize = (s) => {
            const str = (s || '');
            if (typeof str.normalize === 'function') {
                return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
            }
            return str.toLowerCase();
        };
        const q = normalize(query);
        results = professores.filter(p => {
            const nome = normalize(p.nome || '');
            const desc = normalize(p.descricao || '');
            return nome.includes(q) || desc.includes(q);
        });
    }

    res.render('pages/pesquisar_profs', { professores: results, query });
});

// Rota compatível com o formulário (action="/professores") — alias para /pesquisar_profs
router.get('/professores', (req, res) => {
    // Redireciona para a mesma lógica de pesquisa usando a query string
    const query = (req.query.query || '').trim();
    // Reuse the same normalization/filtering logic
    const normalize = (s) => {
        const str = (s || '');
        if (typeof str.normalize === 'function') {
            return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        }
        return str.toLowerCase();
    };
    let results;
    if (!query) {
        results = professores;
    } else {
        const q = normalize(query);
        results = professores.filter(p => {
            const nome = normalize(p.nome || '');
            const desc = normalize(p.descricao || '');
            return nome.includes(q) || desc.includes(q);
        });
    }
    res.render('pages/pesquisar_profs', { professores: results, query });
});

router.get('/agenda', (req, res) => {
    const user = req.session.user_aluno;
    if (!user) {
        return res.redirect('/login');
    }
    res.render('pages/agenda', { user });
});

router.get('/ganhos_mes', (req, res) => {
    const user = req.session.user_prof;
    if (!user) {
        return res.redirect('/login');
    }
    res.render('pages/ganhos_mes', { user });
});

router.get('/feedbacks_prof', (req, res) => {
    const user = req.session.user_prof;
    if (!user) {
        return res.redirect('/login');
    }
    res.render('pages/feedbacks_prof', { user });
});

module.exports = router;