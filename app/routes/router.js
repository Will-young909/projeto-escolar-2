const express = require('express');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const router = express.Router();
const paymentsStore = require('../lib/paymentsStore');
const chatStore = require('../lib/chatStore'); // Importa o chatStore
const multer = require('multer');
const path = require('path');

// Armazenamento em memória para alunos e professores (simulando um banco de dados)
let alunos = [
    {
        id: '1',
        nome: "Maria",
        email: "maria@exemplo.com",
        agenda: [],
        notificacoes: []
    }
];

const professores = [
    {
        id: '2',
        nome: "Mateus",
        email: "mateus@exemplo.com",
        foto: "/imagens/imagem_perfil.jpg",
        descricao: "Professor com 7 doutorados na USP, dei aula pra Einstein...",
        link_previa: "#",
        status: "disponivel",
        horariosDisponiveis: [],
        disciplinas: ["Cálculo I", "Álgebra Linear"]
    },
    {
        id: '3',
        nome: "Jonas",
        email: "jonas@exemplo.com",
        foto: "/imagens/imagem_perfil.jpg",
        descricao: "Professor com 5 doutorados na usp, dei aula pra Newton...",
        link_previa: "#",
        status: "disponivel",
        horariosDisponiveis: [],
        disciplinas: ["Física I"]
    }
];

// --- Configuração do Multer para Upload de Imagem ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'app/public/imagens/uploads/');
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png/;
    const mimetype = allowedTypes.test(file.mimetype);
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());

    if (mimetype && extname) {
        return cb(null, true);
    }
    cb(new Error('Apenas imagens (JPEG, PNG) são permitidas.'));
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // Limite de 5MB
}).single('foto');


// --- NOVAS FUNÇÕES AUXILIARES ---
// Rota para iniciar um chat ou redirecionar para uma sala existente
router.get('/chat/with/:userId', (req, res) => {
    const currentUser = req.session.user_aluno || req.session.user_prof;
    if (!currentUser) {
        return res.redirect('/login');
    }

    const partnerId = req.params.userId;
    if (currentUser.id === partnerId) {
        return res.redirect('/historico_chats');
    }

    // Garante uma ordem consistente para o ID da sala
    const roomIds = [currentUser.id, partnerId].sort();
    const roomId = `chat_${roomIds[0]}-${roomIds[1]}`;

    res.redirect(`/chat/${roomId}`);
});
// Função para obter o nome de um usuário pelo ID (simulação)
function getUserById(id) {
    const professor = professores.find(p => p.id === id);
    if (professor) return { ...professor, tipo: 'professor' };

    const aluno = alunos.find(a => a.id === id);
    if (aluno) return { ...aluno, tipo: 'aluno' };

    return { id, nome: `Usuário ${id}`, tipo: 'desconhecido' };
}

// Função para obter usuário por e-mail
function getUserByEmail(email, tipo) {
    const searchEmail = email.toLowerCase();
    if (tipo === 'aluno') {
        return alunos.find(a => a.email && a.email.toLowerCase() === searchEmail);
    }
    if (tipo === 'professor') {
        return professores.find(p => p.email && p.email.toLowerCase() === searchEmail);
    }
    return null;
}


// Salt simples para demo. Em produção, use gerenciamento seguro de segredos.
const PASSWORD_SALT = process.env.PASSWORD_SALT || 'regimath_demo_salt';

function hashPassword(password) {
    return crypto.createHmac('sha256', PASSWORD_SALT).update(password).digest('hex');
}
// --- FIM DAS FUNÇÕES AUXILIARES ---

router.get('/', (req, res) => {
    res.render('pages/home', { professores });
});

