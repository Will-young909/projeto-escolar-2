
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
const { buildMercadoPagoPreference } = require('../services/mercadoPagoPreferenceBuilder');
const trilhaService = require('../services/trilhaService');
const GamificationService = require('../services/GamificationService');
const AnalyticsService = require('../services/AnalyticsService');
const RecomendacaoProfessorService = require('../services/RecomendacaoProfessorService');
const AdminDenunciaController = require('../controllers/AdminDenunciaController');
const FeedbackService = require('../services/FeedbackService');
const ActivityLimitService = require('../services/ActivityLimitService');
const PasseEstudoService = require('../services/PasseEstudoService');

const { execFile } = require('child_process');

// ffprobe empacotado (já é dependência transitiva do projeto).
// Nada de PATH global: usamos o binário do @ffprobe-installer.
let FFPROBE_BIN = 'ffprobe';
try {
    // eslint-disable-next-line global-require
    FFPROBE_BIN = require('@ffprobe-installer/ffprobe').path;
} catch (e) {
    console.warn('Aviso: @ffprobe-installer/ffprobe não encontrado, usando ffprobe do PATH.');
}

/**
 * Mede a duração de um vídeo via ffprobe (sem depender de get-video-duration,
 * cuja cadeia execa/ESM quebra no Node atual com ERR_REQUIRE_ESM).
 * Retorna segundos (float) ou lança erro se não for possível medir.
 *
 * Estratégia:
 *  1) Tenta o metadado format=duration (rápido, funciona p/ mp4 e webm corrigido).
 *  2) Se vier N/A (webm do MediaRecorder sem cabeçalho de duração), conta os
 *     frames de vídeo e estima pela taxa de captura da composição (24 fps).
 */
async function getVideoDuration(filePath) {
    const run = (args) => new Promise((resolve, reject) => {
        execFile(FFPROBE_BIN, args, { timeout: 60000 }, (error, stdout, stderr) => {
            if (error) return reject(error);
            resolve(String(stdout || '').trim());
        });
    });

    // 1) Metadado do container.
    try {
        const raw = await run([
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ]);
        const duration = parseFloat(raw);
        if (duration && !isNaN(duration) && duration > 0) {
            return duration;
        }
    } catch (e) {
        console.warn(`Aviso: ffprobe (format) falhou para ${filePath}:`, e.message);
    }

    // 2) Contagem de frames (webm do MediaRecorder informa avg_frame_rate 0/0,
    //    mas nb_read_frames é confiável). A composição grava a 24 fps.
    const frameCountRaw = await run([
        '-v', 'error',
        '-select_streams', 'v:0',
        '-count_frames',
        '-show_entries', 'stream=nb_read_frames',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath
    ]);
    const frames = parseInt(String(frameCountRaw).trim(), 10);
    if (frames && !isNaN(frames) && frames > 0) {
        return frames / 24;
    }

    throw new Error(`ffprobe não conseguiu medir a duração de ${filePath}`);
}

const storage = multer.memoryStorage();

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
        // As gravações ficam em área privada (fora de app/public), nunca servidas
        // diretamente pelo express.static. O acesso sempre passa por /gravacao/stream/:id
        // que valida autenticação e vínculo com a aula.
        const dir = path.join(__dirname, '..', 'private', 'recordings');
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

// ---------------------------------------------------------------------------
// Gravações: diretórios, resolução de arquivo e controle de acesso.
// ---------------------------------------------------------------------------

const RECORDINGS_DIR = path.join(__dirname, '..', 'private', 'recordings');

// Diretório legado (usado antes da área privada). Apenas leitura para
// compatibilidade: gravações antigas ainda podem ser acessadas com autenticação.
const LEGACY_RECORDINGS_DIR = path.join(__dirname, '..', 'public', 'recordings');

const GRAVACAO_STATUS = Object.freeze({
    PROCESSANDO: 'processando',
    DISPONIVEL: 'disponivel',
    FALHOU: 'falhou',
    INDISPONIVEL: 'indisponivel'
});

/**
 * Converte um caminho relativo armazenado no banco (que pode estar nos
 * formatos 'recordings/arquivo.webm', '/recordings/arquivo.webm' ou apenas
 * 'arquivo.webm') no caminho absoluto do arquivo em disco.
 *
 * Usamos apenas o basename para impedir path traversal — o nome do arquivo
 * é sempre gerado pelo servidor.
 */
function resolveRecordingFile(relPath) {
    if (!relPath || typeof relPath !== 'string') return null;

    const base = path.basename(relPath.replace(/\\/g, '/'));
    if (!base || !/^[\w.-]+\.(webm|mp4|mov)$/i.test(base)) return null;

    const privatePath = path.join(RECORDINGS_DIR, base);
    if (fs.existsSync(privatePath)) return privatePath;

    const legacyPath = path.join(LEGACY_RECORDINGS_DIR, base);
    if (fs.existsSync(legacyPath)) return legacyPath;

    return null;
}

/**
 * Verifica se o usuário autenticado tem relação com o agendamento
 * (aluno ou professor daquela aula) ou é um administrador autorizado.
 */
function hasRecordingAccess(req, agendamento) {
    if (!req.session) return false;
    if (req.session.user_admin && req.session.user_admin.id) return true;

    const user = req.session.user_aluno || req.session.user_prof;
    if (!user || !user.id) return false;

    const userId = String(user.id);
    return (
        String(agendamento.aluno_id) === userId ||
        String(agendamento.professor_id) === userId
    );
}

/**
 * Formata uma duração em segundos para 'MMm SSs' (ex.: 12m 05s).
 */
