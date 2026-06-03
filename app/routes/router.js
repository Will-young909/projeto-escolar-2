const express = require('express');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const router = express.Router();
const pool = require('../../config/pool');
const paymentsStore = require('../lib/paymentsStore');
const chatStore = require('../lib/chatStore');
const activityStore = require('../lib/activityStore');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const trilhaService = require('../services/trilhaService');
const GamificationService = require('../services/GamificationService');
const AnalyticsService = require('../services/AnalyticsService');
const RecomendacaoProfessorService = require('../services/RecomendacaoProfessorService');

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
    limits: { fileSize: 5 * 1024 * 1024 }
}).single('foto');

const videoStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = 'app/public/recordings';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadVideo = multer({ storage: videoStorage }).single('video');

async function getUserByEmail(email, tipo) {
    const searchEmail = email.toLowerCase();
    const table = tipo === 'aluno' ? 'alunos' : 'professores';
    try {
        const [rows] = await pool.query(`SELECT * FROM ${table} WHERE email = ?`, [searchEmail]);
        return rows[0];
    } catch (error) {
        console.error(`Erro ao buscar usuário por e-mail (${tipo}):`, error);
        return null;
    }
}

async function getUserById(id) {
    try {
        let [profRows] = await pool.query("SELECT *, 'professor' as tipo FROM professores WHERE id = ?", [id]);
        if (profRows.length > 0) {
            const professor = profRows[0];
            const [disciplinas] = await pool.query('SELECT nome FROM disciplinas WHERE professor_id = ?', [professor.id]);
            professor.disciplinas = disciplinas.map(d => d.nome);
            professor.horariosDisponiveis = [];
            return professor;
        }

        let [alunoRows] = await pool.query("SELECT *, 'aluno' as tipo FROM alunos WHERE id = ?", [id]);
        if (alunoRows.length > 0) {
            const aluno = alunoRows[0];
            aluno.agenda = [];
            aluno.notificacoes = [];
            return aluno;
        }

        return { id, nome: `Usuário ${id}`, tipo: 'desconhecido' };
    } catch (error) {
        console.error(`Erro ao buscar usuário por ID (${id}):`, error);
        return { id, nome: `Usuário ${id}`, tipo: 'desconhecido', error: 'Erro no banco de dados' };
    }
}

router.get('/chat/with/:userId', (req, res) => {
    const currentUser = req.session.user_aluno || req.session.user_prof;
    if (!currentUser) {
        return res.redirect('/login');
    }

    const partnerId = req.params.userId;
    if (currentUser.id === partnerId) {
        return res.redirect('/historico_chats');
    }

    const roomIds = [currentUser.id, partnerId].sort();
    const roomId = `chat_${roomIds[0]}-${roomIds[1]}`;

    res.redirect(`/chat/${roomId}`);
});

router.get('/', async (req, res) => {
    try {
        const [professores] = await pool.query('SELECT id, nome, foto, descricao, status FROM professores WHERE status = ? LIMIT 10', ['disponivel']);
        for (let prof of professores) {
            const [disciplinas] = await pool.query('SELECT nome FROM disciplinas WHERE professor_id = ?', [prof.id]);
            prof.disciplinas = disciplinas.map(d => d.nome);
        }
        res.render('pages/home', { professores });
    } catch (error) {
        console.error("Erro ao carregar a home page:", error);
        res.render('pages/home', { professores: [] });
    }
});

router.post('/professor/horarios', async (req, res) => {
    if (!req.session.user_prof) {
        return res.status(401).json({ success: false, message: 'Não autenticado' });
    }

    const { date, slots } = req.body;
    if (!date || !slots || !Array.isArray(slots)) {
        return res.status(400).json({ success: false, message: 'Dados incompletos ou em formato inválido.' });
    }

    const professorId = req.session.user_prof.id;

    try {
        await pool.query('START TRANSACTION');
        await pool.query('DELETE FROM horarios_disponiveis WHERE professor_id = ? AND data = ?', [professorId, date]);

        for (const slot of slots) {
            if (slot.start && slot.end && slot.price) {
                await pool.query(
                    'INSERT INTO horarios_disponiveis (professor_id, data, hora_inicio, hora_fim, preco, status) VALUES (?, ?, ?, ?, ?, ?)',
                    [professorId, date, slot.start, slot.end, slot.price, 'disponivel']
                );
            }
        }

        await pool.query('COMMIT');

        const [horariosAtualizados] = await pool.query('SELECT * FROM horarios_disponiveis WHERE professor_id = ?', [professorId]);
        req.session.user_prof.horariosDisponiveis = horariosAtualizados;

        req.session.save(err => {
            if (err) {
                console.error('Erro ao salvar sessão:', err);
                return res.status(500).json({ success: false, message: 'Erro interno ao salvar os horários.' });
            }
            res.json({ success: true, message: 'Horários salvos com sucesso!' });
        });
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Erro ao salvar horários no banco de dados:', error);
        res.status(500).json({ success: false, message: 'Erro no servidor ao salvar horários.' });
    }
});

router.post('/agendar-horario', async (req, res) => {
    if (!req.session.user_aluno) {
        return res.redirect('/login');
    }

    const { profId, horarioId } = req.body;
    const alunoId = req.session.user_aluno.id;

    try {
        const [professorRows] = await pool.query('SELECT * FROM professores WHERE id = ?', [profId]);
        if (professorRows.length === 0) {
            return res.status(404).send('Professor não encontrado.');
        }
        const professor = professorRows[0];

        const [horarioRows] = await pool.query('SELECT * FROM horarios_disponiveis WHERE id = ? AND professor_id = ? AND status = ?', [horarioId, profId, 'disponivel']);
        if (horarioRows.length === 0) {
            return res.status(404).send('Horário não disponível.');
        }
        const horario = horarioRows[0];
        const horarioIdBanco = horario.id;

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
                unit_price: parseFloat(horario.preco)
            }],
            back_urls: {
                success: "http://localhost:3000/pagamento/sucesso",
                failure: "http://localhost:3000/pagamento/erro",
                pending: "http://localhost:3000/pagamento/pendente"
            },
            auto_return: "approved",
            external_reference: JSON.stringify({ profId, horarioId: horarioIdBanco, alunoId }),
        };

        const response = await mpPreferenceClient.create({ body: preference });
        const body = response.body || response;

        res.redirect(body.init_point || body.sandbox_init_point);

    } catch (error) {
        console.error('Erro ao criar preferência de pagamento:', error);
        res.status(500).send('Falha ao iniciar o processo de pagamento.');
    }
});

router.get('/cadastro', (req, res) => {
    res.render('pages/cadastro', { erros: {}, dados: {} });
});