// Rota para salvar/atualizar horários do professor
router.post('/professor/horarios', (req, res) => {
    if (!req.session.user_prof) {
        return res.status(401).json({ success: false, message: 'Não autenticado' });
    }

    const { date, slots } = req.body;
    if (!date || !slots || !Array.isArray(slots)) {
        return res.status(400).json({ success: false, message: 'Dados incompletos ou em formato inválido.' });
    }

    const user = req.session.user_prof;

    if (!user.horariosDisponiveis) {
        user.horariosDisponiveis = [];
    }

    user.horariosDisponiveis = user.horariosDisponiveis.filter(h => h.data !== date);

    slots.forEach(slot => {
        if (slot.start && slot.end) {
            user.horariosDisponiveis.push({
                data: date,
                horaInicio: slot.start,
                horaFim: slot.end,
                status: 'disponivel',
                alunoId: null,
                horarioId: crypto.randomBytes(8).toString('hex')
            });
        }
    });

    req.session.save(err => {
        if (err) {
            console.error('Erro ao salvar sessão:', err);
            return res.status(500).json({ success: false, message: 'Erro interno ao salvar os horários.' });
        }
        
        console.log(`Horários atualizados para ${user.nome}:`, user.horariosDisponiveis);
        res.json({ success: true, message: 'Horários salvos com sucesso!' });
    });
});


// Rota para iniciar o agendamento de horário (cria preferência de pagamento)
router.post('/agendar-horario', async (req, res) => {
    if (!req.session.user_aluno) {
        return res.redirect('/login');
    }

    const { profId, horarioId } = req.body;
    const professor = professores.find(p => p.id == profId);

    if (!professor || !professor.horariosDisponiveis) {
        return res.status(404).send('Professor ou horário não encontrado.');
    }

    const horario = professor.horariosDisponiveis.find(h => h.horarioId === horarioId && h.status === 'disponivel');

    if (!horario) {
        return res.status(404).send('Horário não disponível.');
    }

    try {
        const mpPreferenceClient = req.app.locals.mpPreferenceClient;
        if (!mpPreferenceClient) {
            return res.status(500).send('Serviço de pagamento não está configurado.');
        }

        const preference = {
            items: [{
                title: `Aula com ${professor.nome}`,
                description: `Agendamento para ${horario.data} às ${horario.horaInicio}`,
                quantity: 1,
                currency_id: 'BRL',
                unit_price: 50 // Preço fixo para a aula (ex: R$ 50,00)
            }],
            back_urls: {
                success: "http://localhost:3000/pagamento/sucesso",
                failure: "http://localhost:3000/pagamento/erro",
                pending: "http://localhost:3000/pagamento/pendente"
            },
            auto_return: "approved",
            // Passa os IDs como referência externa para reconciliação
            external_reference: JSON.stringify({ profId, horarioId, alunoId: req.session.user_aluno.id }),
        };

        const response = await mpPreferenceClient.create({ body: preference });
        const body = response.body || response;
        
        // Redireciona o usuário para o checkout do Mercado Pago
        res.redirect(body.init_point || body.sandbox_init_point);

    } catch (error) {
        console.error('Erro ao criar preferência de pagamento:', error);
        res.status(500).send('Falha ao iniciar o processo de pagamento.');
    }
});

// --- ROTAS DE AUTENTICAÇÃO ATUALIZADAS ---
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

    const existingUser = getUserByEmail(req.body.email, req.body.tipo);
    if (existingUser) {
        return res.render('pages/cadastro', { 
            erros: { email: { msg: 'Este e-mail já está em uso.' } }, 
            dados: req.body 
        });
    }

    const newUser = {
        id: crypto.randomBytes(4).toString('hex'),
        nome: req.body.nome,
        email: req.body.email,
        tipo: req.body.tipo,
        password: hashPassword(req.body.senha),
        initial_password: req.body.senha, // Manter para demo
        agenda: [],
        notificacoes: [],
    };

    if (req.body.tipo === "aluno") {
        alunos.push(newUser);
        req.session.user_aluno = newUser;
    } else {
        newUser.horariosDisponiveis = []; // Adicionar para professores
        newUser.link_previa = '';
        newUser.disciplinas = [];
        professores.push(newUser);
        req.session.user_prof = newUser;
    }

    req.session.save(() => res.redirect('/'));
});

router.get('/login', (req, res) => {
  res.render('pages/login', { erros: {}, dados: {} });
});