function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${String(s).padStart(2, '0')}s`;
}

async function getUserByEmail(email) {
    const searchEmail = email.toLowerCase();
    try {
        const [alunoRows] = await pool.query(`SELECT *, 'aluno' as tipo FROM alunos WHERE email = ?`, [searchEmail]);
        if (alunoRows.length > 0) return alunoRows[0];
        
        const [profRows] = await pool.query(`SELECT *, 'professor' as tipo FROM professores WHERE email = ?`, [searchEmail]);
        if (profRows.length > 0) return profRows[0];

        return null;
    } catch (error) {
        console.error(`Erro ao buscar usuário por e-mail:`, error);
        return null;
    }
}

const activityNormalizer = require('../utils/activityNormalizer');

async function ensureActivityPersisted(activity, creatorId = null) {
    const normalizedQuestions = activityNormalizer.normalizeActivityQuestions(activity);
    const activityId = activity.id;

    const [existingActivity] = await pool.query('SELECT id FROM atividades WHERE id = ?', [activityId]);
    if (existingActivity.length === 0) {
        await pool.query(
            'INSERT INTO atividades (id, professor_id, titulo, descricao) VALUES (?, ?, ?, ?)',
            [activityId, creatorId || activity.professorId || null, activity.title || 'Atividade', activity.description || null]
        );
    }

    const [existingQuestions] = await pool.query('SELECT id, resposta FROM questoes WHERE atividade_id = ? ORDER BY id ASC', [activityId]);
    if (existingQuestions.length >= normalizedQuestions.length) {
        // Re-sincroniza o gabarito caso versões anteriores tenham gravado resposta vazia
        // para questões escritas (correção retroativa de dados já persistidos).
        for (let i = 0; i < normalizedQuestions.length; i++) {
            const q = normalizedQuestions[i];
            const optionEntries = q.options ? Object.entries(q.options) : [];
            const expectedResposta = q.options ? (q.correct || optionEntries[0]?.[0] || '') : (q.correctAnswer || '');
            const existingRow = existingQuestions[i];
            if (existingRow && String(existingRow.resposta || '') !== String(expectedResposta)) {
                await pool.query('UPDATE questoes SET resposta = ? WHERE id = ?', [expectedResposta, existingRow.id]);
            }
        }
        return { activity: { ...activity, questions: normalizedQuestions }, questionIds: existingQuestions.map(q => q.id) };
    }

    if (existingQuestions.length > 0) {
        await pool.query('DELETE FROM questoes WHERE atividade_id = ?', [activityId]);
    }

    const questionIds = [];
    for (const q of normalizedQuestions) {
        let habilidadeId = null;
        if (q.habilidade) {
            const [habilidadeResult] = await pool.query(
                'INSERT INTO habilidades (codigo, descricao) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)',
                [q.habilidade, q.habilidade]
            );
            habilidadeId = habilidadeResult.insertId;
        }

        const optionEntries = q.options ? Object.entries(q.options) : [];
        const resposta = q.options ? (q.correct || optionEntries[0]?.[0] || '') : (q.correctAnswer || '');
        const [result] = await pool.query(
            'INSERT INTO questoes (atividade_id, enunciado, alternativa_a, alternativa_b, alternativa_c, alternativa_d, resposta, habilidade_id, dificuldade) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                activityId,
                q.text,
                optionEntries[0]?.[1] || null,
                optionEntries[1]?.[1] || null,
                optionEntries[2]?.[1] || null,
                optionEntries[3]?.[1] || null,
                resposta,
                habilidadeId,
                q.dificuldade || 'facil'
            ]
        );
        questionIds.push(result.insertId);
    }

    return { activity: { ...activity, questions: normalizedQuestions }, questionIds };
}

function normalizeAnswers(answers) {
    if (!answers) return [];
    if (Array.isArray(answers)) return answers;
    return Object.keys(answers).sort((a, b) => Number(a) - Number(b)).map(key => answers[key]);
}

async function getUserById(id, withRelations = true) {
    try {
        let [profRows] = await pool.query("SELECT *, 'professor' as tipo FROM professores WHERE id = ?", [id]);
        if (profRows.length > 0) {
            const professor = profRows[0];
            if (withRelations) {
                const [disciplinas] = await pool.query('SELECT nome FROM disciplinas WHERE professor_id = ?', [professor.id]);
                professor.disciplinas = disciplinas.map(d => d.nome);
                professor.horariosDisponiveis = [];
                 const [notificacoes] = await pool.query('SELECT * FROM notificacoes WHERE usuario_id = ? AND usuario_tipo = ? AND link_relacionado IS NOT NULL ORDER BY criado_em DESC', [id, 'professor']);
                professor.notificacoes = notificacoes;
            }
            return professor;
        }

        let [alunoRows] = await pool.query("SELECT *, 'aluno' as tipo FROM alunos WHERE id = ?", [id]);
        if (alunoRows.length > 0) {
            const aluno = alunoRows[0];
            if (withRelations) {
                 const [agendamentos] = await pool.query(`SELECT ag.*, p.nome as professor_nome, p.id as professor_id FROM agendamentos ag JOIN professores p ON ag.professor_id = p.id WHERE ag.aluno_id = ? AND ag.status = 'ativo' ORDER BY ag.data, ag.hora`, [id]);
                aluno.agenda = agendamentos.map(ag => ({ id: ag.id, professor: { id: ag.professor_id, nome: ag.professor_nome }, salaId: ag.sala_id, data: (ag.data instanceof Date ? `${ag.data.getFullYear()}-${String(ag.data.getMonth() + 1).padStart(2, '0')}-${String(ag.data.getDate()).padStart(2, '0')}` : String(ag.data)), hora: String(ag.hora) }));

                const [notificacoes] = await pool.query('SELECT * FROM notificacoes WHERE usuario_id = ? AND usuario_tipo = ? AND link_relacionado IS NOT NULL ORDER BY criado_em DESC', [id, 'aluno']);
                aluno.notificacoes = notificacoes;
            }
            return aluno;
        }

        return { id, nome: `Usuário ${id}`, tipo: 'desconhecido' };
    } catch (error) {
        console.error(`Erro ao buscar usuário por ID (${id}):`, error);
        return { id, nome: `Usuário ${id}`, tipo: 'desconhecido', error: 'Erro no banco de dados' };
    }
}

async function handleActivitySubmission(req, res) {
    const { activityId } = req.params;
    const user = req.session.user_aluno;
    if (!user) return res.redirect('/login');

    const hintsUnlocked = req.session.unlockedHintsFor && req.session.unlockedHintsFor[activityId];

    let usouPasse = false;
    if (hintsUnlocked) {
        usouPasse = true;
    } else {
        const limiteDiario = await ActivityLimitService.getContagemAtividadesHoje(user.id);
        if (limiteDiario.limiteAtingido) {
            const passe = await PasseEstudoService.verificarPasseAtivo(user.id);
            if (passe.passeAtivo) {
                usouPasse = true;
                if (passe.tipo === 'quantidade') {
                    await PasseEstudoService.consumirAtividadePasse(user.id);
                }
            } else {
                return res.redirect('/explorar_atividades');
            }
        }
    }

    const activitiesData = activityStore.getActivities();
    const activity = activitiesData.activities.find(a => a.id === activityId);
    if (!activity) return res.status(404).send('Formulário não encontrado.');

    const userAnswers = normalizeAnswers(req.body.answers);

    try {
        await pool.query('START TRANSACTION');

        const { activity: normalizedActivity, questionIds } = await ensureActivityPersisted(activity, activity.professorId || null);
        const totalQuestions = normalizedActivity.questions.length;
        let score = 0;

        normalizedActivity.questions.forEach((question, index) => {
            if (activityNormalizer.isAnswerCorrect(question, userAnswers[index])) score++;
        });

        const pontuacao_total = totalQuestions > 0 ? (score / totalQuestions) * 100 : 0;
        const tipoTentativa = normalizedActivity.isTest ? 'diagnostico' : 'checkpoint';

        const [result] = await pool.query(
            'INSERT INTO tentativas_teste (aluno_id, atividade_id, tipo, pontuacao_total, total_questoes, acertos, erros, data_conclusao, trilha_gerada, usou_passe) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)',
            [user.id, activityId, tipoTentativa, pontuacao_total, totalQuestions, score, totalQuestions - score, normalizedActivity.isTest ? 0 : 1, usouPasse]
        );
        const tentativaId = result.insertId;

        for (let i = 0; i < totalQuestions; i++) {
            const question = normalizedActivity.questions[i];
            const userAnswer = userAnswers[i] || '';
            const isCorrect = activityNormalizer.isAnswerCorrect(question, userAnswer);
            const questionId = questionIds[i];

            if (questionId) {
                await pool.query(
                    'INSERT INTO respostas_teste (tentativa_id, questao_id, resposta_marcada, acertou) VALUES (?, ?, ?, ?)',
                    [tentativaId, questionId, userAnswer, isCorrect ? 1 : 0]
                );
            }
        }

        await pool.query('COMMIT');

        if (req.session.unlockedHintsFor && req.session.unlockedHintsFor[activityId]) {
            delete req.session.unlockedHintsFor[activityId];
            req.session.save();
        }

        if (normalizedActivity.isTest) {
            return res.redirect('/trilha');
        }
        res.redirect(`/ver_resultado/${tentativaId}`);

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Erro ao submeter formulário:', error);
        res.status(500).send('Erro ao processar o formulário.');
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
        const [professores] = await pool.query('SELECT id, nome, foto_perfil, descricao, status FROM professores WHERE status = ? LIMIT 10', ['disponivel']);
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
        await pool.query("DELETE FROM horarios_disponiveis WHERE professor_id = ? AND data = ? AND status IN ('disponivel', 'cancelado')", [professorId, date]);

        for (const slot of slots) {
            if (slot.start && slot.end && Number(slot.price) > 0) {
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
        const siteUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;

        if (!mpPreferenceClient || !process.env.MP_ACCESS_TOKEN) {
            const reference = encodeURIComponent(JSON.stringify({ profId, horarioId: horarioIdBanco, alunoId }));
            return res.redirect(`/pagamento/sucesso?external_reference=${reference}&status=approved&dev_checkout=1`);
        }

        const preference = buildMercadoPagoPreference({
            items: [{
                title: `Aula com ${professor.nome}`,
                description: `Agendamento para ${horario.data} às ${horario.hora_inicio}`,
                quantity: 1,
                currency_id: 'BRL',
                unit_price: parseFloat(horario.preco)
            }],
            siteUrl,
            successUrl: `${siteUrl}/pagamento/sucesso`,
            failureUrl: `${siteUrl}/pagamento/erro`,
            pendingUrl: `${siteUrl}/pagamento/pendente`,
            external_reference: JSON.stringify({ profId, horarioId: horarioIdBanco, alunoId }),
        });

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
            userForSession = { id: userId, nome, email, tipo: 'professor', password: hashedPassword, horariosDisponiveis: [], link_previa: '', disciplinas: [], foto_perfil: null, descricao: '', status: 'disponivel' };
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
], async (req, res) => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.render('pages/login', { erros: erros.mapped(), dados: req.body });
    }

    try {
        const { email, senha } = req.body;
        const user = await getUserByEmail(email);

        if (!user || !bcrypt.compareSync(senha, user.senha)) {
            return res.render('pages/login', {
                erros: { general: { msg: 'E-mail ou senha incorretos.' } },
                dados: req.body
            });
        }

        if (user.tipo === 'aluno') {
            if (user.status === 'banido') {
                return res.render('pages/login', {
                    erros: { general: { msg: 'Esta conta foi banida permanentemente.' } },
                    dados: req.body
                });
            }
            if (user.status === 'suspenso') {
                if (user.suspenso_ate && new Date(user.suspenso_ate) > new Date()) {
                    const dataFim = new Date(user.suspenso_ate).toLocaleDateString('pt-BR');
                    return res.render('pages/login', {
                        erros: { general: { msg: `Esta conta está suspensa até ${dataFim}.` } },
                        dados: req.body
                    });
                } else {
                    await pool.query('UPDATE alunos SET status = \'ativo\', suspenso_ate = NULL WHERE id = ?', [user.id]);
                }
            }
        }

        if (user.tipo === 'professor') {
            if (user.aprovacao_status === 'banned') {
                return res.render('pages/login', {
                    erros: { general: { msg: 'Esta conta foi banida permanentemente.' } },
                    dados: req.body
                });
            }
            if (user.aprovacao_status === 'suspended') {
                if (user.suspenso_ate && new Date(user.suspenso_ate) > new Date()) {
                    const dataFim = new Date(user.suspenso_ate).toLocaleDateString('pt-BR');
                    return res.render('pages/login', {
                        erros: { general: { msg: `Esta conta está suspensa até ${dataFim}.` } },
                        dados: req.body
                    });
                } else {
                    await pool.query('UPDATE professores SET aprovacao_status = \'approved\', suspenso_ate = NULL WHERE id = ?', [user.id]);
                }
            }
        }

        let sessionUser = {
            id: user.id,
            nome: user.nome,
            email: user.email,
            password: user.senha,
            tipo: user.tipo,
            foto_perfil: user.foto_perfil
        };

        if (user.tipo === "aluno") {
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


router.get('/perfil_aluno', async (req, res) => {
    if (!req.session.user_aluno) {
        return res.redirect('/login');
    }
    try {
        const alunoId = req.session.user_aluno.id;
        const [professores] = await pool.query(
            `SELECT DISTINCT p.id, p.nome, p.email, p.foto_perfil
             FROM agendamentos ag
             JOIN professores p ON ag.professor_id = p.id
             WHERE ag.aluno_id = ? AND ag.status IN ('ativo', 'concluido')`,
            [alunoId]
        );

        res.render('pages/perfil_aluno', { 
            user: req.session.user_aluno, 
            session: req.session,
            historicoProfessores: professores
        });

    } catch (error) {
        console.error('Erro ao carregar perfil do aluno:', error);
        res.redirect('/dashboard_aluno');
    }
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
          'SELECT h.*, a.nome as alunoNome, h.id as horarioId FROM horarios_disponiveis h LEFT JOIN alunos a ON h.aluno_id = a.id WHERE h.professor_id = ? AND h.data >= CURDATE() ORDER BY h.data, h.hora_inicio',
          [professorId]
        );

        const [comentarios] = await pool.query(
            'SELECT c.id, c.aluno_id, c.usuario_nome AS usuario, c.texto, c.nota, c.criado_em AS data FROM comentarios c WHERE c.professor_id = ? ORDER BY c.criado_em DESC',
            [professorId]
        );

        professor.horariosDisponiveis = horarios;
        professor.comentarios = comentarios;
        const avaliacoes = comentarios.filter(c => c.nota);
        professor.num_avaliacoes = avaliacoes.length;
        professor.avaliacao_media = avaliacoes.length
            ? (avaliacoes.reduce((sum, c) => sum + Number(c.nota), 0) / avaliacoes.length).toFixed(1)
            : '0.0';

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

router.get('/api/user-type/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'ID do usuário não fornecido' });
    }
    try {
        const user = await getUserById(id, false); // false para não buscar relações
        if (user && (user.tipo === 'professor' || user.tipo === 'aluno')) {
            res.json({ tipo: user.tipo });
        } else {
            res.status(404).json({ error: 'Usuário não encontrado ou tipo inválido' });
        }
    } catch (error) {
        console.error(`Erro ao buscar tipo do usuário ${id}:`, error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
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
            'INSERT INTO comentarios (professor_id, aluno_id, usuario_nome, texto, nota) VALUES (?, ?, ?, ?, ?)',
            [professorId, req.session.user_aluno ? user.id : null, user.nome, texto.trim(), notaInt]
        );

        res.redirect(`/exibir_prof/${professorId}`);
    } catch (error) {
        console.error('Erro ao salvar comentário:', error);
        res.redirect(`/exibir_prof/${professorId}`);
    }
});

router.post('/feedback/responder', async (req, res) => {
    if (!req.session.user_prof) {
        return res.status(401).json({ success: false, message: 'Apenas professores podem responder.' });
    }

    const { feedbackId, alunoId, responseText } = req.body;
    const professor = req.session.user_prof;

    try {
        const result = await FeedbackService.responderFeedback({
            feedbackId,
            alunoId,
            responseText,
            professorId: professor.id,
            professorNome: professor.nome
        });
        res.status(201).json({ success: true, message: 'Resposta enviada com sucesso!', data: result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Erro interno ao salvar a resposta.' });
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

router.get("/video/:room", async (req, res) => {
    const { room } = req.params;
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');

    try {
        const column = req.session.user_aluno ? 'aluno_id' : 'professor_id';
        const [agendamentoRows] = await pool.query(
            `SELECT ag.id, ag.aluno_id, ag.professor_id, a.nome AS aluno_nome, p.nome AS professor_nome
             FROM agendamentos ag
             JOIN alunos a ON ag.aluno_id = a.id
             JOIN professores p ON ag.professor_id = p.id
             WHERE ag.sala_id = ? AND ag.${column} = ? AND ag.status = 'ativo'
             LIMIT 1`,
            [room, user.id]
        );

        // 1) Aula agendada ativa: fluxo normal (nomes da aula, gravação no histórico).
        if (agendamentoRows.length > 0) {
            const agendamento = agendamentoRows[0];
            const ehAluno = !!req.session.user_aluno;

            // Nomes dos participantes para a composição da gravação (sem pedir novamente).
            return res.render("pages/video_call", {
                room,
                user,
                nomeLocal: ehAluno ? agendamento.aluno_nome : agendamento.professor_nome,
                papelLocal: ehAluno ? 'Aluno' : 'Professor',
                nomeRemoto: ehAluno ? agendamento.professor_nome : agendamento.aluno_nome,
                papelRemoto: ehAluno ? 'Professor' : 'Aluno',
                salaLivre: false
            });
        }

        // 2) Sala livre vinda do chat (chat_<id>-<id>): permite entrar sem agendamento.
        //    O usuário precisa fazer parte da sala; a gravação é local/efêmera
        //    (não vinculada ao histórico de aulas).
        if (typeof room === 'string' && room.startsWith('chat_')) {
            const partes = room.replace('chat_', '').split('-');
            if (!partes.includes(String(user.id))) {
                return res.status(403).send('Você não participa desta conversa.');
            }
            const parceiroId = partes.find((id) => id !== String(user.id));
            let parceiroNome = 'Parceiro';
            try {
                const parceiro = await getUserById(parceiroId, false);
                if (parceiro && parceiro.nome) parceiroNome = parceiro.nome;
            } catch (e) { /* mantém fallback */ }

            const ehAluno = !!req.session.user_aluno;
            return res.render("pages/video_call", {
                room,
                user,
                nomeLocal: user.nome || 'Você',
                papelLocal: ehAluno ? 'Aluno' : 'Professor',
                nomeRemoto: parceiroNome,
                papelRemoto: ehAluno ? 'Professor' : 'Aluno',
                salaLivre: true
            });
        }

        return res.status(403).send('Aula não encontrada ou não autorizada.');
    } catch (error) {
        console.error('Erro ao validar acesso à videochamada:', error);
        res.status(500).send('Não foi possível abrir a sala de aula.');
    }
});

router.get('/video-duration', async (req, res) => {
    // Mantido para compatibilidade com o histórico antigo (fallback do front-end).
    // Agora restrito a usuários autenticados e limitado ao diretório de gravações.
    const user = req.session.user_aluno || req.session.user_prof || req.session.user_admin;
    if (!user || !user.id) {
        return res.status(401).json({ error: 'Autenticação necessária.' });
    }

    const { video_path } = req.query;
    if (!video_path) {
        return res.status(400).json({ error: 'Parâmetro video_path não encontrado' });
    }

    // Impede path traversal: apenas o nome do arquivo dentro de recordings é aceito.
    const base = path.basename(String(video_path).replace(/\\/g, '/'));
    if (!base) {
        return res.status(400).json({ error: 'Caminho de vídeo inválido' });
    }

    const fullPath = path.join(LEGACY_RECORDINGS_DIR, base);

    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0) {
        return res.json({ duration: 0 });
    }

    try {
        const duration = await getVideoDuration(fullPath);
        res.json({ duration: Math.round(duration) });
    } catch (error) {
        // Um erro aqui significa que o arquivo existe, mas está corrompido ou em um formato inesperado.
        // Em vez de quebrar, registramos um aviso e retornamos 0 para o front-end.
        console.warn(`Aviso: Não foi possível obter a duração do vídeo em ${fullPath}. O arquivo pode estar corrompido.`, error);
        res.json({ duration: 0 });
    }
});

router.post('/upload_recording', (req, res) => {
    uploadVideo(req, res, async (err) => {
        if (err) {
            console.error('Erro ao fazer upload da gravação:', err);
            return res.status(500).json({ success: false, message: 'Erro ao fazer upload.' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Nenhum arquivo de vídeo enviado.' });
        }

        const { room } = req.body;
        const user = req.session.user_aluno || req.session.user_prof;

        if (!user || !user.id) {
            fs.unlink(req.file.path, () => {});
            return res.status(401).json({ success: false, message: 'Usuário não autenticado.' });
        }

        if (!room) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ success: false, message: 'Sala não informada.' });
        }

        try {
            // Sala livre (chat_X-Y): sem agendamento, sem histórico.
            // Apenas descarta o arquivo temporário e confirma o fim da chamada.
            const ehSalaLivre = typeof room === 'string' && room.startsWith('chat_');
            if (ehSalaLivre) {
                fs.unlink(req.file.path, () => {});
                return res.json({ success: true, salaLivre: true, message: 'Chamada livre encerrada.' });
            }

            const [agendamentos] = await pool.query(
                `SELECT * FROM agendamentos WHERE sala_id = ? ORDER BY id DESC LIMIT 1`,
                [room]
            );

            if (agendamentos.length === 0) {
                fs.unlink(req.file.path, () => {});
                return res.status(404).json({ success: false, message: 'Aula não encontrada.' });
            }

            const agendamento = agendamentos[0];

            // Apenas o aluno ou o professor daquela aula podem enviar a gravação.
            const userId = String(user.id);
            const podeEnviar =
                String(agendamento.aluno_id) === userId ||
                String(agendamento.professor_id) === userId;

            if (!podeEnviar) {
                fs.unlink(req.file.path, () => {});
                return res.status(403).json({ success: false, message: 'Você não participou desta aula.' });
            }

            const arquivoRelativo = `recordings/${req.file.filename}`;
            const tamanho = req.file.size || (fs.statSync(req.file.path).size || 0);

            // 1) Registra a gravação como PROCESSANDO na área privada.
            await pool.query(
                `UPDATE agendamentos
                 SET gravacao_url = NULL,
                     gravacao_path = ?,
                     gravacao_status = ?,
                     gravacao_tamanho = ?
                 WHERE sala_id = ?`,
                [arquivoRelativo, GRAVACAO_STATUS.PROCESSANDO, tamanho, room]
            );

            // 2) Processa: mede a duração real do arquivo.
            // O MediaRecorder não escreve duração no cabeçalho do webm, então o
            // ffprobe pode retornar N/A mesmo com o arquivo íntegro. Nesse caso
            // usamos a duração real medida no cliente (duracao_ms) como fallback.
            // Só marcamos FALHOU quando nem o arquivo nem o cliente dão duração.
            // Fontes de duracao (ordem de confianca):
            //  1) comp_frames/comp_elapsed_ms: frames desenhados no canvas pelo
            //     compositor (fps real = frames / elapsed). Reflete o video final.
            //  2) duracao_ms: relogio de parede do navegador (start->stop).
            //  3) ffprobe: metadado do container ou contagem de frames / 24.
            function numBody(v) {
                if (v == null) return 0;
                const n = Number(String(v).replace(',', '.'));
                return (n > 0 && isFinite(n)) ? n : 0;
            }
            const compFrames = numBody(req.body && req.body.comp_frames);
            const compElapsedSec = numBody(req.body && req.body.comp_elapsed_ms) / 1000;
            let clientDurationSec = numBody(req.body && req.body.duracao_ms) / 1000;
            if (compFrames > 0 && compElapsedSec > 0) {
                const fpsReal = compFrames / compElapsedSec;
                if (fpsReal > 1 && fpsReal <= 60) {
                    clientDurationSec = compFrames / fpsReal;
                }
            }
            try {
                let duration = 0;
                try {
                    duration = await getVideoDuration(req.file.path);
                } catch (ffprobeError) {
                    console.warn(`Aviso: ffprobe sem duração para ${req.file.path}, tentando fallback do cliente:`, ffprobeError.message);
                }

                // Cliente (video final real) tem prioridade sobre a estimativa
                // do servidor: o webm do MediaRecorder nao traz metadado e a
                // contagem de frames assume 24fps fixos.
                if (clientDurationSec > 0) {
                    duration = clientDurationSec;
                }

                if (!duration || duration <= 0 || isNaN(duration)) {
                    throw new Error(`Duração inválida medida para ${req.file.path}`);
                }

                await pool.query(
                    `UPDATE agendamentos
                     SET gravacao_duracao = ?, gravacao_status = ?
                     WHERE sala_id = ?`,
                    [Math.round(duration), GRAVACAO_STATUS.DISPONIVEL, room]
                );

                res.json({ success: true, message: 'Gravação processada e disponível no histórico!' });
            } catch (processError) {
                // Arquivo corrompido ou formato não reconhecido: registra falha.
                console.warn(`Aviso: não foi possível processar a gravação ${req.file.path}:`, processError);

                await pool.query(
                    `UPDATE agendamentos SET gravacao_status = ? WHERE sala_id = ?`,
                    [GRAVACAO_STATUS.FALHOU, room]
                );

                res.json({
                    success: false,
                    message: 'A gravação foi recebida, mas não pôde ser processada.',
                    falhou: true
                });
            }
        } catch (dbError) {
            console.error('Erro ao salvar a gravação no banco de dados:', dbError);
            fs.unlink(req.file.path, () => {});
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
            `SELECT ag.*, ag.sala_id AS salaId, a.id AS aluno_id, a.nome as alunoNome
             FROM agendamentos ag
             JOIN alunos a ON ag.aluno_id = a.id
             WHERE ag.professor_id = ? AND ag.status = 'ativo'
             ORDER BY ag.data, ag.hora`,
            [professor.id]
        );

        professor.agenda = agendamentos.map(ag => ({
            id: ag.id,
            aluno: { id: ag.aluno_id, nome: ag.alunoNome },
            salaId: ag.salaId || ag.sala_id,
            data: (ag.data instanceof Date ? `${ag.data.getFullYear()}-${String(ag.data.getMonth() + 1).padStart(2, '0')}-${String(ag.data.getDate()).padStart(2, '0')}` : String(ag.data)),
            hora: String(ag.hora),
            assunto: ag.assunto || 'Matemática'
        }));

        res.render('pages/aulas', { user: professor, session: req.session });

    } catch (error) {
        console.error('Erro ao carregar a página de aulas:', error);
        res.redirect('/dashboard_prof');
    }
});

router.get('/ver_gravacao/:id', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) {
        return res.redirect('/login');
    }

    const agendamentoId = req.params.id;

    if (!/^\d+$/.test(agendamentoId)) {
        return res.status(400).render('pages/ver_gravacao', { aula: null, acessoNegado: false });
    }

    try {
        const [agendamentoRows] = await pool.query(
            `SELECT a.*,
                    al.nome AS aluno_nome,
                    p.nome AS professor_nome,
                    h.hora_inicio,
                    h.hora_fim,
                    'Matemática' AS materia
             FROM agendamentos a
             JOIN alunos al ON a.aluno_id = al.id
             JOIN professores p ON a.professor_id = p.id
             JOIN horarios_disponiveis h ON a.horario_id = h.id
             WHERE a.id = ?
             LIMIT 1`,
            [agendamentoId]
        );

        if (agendamentoRows.length === 0) {
            return res.status(404).render('pages/ver_gravacao', { aula: null, acessoNegado: false });
        }

        const agendamento = agendamentoRows[0];

        // Controle de acesso: aluno da aula, professor da aula ou administrador.
        if (!hasRecordingAccess(req, agendamento)) {
            return res.status(403).render('pages/ver_gravacao', { aula: null, acessoNegado: true });
        }

        // Normaliza o estado da gravação. Aulas de clientes antigos podem ter
        // gravacao_url preenchida sem gravacao_status — tratamos como disponível.
        let status = agendamento.gravacao_status;
        if (!status) {
            status = agendamento.gravacao_url ? GRAVACAO_STATUS.DISPONIVEL : GRAVACAO_STATUS.INDISPONIVEL;
        }

        const aula = {
            id: agendamento.id,
            materia: agendamento.materia || 'Matemática',
            professorNome: agendamento.professor_nome,
            alunoNome: agendamento.aluno_nome,
            data: agendamento.data,
            horaInicio: agendamento.hora_inicio,
            horaFim: agendamento.hora_fim,
            statusAula: agendamento.status,
            gravacaoStatus: status,
            duracaoFormatada: formatDuration(agendamento.gravacao_duracao),
            tamanhoMB: agendamento.gravacao_tamanho
                ? (agendamento.gravacao_tamanho / (1024 * 1024)).toFixed(1)
                : null,
            podeAssistir: status === GRAVACAO_STATUS.DISPONIVEL,
            usuarioEhAluno: !!(req.session.user_aluno && req.session.user_aluno.id)
        };

        res.render('pages/ver_gravacao', { aula, acessoNegado: false });
    } catch (error) {
        console.error('Erro ao buscar gravação:', error);
        res.status(500).render('pages/ver_gravacao', { aula: null, acessoNegado: false });
    }
});

/**
 * Streaming seguro da gravação.
 *
 * A gravação nunca é servida por arquivo estático. Toda reprodução passa por
 * esta rota, que exige autenticação e vínculo com a aula. Suporta Range
 * requests (necessário para seek no player HTML5) via res.sendFile.
 */
router.get('/gravacao/stream/:id', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof || req.session.user_admin;
    if (!user || !user.id) {
        return res.status(401).json({ error: 'Autenticação necessária.' });
    }

    const agendamentoId = req.params.id;
    if (!/^\d+$/.test(agendamentoId)) {
        return res.status(400).json({ error: 'Identificador inválido.' });
    }

    try {
        const [agendamentoRows] = await pool.query(
            'SELECT * FROM agendamentos WHERE id = ? LIMIT 1',
            [agendamentoId]
        );

        if (agendamentoRows.length === 0) {
            return res.status(404).json({ error: 'Aula não encontrada.' });
        }

        const agendamento = agendamentoRows[0];

        // Aluno/professor da aula ou administrador autorizado.
        if (!hasRecordingAccess(req, agendamento)) {
            return res.status(403).json({ error: 'Você não tem permissão para acessar esta gravação.' });
        }

        if (agendamento.gravacao_status === GRAVACAO_STATUS.PROCESSANDO) {
            return res.status(202).json({ error: 'Gravação ainda em processamento.' });
        }

        if (agendamento.gravacao_status === GRAVACAO_STATUS.FALHOU) {
            return res.status(422).json({ error: 'A gravação não pôde ser processada.' });
        }

        if (agendamento.gravacao_status === GRAVACAO_STATUS.INDISPONIVEL &&
            !agendamento.gravacao_url) {
            return res.status(404).json({ error: 'Gravação indisponível.' });
        }

        // Resolve o arquivo na área privada (com fallback para a área legada).
        const filePath = resolveRecordingFile(agendamento.gravacao_path || agendamento.gravacao_url);

        if (!filePath) {
            return res.status(404).json({ error: 'Arquivo de gravação não encontrado.' });
        }

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        res.setHeader('Content-Disposition', 'inline');

        res.sendFile(filePath, {
            acceptRanges: true,
            maxAge: 0,
            immutable: false
        }, (sendError) => {
            if (sendError && !res.headersSent) {
                res.status(404).json({ error: 'Arquivo de gravação não encontrado.' });
            }
        });
    } catch (error) {
        console.error('Erro ao servir a gravação:', error);
        res.status(500).json({ error: 'Erro interno ao acessar a gravação.' });
    }
});

router.get('/denuncia', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    const { denunciado_id, conteudo_tipo, conteudo_id } = req.query;
    let denunciado = null;

    if (denunciado_id) {
        denunciado = await getUserById(denunciado_id);
    }

    res.render('pages/denuncia', {
        erros: {},
        dados: {
            denunciado_id,
            conteudo_tipo,
            conteudo_id,
            denunciado_nome: denunciado ? denunciado.nome : ''
        },
        user,
        denunciado
    });
});

router.post('/denuncia',
  [
    body('tipo').notEmpty().withMessage('O tipo de denúncia é obrigatório.'),
    body('titulo').trim().isLength({ min: 5 }).withMessage('O título deve ter ao menos 5 caracteres.'),
    body('descricao').trim().isLength({ min: 10 }).withMessage('A descrição deve ter ao menos 10 caracteres.'),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('E-mail inválido.'),
    body('evidencia').optional({ checkFalsy: true }).isURL().withMessage('Link de evidência inválido.'),
    body('anonimo').optional().toBoolean(),
    body('denunciado_id').optional().trim(),
    body('conteudo_tipo').optional().trim(),
    body('conteudo_id').optional().trim()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    const user = req.session.user_aluno || req.session.user_prof;
    const { denunciado_id, conteudo_tipo, conteudo_id } = req.body;

    if (!errors.isEmpty()) {
        const denunciado = denunciado_id ? await getUserById(denunciado_id) : null;
        return res.status(422).render('pages/denuncia', { 
            erros: errors.mapped(), 
            dados: { ...req.body, denunciado_nome: denunciado ? denunciado.nome : '' }, 
            user, 
            denunciado 
        });
    }

    try {
        const { tipo, titulo, descricao, email, evidencia, anonimo } = req.body;
        const isAnonimo = anonimo || !user;
        const denuncianteId = isAnonimo ? null : user.id;
        const emailDenunciante = isAnonimo ? email : (user ? user.email : email);
        
        const conteudoInfo = conteudo_tipo && conteudo_id ? JSON.stringify({ tipo: conteudo_tipo, id: conteudo_id }) : null;

        const prioridade = tipo === 'seguranca' || tipo === 'assédio' ? 'alta' : 'baixa';
        
        const [result] = await pool.query(
            'INSERT INTO denuncias (denunciante_id, denunciado_id, tipo, titulo, descricao, conteudo_info, email, evidencia, anonimo, prioridade, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [denuncianteId, denunciado_id || null, tipo, titulo, descricao, conteudoInfo, emailDenunciante, evidencia || null, isAnonimo, prioridade, 'aberta']
        );

        await pool.query(
            'INSERT INTO denuncia_historico (denuncia_id, acao, detalhes) VALUES (?, ?, ?)',
            [result.insertId, 'Criação', 'Denúncia enviada pelo formulário.']
        );

        return res.redirect('/denuncia_sucesso');
    } catch (error) {
        console.error('Erro ao salvar denúncia:', error);
        const dados = req.body;
        const erros = { general: { msg: "Não foi possível registrar a denúncia. Tente novamente." } };
        const denunciado = denunciado_id ? await getUserById(denunciado_id) : null;
        return res.status(500).render('pages/denuncia', { 
            erros, 
            dados: { ...dados, denunciado_nome: denunciado ? denunciado.nome : '' }, 
            user, 
            denunciado 
        });
    }
  }
);

router.get('/denuncia_sucesso', (req,res)=> {
  const user = req.session.user_aluno || req.session.user_prof;
  res.render('pages/denuncia_sucesso', { user });
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

const passesDeEstudo = {
    quantidade_10: { title: 'Passe de Estudos (+10 Atividades)', price: 10.00 },
    diario: { title: 'Passe de Estudos (Diário)', price: 15.00 },
    semanal: { title: 'Passe de Estudos (Semanal)', price: 25.00 }
};

async function createPassePreference(req, res, passeTipo) {
    if (!req.session.user_aluno) {
        return res.redirect('/login');
    }

    const passeInfo = passesDeEstudo[passeTipo];
    if (!passeInfo) {
        return res.status(404).send('Tipo de passe não encontrado.');
    }

    const alunoId = req.session.user_aluno.id;
    const mpPreferenceClient = req.app.locals.mpPreferenceClient;
    const siteUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;

    if (!mpPreferenceClient || !process.env.MP_ACCESS_TOKEN) {
        const reference = encodeURIComponent(JSON.stringify({ passeTipo, alunoId }));
        return res.redirect(`/pagamento/sucesso?external_reference=${reference}&status=approved&dev_checkout=1`);
    }

    try {
        const preference = buildMercadoPagoPreference({
            items: [{
                title: passeInfo.title,
                description: `Acesso extra para a plataforma RegiMath`,
                quantity: 1,
                currency_id: 'BRL',
                unit_price: passeInfo.price
            }],
            siteUrl,
            successUrl: `${siteUrl}/pagamento/sucesso`,
            failureUrl: `${siteUrl}/pagamento/erro`,
            pendingUrl: `${siteUrl}/pagamento/pendente`,
            external_reference: JSON.stringify({ passeTipo, alunoId }),
        });

        const response = await mpPreferenceClient.create({ body: preference });
        const body = response.body || response;
        res.redirect(body.init_point || body.sandbox_init_point);

    } catch (error) {
        console.error('Erro ao criar preferência de pagamento para passe de estudos:', error);
        res.status(500).send('Falha ao iniciar o processo de pagamento.');
    }
}

router.get('/comprar-passe/quantidade_10', (req, res) => createPassePreference(req, res, 'quantidade_10'));
router.get('/comprar-passe/diario', (req, res) => createPassePreference(req, res, 'diario'));
router.get('/comprar-passe/semanal', (req, res) => createPassePreference(req, res, 'semanal'));


router.get('/pagamento/sucesso', async (req, res) => {
    const { external_reference, payment_id, status } = req.query;
    
    if (!external_reference) {
        return res.render('pages/pagamento_sucesso', {
            paymentId: payment_id,
            status: status,
            message: "Pagamento concluído com sucesso!"
        });
    }

    try {
        const data = JSON.parse(decodeURIComponent(external_reference));

        if (data.passeTipo && data.alunoId) {
            await PasseEstudoService.adicionarPasse(data.alunoId, data.passeTipo);
            const passeInfo = passesDeEstudo[data.passeTipo];

            return res.render('pages/pagamento_sucesso', {
                paymentId: payment_id,
                status: status,
                message: `Compra do ${passeInfo.title} realizada com sucesso! Você já pode usar seus benefícios.`
            });
        }

        if (data.profId && data.horarioId && data.alunoId) {
            await pool.query('START TRANSACTION');

            const [horarioRows] = await pool.query('SELECT * FROM horarios_disponiveis WHERE id = ? FOR UPDATE', [data.horarioId]);

            if (horarioRows.length === 0 || horarioRows[0].status !== 'disponivel') {
                await pool.query('ROLLBACK');
                return res.status(404).render('pages/pagamento_erro', { error: 'O horário selecionado não está mais disponível.' });
            }
            const horario = horarioRows[0];

            const [agendamentoExistente] = await pool.query('SELECT id FROM agendamentos WHERE horario_id = ? AND status = ?', [data.horarioId, 'ativo']);
            if (agendamentoExistente.length > 0) {
                await pool.query('ROLLBACK');
                return res.status(409).render('pages/pagamento_erro', { error: 'Este horário já possui um agendamento ativo.' });
            }

            await pool.query('UPDATE horarios_disponiveis SET status = ?, aluno_id = ? WHERE id = ?', ['agendado', data.alunoId, data.horarioId]);

            const salaId = crypto.randomBytes(16).toString('hex');
            await pool.query(
                'INSERT INTO agendamentos (aluno_id, professor_id, horario_id, sala_id, data, hora, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [data.alunoId, data.profId, data.horarioId, salaId, horario.data, horario.hora_inicio, 'ativo']
            );

            const [aluno] = await pool.query('SELECT nome FROM alunos WHERE id = ?', [data.alunoId]);
            const [professor] = await pool.query('SELECT nome FROM professores WHERE id = ?', [data.profId]);
            const mensagemProfessor = `Nova aula agendada com ${aluno[0].nome} para o dia ${horario.data} às ${horario.hora_inicio}.`;
            const mensagemAluno = `Sua aula com ${professor[0].nome} foi agendada para o dia ${horario.data} às ${horario.hora_inicio}.`;
            await pool.query(
                'INSERT INTO notificacoes (usuario_id, usuario_tipo, tipo, mensagem) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
                [data.profId, 'professor', 'novo_agendamento', mensagemProfessor, data.alunoId, 'aluno', 'novo_agendamento', mensagemAluno]
            );

            await pool.query('COMMIT');

            return res.render('pages/pagamento_sucesso', {
                paymentId: payment_id,
                status: status,
                message: "Agendamento da aula concluído com sucesso!"
            });
        }

        throw new Error('Referência externa inválida.');

    } catch (error) {
        console.error('Erro ao processar sucesso do pagamento:', error);
        res.status(500).render('pages/pagamento_erro', { error: 'Ocorreu um erro crítico ao processar sua compra.' });
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
    const sessionUser = req.session.user_prof;
    if (!sessionUser) return res.redirect('/login');

    try {
        const user = await getUserById(sessionUser.id, true); 
        
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
            professor: user, 
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
    const sessionUser = req.session.user_aluno;
    if (!sessionUser) return res.redirect('/login');

    try {
        const user = await getUserById(sessionUser.id, true);

        const [comentarios] = await pool.query(
            'SELECT nota FROM comentarios WHERE aluno_id = ? AND nota IS NOT NULL',
            [user.id]
        );

        let mediaAvaliacoes = 0;
        if (comentarios.length > 0) {
            const somaNotas = comentarios.reduce((acc, c) => acc + c.nota, 0);
            mediaAvaliacoes = (somaNotas / comentarios.length).toFixed(1);
        }

        const recomendacoesProfessores = await RecomendacaoProfessorService.recomendarProfessoresParaAluno(user.id, { limite: 3 });
        
        res.render('pages/dashboard_aluno', { 
            user, 
            session: req.session, 
            recomendacoesProfessores,
            mediaAvaliacoes
        });

    } catch (error) {
        console.error('Erro ao carregar o dashboard do aluno:', error);
        const user = sessionUser;
        user.notificacoes = [];
        res.render('pages/dashboard_aluno', {
            user,
            session: req.session,
            recomendacoesProfessores: { focos: [], recomendacoes: [] },
            mediaAvaliacoes: 0
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
                SELECT a.*, p.nome as professor_nome, 'Matemática' as materia, h.hora_inicio, h.hora_fim
                FROM agendamentos a
                JOIN professores p ON a.professor_id = p.id
                JOIN horarios_disponiveis h ON a.horario_id = h.id
                WHERE a.aluno_id = ? AND a.status = 'concluido'
            `;
        } else {
            query = `
                SELECT a.*, al.nome as aluno_nome, 'Matemática' as materia, h.hora_inicio, h.hora_fim
                FROM agendamentos a
                JOIN alunos al ON a.aluno_id = al.id
                JOIN horarios_disponiveis h ON a.horario_id = h.id
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
            SELECT t.id as tentativa_id, t.tipo, t.pontuacao_total, t.total_questoes,
                   COALESCE(t.data_conclusao, t.criado_em) AS data_conclusao,
                   COALESCE(a.titulo, CONCAT('Formulário ', t.atividade_id)) AS titulo,
                   COALESCE(a.descricao, 'Formulário concluído') AS descricao
            FROM tentativas_teste t
            LEFT JOIN atividades a ON t.atividade_id = a.id
            WHERE t.aluno_id = ?
        `;
        const params = [user.id];

        if (searchQuery) {
            query += ` AND COALESCE(a.titulo, t.atividade_id) LIKE ?`;
            params.push(`%${searchQuery}%`);
        }

        query += ` ORDER BY COALESCE(t.data_conclusao, t.criado_em) DESC`;

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

router.post('/api/passe/ativar-para-resultado', async (req, res) => {
    if (!req.session.user_aluno) {
        return res.status(401).json({ success: false, message: 'Usuário não autenticado.' });
    }

    const { tentativaId } = req.body;
    const user = req.session.user_aluno;

    try {
        const passe = await PasseEstudoService.verificarPasseAtivo(user.id);
        if (!passe.passeAtivo) {
            return res.status(403).json({ success: false, message: 'Nenhum passe de estudos ativo encontrado.' });
        }

        if (passe.tipo === 'quantidade') {
            await PasseEstudoService.consumirAtividadePasse(user.id);
        }

        await pool.query('UPDATE tentativas_teste SET usou_passe = TRUE WHERE id = ? AND aluno_id = ?', [tentativaId, user.id]);

        res.json({ success: true, message: 'Passe ativado para este resultado!' });

    } catch (error) {
        console.error('Erro ao ativar passe para resultado:', error);
        res.status(500).json({ success: false, message: 'Erro no servidor ao ativar o passe.' });
    }
});

async function getAttemptDetails(tentativaId, userId) {
    const [tentativaRows] = await pool.query(
        'SELECT * FROM tentativas_teste WHERE id = ? AND aluno_id = ?',
        [tentativaId, userId]
    );
    if (tentativaRows.length === 0) return null;

    const tentativa = tentativaRows[0];

    const [respostas] = await pool.query(
        `SELECT rt.*, q.enunciado, q.alternativa_a, q.alternativa_b, q.alternativa_c, q.alternativa_d, q.resposta, q.explicacao
         FROM respostas_teste rt
         JOIN questoes q ON q.id = rt.questao_id
         WHERE rt.tentativa_id = ? ORDER BY rt.id ASC`,
        [tentativaId]
    );

    const [atividadeRows] = await pool.query('SELECT * FROM atividades WHERE id = ?', [tentativa.atividade_id]);
    const atividadeBase = atividadeRows[0] || {};

    // Fonte original da atividade (JSON) para recuperar gabaritos de questões escritas
    // quando o banco tiver sido populado por versões anteriores com resposta vazia.
    let originalQuestions = [];
    try {
        const storedActivity = activityStore.getActivities().activities.find(a => String(a.id) === String(tentativa.atividade_id));
        if (storedActivity) {
            originalQuestions = activityNormalizer.normalizeActivityQuestions(storedActivity);
        }
    } catch (error) {
        originalQuestions = [];
    }

    const atividade = {
        ...atividadeBase,
        questions: respostas.map((r, index) => {
            // Only create options object for multiple choice questions
            const hasOptions = r.alternativa_a || r.alternativa_b || r.alternativa_c || r.alternativa_d;
            const options = hasOptions ? { 
                A: r.alternativa_a, 
                B: r.alternativa_b, 
                C: r.alternativa_c, 
                D: r.alternativa_d 
            } : null;

            // Converte índice numérico -> letra apenas em questões de múltipla escolha.
            // Em questões escritas, o gabarito numérico (ex.: "120") precisa ser preservado.
            let correctKey = r.resposta;
            if (hasOptions) {
                const correctIndex = parseInt(correctKey, 10);
                if (!isNaN(correctIndex) && String(correctIndex) === correctKey && correctIndex >= 1) {
                    correctKey = String.fromCharCode(64 + correctIndex);
                }
            }

            const sourceQuestion = originalQuestions[index] || {};

            return {
                text: r.enunciado,
                type: hasOptions ? 'multiple_choice' : (sourceQuestion.type || 'short_text'),
                options: options,
                correct: correctKey,
                correctAnswer: hasOptions
                    ? (r.explicacao || (options[correctKey] || correctKey))
                    : (r.explicacao || r.resposta || sourceQuestion.correctAnswer || '')
            };
        })
    };

    return { tentativa, respostas, atividade };
}


router.get('/api/resultado/:tentativaId/explicacao/:questionIndex', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) return res.status(401).json({ message: 'Não autenticado' });

    const { tentativaId, questionIndex } = req.params;
    const details = await getAttemptDetails(tentativaId, user.id);

    if (!details || !details.tentativa.usou_passe) {
        return res.status(403).json({ message: 'Acesso não permitido. Ative um passe de estudos.' });
    }

    const question = details.atividade.questions[questionIndex];
    const userAnswer = details.respostas[questionIndex];

    if (!question || userAnswer.acertou) {
        return res.status(400).json({ message: 'Não há erro para explicar nesta questão.' });
    }

    const optionsText = Object.entries(question.options).map(([k, v]) => `${k}) ${v}`).join(', ');
    const prompt = `
        Aja como um tutor de IA chamado Regi, especialista em matemática.
        Sua tarefa é fornecer uma explicação clara e didática sobre um erro que um aluno cometeu em uma atividade.
        
        **Contexto da Atividade:**
        - **Questão:** "${question.text}"
        - **Opções:** ${optionsText}
        - **Resposta Correta:** Alternativa "${question.correct}"
        - **Resposta do Aluno:** Alternativa "${userAnswer.resposta_marcada}"
        
        **Sua Resposta:**
        - Explique detalhadamente por que a resposta do aluno está **incorreta**.
        - Explique o conceito matemático necessário para resolver a questão corretamente.
        - Mostre o passo-a-passo para chegar na **resposta certa**.
        - Mantenha um tom amigável, encorajador e didático.
        - Sua resposta DEVE ser apenas o texto da explicação. Não crie um novo exercício, não adicione "Título" ou "Descrição" no texto.
        - Formate sua resposta em um JSON com uma única chave chamada "description", contendo o texto da explicação.
    `;

    try {
        const port = process.env.APP_PORT || 3000;
        const response = await fetch(`http://localhost:${port}/ia/generate-exercise`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt }),
        });

        if (!response.ok) throw new Error(await response.text());

        const data = await response.json();
        
        res.json({ explicacao: data.description || "Não foi possível gerar uma explicação no momento." });

    } catch (error) {
        console.error('Erro ao gerar explicação com IA:', error);
        res.status(500).json({ message: 'Falha ao gerar explicação.' });
    }
});