router.post('/cadastro', [
    body('email').isEmail().withMessage('Por favor, insira um email válido.').normalizeEmail(),
    body('nome').notEmpty().withMessage('O nome é obrigatório.'),
    body('senha').isLength({ min: 6 }).withMessage('A senha deve ter pelo menos 6 caracteres.'),
    body('confirmar').custom((value, { req }) => value === req.body.senha).withMessage('As senhas não coincidem.'),
    body('tipo').notEmpty().withMessage('Selecione um tipo (Aluno ou Professor).'),
], async (req, res) => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.render('pages/cadastro', { erros: erros.mapped(), dados: req.body });
    }

    try {
        const existingUser = await getUserByEmail(req.body.email, req.body.tipo);
        if (existingUser) {
            return res.render('pages/cadastro', {
                erros: { email: { msg: 'Este e-mail já está em uso.' } },
                dados: req.body
            });
        }

        const hashedPassword = bcrypt.hashSync(req.body.senha, 10);
        const userId = crypto.randomBytes(8).toString('hex');

        let userForSession;
        const { nome, email, tipo } = req.body;

        if (tipo === "aluno") {
            await pool.query('INSERT INTO alunos (id, nome, email, senha) VALUES (?, ?, ?, ?)', [userId, nome, email, hashedPassword]);
            userForSession = { id: userId, nome, email, tipo: 'aluno', password: hashedPassword, agenda: [], notificacoes: [] };
            req.session.user_aluno = userForSession;
        } else {
            await pool.query('INSERT INTO professores (id, nome, email, senha) VALUES (?, ?, ?, ?)', [userId, nome, email, hashedPassword]);
            userForSession = { id: userId, nome, email, tipo: 'professor', password: hashedPassword, horariosDisponiveis: [], link_previa: '', disciplinas: [], foto: '/imagens/imagem_perfil.jpg', descricao: '', status: 'disponivel' };
            req.session.user_prof = userForSession;
        }

        if (tipo === "aluno" && req.body.nivel_escolar) {
            return req.session.save(err => {
                if (err) {
                    console.error('Erro ao salvar sessão:', err);
                    return res.redirect('/');
                }
                res.redirect(`/gerar_atividade?level=${req.body.nivel_escolar}`);
            });
        }

        req.session.save(() => res.redirect('/'));

    } catch (error) {
        console.error("Erro no cadastro:", error);
        res.status(500).render('pages/cadastro', {
            erros: { general: { msg: 'Ocorreu um erro ao criar a conta. Tente novamente.' } },
            dados: req.body
        });
    }
});

router.get('/login', (req, res) => {
  res.render('pages/login', { erros: {}, dados: {} });
});

router.post('/login', [
    body('email').isEmail().withMessage('Por favor, insira um email válido.').normalizeEmail(),
    body('senha').notEmpty().withMessage('A senha é obrigatória.'),
    body('tipo').notEmpty().withMessage('Selecione um tipo (Aluno ou Professor).'),
], async (req, res) => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.render('pages/login', { erros: erros.mapped(), dados: req.body });
    }

    try {
        const { email, senha, tipo } = req.body;
        const user = await getUserByEmail(email, tipo);

        const isValidPassword = user && bcrypt.compareSync(senha, user.senha);

        if (!user || !isValidPassword) {
            return res.render('pages/login', {
                erros: { general: { msg: 'E-mail ou senha incorretos.' } },
                dados: req.body
            });
        }

        let sessionUser = {
            id: user.id,
            nome: user.nome,
            email: user.email,
            password: user.senha,
            tipo: tipo
        };

        if (tipo === "aluno") {
            sessionUser.agenda = [];
            sessionUser.notificacoes = [];
            req.session.user_aluno = sessionUser;
        } else {
            const [disciplinas] = await pool.query('SELECT nome FROM disciplinas WHERE professor_id = ?', [user.id]);
            const [horarios] = await pool.query('SELECT *, id as horarioId FROM horarios_disponiveis WHERE professor_id = ?', [user.id]);

            sessionUser = { ...sessionUser, ...user, disciplinas: disciplinas.map(d => d.nome), horariosDisponiveis: horarios, agenda: [], notificacoes: [] };
            req.session.user_prof = sessionUser;
        }

        req.session.save(() => res.redirect('/'));

    } catch (error) {
        console.error("Erro no login:", error);
        res.status(500).render('pages/login', {
            erros: { general: { msg: 'Ocorreu um erro interno. Tente novamente.' } },
            dados: req.body
        });
    }
});

router.get('/forgot', (req, res) => {
    res.render('pages/forgot_password', { erros: {}, dados: {} });
});

router.post('/forgot', [
    body('email').isEmail().withMessage('Por favor, insira um email válido.').normalizeEmail(),
    body('senha').isLength({ min: 6 }).withMessage('A senha deve ter pelo menos 6 caracteres.'),
    body('confirmar').custom((value, { req }) => value === req.body.senha).withMessage('As senhas não coincidem.'),
    body('tipo').notEmpty().withMessage('Selecione um tipo (Aluno ou Professor).'),
], async (req, res) => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.render('pages/forgot_password', { erros: erros.mapped(), dados: req.body });
    }

    try {
        const { email, senha, tipo } = req.body;
        const user = await getUserByEmail(email, tipo);

        if (!user) {
            return res.render('pages/forgot_password', {
                erros: { email: { msg: 'Nenhum usuário encontrado com este e-mail e tipo.' } },
                dados: req.body
            });
        }

        const hashedPassword = bcrypt.hashSync(senha, 10);
        const table = tipo === 'aluno' ? 'alunos' : 'professores';
        await pool.query(`UPDATE ${table} SET senha = ? WHERE id = ?`, [hashedPassword, user.id]);

        res.redirect('/login');

    } catch (error) {
        console.error('Erro na recuperação de senha:', error);
        res.status(500).render('pages/forgot_password', {
            erros: { general: { msg: 'Ocorreu um erro ao redefinir a senha.' } },
            dados: req.body
        });
    }
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

    try {
        const professor = await getUserById(req.session.user_prof.id);
        if (!professor || professor.tipo !== 'professor') {
            return res.redirect('/logout');
        }

        const [agendamentos] = await pool.query(
            `SELECT DISTINCT a.id, a.nome, a.email
             FROM agendamentos ag
             JOIN alunos a ON ag.aluno_id = a.id
             WHERE ag.professor_id = ? AND ag.status IN ('ativo', 'concluido')`,
            [professor.id]
        );

        const userParaRender = {
            ...professor,
            historicoAlunos: agendamentos
        };

        res.render('pages/perfil_prof', { user: userParaRender, session: req.session });

    } catch (error) {
        console.error('Erro ao carregar perfil do professor:', error);
        res.redirect('/logout');
    }
});