router.post('/login', [
    body('email')
        .isEmail().withMessage('Por favor, insira um email válido.')
        .normalizeEmail(),
    body('senha').notEmpty().withMessage('A senha é obrigatória.'),
    body('tipo').notEmpty().withMessage('Selecione um tipo (Aluno ou Professor).'),
], (req, res) => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.render('pages/login', { erros: erros.mapped(), dados: req.body });
    }

    const { email, senha, tipo } = req.body;
    const user = getUserByEmail(email, tipo);

    const passwordHash = user ? user.password : '';
    const isValidPassword = (user && passwordHash === hashPassword(senha)) || (user && user.initial_password === senha);

    if (!user || !isValidPassword) {
        return res.render('pages/login', { 
            erros: { general: { msg: 'E-mail ou senha incorretos.' } }, 
            dados: req.body 
        });
    }

    if (tipo === "aluno") {
        req.session.user_aluno = user;
    } else {
        req.session.user_prof = user;
    }
    
    req.session.save(() => res.redirect('/'));
});

// --- FIM DAS ROTAS DE AUTENTICAÇÃO ---

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

    // Implementação de recuperação de senha deve ser adicionada aqui
    res.redirect('/login');
});

router.get('/perfil_aluno', (req, res) => {
    if (!req.session.user_aluno) {
        return res.redirect('/login');
    }
    res.render('pages/perfil_aluno', { user: req.session.user_aluno, session: req.session });
});

router.get('/perfil_prof', (req, res) => {
    if (!req.session.user_prof) {
        return res.redirect('/login');
    }

    const professorCompleto = professores.find(p => p.id === req.session.user_prof.id);
    if (!professorCompleto) {
        return res.redirect('/login');
    }

    let historicoAlunos = [];
    if (professorCompleto.horariosDisponiveis) {
        const aulasAgendadas = professorCompleto.horariosDisponiveis.filter(
            h => h.status === 'agendado' && h.alunoId
        );

        const alunoIds = [...new Set(aulasAgendadas.map(h => h.alunoId))];

        historicoAlunos = alunoIds.map(id => getUserById(id)).filter(aluno => aluno.tipo === 'aluno');
    }

    const userParaRender = {
        ...req.session.user_prof,
        historicoAlunos: historicoAlunos
    };

    res.render('pages/perfil_prof', { user: userParaRender, session: req.session });
});


router.get('/exibir_prof/:id', (req, res) => {
    const professorId = req.params.id;
    const professor = professores.find(p => p.id === professorId);

    if (!professor) return res.redirect('/');

    if (!req.session.prof_comentarios) req.session.prof_comentarios = {};
    professor.comentarios = req.session.prof_comentarios[professorId] || [];

    const user = req.session.user_aluno || req.session.user_prof;

    res.render('pages/exibir_prof', { professor, session: req.session, user });
});

// Rota para o PROFESSOR cancelar uma aula
router.post('/cancelar-aula-prof', (req, res) => {
    if (!req.session.user_prof) {
        return res.status(401).json({ success: false, message: 'Professor não autenticado.' });
    }

    const { alunoId, data, hora, motivo } = req.body;
    const aluno = alunos.find(a => a.id == alunoId);

    if (aluno && aluno.agenda) {
        const aulaIndex = aluno.agenda.findIndex(aula => aula.data === data && aula.hora === hora);
        if (aulaIndex > -1) {
            aluno.agenda.splice(aulaIndex, 1);

            if (!aluno.notificacoes) aluno.notificacoes = [];
            aluno.notificacoes.push({
                tipo: 'cancelamento_prof',
                professor: req.session.user_prof.nome,
                aula: { data, hora },
                motivo: motivo || 'Não especificado',
                data: new Date().toISOString()
            });
        }
    }

    const professor = professores.find(p => p.id === req.session.user_prof.id);
    if (professor) {
        if (!professor.aulas) professor.aulas = [];
        professor.aulas.push({ data, hora });
    }

    req.session.save(err => {
        if (err) return res.status(500).json({ success: false, message: 'Erro ao salvar sessão.' });
        res.json({ success: true, message: 'Aula cancelada e aluno notificado.' });
    });
});


