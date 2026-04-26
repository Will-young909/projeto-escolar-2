const express = require('express');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const router = express.Router();
const paymentsStore = require('../lib/paymentsStore');
const chatStore = require('../lib/chatStore');
const activityStore = require('../lib/activityStore');
const multer = require('multer');
const path = require('path');

const AlunoModel = require('../models/AlunoModel');
const ProfessorModel = require('../models/ProfessorModel');
const DisciplinaModel = require('../models/DisciplinaModel');
const HorarioModel = require('../models/HorarioModel');
const AgendamentoModel = require('../models/AgendamentoModel');
const AtividadeModel = require('../models/AtividadeModel');
const QuestaoModel = require('../models/QuestaoModel');
const ComentarioModel = require('../models/ComentarioModel');
const DenunciaModel = require('../models/DenunciaModel');
const PagamentoModel = require('../models/PagamentoModel');
const NotificacaoModel = require('../models/NotificacaoModel');

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


// --- FUNÇÕES AUXILIARES ---
async function getUserById(id) {
    const prof = await ProfessorModel.findById(id);
    if (prof) return { ...prof, tipo: 'professor' };

    const aluno = await AlunoModel.findById(id);
    if (aluno) return { ...aluno, tipo: 'aluno' };

    return { id, nome: `Usuário ${id}`, tipo: 'desconhecido' };
}

const PASSWORD_SALT = process.env.PASSWORD_SALT || 'regimath_demo_salt';

function hashPassword(password) {
    return crypto.createHmac('sha256', PASSWORD_SALT).update(password).digest('hex');
}
// --- FIM DAS FUNÇÕES AUXILIARES ---

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


router.get('/', async (req, res) => {
    const professores = await ProfessorModel.findAll();
    res.render('pages/home', { professores });
});

// Rota para salvar/atualizar horários do professor
router.post('/professor/horarios', async (req, res) => {
    if (!req.session.user_prof) {
        return res.status(401).json({ success: false, message: 'Não autenticado' });
    }

    const { date, slots } = req.body;
    if (!date || !slots || !Array.isArray(slots)) {
        return res.status(400).json({ success: false, message: 'Dados incompletos ou em formato inválido.' });
    }

    const sessionUser = req.session.user_prof;
    const professor = await ProfessorModel.findById(sessionUser.id);

    if (!professor) {
        return res.status(404).json({ success: false, message: 'Professor não encontrado.' });
    }

    await HorarioModel.deleteByProfessorAndData(professor.id, date);

    for (const slot of slots) {
        if (slot.start && slot.end && slot.price) {
            await HorarioModel.create({
                professor_id: professor.id,
                data: date,
                hora_inicio: slot.start,
                hora_fim: slot.end,
                preco: slot.price
            });
        }
    }

    res.json({ success: true, message: 'Horários salvos com sucesso!' });
});