router.get('/exibir_prof/:id', async (req, res) => {
    const professorId = req.params.id;
    try {
        const professor = await getUserById(professorId);

        if (!professor || professor.tipo !== 'professor') {
            return res.redirect('/');
        }

        const [horarios] = await pool.query(
          'SELECT *, id as horarioId FROM horarios_disponiveis WHERE professor_id = ? AND data >= CURDATE() ORDER BY data, hora_inicio',
          [professorId]
        );

        const [comentarios] = await pool.query(
            'SELECT usuario_nome, texto, nota, criado_em FROM comentarios WHERE professor_id = ? ORDER BY criado_em DESC',
            [professorId]
        );

        professor.horariosDisponiveis = horarios;
        professor.comentarios = comentarios;

        const user = req.session.user_aluno || req.session.user_prof;
        res.render('pages/exibir_prof', { professor, session: req.session, user });

    } catch (error) {
        console.error(`Erro ao exibir perfil do professor ${professorId}:`, error);
        res.redirect('/');
    }
});

router.post('/cancelar-aula-prof', async (req, res) => {
    if (!req.session.user_prof) {
        return res.status(401).json({ success: false, message: 'Professor não autenticado.' });
    }

    const { agendamentoId, motivo } = req.body;
    const professorId = req.session.user_prof.id;

    try {
        const [agendamentoRows] = await pool.query(
            'SELECT * FROM agendamentos WHERE id = ? AND professor_id = ? AND status = ?',
            [agendamentoId, professorId, 'ativo']
        );

        if (agendamentoRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Agendamento não encontrado ou já cancelado.' });
        }
        const agendamento = agendamentoRows[0];

        await pool.query('START TRANSACTION');

        await pool.query('UPDATE agendamentos SET status = ? WHERE id = ?', ['cancelado', agendamentoId]);

        await pool.query('UPDATE horarios_disponiveis SET status = ?, aluno_id = NULL WHERE id = ?', ['disponivel', agendamento.horario_id]);

        const mensagem = `Sua aula com ${req.session.user_prof.nome} no dia ${agendamento.data} às ${agendamento.hora} foi cancelada. Motivo: ${motivo || 'Não especificado'}`;
        await pool.query(
            'INSERT INTO notificacoes (usuario_id, usuario_tipo, tipo, mensagem) VALUES (?, ?, ?, ?)',
            [agendamento.aluno_id, 'aluno', 'cancelamento_prof', mensagem]
        );

        await pool.query('COMMIT');

        res.json({ success: true, message: 'Aula cancelada e aluno notificado.' });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Erro ao cancelar aula (prof):', error);
        res.status(500).json({ success: false, message: 'Erro no servidor ao cancelar a aula.' });
    }
});

router.post('/cancelar-aula', async (req, res) => {
    if (!req.session.user_aluno) {
        return res.status(401).json({ success: false, message: 'Usuário não autenticado.' });
    }

    const { agendamentoId, reason } = req.body;
    const alunoId = req.session.user_aluno.id;

    try {
        const [agendamentoRows] = await pool.query(
            'SELECT * FROM agendamentos WHERE id = ? AND aluno_id = ? AND status = ?',
            [agendamentoId, alunoId, 'ativo']
        );

        if (agendamentoRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Agendamento não encontrado ou já foi cancelado.' });
        }
        const agendamento = agendamentoRows[0];

        await pool.query('START TRANSACTION');

        await pool.query('UPDATE agendamentos SET status = ? WHERE id = ?', ['cancelado', agendamentoId]);
        await pool.query('UPDATE horarios_disponiveis SET status = ?, aluno_id = NULL WHERE id = ?', ['disponivel', agendamento.horario_id]);

        const mensagem = `O aluno ${req.session.user_aluno.nome} cancelou a aula do dia ${agendamento.data} às ${agendamento.hora}. Motivo: ${reason || 'Não especificado'}`;
        await pool.query(
            'INSERT INTO notificacoes (usuario_id, usuario_tipo, tipo, mensagem) VALUES (?, ?, ?, ?)',
            [agendamento.professor_id, 'professor', 'cancelamento_aluno', mensagem]
        );

        await pool.query('COMMIT');
        res.json({ success: true, message: 'Aula cancelada com sucesso.' });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Erro ao cancelar aula (aluno):', error);
        res.status(500).json({ success: false, message: 'Erro no servidor.' });
    }
});

router.post('/alterar-senha', [
    body('current_password').notEmpty().withMessage('Informe sua senha atual.'),
    body('new_password').isLength({ min: 6 }).withMessage('A nova senha precisa ter ao menos 6 caracteres.'),
], async (req, res) => {
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

    if (!bcrypt.compareSync(current_password, user.password)) {
        return res.render(renderPage, {
            user,
            erros: { current_password: { msg: 'Senha atual incorreta.' } },
            dados: req.body
        });
    }

    try {
        const newHashedPassword = bcrypt.hashSync(new_password, 10);
        const table = isProf ? 'professores' : 'alunos';

        await pool.query(`UPDATE ${table} SET senha = ? WHERE id = ?`, [newHashedPassword, user.id]);

        user.password = newHashedPassword;

        req.session.save(err => {
            if (err) {
              console.error("Erro ao salvar sessão após mudar senha:", err);
            }
            res.redirect(isProf ? '/perfil_prof' : '/perfil_aluno');
        });

    } catch (error) {
        console.error("Erro ao alterar senha no DB:", error);
        return res.render(renderPage, {
            user,
            erros: { general: { msg: 'Erro ao alterar senha. Tente novamente.' } },
            dados: req.body
        });
    }
});

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
    if (user && user.password && bcrypt.compareSync(current_password, user.password)) {
        return res.json({ valid: true });
    }

    return res.status(400).json({ valid: false, msg: 'Senha atual incorreta.' });
});

router.post('/exibir_prof/:id/comentar', async (req, res) => {
    const professorId = req.params.id;
    const { texto, nota } = req.body;

    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');
    if (!texto || texto.trim() === '') return res.redirect(`/exibir_prof/${professorId}`);

    try {
        const notaInt = nota ? parseInt(nota, 10) : null;
        if (notaInt !== null && (notaInt < 1 || notaInt > 5)) {
           return res.redirect(`/exibir_prof/${professorId}`);
        }

        await pool.query(
            'INSERT INTO comentarios (professor_id, usuario_nome, texto, nota) VALUES (?, ?, ?, ?)',
            [professorId, user.nome, texto.trim(), notaInt]
        );

        res.redirect(`/exibir_prof/${professorId}`);
    } catch (error) {
        console.error('Erro ao salvar comentário:', error);
        res.redirect(`/exibir_prof/${professorId}`);
    }
});