// Rota para o ALUNO cancelar uma aula
router.post('/cancelar-aula', (req, res) => {
    if (!req.session.user_aluno || !req.session.user_aluno.agenda) {
        return res.status(401).json({ success: false, message: 'Usuário não autenticado.' });
    }

    const { profId, data, hora, reason } = req.body;
    const agenda = req.session.user_aluno.agenda;
    const aulaIndex = agenda.findIndex(a => a.professor.id == profId && a.data === data && a.hora === hora);

    if (aulaIndex === -1) {
        return res.status(404).json({ success: false, message: 'Aula não encontrada.' });
    }

    const aulaCancelada = agenda.splice(aulaIndex, 1)[0];
    const professor = professores.find(p => p.id == profId);

    if (professor) {
        if (!professor.notificacoes) professor.notificacoes = [];
        professor.notificacoes.push({
            tipo: 'cancelamento',
            aluno: req.session.user_aluno.nome,
            aula: aulaCancelada,
            motivo: reason || 'Não especificado',
            data: new Date().toISOString()
        });

        if (!professor.aulas) professor.aulas = [];
        professor.aulas.push({ data: aulaCancelada.data, hora: aulaCancelada.hora });
    }

    req.session.save(err => {
        if (err) return res.status(500).json({ success: false, message: 'Erro ao salvar a sessão.' });
        res.json({ success: true, message: 'Aula cancelada com sucesso.' });
    });
});

// POST: alterar senha (suporta professor e aluno)
router.post('/alterar-senha', [
    body('current_password').notEmpty().withMessage('Informe sua senha atual.'),
    body('new_password').isLength({ min: 6 }).withMessage('A nova senha precisa ter ao menos 6 caracteres.'),
], (req, res) => {
    const isProf = !!req.session.user_prof;
    const isAluno = !!req.session.user_aluno;
    if (!isProf && !isAluno) return res.redirect('/login');

    const user = isProf ? req.session.user_prof : req.session.user_aluno;
    const renderPage = isProf ? 'pages/editar_perfil_prof' : 'pages/editar_perfil_aluno';

    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.render(renderPage, { user, erros: erros.mapped(), dados: req.body });
    }

    const { current_password, new_password } = req.body;
    const sessionUser = user;

    const hashedCurrent = hashPassword(current_password);
    if (sessionUser.password !== hashedCurrent && sessionUser.initial_password !== current_password) {
        return res.render(renderPage, {
            user: sessionUser,
            erros: { current_password: { msg: 'Senha atual incorreta.' } },
            dados: req.body
        });
    }

    sessionUser.password = hashPassword(new_password);
    sessionUser.initial_password = undefined;

    req.session.save(err => {
        if (err) {
            return res.render(renderPage, {
                user: sessionUser,
                erros: { general: { msg: 'Erro ao alterar senha. Tente novamente.' } },
                dados: req.body
            });
        }
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

    const user = req.session.user_prof || req.session.user_aluno;
    if (!user) return res.status(401).json({ valid: false, msg: 'Usuário não autenticado.' });

    const { current_password } = req.body;
    if ((user.password && hashPassword(current_password) === user.password) || (user.initial_password && current_password === user.initial_password)) {
        return res.json({ valid: true });
    }

    return res.status(400).json({ valid: false, msg: 'Senha atual incorreta.' });
});

// Rota para adicionar comentário a um professor
router.post('/exibir_prof/:id/comentar', (req, res) => {
    const professorId = req.params.id;
    const texto = (req.body.texto || '').trim();
    const nota = req.body.nota; 

    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');
    if (!texto) return res.redirect(`/exibir_prof/${professorId}`);

    if (!req.session.prof_comentarios) req.session.prof_comentarios = {};
    if (!req.session.prof_comentarios[professorId]) req.session.prof_comentarios[professorId] = [];

    const newComment = {
        usuario: user.nome,
        texto,
        data: new Date().toISOString(),
    };

    if (nota) {
        const notaInt = parseInt(nota, 10);
        if (notaInt >= 1 && notaInt <= 5) {
            newComment.nota = notaInt;
        }
    }

    req.session.prof_comentarios[professorId].push(newComment);

    req.session.save(err => {
        if (err) {
            console.error('Erro ao salvar o comentário na sessão:', err);
        }
        return res.redirect(`/exibir_prof/${professorId}`);
    });
});


// --- ROTAS DE CHAT ATUALIZADAS ---
router.get('/chat/:roomId', (req, res) => {
    const { roomId } = req.params;
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');
    
    const roomParts = roomId.replace('chat_', '').split('-');
    const partnerId = roomParts.find(id => id !== user.id);
    const partner = getUserById(partnerId);

    res.render('pages/chat', { 
        user, 
        room: roomId,
        interlocutorName: partner.nome || 'Conversa'
    });
});

router.get('/chat', (req, res) => {
    res.redirect('/historico_chats');
});

// Rota para a página de videochamada
router.get("/video/:room", (req, res) => {
    const { room } = req.params;
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');
    res.render("pages/video_call", { room, user });
});
// --- FIM DAS ROTAS DE CHAT --


router.get('/politica', (req, res) => {
    res.render('pages/politica');
});

router.get('/termos', (req, res) => {
    res.render('pages/termos');
});

router.get('/aulas', (req, res) => {
    const user = req.session.user_prof;
    if (!user) return res.redirect('/login');
    res.render('pages/aulas', { user, session: req.session });
});


// GET exibe formulário (dados e erros são opcionais) — padronizado como nas outras rotas
router.get('/denuncia', (req, res) => {
    res.render('pages/denuncia', { erros: {}, dados: {} });
});

// POST valida e processa
router.post('/denuncia',
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
    const dados = req.body;

    if (!errors.isEmpty()) {
        return res.status(422).render('pages/denuncia', { erros: errors.mapped(), dados });
    }

    console.log('Nova denúncia:', dados);
    req.session.dados = dados;
    return res.redirect('/denuncia_sucesso');
  }
);