// Rota para iniciar o agendamento de horário (cria preferência de pagamento)
router.post('/agendar-horario', async (req, res) => {
    if (!req.session.user_aluno) {
        return res.redirect('/login');
    }

    const { profId, horarioId } = req.body;
    const alunoId = req.session.user_aluno.id;

    const professor = await ProfessorModel.findById(profId);
    if (!professor) {
        return res.status(404).send('Professor não encontrado.');
    }

    const horario = await HorarioModel.findById(horarioId);
    if (!horario || horario.status !== 'disponivel') {
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
                description: `Agendamento para ${horario.data} às ${horario.hora_inicio}`,
                quantity: 1,
                currency_id: 'BRL',
                unit_price: Number(horario.preco)
            }],
            back_urls: {
                success: "http://localhost:3000/pagamento/sucesso",
                failure: "http://localhost:3000/pagamento/erro",
                pending: "http://localhost:3000/pagamento/pendente"
            },
            auto_return: "approved",
            external_reference: JSON.stringify({ profId, horarioId, alunoId }),
        };

        const response = await mpPreferenceClient.create({ body: preference });
        const body = response.body || response;
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
], async (req, res) => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.render('pages/cadastro', { erros: erros.mapped(), dados: req.body });
    }

    const { nome, email, senha, tipo } = req.body;

    if (tipo === 'aluno') {
        const existing = await AlunoModel.findByEmail(email);
        if (existing) {
            return res.render('pages/cadastro', {
                erros: { email: { msg: 'Este e-mail já está em uso.' } },
                dados: req.body
            });
        }
        const created = await AlunoModel.create({ nome, email, senha: hashPassword(senha) });
        req.session.user_aluno = { id: created.id, nome, email, tipo };
    } else {
        const existing = await ProfessorModel.findByEmail(email);
        if (existing) {
            return res.render('pages/cadastro', {
                erros: { email: { msg: 'Este e-mail já está em uso.' } },
                dados: req.body
            });
        }
        const created = await ProfessorModel.create({ nome, email, senha: hashPassword(senha) });
        req.session.user_prof = { id: created.id, nome, email, tipo };
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
], async (req, res) => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.render('pages/login', { erros: erros.mapped(), dados: req.body });
    }

    const { email, senha, tipo } = req.body;
    let user;
    if (tipo === 'aluno') {
        user = await AlunoModel.findByEmail(email);
    } else {
        user = await ProfessorModel.findByEmail(email);
    }

    if (!user || user.senha !== hashPassword(senha)) {
        return res.render('pages/login', {
            erros: { general: { msg: 'E-mail ou senha incorretos.' } },
            dados: req.body
        });
    }

    if (tipo === "aluno") {
        req.session.user_aluno = { id: user.id, nome: user.nome, email: user.email, tipo };
    } else {
        req.session.user_prof = { id: user.id, nome: user.nome, email: user.email, tipo };
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

router.get('/perfil_prof', async (req, res) => {
    if (!req.session.user_prof) {
        return res.redirect('/login');
    }

    const professor = await ProfessorModel.findById(req.session.user_prof.id);
    if (!professor) {
        return res.redirect('/login');
    }

    const horarios = await HorarioModel.findByProfessor(professor.id);
    const aulasAgendadas = horarios.filter(h => h.status === 'agendado' && h.aluno_id);
    const alunoIds = [...new Set(aulasAgendadas.map(h => h.aluno_id))];

    const historicoAlunos = [];
    for (const id of alunoIds) {
        const aluno = await AlunoModel.findById(id);
        if (aluno) historicoAlunos.push({ ...aluno, tipo: 'aluno' });
    }

    const disciplinas = await DisciplinaModel.findByProfessor(professor.id);

    const userParaRender = {
        ...professor,
        historicoAlunos,
        disciplinas: disciplinas.map(d => d.nome),
        horariosDisponiveis: horarios
    };

    res.render('pages/perfil_prof', { user: userParaRender, session: req.session });
});


router.get('/exibir_prof/:id', async (req, res) => {
    const professorId = req.params.id;
    const professorData = await ProfessorModel.findById(professorId);

    if (!professorData) return res.redirect('/');

    const horarios = await HorarioModel.findByProfessor(professorId);
    for (const horario of horarios) {
        if (horario.status === 'agendado' && horario.aluno_id) {
            const aluno = await AlunoModel.findById(horario.aluno_id);
            if (aluno) horario.alunoNome = aluno.nome;
        }
    }

    const disciplinas = await DisciplinaModel.findByProfessor(professorId);
    const comentarios = await ComentarioModel.findByProfessor(professorId);

    const professor = {
        ...professorData,
        horariosDisponiveis: horarios,
        disciplinas: disciplinas.map(d => d.nome),
        comentarios
    };

    const user = req.session.user_aluno || req.session.user_prof;
    res.render('pages/exibir_prof', { professor, session: req.session, user });
});

// Rota para o PROFESSOR cancelar uma aula
router.post('/cancelar-aula-prof', async (req, res) => {
    if (!req.session.user_prof) {
        return res.status(401).json({ success: false, message: 'Professor não autenticado.' });
    }

    const { alunoId, data, hora, motivo } = req.body;

    await NotificacaoModel.create({
        usuario_id: alunoId,
        usuario_tipo: 'aluno',
        tipo: 'cancelamento_prof',
        mensagem: `Aula do dia ${data} às ${hora} cancelada pelo professor ${req.session.user_prof.nome}. Motivo: ${motivo || 'Não especificado'}`
    });

    const horarios = await HorarioModel.findByProfessor(req.session.user_prof.id);
    const horario = horarios.find(h => String(h.data) === data && h.hora_inicio === hora && h.aluno_id == alunoId);
    if (horario) {
        await HorarioModel.update(horario.id, { status: 'disponivel', aluno_id: null });
    }

    res.json({ success: true, message: 'Aula cancelada e aluno notificado.' });
});


// Rota para o ALUNO cancelar uma aula
router.post('/cancelar-aula', async (req, res) => {
    if (!req.session.user_aluno) {
        return res.status(401).json({ success: false, message: 'Usuário não autenticado.' });
    }

    const { profId, data, hora, reason } = req.body;

    const horarios = await HorarioModel.findByProfessor(profId);
    const horario = horarios.find(h => String(h.data) === data && h.hora_inicio === hora && h.aluno_id == req.session.user_aluno.id);

    if (!horario) {
        return res.status(404).json({ success: false, message: 'Aula não encontrada.' });
    }

    await HorarioModel.update(horario.id, { status: 'disponivel', aluno_id: null });

    await NotificacaoModel.create({
        usuario_id: profId,
        usuario_tipo: 'professor',
        tipo: 'cancelamento',
        mensagem: `Aula do dia ${data} às ${hora} cancelada pelo aluno ${req.session.user_aluno.nome}. Motivo: ${reason || 'Não especificado'}`
    });

    res.json({ success: true, message: 'Aula cancelada com sucesso.' });
});

// POST: alterar senha (suporta professor e aluno)
router.post('/alterar-senha', [
    body('current_password').notEmpty().withMessage('Informe sua senha atual.'),
    body('new_password').isLength({ min: 6 }).withMessage('A nova senha precisa ter ao menos 6 caracteres.'),
], async (req, res) => {
    const isProf = !!req.session.user_prof;
    const isAluno = !!req.session.user_aluno;
    if (!isProf && !isAluno) return res.redirect('/login');

    const sessionUser = isProf ? req.session.user_prof : req.session.user_aluno;
    const renderPage = isProf ? 'pages/editar_perfil_prof' : 'pages/editar_perfil_aluno';

    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.render(renderPage, { user: sessionUser, erros: erros.mapped(), dados: req.body });
    }

    const { current_password, new_password } = req.body;

    const dbUser = isProf
        ? await ProfessorModel.findById(sessionUser.id)
        : await AlunoModel.findById(sessionUser.id);

    if (!dbUser || dbUser.senha !== hashPassword(current_password)) {
        return res.render(renderPage, {
            user: sessionUser,
            erros: { current_password: { msg: 'Senha atual incorreta.' } },
            dados: req.body
        });
    }

    const Model = isProf ? ProfessorModel : AlunoModel;
    await Model.update(sessionUser.id, { senha: hashPassword(new_password) });

    res.redirect(isProf ? '/perfil_prof' : '/perfil_aluno');
});