router.post('/atividades/gerar-com-ia', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) {
        return res.status(401).json({ message: 'Usuário não autenticado.' });
    }

    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
        return res.status(400).json({ message: 'A descrição da atividade é muito curta ou inválida.' });
    }

    try {
        const passe = await PasseEstudoService.verificarPasseAtivo(user.id);
        if (!passe.passeAtivo) {
            return res.status(403).json({ message: 'Você precisa de um Passe de Estudos ativo para gerar atividades com IA.' });
        }

        if (passe.tipo === 'quantidade') {
            await PasseEstudoService.consumirAtividadePasse(user.id);
        }

        const iaPrompt = `Crie um exercício de matemática com base na seguinte solicitação de um aluno: "${prompt}". O exercício deve estar no formato JSON esperado, com "title", "description" e uma lista de "questions", onde cada questão tem "options" como um array de strings e "correct" como o índice da resposta correta.`;

        const port = process.env.APP_PORT || 3000;
        const response = await fetch(`http://localhost:${port}/ia/generate-exercise`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: iaPrompt }),
        });

        if (!response.ok) {
            throw new Error('A IA não conseguiu gerar a atividade. Tente um prompt diferente.');
        }

        const data = await response.json();
        
        const normalizedQuestions = activityNormalizer.normalizeActivityQuestions({ questions: data.questions || [] });

        const activities = activityStore.getActivities();

        const newActivity = {
            id: crypto.randomBytes(8).toString('hex'),
            alunoId: user.id,
            isTest: false,
            title: data.title || 'Atividade Gerada por IA',
            description: data.description || `Criado a partir do prompt: "${prompt.substring(0, 50)}..."`,
            questions: normalizedQuestions, 
            professorNome: user.nome 
        };

        activities.activities.push(newActivity);
        activityStore.saveActivities(activities);

        res.status(201).json({ activityId: newActivity.id });

    } catch (error) {
        console.error('Erro ao gerar atividade com IA:', error);
        res.status(500).json({ message: error.message || 'Falha ao se comunicar com o serviço de IA.' });
    }
});