// Página simples de sucesso (crie views/denuncia_sucesso.ejs)
router.get('/denuncia_sucesso', (req,res)=> {
  res.render('pages/denuncia_sucesso', { dados: req.session.dados });
});


router.get('/logout', (req, res) => {
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
        const mpPreferenceClient = req.app.locals.mpPreferenceClient;
        if (!mpPreferenceClient) return res.status(500).json({ error: 'Mercado Pago não configurado no servidor.' });

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

        res.json({
            id: body?.id,
            init_point: body?.init_point || body?.sandbox_init_point
        });
    } catch (error) {
        console.error('Erro ao criar preferência:', error);
        res.status(500).json({ error: 'Falha ao criar preferência', details: error.message });
    }
});

// Rota de sucesso do pagamento (onde o agendamento é efetivado)
router.get('/pagamento/sucesso', (req, res) => {
    const { external_reference } = req.query;

    if (!external_reference) {
        return res.render('pages/pagamento_sucesso', {
            paymentId: req.query.payment_id,
            status: req.query.status,
            message: "Pagamento da assinatura concluído com sucesso!"
        });
    }

    try {
        const { profId, horarioId, alunoId } = JSON.parse(external_reference);
        const professor = professores.find(p => p.id == profId);

        if (!professor || !professor.horariosDisponiveis) {
            return res.status(404).render('pages/pagamento_erro', { error: 'O professor não foi encontrado.' });
        }

        const horario = professor.horariosDisponiveis.find(h => h.horarioId === horarioId);
        if (!horario) {
            return res.status(404).render('pages/pagamento_erro', { error: 'O horário não existe mais.' });
        }

        if (horario.status === 'disponivel') {
            horario.status = 'agendado';
            horario.alunoId = alunoId;

            if (req.session.user_aluno && req.session.user_aluno.id === alunoId) {
                if (!req.session.user_aluno.agenda) req.session.user_aluno.agenda = [];
                req.session.user_aluno.agenda.push({
                    professor: { id: professor.id, nome: professor.nome },
                    salaId: horario.salaId || crypto.randomBytes(16).toString('hex'),
                    data: horario.data,
                    hora: horario.horaInicio
                });
            }
            
            req.session.save(err => {
                if (err) return res.render('pages/pagamento_erro', { error: 'Seu pagamento foi aprovado, mas houve um erro ao salvar o agendamento.' });
                res.render('pages/pagamento_sucesso', { paymentId: req.query.payment_id, status: req.query.status });
            });

        } else {
            console.warn(`Conflito de agendamento: Horário ${horarioId} do prof ${profId} já estava '${horario.status}'.`);
            res.render('pages/pagamento_erro', { 
                error: 'O horário escolhido foi agendado por outra pessoa. Contate o suporte para reagendar ou solicitar o estorno.' 
            });
        }
    } catch (error) {
        console.error('Erro ao processar sucesso do pagamento:', error);
        res.status(500).render('pages/pagamento_erro', { error: 'Ocorreu um erro crítico ao processar seu agendamento.' });
    }
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
    if (!user) return res.redirect('/login');

    const professor = professores.find(p => p.id === user.id);
    const agora = new Date();
    const mesAtual = agora.getMonth();
    const anoAtual = agora.getFullYear();

    let aulasProximas24h = 0;
    let proximaAula = null;
    let ganhosMes = { total: 0, concluidas: 0, futuras: 0 };
    let avaliacaoMedia = { media: 0, totalAvaliacoes: 0, ultimoFeedback: "Nenhum feedback ainda." };

    if (professor && professor.horariosDisponiveis) {
        const horariosAgendados = professor.horariosDisponiveis
            .filter(h => h.status === 'agendado')
            .map(h => ({ ...h, dataObj: new Date(`${h.data}T${h.horaInicio}`) }))
            .sort((a, b) => a.dataObj - b.dataObj);

        const aulasFuturas = horariosAgendados.filter(h => h.dataObj > agora);

        // Contagem para as próximas 24h
        const proximas24h = new Date(agora.getTime() + 24 * 60 * 60 * 1000);
        aulasProximas24h = aulasFuturas.filter(h => h.dataObj < proximas24h).length;

        // Encontra a próxima aula
        if (aulasFuturas.length > 0) {
            const proximoHorario = aulasFuturas[0];
            const aluno = getUserById(proximoHorario.alunoId);
            proximaAula = {
                ...proximoHorario,
                aluno: aluno,
                salaId: proximoHorario.salaId || 'geral'
            };
        }

        // Cálculo de Ganhos no Mês
        const aulasConcluidasEsteMes = horariosAgendados.filter(h => 
            h.dataObj < agora && 
            h.dataObj.getMonth() === mesAtual && 
            h.dataObj.getFullYear() === anoAtual
        );

        ganhosMes.total = aulasConcluidasEsteMes.length * 50; // Preço fixo de 50
        ganhosMes.concluidas = aulasConcluidasEsteMes.length;
        ganhosMes.futuras = aulasFuturas.length;
    }

    // Cálculo da Avaliação Média
    const comentarios = (req.session.prof_comentarios && req.session.prof_comentarios[user.id]) || [];
    const avaliacoes = comentarios.filter(c => c.nota);
    
    if (avaliacoes.length > 0) {
        const somaNotas = avaliacoes.reduce((acc, c) => acc + c.nota, 0);
        avaliacaoMedia.media = (somaNotas / avaliacoes.length).toFixed(1);
        avaliacaoMedia.totalAvaliacoes = avaliacoes.length;
        
        // Pega o feedback mais recente que tenha um texto
        const ultimoFeedbackComTexto = [...avaliacoes].reverse().find(a => a.texto);
        if(ultimoFeedbackComTexto) {
            avaliacaoMedia.ultimoFeedback = ultimoFeedbackComTexto.texto;
        }
    }

    res.render('pages/dashboard_prof', { 
        user,
        professor: professor || user,
        session: req.session,
        aulasProximas24h,
        proximaAula,
        ganhosMes,
        avaliacaoMedia
    });
});