router.get('/chat/:roomId', async (req, res) => {
    const { roomId } = req.params;
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');

    const roomParts = roomId.replace('chat_', '').split('-');
    const partnerId = roomParts.find(id => id !== user.id);
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

router.get("/video/:room", (req, res) => {
    const { room } = req.params;
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');
    res.render("pages/video_call", { room, user });
});

router.post('/upload_recording', (req, res) => {
    uploadVideo(req, res, async (err) => {
        if (err) {
            console.error('Erro ao fazer upload da gravação:', err);
            return res.status(500).json({ success: false, message: 'Erro ao fazer upload.' });
        }

        const { room } = req.body;
        const videoPath = `/recordings/${req.file.filename}`;

        try {
            await pool.query('UPDATE agendamentos SET gravacao_url = ? WHERE sala_id = ?', [videoPath, room]);
            res.json({ success: true, message: 'Gravação salva com sucesso!' });
        } catch (error) {
            console.error('Erro ao salvar URL da gravação no banco de dados:', error);
            res.status(500).json({ success: false, message: 'Erro ao salvar gravação no banco de dados.' });
        }
    });
});

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

    try {
        const professor = await getUserById(sessionUser.id);
        if (!professor) {
            return res.redirect('/logout');
        }

        const [agendamentos] = await pool.query(
            `SELECT ag.*, a.nome as alunoNome
             FROM agendamentos ag
             JOIN alunos a ON ag.aluno_id = a.id
             WHERE ag.professor_id = ? AND ag.status = 'ativo'
             ORDER BY ag.data, ag.hora`,
            [professor.id]
        );

        professor.agendamentos = agendamentos;

        res.render('pages/aulas', { user: professor, session: req.session });

    } catch (error) {
        console.error('Erro ao carregar a página de aulas:', error);
        res.redirect('/dashboard_prof');
    }
});

router.get('/denuncia', (req, res) => {
    res.render('pages/denuncia', { erros: {}, dados: {} });
});

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
    if (!errors.isEmpty()) {
        return res.status(422).render('pages/denuncia', { erros: errors.mapped(), dados: req.body });
    }

    try {
        const { tipo, titulo, descricao, email, evidencia, anonimo } = req.body;
        await pool.query(
            'INSERT INTO denuncias (tipo, titulo, descricao, email, evidencia, anonimo) VALUES (?, ?, ?, ?, ?, ?)',
            [tipo, titulo, descricao, anonimo ? null : email, evidencia, anonimo ? 1 : 0]
        );
        return res.redirect('/denuncia_sucesso');
    } catch (error) {
        console.error('Erro ao salvar denúncia:', error);
        const dados = req.body;
        const erros = { general: { msg: "Não foi possível registrar a denúncia. Tente novamente." } };
        return res.status(500).render('pages/denuncia', { erros, dados });
    }
  }
);