router.post('/api/resultado/:tentativaId/chat', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) return res.status(401).json({ message: 'Não autenticado' });

    const { tentativaId } = req.params;
    const { messages } = req.body;
    const details = await getAttemptDetails(tentativaId, user.id);

    if (!details || !details.tentativa.usou_passe) {
        return res.status(403).json({ message: 'Acesso não permitido. Ative um passe de estudos.' });
    }

    const lastUserMessage = messages[messages.length - 1].content;

    const prompt = `
        Aja como um tutor de IA chamado Regi. Você é amigável, um especialista em matemática e está ajudando um aluno a tirar dúvidas sobre uma atividade que ele acabou de fazer.
        
        **Contexto:**
        - **Atividade:** "${details.atividade.titulo}"
        - **Desempenho do Aluno:** Acertou ${details.tentativa.acertos} de ${details.tentativa.total_questoes} questões.
        - **Histórico da conversa:** \n${messages.slice(0, -1).map(m => `${m.role}: ${m.content}`).join('\n')}

        **Sua Tarefa:**
        - Sua única tarefa é responder a pergunta de um aluno de forma clara, didática e direta, como um verdadeiro tutor.
        - A pergunta do aluno é: "${lastUserMessage}"
        - Responda apenas à pergunta feita. Não crie um novo exercício.
        - Sua resposta DEVE ser um JSON com uma única chave "description", contendo apenas o texto da sua resposta. Nenhuma outra formatação.
    `;

    try {
        const port = process.env.APP_PORT || 3000;
        const response = await fetch(`http://localhost:${port}/ia/generate-exercise`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt }),
        });

        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        res.json({ reply: data.description || "Não consigo responder no momento." });
    } catch (error) {
        console.error('Erro no chat com IA:', error);
        res.status(500).json({ message: 'Falha na comunicação com a IA.' });
    }
});