router.get('/dashboard_aluno', (req, res) => {
    const user = req.session.user_aluno;
    if (!user) return res.redirect('/login');
    res.render('pages/dashboard_aluno', { user, session: req.session });
});


router.get('/painel_adm', (req, res) => {
    res.render('pages/painel_adm', { professores });
});

// Rota para buscar o histórico de chats do usuário com filtro de pesquisa
router.get('/historico_chats', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');

    // Termo de pesquisa da query string
    const searchQuery = (req.query.search || '').trim().toLowerCase();

    try {
        const allMessages = await chatStore.loadMessages();
        let userChats = []; // Alterado para 'let' para permitir a reatribuição após o filtro

        for (const room in allMessages) {
            if (room.startsWith('global')) continue;

            const roomParts = room.replace('chat_', '').split('-');
            // **CORREÇÃO**: Garantir que o ID do usuário da sessão seja string para a comparação
            if (roomParts.includes(String(user.id))) {
                const messages = allMessages[room];
                if (messages.length > 0) {
                    const lastMessage = messages[messages.length - 1];
                    const partnerId = roomParts.find(id => id !== String(user.id));
                    const partner = getUserById(partnerId);

                    userChats.push({
                        id: room,
                        partnerName: partner.nome || `Usuário ${partnerId}`,
                        partnerRole: partner.tipo,
                        lastMessage: lastMessage.text,
                        lastActive: lastMessage.time
                    });
                }
            }
        }

        // Aplica o filtro de pesquisa se um termo foi fornecido
        if (searchQuery) {
            userChats = userChats.filter(chat =>
                chat.partnerName.toLowerCase().includes(searchQuery)
            );
        }

        // Ordena os chats pelo mais recente
        userChats.sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));

        // Passa o termo de pesquisa para o template
        res.render('pages/historico_chats', {
            chats: userChats,
            user,
            searchQuery // Envia a pesquisa de volta para o input
        });

    } catch (error) {
        console.error('Erro ao carregar o histórico de chats:', error);
        res.status(500).send('Não foi possível carregar o histórico de conversas.');
    }
});