router.get('/denuncia_sucesso', (req,res)=> {
  res.render('pages/denuncia_sucesso');
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

router.get('/pagamento', (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof || { nome: 'Visitante', tipo: 'visitante' };
    res.render('pages/pagamento', { user });
});

router.get('/create_preference', async (req, res) => {
    try {
        const mpPreferenceClient = req.app.locals.mpPreferenceClient;
        if (!mpPreferenceClient) return res.status(500).json({ error: 'Mercado Pago não configurado no servidor.' });

        const preference = {
            items: [{
                title: 'Mensalidade Regimath',
                description: 'Acesso a plataforma por 30 dias',
                quantity: 1,
                currency_id: 'BRL',
                unit_price: 100
            }],
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

router.get('/pagamento/sucesso', async (req, res) => {
    const { external_reference, payment_id, status } = req.query;

    if (!external_reference) {
        return res.render('pages/pagamento_sucesso', {
            paymentId: payment_id,
            status: status,
            message: "Pagamento da assinatura concluído com sucesso!"
        });
    }

    try {
        const { profId, horarioId, alunoId } = JSON.parse(external_reference);

        await pool.query('START TRANSACTION');

        const [horarioRows] = await pool.query('SELECT * FROM horarios_disponiveis WHERE id = ? FOR UPDATE', [horarioId]);

        if (horarioRows.length === 0 || horarioRows[0].status !== 'disponivel') {
            await pool.query('ROLLBACK');
            return res.status(404).render('pages/pagamento_erro', { error: 'O horário selecionado não está mais disponível.' });
        }
        const horario = horarioRows[0];

        await pool.query('UPDATE horarios_disponiveis SET status = ?, aluno_id = ? WHERE id = ?', ['agendado', alunoId, horarioId]);

        const salaId = crypto.randomBytes(16).toString('hex');
        await pool.query(
            'INSERT INTO agendamentos (aluno_id, professor_id, horario_id, sala_id, data, hora, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [alunoId, profId, horarioId, salaId, horario.data, horario.hora_inicio, 'ativo']
        );

        const [aluno] = await pool.query('SELECT nome FROM alunos WHERE id = ?', [alunoId]);
        const mensagem = `Nova aula agendada com ${aluno[0].nome} para o dia ${horario.data} às ${horario.hora_inicio}.`;
        await pool.query(
            'INSERT INTO notificacoes (usuario_id, usuario_tipo, tipo, mensagem) VALUES (?, ?, ?, ?)',
            [profId, 'professor', 'novo_agendamento', mensagem]
        );

        await pool.query('COMMIT');

        res.render('pages/pagamento_sucesso', {
            paymentId: payment_id,
            status: status,
            message: "Agendamento concluído com sucesso!"
        });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Erro ao processar sucesso do pagamento:', error);
        res.status(500).render('pages/pagamento_erro', { error: 'Ocorreu um erro crítico ao processar seu agendamento.' });
    }
});

router.get('/pagamento/erro', (req, res) => {
    res.render('pages/pagamento_erro', {
        error: req.query.error || 'Pagamento não aprovado'
    });
});

router.get('/pagamento/pendente', (req, res) => {
    res.render('pages/pagamento_pendente', {
        paymentId: req.query.payment_id
    });
});

router.get('/dashboard_prof', async (req, res) => {
    const user = req.session.user_prof;
    if (!user) return res.redirect('/login');

    try {
        const professor = await getUserById(user.id);
        const agora = new Date();
        const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
        const proximas24h = new Date(agora.getTime() + 24 * 60 * 60 * 1000);

        const [agendamentos] = await pool.query(
            `SELECT ag.*, a.nome as alunoNome, h.preco
             FROM agendamentos ag
             JOIN alunos a ON ag.aluno_id = a.id
             JOIN horarios_disponiveis h ON ag.horario_id = h.id
             WHERE ag.professor_id = ? AND ag.status != 'cancelado'`,
            [user.id]
        );

        const aulas = agendamentos.map(ag => ({...ag, dataObj: new Date(`${ag.data}T${ag.hora}`)}));
        const aulasFuturas = aulas.filter(ag => ag.dataObj > agora).sort((a,b) => a.dataObj - b.dataObj);
        const aulasConcluidasMes = aulas.filter(ag => ag.dataObj < agora && ag.dataObj >= inicioMes);

        const aulasProximas24h = aulasFuturas.filter(ag => ag.dataObj < proximas24h).length;
        const proximaAula = aulasFuturas.length > 0 ? aulasFuturas[0] : null;

        const ganhosMes = {
            total: aulasConcluidasMes.reduce((sum, ag) => sum + parseFloat(ag.preco), 0),
            concluidas: aulasConcluidasMes.length,
            futuras: aulasFuturas.length,
        };

        const [comentarios] = await pool.query('SELECT nota, texto FROM comentarios WHERE professor_id = ?', [user.id]);
        const avaliacoesComNota = comentarios.filter(c => c.nota);
        let avaliacaoMedia = { media: 0, totalAvaliacoes: 0, ultimoFeedback: "Nenhum feedback ainda." };

        if (avaliacoesComNota.length > 0) {
            avaliacaoMedia.totalAvaliacoes = avaliacoesComNota.length;
            avaliacaoMedia.media = (avaliacoesComNota.reduce((sum, c) => sum + c.nota, 0) / avaliacoesComNota.length).toFixed(1);
            const ultimoFeedback = comentarios.filter(c => c.texto).pop();
            if (ultimoFeedback) avaliacaoMedia.ultimoFeedback = ultimoFeedback.texto;
        }

        res.render('pages/dashboard_prof', {
            user,
            professor,
            session: req.session,
            aulasProximas24h,
            proximaAula,
            ganhosMes,
            avaliacaoMedia
        });
    } catch(error) {
        console.error("Erro no dashboard do professor:", error);
        res.redirect('/logout');
    }
});


router.get('/dashboard_aluno', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) return res.redirect('/login');

    try {
        const recomendacoesProfessores = await RecomendacaoProfessorService.recomendarProfessoresParaAluno(user.id, { limite: 3 });
        res.render('pages/dashboard_aluno', { user, session: req.session, recomendacoesProfessores });
    } catch (error) {
        console.error('Erro ao carregar recomendações de professores no dashboard:', error);
        res.render('pages/dashboard_aluno', {
            user,
            session: req.session,
            recomendacoesProfessores: { focos: [], recomendacoes: [] }
        });
    }
});

router.get('/-progressomeu', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) {
        return res.redirect('/login');
    }

    try {
        const dashboardData = await AnalyticsService.getDashboardData(user.id);
        res.render('pages/meu-progresso', {
            user,
            dashboard: dashboardData,
            session: req.session
        });
    } catch (error) {
        console.error('Erro ao carregar a página de progresso do aluno:', error);
        res.status(500).send('Não foi possível carregar seus dados de progresso.');
    }
});

router.get('/painel_adm', (req, res) => {
    // Redireciona para a rota de dashboard de admin, que usa o controller e middleware corretos
    res.redirect('/admin/dashboard');
});

router.get('/historico_chats', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');

    const searchQuery = (req.query.search || '').trim().toLowerCase();

    try {
        const allMessages = await chatStore.loadMessages();
        let userChats = [];

        for (const room in allMessages) {
            if (room.startsWith('global')) continue;

            const roomParts = room.replace('chat_', '').split('-');
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

        if (searchQuery) {
            userChats = userChats.filter(chat =>
                chat.partnerName.toLowerCase().includes(searchQuery)
            );
        }

        userChats.sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));

        res.render('pages/historico_chats', {
            chats: userChats,
            user,
            searchQuery
        });

    } catch (error) {
        console.error('Erro ao carregar o histórico de chats:', error);
        res.status(500).send('Não foi possível carregar o histórico de conversas.');
    }
});

router.get('/historico_aulas', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');

    const searchQuery = (req.query.search || '').trim().toLowerCase();
    const userType = req.session.user_aluno ? 'aluno' : 'professor';

    try {
        let query;
        let params = [user.id];

        if (userType === 'aluno') {
            query = `
                SELECT a.*, p.nome as professor_nome, 'Matemática' as materia
                FROM agendamentos a
                JOIN professores p ON a.professor_id = p.id
                WHERE a.aluno_id = ? AND a.status = 'concluido'
            `;
        } else {
            query = `
                SELECT a.*, al.nome as aluno_nome, 'Matemática' as materia
                FROM agendamentos a
                JOIN alunos al ON a.aluno_id = al.id
                WHERE a.professor_id = ? AND a.status = 'concluido'
            `;
        }

        if (searchQuery) {
            query += ` AND (p.nome LIKE ? OR 'Matemática' LIKE ?)`;
            params.push(`%${searchQuery}%`, `%${searchQuery}%`);
        }

        const [aulas] = await pool.query(query, params);

        res.render('pages/historico_aulas', {
            aulas: aulas,
            user,
            searchQuery,
            session: req.session
        });

    } catch (error) {
        console.error('Erro ao carregar o histórico de aulas:', error);
        res.status(500).send('Não foi possível carregar o histórico de aulas.');
    }
});

router.get('/historico_formularios', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) {
        return res.redirect('/login');
    }

    const searchQuery = (req.query.search || '').trim().toLowerCase();

    try {
        let query = `
            SELECT t.id as tentativa_id, t.pontuacao_total, t.total_questoes, t.data_conclusao, a.titulo, a.descricao
            FROM tentativas_teste t
            JOIN atividades a ON t.atividade_id = a.id
            WHERE t.aluno_id = ?
        `;
        const params = [user.id];

        if (searchQuery) {
            query += ` AND a.titulo LIKE ?`;
            params.push(`%${searchQuery}%`);
        }

        query += ` ORDER BY t.data_conclusao DESC`;

        const [forms] = await pool.query(query, params);

        res.render('pages/historico_formularios', {
            forms: forms,
            user,
            searchQuery,
            session: req.session
        });

    } catch (error) {
        console.error('Erro ao carregar o histórico de formulários:', error);
        res.status(500).send('Não foi possível carregar o histórico de formulários.');
    }
});