router.get('/ver_resultado/:tentativa_id', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) return res.redirect('/login');

    try {
        const details = await getAttemptDetails(req.params.tentativa_id, user.id);
        if (!details) {
            return res.status(404).send('Tentativa não encontrada ou não pertence a este usuário.');
        }

        let passeDisponivel = { passeAtivo: false };
        if (!details.tentativa.usou_passe) {
            passeDisponivel = await PasseEstudoService.verificarPasseAtivo(user.id);
        }

        const recomendacoesProfessores = await RecomendacaoProfessorService.recomendarProfessoresParaAluno(user.id, {
            tentativaId: details.tentativa.id, limite: 3
        });

        res.render('pages/ver_resultado', {
            tentativa: details.tentativa,
            respostas: details.respostas,
            atividade: details.atividade,
            user,
            session: req.session,
            recomendacoesProfessores,
            aiTutorUnlocked: details.tentativa.usou_passe,
            passeDisponivel
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

            if (req.file) {
                const base64Image = req.file.buffer.toString('base64');
                const dataUri = `data:${req.file.mimetype};base64,${base64Image}`;
                updatedData.foto_perfil = dataUri;
            }

            if (isProf) {
                updatedData.descricao = req.body.descricao || user.descricao;
                updatedData.link_previa = req.body.link_previa || user.link_previa;
                updatedData.status = req.body.status || user.status;
                
                await pool.query('UPDATE professores SET nome=?, email=?, descricao=?, link_previa=?, status=?, foto_perfil=? WHERE id=?',
                    [updatedData.nome, updatedData.email, updatedData.descricao, updatedData.link_previa, updatedData.status, updatedData.foto_perfil || user.foto_perfil, user.id]
                );

                await pool.query('DELETE FROM disciplinas WHERE professor_id = ?', [user.id]);
                for (const d of disciplinas) {
                    await pool.query('INSERT INTO disciplinas (professor_id, nome) VALUES (?, ?)', [user.id, d]);
                }
                updatedData.disciplinas = disciplinas;

            } else {
                await pool.query('UPDATE alunos SET nome=?, email=?, foto_perfil=? WHERE id=?', 
                [updatedData.nome, updatedData.email, updatedData.foto_perfil || user.foto_perfil, user.id]);
            }

            const sessionKey = isProf ? 'user_prof' : 'user_aluno';
            req.session[sessionKey] = { ...user, ...updatedData };
            if (req.session[sessionKey].foto) {
                delete req.session[sessionKey].foto;
            }

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
            SELECT p.id, p.nome, p.foto_perfil, p.descricao, p.status, GROUP_CONCAT(d.nome SEPARATOR ', ') as disciplinas
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
            data: (ag.data instanceof Date ? `${ag.data.getFullYear()}-${String(ag.data.getMonth() + 1).padStart(2, '0')}-${String(ag.data.getDate()).padStart(2, '0')}` : String(ag.data)),
            hora: String(ag.hora),
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
            `SELECT c.*, c.usuario_nome AS usuario, c.criado_em AS data, a.id AS aluno_id, a.nome AS aluno_nome
             FROM comentarios c
             LEFT JOIN alunos a ON a.id = c.aluno_id
             WHERE c.professor_id = ?
             ORDER BY c.criado_em DESC`,
            [user.id]
        );

        const avaliacoesComNota = feedbacks.filter(f => f.nota);
        const totalAvaliacoes = avaliacoesComNota.length;

        const distribuicaoNotas = { 5: { count: 0 }, 4: { count: 0 }, 3: { count: 0 }, 2: { count: 0 }, 1: { count: 0 } };
        let somaNotas = 0;

        if (totalAvaliacoes > 0) {
            avaliacoesComNota.forEach(f => {
                somaNotas += Number(f.nota);
                if (distribuicaoNotas[f.nota]) {
                    distribuicaoNotas[f.nota].count++;
                }
            });
        }
        Object.keys(distribuicaoNotas).forEach(key => {
            distribuicaoNotas[key].percent = totalAvaliacoes > 0 ? (distribuicaoNotas[key].count / totalAvaliacoes) * 100 : 0;
        });

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

router.get('/feedbacks_aluno', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) return res.redirect('/login');

    try {
        const [comentarios] = await pool.query(
            `SELECT c.*, c.criado_em AS data, p.id AS profId, p.nome AS professorNome
             FROM comentarios c
             JOIN professores p ON p.id = c.professor_id
             WHERE c.aluno_id = ? OR (c.aluno_id IS NULL AND c.usuario_nome = ?)
             ORDER BY c.criado_em DESC`,
            [user.id, user.nome]
        );
        res.render('pages/feedbacks_aluno', { user: { ...user, comentarios }, session: req.session });
    } catch (error) {
        console.error('Erro ao carregar feedbacks do aluno:', error);
        res.render('pages/feedbacks_aluno', { user: { ...user, comentarios: [] }, session: req.session });
    }
});