// API: verifica senha atual via AJAX (retorna JSON)
router.post('/api/verify-current-password', [
    body('current_password').notEmpty().withMessage('Informe sua senha atual.'),
], async (req, res) => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.status(400).json({ valid: false, msg: erros.array()[0].msg });
    }

    const sessionUser = req.session.user_prof || req.session.user_aluno;
    if (!sessionUser) return res.status(401).json({ valid: false, msg: 'Usuário não autenticado.' });

    const isProf = !!req.session.user_prof;
    const dbUser = isProf
        ? await ProfessorModel.findById(sessionUser.id)
        : await AlunoModel.findById(sessionUser.id);

    const { current_password } = req.body;
    if (dbUser && dbUser.senha === hashPassword(current_password)) {
        return res.json({ valid: true });
    }

    return res.status(400).json({ valid: false, msg: 'Senha atual incorreta.' });
});

// Rota para adicionar comentário a um professor
router.post('/exibir_prof/:id/comentar', async (req, res) => {
    const professorId = req.params.id;
    const texto = (req.body.texto || '').trim();
    const nota = req.body.nota;

    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');
    if (!texto) return res.redirect(`/exibir_prof/${professorId}`);

    let notaInt = null;
    if (nota) {
        notaInt = parseInt(nota, 10);
        if (notaInt < 1 || notaInt > 5) notaInt = null;
    }

    await ComentarioModel.create({
        professor_id: professorId,
        usuario_nome: user.nome,
        texto,
        nota: notaInt
    });

    res.redirect(`/exibir_prof/${professorId}`);
});