router.get('/ver_resultado/:tentativa_id', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) {
        return res.redirect('/login');
    }

    const { tentativa_id } = req.params;

    try {
        const [tentativaRows] = await pool.query(
            'SELECT * FROM tentativas_teste WHERE id = ? AND aluno_id = ?',
            [tentativa_id, user.id]
        );

        if (tentativaRows.length === 0) {
            return res.status(404).send('Tentativa não encontrada ou não pertence a este usuário.');
        }
        const tentativa = tentativaRows[0];

        const [respostas] = await pool.query(
            'SELECT * FROM respostas_teste WHERE tentativa_id = ? ORDER BY id ASC',
            [tentativa_id]
        );

        const activitiesData = activityStore.getActivities();
        const atividade = activitiesData.activities.find(a => a.id === tentativa.atividade_id);

        if (!atividade) {
            return res.status(404).send('Atividade não encontrada.');
        }

        const recomendacoesProfessores = await RecomendacaoProfessorService.recomendarProfessoresParaAluno(user.id, {
            tentativaId: tentativa.id,
            limite: 3
        });

        res.render('pages/ver_resultado', {
            tentativa,
            respostas,
            atividade,
            user,
            session: req.session,
            recomendacoesProfessores
        });

    } catch (error) {
        console.error('Erro ao carregar o resultado do teste:', error);
        res.status(500).send('Não foi possível carregar o resultado do teste.');
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

router.post('/perfil/editar', (req, res) => {
    upload(req, res, async (err) => {
        const isProf = !!req.session.user_prof;
        const isAluno = !!req.session.user_aluno;
        if (!isProf && !isAluno) return res.redirect('/login');

        const user = isProf ? req.session.user_prof : req.session.user_aluno;
        const renderPage = isProf ? 'pages/editar_perfil_prof' : 'pages/editar_perfil_aluno';

        if (err) {
            return res.render(renderPage, { user, erros: { foto: { msg: err.message } }, dados: req.body, session: req.session });
        }

        await body('nome').notEmpty().withMessage('O nome é obrigatório.').run(req);
        await body('email').isEmail().withMessage('O e-mail é inválido.').run(req);

        const erros = validationResult(req);
        if (!erros.isEmpty()) {
            return res.render(renderPage, { user, erros: erros.mapped(), dados: req.body, session: req.session });
        }

        try {
            const table = isProf ? 'professores' : 'alunos';
            let disciplinas = req.body.disciplinas || [];
            if (disciplinas && !Array.isArray(disciplinas)) {
                disciplinas = [disciplinas];
            }
            disciplinas = disciplinas.filter(d => d && d.trim() !== '');

            const updatedData = {
                nome: req.body.nome,
                email: req.body.email,
            };

            if (isProf) {
                updatedData.descricao = req.body.descricao || user.descricao;
                updatedData.link_previa = req.body.link_previa || user.link_previa;
                updatedData.status = req.body.status || user.status;
                if (req.file) {
                    updatedData.foto = '/imagens/uploads/' + req.file.filename;
                }

                await pool.query('UPDATE professores SET nome=?, email=?, descricao=?, link_previa=?, status=?, foto=? WHERE id=?',
                    [updatedData.nome, updatedData.email, updatedData.descricao, updatedData.link_previa, updatedData.status, updatedData.foto || user.foto, user.id]
                );

                await pool.query('DELETE FROM disciplinas WHERE professor_id = ?', [user.id]);
                for (const d of disciplinas) {
                    await pool.query('INSERT INTO disciplinas (professor_id, nome) VALUES (?, ?)', [user.id, d]);
                }
                updatedData.disciplinas = disciplinas;

            } else {
                await pool.query('UPDATE alunos SET nome=?, email=? WHERE id=?', [updatedData.nome, updatedData.email, user.id]);
            }

            const sessionKey = isProf ? 'user_prof' : 'user_aluno';
            req.session[sessionKey] = { ...user, ...updatedData };

            req.session.save(err => {
                if (err) {
                    console.error("Erro ao salvar sessão após editar perfil:", err);
                }
                res.redirect(isProf ? '/perfil_prof' : '/perfil_aluno');
            });

        } catch(error) {
            console.error("Erro ao editar perfil:", error);
            res.render(renderPage, { user, erros: { general: { msg: 'Erro ao salvar.' } }, session: req.session });
        }
    });
});

router.get('/pesquisar_profs', async (req, res) => {
    const query = (req.query.query || '').trim().toLowerCase();
    const page = parseInt(req.query.page) || 1;
    const somenteRecomendados = req.query.recomendados === '1' && !!req.session.user_aluno;
    const itemsPerPage = somenteRecomendados ? 3 : 1;
    let recomendacoesProfessores = { focos: [], recomendacoes: [] };

    try {
        let sql = `
            SELECT p.id, p.nome, p.foto, p.descricao, p.status, GROUP_CONCAT(d.nome SEPARATOR ', ') as disciplinas
            FROM professores p
            LEFT JOIN disciplinas d ON p.id = d.professor_id
        `;
        const params = [];

        if (query) {
            sql += `
                WHERE (p.nome LIKE ? OR p.descricao LIKE ? OR d.nome LIKE ?)
            `;
            const likeQuery = `%${query}%`;
            params.push(likeQuery, likeQuery, likeQuery);
        }

        sql += ` GROUP BY p.id`;

        // Construir uma query de contagem sem o GROUP BY para obter o total real
        const countSql = sql.replace(/SELECT[\s\S]*?FROM/i, 'SELECT COUNT(DISTINCT p.id) as total FROM').replace(/\sGROUP BY[\s\S]*/i, '');
        const [countRows] = await pool.query(countSql, params);
        const totalItems = somenteRecomendados ? itemsPerPage : countRows[0].total;
        const totalPages = somenteRecomendados ? 1 : Math.ceil(totalItems / itemsPerPage);

        if (!somenteRecomendados) {
            sql += ` LIMIT ? OFFSET ?`;
            params.push(itemsPerPage, (page - 1) * itemsPerPage);
        }

        let results;

        if (somenteRecomendados) {
            recomendacoesProfessores = await RecomendacaoProfessorService.recomendarProfessoresParaAluno(req.session.user_aluno.id, { limite: itemsPerPage });
            results = recomendacoesProfessores.recomendacoes;
        } else {
            [results] = await pool.query(sql, params);

            results.forEach(prof => {
                prof.disciplinas = prof.disciplinas ? prof.disciplinas.split(', ') : [];
            });
        }

        res.render('pages/pesquisar_profs', {
            professores: results,
            query,
            session: req.session,
            currentPage: page,
            totalPages,
            url: req.path,
            somenteRecomendados,
            recomendacoesProfessores
        });

    } catch (error) {
        console.error("Erro ao pesquisar professores:", error);
        res.render('pages/pesquisar_profs', {
            professores: [],
            query,
            session: req.session,
            currentPage: 1,
            totalPages: 1,
            url: req.path,
            somenteRecomendados: false,
            recomendacoesProfessores: { focos: [], recomendacoes: [] }
        });
    }
});


router.get('/professores', (req, res) => {
    res.redirect('/pesquisar_profs?query=' + (req.query.query || ''));
});

router.get('/agenda', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) return res.redirect('/login');

    try {
        const [agendamentos] = await pool.query(
            `SELECT ag.*, p.nome as professor_nome, p.id as professor_id
             FROM agendamentos ag
             JOIN professores p ON ag.professor_id = p.id
             WHERE ag.aluno_id = ? AND ag.status = 'ativo'
             ORDER BY ag.data, ag.hora`,
            [user.id]
        );
        const agendaFormatada = agendamentos.map(ag => ({
            id: ag.id,
            professor: { id: ag.professor_id, nome: ag.professor_nome },
            salaId: ag.sala_id,
            data: ag.data,
            hora: ag.hora,
        }));

        res.render('pages/agenda', { user: { ...user, agenda: agendaFormatada }, session: req.session });
    } catch(error) {
        console.error("Erro ao carregar agenda do aluno:", error);
        res.render('pages/agenda', { user, session: req.session });
    }
});