router.get('/atividades', (req, res) => {
    res.render('pages/atividades', { activity: null });
});

router.get('/lista_atividades', (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) {
        return res.redirect('/login');
    }

    const allActivities = activityStore.getActivities().activities;
    const userActivities = allActivities.filter(activity => 
        (activity.professorId === user.id || activity.alunoId === user.id) && !activity.isTest
    );

    res.render('pages/lista_atividades', { activities: userActivities });
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
    newActivity.id = crypto.randomBytes(8).toString('hex');
    newActivity.professorId = user.id;

    if(newActivity.questions) {
        newActivity.questions = Object.values(newActivity.questions).map(q => ({
            ...q,
            options: q.options ? Object.values(q.options) : []
        }));
    }

    activities.activities.push(newActivity);
    activityStore.saveActivities(activities);
    res.redirect('/lista_atividades');
});

router.get('/atividades/editar/:id', (req, res) => {
    const activities = activityStore.getActivities();
    const activity = activities.activities.find(a => a.id === req.params.id);
    if (activity) {
        res.render('pages/atividades', { activity });
    } else {
        res.redirect('/lista_atividades');
    }
});

router.post('/atividades/editar/:id', [
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

    const activities = activityStore.getActivities();
    const activityIndex = activities.activities.findIndex(a => a.id === req.params.id);
    if (activityIndex !== -1) {
        const user = req.session.user_aluno || req.session.user_prof;
        if (!user || activities.activities[activityIndex].professorId !== user.id) {
            return res.status(403).send('Você não tem permissão para editar esta atividade.');
        }

        const updatedActivity = req.body;
        updatedActivity.id = req.params.id;
        updatedActivity.professorId = user.id;

        if(updatedActivity.questions) {
            updatedActivity.questions = Object.values(updatedActivity.questions).map(q => ({
                ...q,
                options: q.options ? Object.values(q.options) : []
            }));
        }

        activities.activities[activityIndex] = updatedActivity;
        activityStore.saveActivities(activities);
        res.redirect('/lista_atividades');
    } else {
        res.status(404).send('Atividade não encontrada.');
    }
});