router.get('/editar_perfil_aluno', (req, res) => {
    const user = req.session.user_aluno;
    if (!user) return res.redirect('/login');
    res.render('pages/editar_perfil_aluno', { user, erros: {}, dados: {} });
});

router.get('/editar_perfil_prof', (req, res) => {
    const user = req.session.user_prof;
    if (!user) return res.redirect('/login');
    res.render('pages/editar_perfil_prof', { user, erros: {}, dados: {}, session: req.session });
});

// POST: Editar perfil do professor com validação e upload de foto
router.post('/perfil/editar', (req, res) => {
    upload(req, res, async (err) => {
        const isProf = !!req.session.user_prof;
        const isAluno = !!req.session.user_aluno;
        if (!isProf && !isAluno) return res.redirect('/login');

        const user = isProf ? req.session.user_prof : req.session.user_aluno;
        const renderPage = isProf ? 'pages/editar_perfil_prof' : 'pages/editar_perfil_aluno';

        if (err) {
            return res.render(renderPage, {
                user,
                erros: { foto: { msg: err.message } },
                dados: req.body,
                session: req.session
            });
        }

        await body('nome').notEmpty().withMessage('O nome é obrigatório.').run(req);
        await body('email').isEmail().withMessage('O e-mail é inválido.').run(req);

        const erros = validationResult(req);
        if (!erros.isEmpty()) {
            return res.render(renderPage, { user, erros: erros.mapped(), dados: req.body, session: req.session });
        }
        
        // Garante que 'disciplinas' seja sempre um array
        let disciplinas = req.body.disciplinas || [];
        if (disciplinas && !Array.isArray(disciplinas)) {
            disciplinas = [disciplinas];
        }
        // Filtra valores vazios que possam ter sido enviados pelo formulário
        disciplinas = disciplinas.filter(d => d && d.trim() !== '');

        const updatedData = {
            nome: req.body.nome,
            email: req.body.email,
            descricao: req.body.descricao || user.descricao,
            link_previa: req.body.link_previa || user.link_previa,
            status: req.body.status || user.status,
            disciplinas: disciplinas // Usa o array de disciplinas que foi tratado
        };

        if (req.file) {
            updatedData.foto = '/imagens/uploads/' + req.file.filename;
        }

        // Atualiza a sessão
        req.session.user_prof = { ...user, ...updatedData };

        // Atualiza o array global `professores`
        const profIndex = professores.findIndex(p => p.id === user.id);
        if (profIndex !== -1) {
            professores[profIndex] = { ...professores[profIndex], ...updatedData };
        }

        req.session.save(err => {
            if (err) {
                return res.render(renderPage, { user, erros: { general: { msg: 'Erro ao salvar.' } }, session: req.session });
            }
            res.redirect(isProf ? '/perfil_prof' : '/perfil_aluno');
        });
    });
});


router.get('/pesquisar_profs', (req, res) => {
    const query = (req.query.query || '').trim().toLowerCase();
    let results = professores;
    if (query) {
        results = professores.filter(p => p.nome.toLowerCase().includes(query) || p.descricao.toLowerCase().includes(query));
    }
    res.render('pages/pesquisar_profs', { professores: results, query, session: req.session });
});