router.get('/ganhos_mes', async (req, res) => {
    const user = req.session.user_prof;
    if (!user) return res.redirect('/login');

    const agora = new Date();
    const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1);

    try {
        const [aulasConcluidas] = await pool.query(
            `SELECT h.preco, a.nome as aluno_nome, ag.data, ag.hora
             FROM agendamentos ag
             JOIN horarios_disponiveis h ON ag.horario_id = h.id
             JOIN alunos a ON ag.aluno_id = a.id
             WHERE ag.professor_id = ?
               AND ag.status = 'concluido'
               AND ag.data >= ?
             ORDER BY ag.data DESC, ag.hora DESC`,
            [user.id, inicioMes]
        );

        const [aulasAgendadas] = await pool.query(
            'SELECT COUNT(*) as total FROM agendamentos WHERE professor_id = ? AND status = ? AND data >= ?',
            [user.id, 'ativo', agora]
        );

        let resumo = {
            mes: agora.toLocaleString('pt-BR', { month: 'long', year: 'numeric' }),
            totalGanhos: aulasConcluidas.reduce((sum, aula) => sum + parseFloat(aula.preco), 0),
            aulasConcluidas: aulasConcluidas.length,
            aulasAgendadas: aulasAgendadas[0].total,
            ticketMedio: aulasConcluidas.length > 0 ? (aulasConcluidas.reduce((sum, aula) => sum + parseFloat(aula.preco), 0) / aulasConcluidas.length) : 0
        };

        let movimentacoes = aulasConcluidas.map(aula => ({
            titulo: `Aula com ${aula.aluno_nome}` ,
            data: new Date(aula.data).toLocaleDateString('pt-BR'),
            hora: aula.hora,
            valor: parseFloat(aula.preco)
        }));

        res.render('pages/ganhos_mes', {
            user,
            resumo,
            movimentacoes
        });

    } catch(error) {
        console.error("Erro ao carregar ganhos do mês:", error);
        res.redirect('/dashboard_prof');
    }
});