router.get('/explorar_atividades', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    const activitiesData = activityStore.getActivities();
    let limiteDiario = { limiteAtingido: false, contagem: 0, limite: 5 };
    let passeAtivo = { passeAtivo: false };

    if (user && user.tipo === 'aluno') {
        limiteDiario = await ActivityLimitService.getContagemAtividadesHoje(user.id);
        passeAtivo = await PasseEstudoService.verificarPasseAtivo(user.id);
    }

    const activities = await Promise.all(activitiesData.activities
        .filter(activity => !activity.isTest && !activity.alunoId)
        .map(async (activity) => {
            const creatorId = activity.alunoId || activity.professorId;
            if (!creatorId) return { ...activity, professorNome: 'Anônimo' }; 
            const creator = await getUserById(creatorId, false);
            return {
                ...activity,
                professorNome: creator ? creator.nome : 'Usuário Desconhecido'
            };
        })
    );

    res.render('pages/explorar_atividades', {
        activities,
        user,
        session: req.session,
        limiteDiario,
        passeAtivo
    });
});

router.post('/api/passe/ativar-para-dicas', async (req, res) => {
    if (!req.session.user_aluno) {
        return res.status(401).json({ success: false, message: 'Usuário não autenticado.' });
    }

    const { activityId } = req.body;
    const user = req.session.user_aluno;

    try {
        const passe = await PasseEstudoService.verificarPasseAtivo(user.id);
        if (!passe.passeAtivo) {
            return res.status(403).json({ success: false, message: 'Nenhum passe de estudos ativo encontrado.' });
        }

        if (passe.tipo === 'quantidade') {
            await PasseEstudoService.consumirAtividadePasse(user.id);
        }

        req.session.unlockedHintsFor = req.session.unlockedHintsFor || {};
        req.session.unlockedHintsFor[activityId] = true;

        req.session.save(err => {
            if (err) {
                console.error('Erro ao salvar sessão após ativar passe:', err);
                return res.status(500).json({ success: false, message: 'Erro interno ao salvar sessão.' });
            }
            res.json({ success: true, message: 'Passe ativado para dicas!' });
        });

    } catch (error) {
        console.error('Erro ao ativar passe para dicas:', error);
        res.status(500).json({ success: false, message: 'Erro no servidor ao ativar o passe.' });
    }
});