router.get('/professores', (req, res) => {
    res.redirect('/pesquisar_profs?query=' + (req.query.query || ''));
});

router.get('/agenda', (req, res) => {
    const user = req.session.user_aluno;
    if (!user) return res.redirect('/login');
    res.render('pages/agenda', { user, session: req.session });
});

router.get('/ganhos_mes', (req, res) => {
    const user = req.session.user_prof;
    if (!user) return res.redirect('/login');

    const professor = professores.find(p => p.id === user.id);
    const agora = new Date();
    const mesAtual = agora.getMonth();
    const anoAtual = agora.getFullYear();

    const VALOR_AULA = 50; // Valor fixo por aula

    let movimentacoes = [];
    let resumo = {
        mes: agora.toLocaleString('pt-BR', { month: 'long', year: 'numeric' }),
        totalGanhos: 0,
        aulasConcluidas: 0,
        aulasAgendadas: 0,
        ticketMedio: 0
    };

    if (professor && professor.horariosDisponiveis) {
        const aulasDoMes = professor.horariosDisponiveis.filter(h => {
            const dataAula = new Date(`${h.data}T${h.horaInicio}`);
            return h.status === 'agendado' && dataAula.getMonth() === mesAtual && dataAula.getFullYear() === anoAtual;
        });

        const aulasConcluidas = aulasDoMes.filter(h => new Date(`${h.data}T${h.horaInicio}`) < agora);
        resumo.aulasConcluidas = aulasConcluidas.length;
        resumo.totalGanhos = aulasConcluidas.length * VALOR_AULA;
        resumo.aulasAgendadas = aulasDoMes.length - aulasConcluidas.length;
        resumo.ticketMedio = resumo.aulasConcluidas > 0 ? resumo.totalGanhos / resumo.aulasConcluidas : 0;

        // Ordena por data, da mais recente para a mais antiga
        movimentacoes = aulasConcluidas
            .sort((a, b) => new Date(`${b.data}T${b.horaInicio}`) - new Date(`${a.data}T${a.horaInicio}`))
            .map(h => ({
                titulo: `Aula com ${getUserById(h.alunoId).nome || 'Aluno'}`,
                data: new Date(`${h.data}T${h.horaInicio}`).toLocaleDateString('pt-BR'),
                hora: h.horaInicio,
                valor: VALOR_AULA
            }));
    }

    res.render('pages/ganhos_mes', { 
        user,
        resumo,
        movimentacoes
    });
});


router.get('/feedbacks_prof', (req, res) => {
    const user = req.session.user_prof;
    if (!user) return res.redirect('/login');

    const allComentarios = (req.session.prof_comentarios && req.session.prof_comentarios[user.id]) || [];
    const feedbacks = allComentarios
        .sort((a, b) => new Date(b.data) - new Date(a.data)); // Mais recentes primeiro

    const avaliacoesComNota = feedbacks.filter(f => f.nota);
    const totalAvaliacoes = avaliacoesComNota.length;

    const distribuicaoNotas = {
        5: { count: 0, percent: 0 },
        4: { count: 0, percent: 0 },
        3: { count: 0, percent: 0 },
        2: { count: 0, percent: 0 },
        1: { count: 0, percent: 0 },
    };

    let somaNotas = 0;

    if (totalAvaliacoes > 0) {
        avaliacoesComNota.forEach(f => {
            somaNotas += f.nota;
            if (distribuicaoNotas[f.nota]) {
                distribuicaoNotas[f.nota].count++;
            }
        });

        for (let i = 1; i <= 5; i++) {
            distribuicaoNotas[i].percent = (distribuicaoNotas[i].count / totalAvaliacoes) * 100;
        }
    }

    const mediaGeral = totalAvaliacoes > 0 ? (somaNotas / totalAvaliacoes).toFixed(1) : "0.0";

    res.render('pages/feedbacks_prof', {
        user,
        feedbacks,
        resumo: {
            media: mediaGeral,
            total: totalAvaliacoes,
            distribuicao: distribuicaoNotas
        }
    });
});


router.get('/feedbacks_aluno', (req, res) => {
    const user = req.session.user_aluno;
    if (!user) return res.redirect('/login');
    res.render('pages/feedbacks_aluno', { user, session: req.session });
});

module.exports = router;