router.get('/feedbacks_prof', async (req, res) => {
    const user = req.session.user_prof;
    if (!user) return res.redirect('/login');

    try {
        const [feedbacks] = await pool.query(
            'SELECT * FROM comentarios WHERE professor_id = ? ORDER BY criado_em DESC',
            [user.id]
        );

        const avaliacoesComNota = feedbacks.filter(f => f.nota);
        const totalAvaliacoes = avaliacoesComNota.length;

        const distribuicaoNotas = { 5: { count: 0 }, 4: { count: 0 }, 3: { count: 0 }, 2: { count: 0 }, 1: { count: 0 } };
        let somaNotas = 0;

        if (totalAvaliacoes > 0) {
            avaliacoesComNota.forEach(f => {
                somaNotas += f.nota;
                if (distribuicaoNotas[f.nota]) {
                    distribuicaoNotas[f.nota].count++;
                }
            });
            Object.keys(distribuicaoNotas).forEach(key => {
                distribuicaoNotas[key].percent = (distribuicaoNotas[key].count / totalAvaliacoes) * 100;
            });
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
    } catch (error) {
        console.error("Erro ao carregar feedbacks:", error);
        res.redirect('/dashboard_prof');
    }
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

router.post('/atividades', [
    body('title').notEmpty().withMessage('O título da atividade é obrigatório.'),
    body('questions').custom((questions, { req }) => {
        if (!questions) {
            throw new Error('A atividade deve ter pelo menos uma questão.');
        }
        for (const question of Object.values(questions)) {
            if (question.type === 'multiple_choice') {
                if (!question.correct) {
                    throw new Error('Cada questão de múltipla escolha deve ter uma resposta correta.');
                }
            } else if (question.type === 'short_text' || question.type === 'long_text') {
                if (!question.correctAnswer || question.correctAnswer.trim() === '') {
                    throw new Error('Cada questão de resposta curta ou parágrafo deve ter um gabarito.');
                }
            }
        }
        return true;
    })
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) {
        return res.redirect('/login');
    }

    const newActivity = req.body;
    const activities = activityStore.getActivities();
    newActivity.id = Math.random().toString(36).substring(7);
    newActivity.professorId = user.id;

    activities.activities.push(newActivity);
    activityStore.saveActivities(activities);
    res.redirect('/lista_atividades');
});

router.get('/explorar_atividades', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    const activitiesData = activityStore.getActivities();

    const activities = await Promise.all(activitiesData.activities
        .filter(activity => !activity.isTest)
        .map(async (activity) => {
            const creator = await getUserById(activity.professorId);
            return {
                ...activity,
                professorNome: creator ? creator.nome : 'Anônimo'
            };
        })
    );

    res.render('pages/explorar_atividades', {
        activities,
        user,
        session: req.session
    });
});


router.get('/ver_atividade/:id', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    const activitiesData = activityStore.getActivities();
    const activity = activitiesData.activities.find(a => a.id === req.params.id);

    if (activity) {
        const creatorId = activity.isTest ? activity.alunoId : activity.professorId;
        const creator = await getUserById(creatorId);

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

router.post('/submit-test/:activityId', async (req, res) => {
    const { activityId } = req.params;
    const user = req.session.user_aluno;
    if (!user) return res.redirect('/login');

    const activitiesData = activityStore.getActivities();
    const activity = activitiesData.activities.find(a => a.id === activityId);
    if (!activity || !activity.isTest) return res.status(404).send('Teste não encontrado.');

    const userAnswers = req.body.answers;
    let score = 0;
    const totalQuestions = activity.questions.length;
    const questionIds = [];

    try {
        await pool.query('START TRANSACTION');

        const [existingActivity] = await pool.query('SELECT id FROM atividades WHERE id = ?', [activityId]);
        if (existingActivity.length === 0) {
            await pool.query('INSERT INTO atividades (id, titulo, descricao) VALUES (?, ?, ?)', [activityId, activity.title, activity.description]);

            for (const q of activity.questions) {
                let habilidadeId = null;
                if (q.habilidade) {
                    const [habilidadeResult] = await pool.query('INSERT INTO habilidades (codigo, descricao) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)', [q.habilidade, q.habilidade]);
                    habilidadeId = habilidadeResult.insertId;
                }

                const [result] = await pool.query(
                    'INSERT INTO questoes (atividade_id, enunciado, alternativa_a, alternativa_b, alternativa_c, alternativa_d, resposta, habilidade_id, dificuldade) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [activityId, q.text || q.question || q.enunciado, q.options[0], q.options[1], q.options[2], q.options[3], q.correct, habilidadeId, q.dificuldade]
                );
                questionIds.push(result.insertId);
            }
        } else {
            const [existingQuestions] = await pool.query('SELECT id FROM questoes WHERE atividade_id = ?', [activityId]);
            existingQuestions.forEach(q => questionIds.push(q.id));
        }

        activity.questions.forEach((question, index) => {
            if (userAnswers[index] && userAnswers[index].toLowerCase() === question.correct.toLowerCase()) {
                score++;
            }
        });

        const pontuacao_total = (score / totalQuestions) * 100;

        const [result] = await pool.query(
            'INSERT INTO tentativas_teste (aluno_id, atividade_id, tipo, pontuacao_total, total_questoes) VALUES (?, ?, ?, ?, ?)',
            [user.id, activityId, 'diagnostico', pontuacao_total, totalQuestions]
        );
        const tentativaId = result.insertId;

        for (let i = 0; i < totalQuestions; i++) {
            const question = activity.questions[i];
            const userAnswer = userAnswers[i];
            const isCorrect = userAnswer && userAnswer.toLowerCase() === question.correct.toLowerCase();
            const questionId = questionIds[i];

            if (questionId) {
                await pool.query(
                    'INSERT INTO respostas_teste (tentativa_id, questao_id, resposta_marcada, acertou) VALUES (?, ?, ?, ?)',
                    [tentativaId, questionId, userAnswer, isCorrect ? 1 : 0]
                );
            }
        }

        await trilhaService.gerarTrilhaDaTentativa({ alunoId: user.id, tentativaId });

        await pool.query('COMMIT');
        res.redirect('/trilha');
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Erro ao submeter o teste e gerar a trilha:', error);
        res.status(500).send('Erro ao processar o teste.');
    }
});

router.get('/nivel_escolar', (req, res) => {
    res.render('pages/nivel_escolar');
});

router.get('/gerar_atividade', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) {
        return res.redirect('/login');
    }

    const { level } = req.query;
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
            prompt = 'um exercício de matemática para o 5º ano do ensino fundamental com 3 questões de múltipla escolha.';
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

        const questions = (data.questions || []).map(q => ({
            title: q.title,
            text: q.title,
            options: Object.values(q.options || {}),
            correct: q.correct,
            habilidade: q.habilidade,
            dificuldade: q.dificuldade
        }));

        const newActivity = {
            id: Math.random().toString(36).substring(7),
            alunoId: user.id,
            isTest: true,
            title: data.title || 'Teste de Nivelamento',
            description: data.description || 'Este é um teste para avaliar seu conhecimento.',
            questions: questions
        };

        activities.activities.push(newActivity);
        activityStore.saveActivities(activities);
        res.redirect(`/ver_atividade/${newActivity.id}`);
    } catch (error) {
        console.error('Erro ao gerar exercício com IA:', error);
        res.status(500).send('Não foi possível gerar o exercício. Verifique o console para mais detalhes.');
    }
});

router.get('/trilha', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) {
        return res.redirect('/login');
    }

    try {
        const tarefa = await trilhaService.iniciarTrilhaParaAluno(user.id);

        if (tarefa.tarefaTipo === 'CONCLUIDO') {
            // MODIFICADO: Renderiza a página de conclusão em vez de redirecionar
            return res.render('pages/trilha_concluida');
        }

        res.render('pages/trilha', {
            user,
            tarefa: tarefa,
            session: req.session
        });

    } catch (error) {
        console.error('Erro ao carregar a trilha de exercícios:', error);
        res.status(500).send('Erro ao carregar a trilha de exercícios.');
    }
});

router.post('/trilha/responder', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) {
        return res.redirect('/login');
    }

    const { item_id, resposta } = req.body;
    const tempoResposta = 15;

    try {
        if (!item_id || !resposta) {
            console.warn("Tentativa de resposta sem item_id ou resposta.", { body: req.body });
            return res.redirect('/trilha');
        }

        const resultado = await trilhaService.processarRespostaEProximaQuestao(
            user.id,
            item_id,
            resposta,
            tempoResposta
        );

        GamificationService.registrarAtividade(user.id);

        if (resultado.acertou) {
            GamificationService.concederXpPorAcerto(user.id);
        }

        res.redirect('/trilha');

    } catch (error) {
        console.error('Erro ao responder item da trilha:', error);
        res.status(500).send('Erro ao processar sua resposta.');
    }
});

router.post('/webhook/mercadopago', express.json(), async (req, res) => {
    try {
      const { type, data } = req.body;

      if (type === 'payment') {
        const paymentId = data.id;
        const paymentRes = await mpPaymentClient.get({ id: paymentId });
        const payment = paymentRes || {};

        if (payment.status === 'approved') {
          const prefId = payment.external_reference || payment.preference_id;
          let room = payment.metadata?.room;

          if (!room && prefId) {
            const storedPref = await paymentsStore.getByPreferenceId(prefId);
            if (storedPref) room = storedPref.room;
          }

          if (room) {
            io.to(room).emit('paymentConfirmed', {
              id: paymentId,
              prefId,
              amount: payment.transaction_amount || 0,
              payer: payment.payer?.email || 'Pagador Desconhecido',
              status: payment.status,
              time: Date.now()
            });

            await paymentsStore.updateByPreferenceId(prefId, { status: payment.status });
          }
        }
      }
      res.sendStatus(200);
    } catch (err) {
      console.error('Webhook MP error', err?.message || err);
      res.sendStatus(500);
    }
});

module.exports = router;