router.get('/api/atividade/:activityId/dica/:questionIndex', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) {
        return res.status(401).json({ message: 'Usuário não autenticado.' });
    }

    const { activityId, questionIndex } = req.params;

    const hintsUnlocked = req.session.unlockedHintsFor && req.session.unlockedHintsFor[activityId];
    const limiteDiario = await ActivityLimitService.getContagemAtividadesHoje(user.id);
    const passeDisponivel = await PasseEstudoService.verificarPasseAtivo(user.id);
    const usouPasseNaAtividade = limiteDiario.limiteAtingido && passeDisponivel.passeAtivo;

    if (!hintsUnlocked && !usouPasseNaAtividade) {
        return res.status(403).json({ message: 'Acesso às dicas não liberado para esta atividade.' });
    }

    try {
        const activitiesData = activityStore.getActivities();
        let activity = activitiesData.activities.find(a => a.id === activityId);

        if (!activity) {
            return res.status(404).json({ message: 'Atividade não encontrada.' });
        }

        const questions = activityNormalizer.normalizeActivityQuestions(activity);
        const question = questions[questionIndex];

        if (!question) {
            return res.status(404).json({ message: 'Questão não encontrada.' });
        }

        const optionsText = question.options ? Object.entries(question.options).map(([key, value]) => `${key}) ${value}`).join('\n') : ''

        const prompt = `Por favor, atue como um tutor de matemática. Sua tarefa é criar uma única dica para a questão a seguir. A dica não deve conter a resposta, nem mesmo a letra da alternativa correta. A dica deve ser uma pergunta curta ou uma pequena sugestão que guie o raciocínio do aluno. A questão é: "${question.text}". As opções são: ${optionsText}. A resposta correta é a letra '${question.correct}'. A dica precisa ser em português do Brasil.`;
        
        const port = process.env.APP_PORT || 3000;
        const response = await fetch(`http://localhost:${port}/ia/generate-exercise`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: `Gere um exercício cuja descrição seja uma dica para a seguinte questão: ${prompt}. A questão em si pode ser um placeholder.` }),
        });

        if (!response.ok) {
            console.error('Erro da API de IA:', await response.text());
            throw new Error('A resposta do servidor de IA não foi OK.');
        }

        const data = await response.json();
        
        let dica = "Não foi possível gerar uma dica no momento.";
        if (data.questions && data.questions[0] && data.questions[0].dica) {
            dica = data.questions[0].dica;
        } else if (data.description) {
            dica = data.description;
        }

        res.json({ dica });

    } catch (error) {
        console.error('Erro ao gerar dica com IA:', error);
        res.status(500).json({ message: 'Não foi possível gerar a dica. Verifique o console para mais detalhes.' });
    }
});


router.get('/ver_atividade/:id', async (req, res) => {
    const user = req.session.user_aluno || req.session.user_prof;
    const activityId = req.params.id;

    let usouPasseNaAtividade = false;
    let passeDisponivel = { passeAtivo: false };
    let hintsUnlocked = false;

    if (user && user.tipo === 'aluno') {
        const limiteDiario = await ActivityLimitService.getContagemAtividadesHoje(user.id);
        passeDisponivel = await PasseEstudoService.verificarPasseAtivo(user.id);

        usouPasseNaAtividade = limiteDiario.limiteAtingido && passeDisponivel.passeAtivo;

        req.session.unlockedHintsFor = req.session.unlockedHintsFor || {};

        if (usouPasseNaAtividade) {
            req.session.unlockedHintsFor[activityId] = true;
        }
        
        hintsUnlocked = !!req.session.unlockedHintsFor[activityId];
        
        if (limiteDiario.limiteAtingido && !passeDisponivel.passeAtivo) {
            return res.redirect('/explorar_atividades');
        }
    }

    const activitiesData = activityStore.getActivities();
    const activity = activitiesData.activities.find(a => a.id === activityId);

    if (activity) {
        const creatorId = activity.isTest ? activity.alunoId : (activity.alunoId || activity.professorId);
        const creator = await getUserById(creatorId);

        const activityData = {
            ...activity,
            questions: activityNormalizer.normalizeActivityQuestions(activity),
            professorNome: creator ? creator.nome : 'Anônimo'
        };
        
        res.render('pages/ver_atividade', {
            activity: activityData,
            user,
            session: req.session,
            usouPasseNaAtividade,
            passeDisponivel,
            hintsUnlocked
        });
    } else {
        res.redirect('/explorar_atividades');
    }
});

router.post('/submit-test/:activityId', handleActivitySubmission);
router.post('/submit-activity/:activityId', handleActivitySubmission);

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

    prompt = `Crie ${prompt} O exercício deve estar no formato JSON esperado, com "title", "description" e uma lista de "questions", onde cada questão tem "options" como um array de strings e "correct" como o índice da resposta correta.`;

    try {
        const port = process.env.APP_PORT;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const response = await fetch(`http://localhost:${port}/ia/generate-exercise`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });

        if (!response.ok) {
            throw new Error('A resposta do servidor não foi OK.');
        }

        const data = await response.json();

        const normalizedQuestions = activityNormalizer.normalizeActivityQuestions({ questions: data.questions || [] });

        const activities = activityStore.getActivities();

        const newActivity = {
            id: crypto.randomBytes(8).toString('hex'),
            alunoId: user.id,
            isTest: true,
            title: data.title || 'Teste de Nivelamento',
            description: data.description || 'Este é um teste para avaliar seu conhecimento.',
            questions: normalizedQuestions 
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
        const [attempts] = await pool.query(
            'SELECT 1 FROM tentativas_teste WHERE aluno_id = ? LIMIT 1',
            [user.id]
        );

        if (attempts.length === 0) {
            return res.redirect('/nivel_escolar');
        }

        const tarefa = await trilhaService.iniciarTrilhaParaAluno(user.id);
        const progresso = await trilhaService.obterProgresso(user.id);

        if (tarefa.tarefaTipo === 'CONCLUIDO') {
            return res.render('pages/trilha_concluida');
        }

        res.render('pages/trilha', {
            user,
            tarefa: tarefa,
            progresso,
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

        await trilhaService.processarRespostaEProximaQuestao(
            user.id,
            Number(item_id),
            resposta,
            tempoResposta
        );

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

// Admin Denuncias routes
router.post('/admin/denuncias/:id/status', AdminDenunciaController.updateStatusDenuncia);
router.post('/admin/denuncias/:id/warn', AdminDenunciaController.warnUser);
router.post('/admin/denuncias/:id/suspend', AdminDenunciaController.suspendUser);
router.post('/admin/denuncias/:id/ban', AdminDenunciaController.banUser);
router.post('/admin/denuncias/:id/note', AdminDenunciaController.addInternalNote);
router.get('/admin/denuncias/:id/historico', AdminDenunciaController.getDenunciaHistorico);

module.exports = router;