// --- ROTAS DE CHAT ATUALIZADAS ---
router.get('/chat/:roomId', async (req, res) => {
    const { roomId } = req.params;
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');
    
    const roomParts = roomId.replace('chat_', '').split('-');
    const partnerId = roomParts.find(id => String(id) !== String(user.id));
    const partner = await getUserById(partnerId);

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

router.get('/aulas', async (req, res) => {
    const sessionUser = req.session.user_prof;
    if (!sessionUser) {
        return res.redirect('/login');
    }

    const professor = await ProfessorModel.findById(sessionUser.id);
    if (!professor) {
        return res.redirect('/logout');
    }

    const horarios = await HorarioModel.findByProfessor(professor.id);
    for (const horario of horarios) {
        if (horario.status === 'agendado' && horario.aluno_id) {
            const aluno = await AlunoModel.findById(horario.aluno_id);
            horario.alunoNome = aluno ? aluno.nome : 'Aluno desconhecido';
        }
    }

    const user = { ...professor, horariosDisponiveis: horarios };
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
  async (req, res) => {
    const errors = validationResult(req);
    const dados = req.body;

    if (!errors.isEmpty()) {
        return res.status(422).render('pages/denuncia', { erros: errors.mapped(), dados });
    }

    await DenunciaModel.create({
        tipo: dados.tipo,
        titulo: dados.titulo,
        descricao: dados.descricao,
        email: dados.email,
        evidencia: dados.evidencia,
        anonimo: dados.anonimo
    });

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
router.get('/pagamento/sucesso', async (req, res) => {
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
        const professor = await ProfessorModel.findById(profId);

        if (!professor) {
            return res.status(404).render('pages/pagamento_erro', { error: 'O professor não foi encontrado.' });
        }

        const horario = await HorarioModel.findById(horarioId);
        if (!horario) {
            return res.status(404).render('pages/pagamento_erro', { error: 'O horário não existe mais.' });
        }

        await HorarioModel.update(horario.id, { status: 'agendado', aluno_id: alunoId });

        const salaId = crypto.randomBytes(16).toString('hex');

        await AgendamentoModel.create({
            aluno_id: alunoId,
            professor_id: profId,
            horario_id: horario.id,
            sala_id: salaId,
            data: horario.data,
            hora: horario.hora_inicio
        });

        res.render('pages/pagamento_sucesso', {
            paymentId: req.query.payment_id,
            status: req.query.status,
            message: "Agendamento concluído com sucesso!"
        });

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

router.get('/dashboard_prof', async (req, res) => {
    const user = req.session.user_prof;
    if (!user) return res.redirect('/login');

    const professor = await ProfessorModel.findById(user.id);
    const agora = new Date();
    const mesAtual = agora.getMonth();
    const anoAtual = agora.getFullYear();

    let aulasProximas24h = 0;
    let proximaAula = null;
    let ganhosMes = { total: 0, concluidas: 0, futuras: 0 };
    let avaliacaoMedia = { media: 0, totalAvaliacoes: 0, ultimoFeedback: "Nenhum feedback ainda." };

    const horarios = await HorarioModel.findByProfessor(user.id);
    const horariosAgendados = horarios
        .filter(h => h.status === 'agendado')
        .map(h => ({ ...h, dataObj: new Date(`${h.data}T${h.hora_inicio}`) }))
        .sort((a, b) => a.dataObj - b.dataObj);

    const aulasFuturas = horariosAgendados.filter(h => h.dataObj > agora);

    const proximas24h = new Date(agora.getTime() + 24 * 60 * 60 * 1000);
    aulasProximas24h = aulasFuturas.filter(h => h.dataObj < proximas24h).length;

    if (aulasFuturas.length > 0) {
        const proximoHorario = aulasFuturas[0];
        const aluno = await getUserById(proximoHorario.aluno_id);
        proximaAula = {
            ...proximoHorario,
            aluno,
            salaId: 'geral'
        };
    }

    const aulasConcluidasEsteMes = horariosAgendados.filter(h =>
        h.dataObj < agora &&
        h.dataObj.getMonth() === mesAtual &&
        h.dataObj.getFullYear() === anoAtual
    );

    ganhosMes.total = aulasConcluidasEsteMes.length * 50;
    ganhosMes.concluidas = aulasConcluidasEsteMes.length;
    ganhosMes.futuras = aulasFuturas.length;

    const statsAvaliacao = await ComentarioModel.mediaByProfessor(user.id);
    if (statsAvaliacao.total > 0) {
        avaliacaoMedia.media = Number(statsAvaliacao.media).toFixed(1);
        avaliacaoMedia.totalAvaliacoes = statsAvaliacao.total;
        const comentarios = await ComentarioModel.findByProfessor(user.id);
        const ultimoFb = comentarios.find(c => c.texto);
        if (ultimoFb) avaliacaoMedia.ultimoFeedback = ultimoFb.texto;
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


router.get('/painel_adm', async (req, res) => {
    const professores = await ProfessorModel.findAll();
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
                    const partner = await getUserById(partnerId);

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

        let disciplinas = req.body.disciplinas || [];
        if (!Array.isArray(disciplinas)) disciplinas = [disciplinas];
        disciplinas = disciplinas.filter(d => d && d.trim() !== '');

        const updatedData = {
            nome: req.body.nome,
            email: req.body.email,
            descricao: req.body.descricao || user.descricao || '',
            link_previa: req.body.link_previa || user.link_previa || '',
            status: req.body.status || user.status || 'disponivel'
        };

        if (req.file) {
            updatedData.foto = '/imagens/uploads/' + req.file.filename;
        }

        if (isProf) {
            await ProfessorModel.update(user.id, updatedData);
            await DisciplinaModel.syncProfessor(user.id, disciplinas);
            req.session.user_prof = { ...user, ...updatedData };
        } else {
            await AlunoModel.update(user.id, { nome: updatedData.nome, email: updatedData.email });
            req.session.user_aluno = { ...user, nome: updatedData.nome, email: updatedData.email };
        }

        req.session.save(saveErr => {
            if (saveErr) {
                return res.render(renderPage, { user, erros: { general: { msg: 'Erro ao salvar.' } }, session: req.session });
            }
            res.redirect(isProf ? '/perfil_prof' : '/perfil_aluno');
        });
    });
});


router.get('/pesquisar_profs', async (req, res) => {
    const query = (req.query.query || '').trim().toLowerCase();
    let results = await ProfessorModel.findAll();
    if (query) {
        results = results.filter(p =>
            p.nome.toLowerCase().includes(query) ||
            (p.descricao && p.descricao.toLowerCase().includes(query))
        );
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

router.get('/ganhos_mes', async (req, res) => {
    const user = req.session.user_prof;
    if (!user) return res.redirect('/login');

    const agora = new Date();
    const mesAtual = agora.getMonth();
    const anoAtual = agora.getFullYear();
    const VALOR_AULA = 50;

    let movimentacoes = [];
    let resumo = {
        mes: agora.toLocaleString('pt-BR', { month: 'long', year: 'numeric' }),
        totalGanhos: 0,
        aulasConcluidas: 0,
        aulasAgendadas: 0,
        ticketMedio: 0
    };

    const horarios = await HorarioModel.findByProfessor(user.id);
    const aulasDoMes = horarios.filter(h => {
        const dataAula = new Date(`${h.data}T${h.hora_inicio}`);
        return h.status === 'agendado' && dataAula.getMonth() === mesAtual && dataAula.getFullYear() === anoAtual;
    });

    const aulasConcluidas = aulasDoMes.filter(h => new Date(`${h.data}T${h.hora_inicio}`) < agora);
    resumo.aulasConcluidas = aulasConcluidas.length;
    resumo.totalGanhos = aulasConcluidas.length * VALOR_AULA;
    resumo.aulasAgendadas = aulasDoMes.length - aulasConcluidas.length;
    resumo.ticketMedio = resumo.aulasConcluidas > 0 ? resumo.totalGanhos / resumo.aulasConcluidas : 0;

    const sorted = aulasConcluidas.sort((a, b) => new Date(`${b.data}T${b.hora_inicio}`) - new Date(`${a.data}T${a.hora_inicio}`));
    for (const h of sorted) {
        const aluno = await getUserById(h.aluno_id);
        movimentacoes.push({
            titulo: `Aula com ${aluno.nome || 'Aluno'}`,
            data: new Date(`${h.data}T${h.hora_inicio}`).toLocaleDateString('pt-BR'),
            hora: h.hora_inicio,
            valor: VALOR_AULA
        });
    }

    res.render('pages/ganhos_mes', { user, resumo, movimentacoes });
});


router.get('/feedbacks_prof', async (req, res) => {
    const user = req.session.user_prof;
    if (!user) return res.redirect('/login');

    const feedbacks = await ComentarioModel.findByProfessor(user.id);

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

router.get('/atividades', (req, res) => {
    res.render('pages/atividades');
});

router.get('/lista_atividades', (req, res) => {
    const activities = activityStore.getActivities();
    res.render('pages/lista_atividades', { activities: activities.activities });
});

router.post('/atividades', (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) {
        return res.redirect('/login');
    }

    const activities = activityStore.getActivities();
    const newActivity = req.body;
    newActivity.id = Math.random().toString(36).substring(7);
    newActivity.professorId = user.id; // Save creator's ID

    activities.activities.push(newActivity);
    activityStore.saveActivities(activities);
    res.redirect('/lista_atividades');
});

// Rota para explorar todas as atividades
router.get('/explorar_atividades', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    const activitiesData = activityStore.getActivities();

    const activities = [];
    for (const activity of activitiesData.activities) {
        const creator = await getUserById(activity.professorId);
        activities.push({
            ...activity,
            professorNome: creator ? creator.nome : 'Anônimo'
        });
    }

    res.render('pages/explorar_atividades', { 
        activities,
        user,
        session: req.session
    });
});

// Rota para ver uma atividade específica
router.get('/ver_atividade/:id', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    const activitiesData = activityStore.getActivities();
    const activity = activitiesData.activities.find(a => a.id === req.params.id);

    if (activity) {
        const creator = await getUserById(activity.professorId);
        const activityData = {
            ...activity,
            professorNome: creator ? creator.nome : 'Anônimo'
        };
        res.render('pages/ver_atividade', { 
            activity: activityData, 
            user, 
            session: req.session 
        });
    } else {
        res.redirect('/explorar_atividades');
    }
});

router.get('/nivel_escolar', (req, res) => {
    res.render('pages/nivel_escolar');
});

router.post('/gerar_atividade', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) {
        return res.redirect('/login');
    }

    const { level } = req.body;
    let prompt;

    switch (level) {
        case 'fundamental1':
            prompt = 'um exercício de matemática para o 1º ano do ensino fundamental com 10 questões de múltipla escolha.';
            break;
        case 'fundamental2':
            prompt = 'um exercício de matemática para o 2º ano do ensino fundamental com 10 questões de múltipla escolha.';
            break;
        case 'fundamental3':
            prompt = 'um exercício de matemática para o 3º ano do ensino fundamental com 10 questões de múltipla escolha.';
            break;
        case 'fundamental4':
            prompt = 'um exercício de matemática para o 4º ano do ensino fundamental com 10 questões de múltipla escolha.';
            break;
        case 'fundamental5':
            prompt = 'um exercício de matemática para o 5º ano do ensino fundamental com 10 questões de múltipla escolha.';
            break;
        case 'fundamental6':
            prompt = 'um exercício de matemática para o 6º ano do ensino fundamental com 10 questões de múltipla escolha.';
            break;
        case 'fundamental7':
            prompt = 'um exercício de matemática para o 7º ano do ensino fundamental com 10 questões de múltipla escolha.';
            break;
        case 'fundamental8':
            prompt = 'um exercício de matemática para o 8º ano do ensino fundamental com 10 questões de múltipla escolha.';
            break;
        case 'fundamental9':
            prompt = 'um exercício de matemática para o 9º ano do ensino fundamental com 10 questões de múltipla escolha.';
            break;
        case 'medio1':
            prompt = 'um exercício de matemática para o 1º ano do ensino médio com 10 questões de múltipla escolha.';
            break;
        case 'medio2':
            prompt = 'um exercício de matemática para o 2º ano do ensino médio com 10 questões de múltipla escolha.';
            break;
        case 'medio3':
            prompt = 'um exercício de matemática para o 3º ano do ensino médio com 10 questões de múltipla escolha.';
            break;
        default:
            prompt = 'um exercício de matemática com 10 questões de múltipla escolha.';
    }

    try {
        const port = process.env.APP_PORT;
        const response = await fetch(`http://localhost:${port}/ia/generate-exercise`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });

        if (!response.ok) {
            throw new Error('A resposta do servidor não foi OK.');
        }

        const data = await response.json();
        const activities = activityStore.getActivities();
        const newActivity = {
            id: Math.random().toString(36).substring(7),
            professorId: user.id,
            title: data.title || 'Atividade Gerada por IA',
            description: data.description || '',
            questions: data.questions || []
        };

        activities.activities.push(newActivity);
        activityStore.saveActivities(activities);
        res.redirect(`/ver_atividade/${newActivity.id}`);
    } catch (error) {
        console.error('Erro ao gerar exercício com IA:', error);
        res.status(500).send('Não foi possível gerar o exercício. Verifique o console para mais detalhes.');
    }
});

module.exports = router;
