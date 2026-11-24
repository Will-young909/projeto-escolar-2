
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
const RecomendacaoTrackingService = require('../services/RecomendacaoTrackingService');
const AdminDenunciaController = require('../controllers/AdminDenunciaController');
const AlertasController = require('../controllers/AlertasController');
const FeedbackService = require('../services/FeedbackService');
const ActivityLimitService = require('../services/ActivityLimitService');
const PasseEstudoService = require('../services/PasseEstudoService');
const PagamentoModel = require('../models/PagamentoModel');
const PaymentSettlementService = require('../services/PaymentSettlementService');
const FinanceService = require('../services/FinanceService');
const { postJson } = require('../utils/internalFetch');
const { getSaoPauloDateTime } = require('../utils/brasiliaTime');
const Validacao = require('../services/QuestionValidationService');
const { conferenceGabarito } = require('../services/GabaritoConferenceService');
const C = require('../constants/trilha');

/**
 * Gera um conjunto de questões pela IA e o devolve APENAS se todas passarem na
 * validação determinística (QuestionValidationService).
 *
 * Aplica a mesma trava usada na trilha adaptativa: a IA sugere o gabarito, mas
 * o backend recalcula. Questões inválidas (sem resposta correta entre as
 * alternativas, `correct` incoerente, duas corretas, duplicadas...) são
 * descartadas e o conjunto é regenerado, com limite de tentativas.
 *
 * @param {string} prompt Prompt enviado ao endpoint de IA.
 * @param {number} [quantidadeEsperada] Nº de questões desejado (0 = quantas vierem).
 * @returns {Promise<{ok: true, data: object}|{ok: false, motivo: string, tentativas: number}>}
 */
async function gerarQuestoesValidadas(prompt, quantidadeEsperada = 0) {
  let ultimoErro = '';

  for (let tentativa = 1; tentativa <= C.IA_VALIDACAO.MAX_TENTATIVAS; tentativa++) {
    let data;
    try {
      const response = await postJson('/ia/generate-exercise', { prompt });
      if (!response.ok) {
        ultimoErro = `servidor de IA respondeu ${response.status}`;
        console.error('[IA][VALIDATION_FAILED] Tentativa:', tentativa, '| Motivo:', ultimoErro);
        continue;
      }
      data = await response.json();
    } catch (error) {
      ultimoErro = `falha de comunicação com a IA: ${error.message}`;
      console.error('[IA][VALIDATION_FAILED] Tentativa:', tentativa, '| Motivo:', ultimoErro);
      continue;
    }

    const questions = Array.isArray(data?.questions) ? data.questions : [];
    if (quantidadeEsperada > 0 && questions.length < quantidadeEsperada) {
      ultimoErro = `a IA retornou ${questions.length} questão(ões) e eram esperadas ${quantidadeEsperada}`;
      console.error('[IA][VALIDATION_FAILED] Tentativa:', tentativa, '| Motivo:', ultimoErro);
      continue;
    }
    if (questions.length === 0) {
      ultimoErro = 'a IA não retornou nenhuma questão';
      console.error('[IA][VALIDATION_FAILED] Tentativa:', tentativa, '| Motivo:', ultimoErro);
      continue;
    }

    // Valida TODAS as questões do conjunto: nenhuma entra se houver uma inválida.
    const invalidas = [];
    const naoConferiveis = [];
    questions.forEach((question, indice) => {
      const relatorio = Validacao.validar(question);
      // Só reprova o que o backend CONSEGUIU conferir e achou errado.
      // `validavel: false` significa "não consigo provar" — típico de conteúdo
      // que o validador textual não cobre (equação do 2º grau, função, log,
      // vértice de parábola). Barrar nesses casos reprova questões CORRETAS por
      // falta de cobertura, não por erro. É a mesma política já aplicada em
      // `conferenceGabarito` (linha 45) deste arquivo.
      if (relatorio.validavel && !relatorio.valid) {
        invalidas.push({ indice, erros: relatorio.errors, calculada: relatorio.calculatedAnswer });
        console.error(
          '[IA][VALIDATION_FAILED] Tentativa:', tentativa,
          '| Questão', indice + 1,
          '| Motivo:', relatorio.errors.join(' '),
          '| Resposta calculada:', relatorio.calculatedAnswer ?? 'n/d',
          '| Alternativas:', JSON.stringify(relatorio.detalhes.alternativas || [])
        );
        return;
      }
      if (!relatorio.validavel) {
        naoConferiveis.push(indice + 1);
        console.warn(
          '[IA][VALIDATION_SKIPPED] Tentativa:', tentativa,
          '| Questão', indice + 1,
          '| Motivo:', relatorio.errors.join(' '),
          '| Aceita sem conferência: o validador não cobre este tipo de conta.'
        );
      }
    });

    if (invalidas.length === 0) {
      console.log(
        '[IA][VALIDATION_OK] Tentativa:', tentativa,
        '| Questões validadas:', questions.length,
        naoConferiveis.length ? `| sem conferência: ${naoConferiveis.join(',')}` : ''
      );
      return { ok: true, data };
    }
    ultimoErro = `${invalidas.length} questão(ões) inválida(s): ${invalidas[0].erros.join(' ')}`;
  }

  console.error(
    '[IA][GENERATION_FAILED]',
    `Falha após ${C.IA_VALIDACAO.MAX_TENTATIVAS} tentativa(s). Última razão:`, ultimoErro,
    '| Nada foi salvo.'
  );
  return { ok: false, motivo: ultimoErro, tentativas: C.IA_VALIDACAO.MAX_TENTATIVAS };
}

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

// Aceita imagens e PDF (para comprovante de formação) e vídeo para aula prévia
const fileFilterPerfil = (req, file, cb) => {
    if (file.fieldname === 'previa_arquivo') {
        const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
        if (allowed.includes(file.mimetype)) return cb(null, true);
        return cb(new Error('Formato de vídeo inválido. Use MP4, WEBM, MOV ou MKV.'));
    }
    const isImage = /jpeg|jpg|png/.test(file.mimetype) && /jpeg|jpg|png/.test(path.extname(file.originalname).toLowerCase());
    const isPdf = file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf';
    if (isImage || isPdf) {
        return cb(null, true);
    }
    cb(new Error('Apenas imagens (JPEG, PNG) ou PDF são permitidas.'));
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }
}).single('foto');

const uploadProfileEdit = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'foto') return fileFilter(req, file, cb);
        if (file.fieldname === 'previa_arquivo') {
            const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
            if (allowed.includes(file.mimetype)) return cb(null, true);
            return cb(new Error('Formato de vídeo inválido. Use MP4, WEBM, MOV ou MKV.'));
        }
        cb(new Error('Campo de upload inválido.'));
    },
    limits: { fileSize: 100 * 1024 * 1024 }
}).fields([{ name: 'foto', maxCount: 1 }, { name: 'previa_arquivo', maxCount: 1 }]);

// Upload de múltiplos campos usado apenas no formulário de perfil profissional pendente
const uploadPerfil = multer({
    storage: storage,
    fileFilter: fileFilterPerfil,
    limits: { fileSize: 100 * 1024 * 1024 }
}).fields([{ name: 'foto', maxCount: 1 }, { name: 'comprovante', maxCount: 1 }, { name: 'previa_arquivo', maxCount: 1 }]);

const denunciaEvidenceStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = path.join(__dirname, '..', 'private', 'denuncia_evidencias');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'evidencia-' + uniqueSuffix + path.extname(file.originalname).toLowerCase());
    }
});

const denunciaEvidenceFilter = (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Formato de evidência inválido. Use imagem (JPG/PNG/WEBP/GIF) ou vídeo (MP4/WEBM/MOV).'));
};

const uploadDenunciaEvidencia = multer({
    storage: denunciaEvidenceStorage,
    fileFilter: denunciaEvidenceFilter,
    limits: { fileSize: 50 * 1024 * 1024 }
}).single('evidencia_arquivo');

const AULAS_PREVIAS_DIR = path.join(__dirname, '..', 'private', 'aulas_previas');

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
const { anoDoNivel } = require('../utils/trilhaHelpers');

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
    const anoDaAtividade = anoDoNivel(activity.nivelEscolar);
    for (const q of normalizedQuestions) {
        let habilidadeId = null;
        if (q.habilidade) {
            // ATENÇÃO: `habilidades` é tabela GLOBAL (`codigo` UNIQUE), então esta
            // linha é compartilhada por todos os alunos e todas as atividades.
            // `ano_escolar` aqui é apenas a série da atividade que está sendo
            // gravada AGORA — não "a série da habilidade", que não existe.
            //
            // O COALESCE abaixo significa "só preenche se ainda era NULL": como a
            // habilidade nasce aqui quando a atividade tem nível, mas a trilha
            // (`gerarQuestaoDeterministica`) insere a questão com habilidade já
            // existente e nunca passa por este INSERT, na prática as habilidades
            // criadas pela trilha ficam com ano_escolar NULL para sempre.
            //
            // Ninguém filtra por esta coluna. Quem pondera dificuldade por série
            // lê `curriculo_aluno.ano_escolar` (ver `selecionarProximaQuestao`).
            // Os dois únicos consumidores daqui são ORDER BY. Ver B2 no histórico:
            // filtrar por série de verdade exige guardar a série na relação
            // (`habilidades_curriculo`/`questoes`), não numa linha global.
            const [habilidadeResult] = await pool.query(
                'INSERT INTO habilidades (codigo, descricao, ano_escolar) VALUES (?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id), ano_escolar=COALESCE(ano_escolar, VALUES(ano_escolar))',
                [q.habilidade, q.habilidade, anoDaAtividade]
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
                const [horarios] = await pool.query(
                    "SELECT id, data, hora_inicio, hora_fim, preco, status FROM horarios_disponiveis WHERE professor_id = ? ORDER BY data, hora_inicio",
                    [professor.id]
                );
                const spNow = getSaoPauloDateTime();
                const todaySp = spNow.slice(0, 10);
                const timeSp = spNow.slice(11, 16);
                professor.horariosDisponiveis = horarios.filter(h => {
                    if (h.status === 'agendado') return true;
                    const d = h.data instanceof Date
                        ? `${h.data.getFullYear()}-${String(h.data.getMonth() + 1).padStart(2, '0')}-${String(h.data.getDate()).padStart(2, '0')}`
                        : String(h.data).slice(0, 10);
                    const hi = String(h.hora_inicio).slice(0, 5);
                    return d > todaySp || (d === todaySp && hi > timeSp);
                });
                const [notificacoes] = await pool.query('SELECT id, tipo, mensagem, lida, link_relacionado, resolvida, criado_em FROM notificacoes WHERE usuario_id = ? AND usuario_tipo = ? ORDER BY criado_em DESC LIMIT 30', [id, 'professor']);
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

                const [notificacoes] = await pool.query('SELECT id, tipo, mensagem, lida, link_relacionado, resolvida, criado_em FROM notificacoes WHERE usuario_id = ? AND usuario_tipo = ? ORDER BY criado_em DESC LIMIT 30', [id, 'aluno']);
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

        const questionScores = normalizedActivity.questions.map((question, index) => {
            const userAnswer = userAnswers[index] || '';
            if (question.options) {
                const correct = activityNormalizer.isAnswerCorrect(question, userAnswer);
                return { correct, scorePercent: correct ? 100 : 0, userAnswer, evaluation: null };
            }
            const evaluation = activityNormalizer.evaluateKeywordAnswer(question, userAnswer);
            return { correct: evaluation.isCorrect, scorePercent: evaluation.scorePercent, userAnswer, evaluation };
        });
        score = questionScores.reduce((sum, q) => sum + (q.scorePercent / 100), 0);

        const pontuacao_total = totalQuestions > 0 ? (score / totalQuestions) * 100 : 0;
        const acertosCount = questionScores.filter(q => q.scorePercent >= 99.999).length;
        const tipoTentativa = normalizedActivity.isTest ? 'diagnostico' : 'checkpoint';

        const [result] = await pool.query(
            'INSERT INTO tentativas_teste (aluno_id, atividade_id, tipo, pontuacao_total, total_questoes, acertos, erros, data_conclusao, trilha_gerada, usou_passe) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)',
            [user.id, activityId, tipoTentativa, pontuacao_total, totalQuestions, acertosCount, totalQuestions - acertosCount, normalizedActivity.isTest ? 0 : 1, usouPasse]
        );
        const tentativaId = result.insertId;

        for (let i = 0; i < totalQuestions; i++) {
            const question = normalizedActivity.questions[i];
            const qScore = questionScores[i];
            const questionId = questionIds[i];

            if (questionId) {
                await pool.query(
                    'INSERT INTO respostas_teste (tentativa_id, questao_id, resposta_marcada, acertou) VALUES (?, ?, ?, ?)',
                    [tentativaId, questionId, qScore.userAnswer, qScore.scorePercent >= 99.999 ? 1 : 0]
                );
            }
        }

        await pool.query('COMMIT');

        if (req.session.unlockedHintsFor && req.session.unlockedHintsFor[activityId]) {
            delete req.session.unlockedHintsFor[activityId];
            req.session.save();
        }

        if (normalizedActivity.isTest) {
            // O diagnóstico define o curriculo: e ele que diz a trilha quais
            // habilidades servem para a serie do aluno. Sem isso a trilha
            // sortearia qualquer habilidade do banco (e cairia na de menor id).
            try {
                const curriculo = await trilhaService.sincronizarCurriculoDoDiagnostico(
                    user.id, tentativaId, activity.nivelEscolar || null
                );
                console.log('[TRILHA][CURRICULO] Aluno', user.id, '| ano', curriculo.ano, '| habilidades', curriculo.habilidades, curriculo.criado ? '' : '(nao criado)');
            } catch (e) {
                console.error('Falha ao montar o curriculo do aluno:', e.message);
            }
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
        const [professores] = await pool.query(`
            SELECT p.id, p.nome, p.foto_perfil, p.descricao, p.status,
                   COALESCE(AVG(c.nota), 0) as avaliacao_media,
                   COUNT(c.id) as num_avaliacoes
            FROM professores p
            LEFT JOIN comentarios c ON c.professor_id = p.id AND c.nota IS NOT NULL
            WHERE p.status = ? AND p.aprovacao_status = 'approved'
            GROUP BY p.id, p.nome, p.foto_perfil, p.descricao, p.status
            LIMIT 10
        `, ['disponivel']);
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

    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    if (!dateMatch) {
        return res.status(400).json({ success: false, message: 'Data inválida.' });
    }
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const dateObj = new Date(year, month - 1, day);
    if (dateObj.getFullYear() !== year || dateObj.getMonth() !== month - 1 || dateObj.getDate() !== day) {
        return res.status(400).json({ success: false, message: 'Data inválida.' });
    }

    const now = new Date();
    const normalizedSlots = [];
    for (const slot of slots) {
        if (!slot || !slot.start || !slot.end || slot.price === undefined || slot.price === null || slot.price === '') {
            return res.status(400).json({ success: false, message: 'Preencha todos os campos de cada horário corretamente.' });
        }
        if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(slot.start) || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(slot.end)) {
            return res.status(400).json({ success: false, message: 'Formato de horário inválido.' });
        }
        if (slot.end <= slot.start) {
            return res.status(400).json({ success: false, message: 'O horário final deve ser depois do horário inicial.' });
        }
        const priceNum = Number(slot.price);
        if (!Number.isFinite(priceNum) || priceNum <= 0) {
            return res.status(400).json({ success: false, message: 'O preço deve ser maior que zero.' });
        }
        const [sh, sm] = slot.start.split(':').map(Number);
        const slotStart = new Date(year, month - 1, day, sh, sm, 0, 0);
        if (slotStart <= now) {
            return res.status(400).json({ success: false, message: 'Não é permitido cadastrar horários que já passaram.' });
        }
        const hasOverlap = normalizedSlots.some(s => slot.start < s.end && slot.end > s.start);
        if (hasOverlap) {
            return res.status(400).json({ success: false, message: 'Não é permitido cadastrar horários iguais ou sobrepostos no mesmo dia.' });
        }
        normalizedSlots.push({ start: slot.start, end: slot.end, price: priceNum });
    }

    const professorId = req.session.user_prof.id;

    try {
        await pool.query('START TRANSACTION');
        await pool.query("DELETE FROM horarios_disponiveis WHERE professor_id = ? AND data = ? AND status IN ('disponivel', 'cancelado')", [professorId, date]);

        for (const slot of normalizedSlots) {
            await pool.query(
                'INSERT INTO horarios_disponiveis (professor_id, data, hora_inicio, hora_fim, preco, status) VALUES (?, ?, ?, ?, ?, ?)',
                [professorId, date, slot.start, slot.end, slot.price, 'disponivel']
            );
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
            const devCheckoutId = crypto.randomUUID();
            await PagamentoModel.create({
                checkout_id: devCheckoutId,
                preference_id: devCheckoutId,
                descricao: `Aula com ${professor.nome}`,
                valor: horario.preco,
                criado_por: alunoId,
                professor_id: profId,
                status: 'pending'
            });
            const reference = encodeURIComponent(JSON.stringify({
                profId,
                horarioId: horarioIdBanco,
                alunoId,
                devCheckoutId
            }));
            return res.redirect(`/pagamento/sucesso?external_reference=${reference}&status=approved&dev_checkout=1`);
        }

        const checkoutId = crypto.randomUUID();
        const lessonRef = { checkoutId, profId, horarioId: horarioIdBanco, alunoId };
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
            external_reference: JSON.stringify(lessonRef),
            metadata: lessonRef,
        });

        const response = await mpPreferenceClient.create({ body: preference });
        const body = response.body || response;

        if (!body.id) {
            throw new Error('Mercado Pago não retornou o identificador da preferência.');
        }
        await PagamentoModel.create({
            checkout_id: checkoutId,
            preference_id: body.id,
            descricao: `Aula com ${professor.nome}`,
            valor: horario.preco,
            criado_por: alunoId,
            professor_id: profId,
            status: 'pending'
        });

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

        req.session.save(() => {
            if (tipo === 'professor') {
                return res.redirect('/professor/perfil-profissional?novo=1');
            }
            res.redirect('/');
        });

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
                } else if (!user.suspenso_ate) {
                    return res.render('pages/login', {
                        erros: { general: { msg: 'Esta conta está suspensa. Entre em contato com a administração.' } },
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
                } else if (!user.suspenso_ate) {
                    return res.render('pages/login', {
                        erros: { general: { msg: 'Esta conta está suspensa. Entre em contato com a administração.' } },
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

        req.session.save(() => {
            if (user.tipo === 'professor' && user.aprovacao_status === 'pending') {
                return res.redirect('/professor/perfil-profissional?pendente=1');
            }
            res.redirect('/');
        });

    } catch (error) {
        console.error("Erro no login:", error);
        res.status(500).render('pages/login', {
            erros: { general: { msg: 'Ocorreu um erro interno. Tente novamente.' } },
            dados: req.body
        });
    }
});

// ============================================================================
// Perfil profissional do professor (fluxo de aprovação)
// ============================================================================

// Exibe o formulário de perfil profissional para professores pendentes.
// Professores já aprovados são enviados direto para o próprio perfil.
router.get('/professor/perfil-profissional', async (req, res) => {
    if (!req.session.user_prof) {
        return res.redirect('/login');
    }

    try {
        // Já aprovado: não precisa mais preencher o formulário de adesão.
        if (req.session.user_prof.aprovacao_status === 'approved') {
            return res.redirect('/perfil_prof');
        }

        const professor = await getUserById(req.session.user_prof.id, false);
        if (!professor || professor.tipo !== 'professor') {
            return res.redirect('/logout');
        }

        res.render('pages/editar_perfil_prof', {
            user: professor,
            dados: {},
            erros: {},
            perfil_pendente: true,
            enviado: req.query.enviado === '1',
            session: req.session,
        });
    } catch (error) {
        console.error('Erro ao carregar perfil profissional pendente:', error);
        res.redirect('/logout');
    }
});

// Salva o perfil profissional do professor pendente e o envia para análise.
router.post('/professor/perfil-profissional', uploadPerfil, async (req, res) => {
    if (!req.session.user_prof) {
        return res.redirect('/login');
    }

    await body('nome').notEmpty().withMessage('O nome é obrigatório.').run(req);
    await body('email').isEmail().withMessage('O e-mail é inválido.').run(req);
    await body('descricao').notEmpty().withMessage('A descrição profissional é obrigatória.').run(req);
    await body('formacao').isIn(['estudante_universitario', 'graduado', 'pos_graduado', 'mestre']).withMessage('Selecione sua formação.').run(req);

    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        const professor = await getUserById(req.session.user_prof.id, false);
        return res.render('pages/editar_perfil_prof', {
            user: professor || req.session.user_prof,
            dados: req.body,
            erros: erros.mapped(),
            perfil_pendente: true,
            session: req.session,
        });
    }

    try {
        const professorId = req.session.user_prof.id;
        let disciplinas = req.body.disciplinas || [];
        if (disciplinas && !Array.isArray(disciplinas)) {
            disciplinas = [disciplinas];
        }
        disciplinas = disciplinas.filter(d => d && d.trim() !== '');

        let foto_perfil = req.session.user_prof.foto_perfil || null;
        if (req.files && req.files.foto && req.files.foto[0]) {
            const f = req.files.foto[0];
            const base64Image = f.buffer.toString('base64');
            foto_perfil = `data:${f.mimetype};base64,${base64Image}`;
        }

        let comprovante_formacao = req.session.user_prof.comprovante_formacao || null;
        if (req.files && req.files.comprovante && req.files.comprovante[0]) {
            const c = req.files.comprovante[0];
            comprovante_formacao = `data:${c.mimetype};base64,${c.buffer.toString('base64')}`;
        }

        const previaFile = req.files && req.files.previa_arquivo ? req.files.previa_arquivo[0] : null;
        let previa_arquivo = req.session.user_prof.previa_arquivo || null;
        if (previaFile) {
            if (previa_arquivo) {
                const oldBase = path.basename(String(previa_arquivo).replace(/\\/g, '/'));
                const oldPath = path.join(__dirname, '..', 'private', 'aulas_previas', oldBase);
                if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
            }
            const dir = path.join(__dirname, '..', 'private', 'aulas_previas');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const ext = path.extname(previaFile.originalname).toLowerCase() || '.mp4';
            const filename = 'previa-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
            fs.writeFileSync(path.join(dir, filename), previaFile.buffer);
            previa_arquivo = `aulas_previas/${filename}`;
        }
        if (req.body.remover_previa_arquivo === '1' && !previaFile) {
            if (previa_arquivo) {
                const oldBase = path.basename(String(previa_arquivo).replace(/\\/g, '/'));
                const oldPath = path.join(__dirname, '..', 'private', 'aulas_previas', oldBase);
                if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
            }
            previa_arquivo = null;
        }

        await pool.query(
            `UPDATE professores
             SET nome = ?, email = ?, descricao = ?, formacao = ?, comprovante_formacao = ?, link_previa = ?, previa_arquivo = ?,
                 perfil_enviado_em = NOW(), foto_perfil = COALESCE(?, foto_perfil)
             WHERE id = ?`,
            [
                req.body.nome,
                req.body.email,
                req.body.descricao,
                req.body.formacao,
                comprovante_formacao,
                req.body.link_previa || null,
                previa_arquivo,
                foto_perfil,
                professorId,
            ]
        );

        await pool.query('DELETE FROM disciplinas WHERE professor_id = ?', [professorId]);
        for (const d of disciplinas) {
            await pool.query('INSERT INTO disciplinas (professor_id, nome) VALUES (?, ?)', [professorId, d]);
        }

        const updated = await getUserById(professorId, false);
        const disciplinasAtualizadas = await pool.query('SELECT nome FROM disciplinas WHERE professor_id = ?', [professorId]);

        req.session.user_prof = {
            ...req.session.user_prof,
            nome: req.body.nome,
            email: req.body.email,
            descricao: req.body.descricao,
            formacao: req.body.formacao,
            comprovante_formacao: comprovante_formacao,
            foto_perfil: foto_perfil || req.session.user_prof.foto_perfil,
            disciplinas: disciplinasAtualizadas[0]?.map(d => d.nome) || [],
            perfil_enviado_em: new Date(),
        };

        req.session.save((err) => {
            if (err) {
                console.error('Erro ao salvar sessão após perfil profissional:', err);
            }
            res.redirect('/professor/perfil-profissional?enviado=1');
        });

    } catch (error) {
        console.error('Erro ao salvar perfil profissional:', error);
        const professor = await getUserById(req.session.user_prof.id, false);
        res.render('pages/editar_perfil_prof', {
            user: professor || req.session.user_prof,
            dados: req.body,
            erros: { general: { msg: 'Erro ao salvar o perfil. Tente novamente.' } },
            perfil_pendente: true,
            session: req.session,
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

        // Perfil público só é exibido para professores já aprovados
        if (professor.aprovacao_status !== 'approved') {
            return res.redirect('/?erro=perfil_nao_disponivel');
        }

        const spNow = getSaoPauloDateTime();
        const today = spNow.slice(0, 10);
        const currentTime = spNow.slice(11, 16);
        const [horarios] = await pool.query(
          `SELECT h.*, a.nome as alunoNome, h.id as horarioId
           FROM horarios_disponiveis h
           LEFT JOIN alunos a ON h.aluno_id = a.id
           WHERE h.professor_id = ?
             AND (h.data > ? OR (h.data = ? AND h.hora_inicio > ?))
           ORDER BY h.data, h.hora_inicio`,
          [professorId, today, today, currentTime]
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

        // Process reimbursement for the cancelled class
        await pool.query(
          'INSERT INTO reembolsos (agendamento_id, aluno_id, professor_id, valor_reembolso, status, tipo, motivo) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [agendamentoId, agendamento.aluno_id, agendamento.professor_id, 0, 'processando', 'parcial', motivo]
        );

        await pool.query('COMMIT');

        res.json({ success: true, message: 'Aula cancelada e aluno notificado.', refund: { status: 'processando' } });

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

        // Process reimbursement for the cancelled class
        await pool.query(
          'INSERT INTO reembolsos (agendamento_id, aluno_id, professor_id, valor_reembolso, status, tipo, motivo) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [agendamentoId, agendamento.aluno_id, agendamento.professor_id, 0, 'processando', 'parcial', reason]
        );

        await pool.query('COMMIT');

        res.json({ success: true, message: 'Aula cancelada com sucesso.', refund: { status: 'processando' } });

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
    const isAdmin = !!req.session.user_admin;
    if (!isProf && !isAluno && !isAdmin) return res.redirect('/login');

    let currentUser, renderPage, profileRedirect, table, currentHash;
    try {
        if (isAdmin) {
            const [rows] = await pool.query('SELECT id, nome, email, role, senha FROM admins WHERE id = ?', [req.session.user_admin.id]);
            if (!rows.length) return res.redirect('/admin/login');
            currentUser = rows[0];
            currentHash = rows[0].senha;
            renderPage = 'pages/editar_perfil_admin';
            profileRedirect = '/perfil_adm';
            table = 'admins';
        } else if (isProf) {
            currentUser = req.session.user_prof;
            currentHash = currentUser.password;
            renderPage = 'pages/editar_perfil_prof';
            profileRedirect = '/perfil_prof';
            table = 'professores';
        } else {
            currentUser = req.session.user_aluno;
            currentHash = currentUser.password;
            renderPage = 'pages/editar_perfil_aluno';
            profileRedirect = '/perfil_aluno';
            table = 'alunos';
        }

        const renderError = (errosMap) => res.render(renderPage, { user: currentUser, erros: errosMap, dados: req.body, session: req.session });

        const erros = validationResult(req);
        if (!erros.isEmpty()) {
            return renderError(erros.mapped());
        }

        const { current_password, new_password } = req.body;
        if (!currentHash || !bcrypt.compareSync(current_password, currentHash)) {
            return renderError({ current_password: { msg: 'Senha atual incorreta.' } });
        }

        const newHashedPassword = bcrypt.hashSync(new_password, 10);
        await pool.query(`UPDATE ${table} SET senha = ? WHERE id = ?`, [newHashedPassword, currentUser.id]);

        if (!isAdmin) {
            currentUser.password = newHashedPassword;
            req.session.save(err => {
                if (err) console.error("Erro ao salvar sessão após mudar senha:", err);
                res.redirect(profileRedirect);
            });
        } else {
            res.redirect(profileRedirect);
        }
    } catch (error) {
        console.error("Erro ao alterar senha:", error);
        const fallbackPage = isAdmin ? 'pages/editar_perfil_admin' : (isProf ? 'pages/editar_perfil_prof' : 'pages/editar_perfil_aluno');
        const fallbackUser = currentUser || req.session.user_admin || req.session.user_prof || req.session.user_aluno;
        return res.render(fallbackPage, {
            user: fallbackUser,
            erros: { general: { msg: 'Erro ao alterar senha. Tente novamente.' } },
            dados: req.body,
            session: req.session
        });
    }
});

router.post('/api/verify-current-password', [
    body('current_password').notEmpty().withMessage('Informe sua senha atual.'),
], async (req, res) => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return res.status(400).json({ valid: false, msg: erros.array()[0].msg });
    }

    const { current_password } = req.body;
    try {
        if (req.session.user_admin) {
            const [rows] = await pool.query('SELECT senha FROM admins WHERE id = ?', [req.session.user_admin.id]);
            if (rows.length && rows[0].senha && bcrypt.compareSync(current_password, rows[0].senha)) {
                return res.json({ valid: true });
            }
            return res.status(400).json({ valid: false, msg: 'Senha atual incorreta.' });
        }

        const user = req.session.user_prof || req.session.user_aluno;
        if (!user) return res.status(401).json({ valid: false, msg: 'Usuário não autenticado.' });

        if (user.password && bcrypt.compareSync(current_password, user.password)) {
            return res.json({ valid: true });
        }

        return res.status(400).json({ valid: false, msg: 'Senha atual incorreta.' });
    } catch (error) {
        console.error('Erro ao verificar senha atual:', error);
        return res.status(500).json({ valid: false, msg: 'Erro ao verificar senha.' });
    }
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

// ============================================================================
// Edição de comentário próprio
// ============================================================================

router.get('/exibir_prof/:profId/comentario/:comentarioId/editar', async (req, res) => {
    const { profId, comentarioId } = req.params;
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');

    try {
        const [rows] = await pool.query(
            'SELECT * FROM comentarios WHERE id = ? AND professor_id = ?',
            [comentarioId, profId]
        );
        const comentario = rows[0];
        if (!comentario) {
            return res.redirect(`/exibir_prof/${profId}`);
        }

        const isAluno = !!req.session.user_aluno;
        const isOwner = isAluno
            ? comentario.aluno_id && comentario.aluno_id === user.id
            : comentario.usuario_nome === user.nome;

        if (!isOwner) {
            return res.redirect(`/exibir_prof/${profId}`);
        }

        res.render('pages/editar_comentario', {
            professorId: profId,
            comentario,
            session: req.session,
            user,
            erros: {}
        });
    } catch (error) {
        console.error('Erro ao carregar edição de comentário:', error);
        res.redirect(`/exibir_prof/${profId}`);
    }
});

router.post('/exibir_prof/:profId/comentario/:comentarioId/editar', async (req, res) => {
    const { profId, comentarioId } = req.params;
    const { texto, nota } = req.body;
    const user = req.session.user_aluno || req.session.user_prof;
    if (!user) return res.redirect('/login');
    if (!texto || texto.trim() === '') {
        return res.redirect(`/exibir_prof/${profId}/comentario/${comentarioId}/editar`);
    }

    try {
        const notaInt = nota ? parseInt(nota, 10) : null;
        if (notaInt !== null && (notaInt < 1 || notaInt > 5)) {
            return res.redirect(`/exibir_prof/${profId}/comentario/${comentarioId}/editar`);
        }

        const [rows] = await pool.query(
            'SELECT * FROM comentarios WHERE id = ? AND professor_id = ?',
            [comentarioId, profId]
        );
        const comentario = rows[0];
        if (!comentario) {
            return res.redirect(`/exibir_prof/${profId}`);
        }

        const isAluno = !!req.session.user_aluno;
        const isOwner = isAluno
            ? comentario.aluno_id && comentario.aluno_id === user.id
            : comentario.usuario_nome === user.nome;

        if (!isOwner) {
            return res.redirect(`/exibir_prof/${profId}`);
        }

        await pool.query(
            'UPDATE comentarios SET texto = ?, nota = ? WHERE id = ?',
            [texto.trim(), notaInt, comentarioId]
        );

        res.redirect(`/exibir_prof/${profId}`);
    } catch (error) {
        console.error('Erro ao editar comentário:', error);
        res.redirect(`/exibir_prof/${profId}`);
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
    if (!roomParts.includes(String(user.id))) return res.status(403).send('Acesso negado.');

    const partnerId = roomParts.find(id => id !== String(user.id));
    const partner = await getUserById(partnerId, false);
    if (!partner || !partner.id) return res.status(404).send('Usuário não encontrado.');

    let horariosDisponiveis = [];
    if (req.session.user_prof) {
        const spNow = getSaoPauloDateTime();
        const todaySp = spNow.slice(0, 10);
        const timeSp = spNow.slice(11, 16);
        const [rows] = await pool.query(
            `SELECT id, data, hora_inicio, hora_fim, preco
             FROM horarios_disponiveis
             WHERE professor_id = ? AND status = 'disponivel'
             ORDER BY data, hora_inicio`,
            [user.id]
        );
        horariosDisponiveis = rows.filter(h => {
            const d = h.data instanceof Date
                ? `${h.data.getFullYear()}-${String(h.data.getMonth() + 1).padStart(2, '0')}-${String(h.data.getDate()).padStart(2, '0')}`
                : String(h.data).slice(0, 10);
            const hi = String(h.hora_inicio).slice(0, 5);
            return d > todaySp || (d === todaySp && hi > timeSp);
        }).map(h => ({
            id: h.id,
            data: h.data instanceof Date
                ? `${h.data.getFullYear()}-${String(h.data.getMonth() + 1).padStart(2, '0')}-${String(h.data.getDate()).padStart(2, '0')}`
                : String(h.data).slice(0, 10),
            hora_inicio: String(h.hora_inicio).slice(0, 5),
            hora_fim: String(h.hora_fim).slice(0, 5),
            preco: Number(h.preco)
        }));
    }

    res.render('pages/chat', {
        user,
        room: roomId,
        interlocutorName: partner.nome || 'Conversa',
        partner: { id: String(partner.id), nome: partner.nome || 'Conversa', tipo: partner.tipo || null },
        horariosDisponiveis
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
        const ext = path.extname(filePath) || '.webm';
        const fileName = `gravacao-aula-${agendamentoId}${ext}`;
        const disposition = req.query.download === '1' ? 'attachment' : 'inline';
        res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);

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

router.post('/denuncia', (req, res) => {
  uploadDenunciaEvidencia(req, res, async (uploadErr) => {
    const user = req.session.user_aluno || req.session.user_prof;
    const { denunciado_id, conteudo_tipo, conteudo_id } = req.body || {};

    const renderWithError = async (status, erros, dadosExtra = {}) => {
      if (uploadErr && req.file?.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      const denunciado = denunciado_id ? await getUserById(denunciado_id) : null;
      return res.status(status).render('pages/denuncia', {
        erros,
        dados: { ...(req.body || {}), ...dadosExtra, denunciado_nome: denunciado ? denunciado.nome : '' },
        user,
        denunciado
      });
    };

    if (uploadErr) {
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? 'O arquivo de evidência deve ter no máximo 50MB.'
        : (uploadErr.message || 'Erro ao enviar arquivo de evidência.');
      return renderWithError(422, { evidencia_arquivo: { msg } });
    }

    await Promise.all([
      body('tipo').notEmpty().withMessage('O tipo de denúncia é obrigatório.').run(req),
      body('titulo').trim().isLength({ min: 5 }).withMessage('O título deve ter ao menos 5 caracteres.').run(req),
      body('descricao').trim().isLength({ min: 10 }).withMessage('A descrição deve ter ao menos 10 caracteres.').run(req),
      body('email').optional({ checkFalsy: true }).isEmail().withMessage('E-mail inválido.').run(req),
      body('evidencia').optional({ checkFalsy: true }).isURL().withMessage('Link de evidência inválido.').run(req),
      body('anonimo').optional().toBoolean().run(req),
      body('denunciado_id').optional().trim().run(req),
      body('conteudo_tipo').optional().trim().run(req),
      body('conteudo_id').optional().trim().run(req)
    ]);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return renderWithError(422, errors.mapped());
    }

    try {
      const { tipo, titulo, descricao, email, evidencia, anonimo } = req.body;
      const isAnonimo = anonimo || !user;
      const denuncianteId = isAnonimo ? null : user.id;
      const emailDenunciante = isAnonimo ? email : (user ? user.email : email);
      const conteudoInfo = conteudo_tipo && conteudo_id ? JSON.stringify({ tipo: conteudo_tipo, id: conteudo_id }) : null;
      const prioridade = tipo === 'seguranca' || tipo === 'assédio' ? 'alta' : 'baixa';
      const evidenciaArquivo = req.file ? `denuncia_evidencias/${req.file.filename}` : null;

      const [result] = await pool.query(
        'INSERT INTO denuncias (denunciante_id, denunciado_id, tipo, titulo, descricao, conteudo_info, email, evidencia, evidencia_arquivo, anonimo, prioridade, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [denuncianteId, denunciado_id || null, tipo, titulo, descricao, conteudoInfo, emailDenunciante, evidencia || null, evidenciaArquivo, isAnonimo, prioridade, 'aberta']
      );

      await pool.query(
        'INSERT INTO denuncia_historico (denuncia_id, acao, detalhes) VALUES (?, ?, ?)',
        [result.insertId, 'Criação', evidenciaArquivo ? 'Denúncia enviada pelo formulário com arquivo de evidência.' : 'Denúncia enviada pelo formulário.']
      );

      return res.redirect('/denuncia_sucesso');
    } catch (error) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      console.error('Erro ao salvar denúncia:', error);
      return renderWithError(500, { general: { msg: "Não foi possível registrar a denúncia. Tente novamente." } });
    }
  });
});

const DENUNCIA_EVIDENCIAS_DIR = path.join(__dirname, '..', 'private', 'denuncia_evidencias');

router.get('/denuncia/evidencia/:id', async (req, res) => {
    const user = req.session.user_admin;
    if (!user || !user.id) return res.status(401).send('Autenticação de administrador necessária.');

    const id = req.params.id;
    if (!/^\d+$/.test(id)) return res.status(400).send('Identificador inválido.');

    try {
        const [[denuncia]] = await pool.query('SELECT evidencia_arquivo FROM denuncias WHERE id = ?', [id]);
        if (!denuncia || !denuncia.evidencia_arquivo) return res.status(404).send('Evidência não encontrada.');

        const base = path.basename(String(denuncia.evidencia_arquivo).replace(/\\/g, '/'));
        if (!base || !/^evidencia-[\w.-]+\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$/i.test(base)) {
            return res.status(400).send('Arquivo de evidência inválido.');
        }
        const filePath = path.join(DENUNCIA_EVIDENCIAS_DIR, base);
        if (!fs.existsSync(filePath)) return res.status(404).send('Arquivo de evidência não encontrado.');

        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        return res.sendFile(filePath);
    } catch (error) {
        console.error('Erro ao servir evidência de denúncia:', error);
        return res.status(500).send('Erro ao acessar evidência.');
    }
});

router.get('/professor/previa/:id', async (req, res) => {
    const id = req.params.id;
    if (!/^[\w-]+$/.test(String(id))) return res.status(400).send('Identificador inválido.');
    try {
        const [[prof]] = await pool.query('SELECT previa_arquivo, aprovacao_status, status FROM professores WHERE id = ?', [id]);
        if (!prof || !prof.previa_arquivo) return res.status(404).send('Aula prévia não encontrada.');
        const isOwner = (req.session.user_prof && req.session.user_prof.id === id);
        const isAdmin = !!req.session.user_admin;
        const isApproved = prof.aprovacao_status === 'approved';
        const isActive = prof.status === 'ativo' || prof.status === 'disponivel';
        const isPublic = isApproved && isActive;
        if (!isOwner && !isAdmin && !isPublic) return res.status(403).send('Acesso negado.');

        const base = path.basename(String(prof.previa_arquivo).replace(/\\/g, '/'));
        if (!base || !/^previa-[\w.-]+\.(mp4|webm|mov|mkv)$/i.test(base)) return res.status(400).send('Arquivo inválido.');
        const filePath = path.join(AULAS_PREVIAS_DIR, base);
        if (!fs.existsSync(filePath)) return res.status(404).send('Arquivo não encontrado.');

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', isPublic ? 'public, max-age=3600' : 'private, max-age=0, must-revalidate');
        return res.sendFile(filePath, { acceptRanges: true });
    } catch (error) {
        console.error('Erro ao servir aula prévia:', error);
        return res.status(500).send('Erro ao acessar aula prévia.');
    }
});

router.get('/denuncia_sucesso', (req,res)=> {
  const user = req.session.user_aluno || req.session.user_prof;
  res.render('pages/denuncia_sucesso', { user });
});

// Notificações do usuário
router.get('/minhas-notificacoes', AlertasController.getMinhasNotificacoes);
router.post('/minhas-notificacoes/marcar-todas-lidas', AlertasController.marcarTodasLidas);
router.post('/minhas-notificacoes/:id/lida', AlertasController.marcarNotificacaoLida);
router.post('/minhas-notificacoes/:id/resolver', AlertasController.resolverNotificacao);
router.delete('/minhas-notificacoes/:id', AlertasController.excluirNotificacao);
router.get('/api/notificacoes/nao-lidas', AlertasController.countNaoLidas);

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
        const checkoutId = crypto.randomUUID();
        await PagamentoModel.create({
            checkout_id: checkoutId,
            preference_id: checkoutId,
            descricao: passeInfo.title,
            valor: passeInfo.price,
            criado_por: alunoId,
            status: 'pending'
        });
        const reference = encodeURIComponent(JSON.stringify({ checkoutId, passeTipo, alunoId }));
        return res.redirect(`/pagamento/sucesso?external_reference=${reference}&status=approved&dev_checkout=1&payment_id=${checkoutId}`);
    }

    try {
        const checkoutId = crypto.randomUUID();
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
            external_reference: JSON.stringify({ checkoutId, passeTipo, alunoId }),
            metadata: { checkoutId, passeTipo, alunoId },
        });

        const response = await mpPreferenceClient.create({ body: preference });
        const body = response.body || response;
        if (!body.id) {
            throw new Error('Mercado Pago não retornou o identificador da preferência.');
        }
        await PagamentoModel.create({
            checkout_id: checkoutId,
            preference_id: body.id,
            descricao: passeInfo.title,
            valor: passeInfo.price,
            criado_por: alunoId,
            status: 'pending'
        });
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
        let data;
        const rawRef = decodeURIComponent(external_reference);
        try {
            data = JSON.parse(rawRef);
        } catch (_) {
            data = { checkoutId: rawRef };
        }
        const checkoutId = data.checkoutId || (typeof rawRef === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawRef) ? rawRef : null);
        if (checkoutId) data.checkoutId = checkoutId;

        // Recupera contexto de agendamento quando a referência vier só como UUID (checkout_id)
        if (!(data.profId && data.horarioId && data.alunoId)) {
            let mpPayment = null;
            if (payment_id) {
                try {
                    const paymentClient = req.app.locals.mpPaymentClient;
                    if (paymentClient) mpPayment = await paymentClient.get({ id: payment_id });
                } catch (_) {}
            }
            const sources = [mpPayment?.metadata, mpPayment && { external_reference: mpPayment.external_reference }];
            for (const src of sources) {
                if (!src) continue;
                if (src.profId && src.horarioId && src.alunoId) {
                    data = { ...src, ...data, checkoutId: data.checkoutId || src.checkoutId || checkoutId };
                    break;
                }
                if (src.external_reference) {
                    try {
                        const ref = typeof src.external_reference === 'string' ? JSON.parse(src.external_reference) : src.external_reference;
                        if (ref && ref.profId && ref.horarioId && ref.alunoId) {
                            data = { ...ref, ...data, checkoutId: data.checkoutId || ref.checkoutId || checkoutId };
                            break;
                        }
                    } catch (_) {}
                }
            }
        }

        if (data.passeTipo && data.alunoId) {
            let approvedPayment = null;
            const devCheckout = req.query.dev_checkout === '1';
            if (devCheckout) {
                // checkout de desenvolvimento: pagamento considerado aprovado
            } else {
                const paymentClient = req.app.locals.mpPaymentClient;
                if (!payment_id || !paymentClient) {
                    return res.status(400).render('pages/pagamento_erro', { error: 'Não foi possível confirmar o pagamento.' });
                }
                approvedPayment = await paymentClient.get({ id: payment_id });
                if (!approvedPayment || approvedPayment.status !== 'approved') {
                    return res.status(400).render('pages/pagamento_erro', { error: 'O pagamento ainda não foi aprovado.' });
                }
            }

            const preferenceId = approvedPayment?.preference_id || checkoutId || null;
            let pendingPayment = null;
            if (checkoutId) pendingPayment = await PagamentoModel.findByCheckoutId(checkoutId);
            if (!pendingPayment && preferenceId) pendingPayment = await PagamentoModel.findByPreferenceId(preferenceId);
            if (!pendingPayment && payment_id) pendingPayment = await PagamentoModel.findByPaymentId(payment_id);

            // Garante registro pendente para liquidação/receita quando não existir (ex.: fluxo legado)
            if (!pendingPayment) {
                const passeInfoReg = passesDeEstudo[data.passeTipo];
                const valorReg = approvedPayment?.transaction_amount || passeInfoReg?.price || 0;
                try {
                    await PagamentoModel.create({
                        checkout_id: checkoutId || null,
                        preference_id: preferenceId,
                        payment_id: payment_id || null,
                        descricao: passeInfoReg?.title || `Passe de Estudos (${data.passeTipo})`,
                        valor: valorReg,
                        criado_por: data.alunoId,
                        status: 'pending'
                    });
                } catch (_) {
                    // ignora corrida/duplicidade; seguirá por lookup abaixo
                }
                if (checkoutId) pendingPayment = await PagamentoModel.findByCheckoutId(checkoutId);
                if (!pendingPayment && preferenceId) pendingPayment = await PagamentoModel.findByPreferenceId(preferenceId);
                if (!pendingPayment && payment_id) pendingPayment = await PagamentoModel.findByPaymentId(payment_id);
            }

            const settlement = await PaymentSettlementService.settleApprovedPayment({
                checkoutId: checkoutId || null,
                preferenceId,
                paymentId: payment_id || null
            });

            // Concede o passe apenas na primeira confirmação do pagamento (idempotente em replays/webhook+sucesso)
            const alreadyPaid = pendingPayment && (pendingPayment.status === 'pago' || pendingPayment.liberado_em);
            if (!alreadyPaid && !(settlement && settlement.alreadySettled)) {
                await PasseEstudoService.adicionarPasse(data.alunoId, data.passeTipo);
            }

            const passeInfo = passesDeEstudo[data.passeTipo];
            return res.render('pages/pagamento_sucesso', {
                paymentId: payment_id,
                status: status,
                message: `Compra do ${passeInfo ? passeInfo.title : 'Passe de Estudos'} realizada com sucesso! Você já pode usar seus benefícios.`
            });
        }

        if (data.profId && data.horarioId && data.alunoId) {
            let approvedPayment = null;
            const checkoutId = data.checkoutId || data.devCheckoutId || null;
            const devCheckout = req.query.dev_checkout === '1' && (data.devCheckoutId || checkoutId);
            if (devCheckout) {
                const devPayment = checkoutId
                    ? (await PagamentoModel.findByCheckoutId(checkoutId)) || (data.devCheckoutId ? await PagamentoModel.findByPreferenceId(data.devCheckoutId) : null)
                    : (data.devCheckoutId ? await PagamentoModel.findByPreferenceId(data.devCheckoutId) : null);
                if (!devPayment || devPayment.professor_id !== data.profId) {
                    return res.status(400).render('pages/pagamento_erro', { error: 'Checkout de teste inválido.' });
                }
            } else {
                const paymentClient = req.app.locals.mpPaymentClient;
                if (!payment_id || !paymentClient) {
                    return res.status(400).render('pages/pagamento_erro', { error: 'Não foi possível confirmar o pagamento.' });
                }
                approvedPayment = await paymentClient.get({ id: payment_id });
                if (!approvedPayment || approvedPayment.status !== 'approved') {
                    return res.status(400).render('pages/pagamento_erro', { error: 'O pagamento ainda não foi aprovado.' });
                }
                if (approvedPayment.external_reference) {
                    const extRef = String(approvedPayment.external_reference);
                    const matchesCheckout = checkoutId && extRef === String(checkoutId);
                    let matchesLegacy = false;
                    if (!matchesCheckout) {
                        try {
                            const confirmedReference = JSON.parse(extRef);
                            matchesLegacy = confirmedReference.profId === data.profId &&
                                String(confirmedReference.horarioId) === String(data.horarioId) &&
                                confirmedReference.alunoId === data.alunoId;
                        } catch (_) { matchesLegacy = false; }
                    }
                    if (!matchesCheckout && !matchesLegacy) {
                        return res.status(400).render('pages/pagamento_erro', { error: 'A referência do pagamento não corresponde ao agendamento.' });
                    }
                }
            }

            const preferenceId = approvedPayment?.preference_id || data.devCheckoutId || null;
            let pendingPayment = null;
            if (checkoutId) pendingPayment = await PagamentoModel.findByCheckoutId(checkoutId);
            if (!pendingPayment && preferenceId) pendingPayment = await PagamentoModel.findByPreferenceId(preferenceId);
            if (!pendingPayment && payment_id) pendingPayment = await PagamentoModel.findByPaymentId(payment_id);

            let salaId = pendingPayment?.sala || null;
            let professor = null;
            if (!pendingPayment || pendingPayment.status !== 'pago' || !pendingPayment.sala) {
                const connection = await pool.getConnection();
                let transactionStarted = false;
                try {
                    await connection.beginTransaction();
                    transactionStarted = true;

                    let lockedPayment = null;
                    if (pendingPayment?.id) {
                        const [rows] = await connection.query('SELECT * FROM pagamentos WHERE id = ? FOR UPDATE', [pendingPayment.id]);
                        lockedPayment = rows[0] || null;
                    } else if (checkoutId) {
                        const [rows] = await connection.query('SELECT * FROM pagamentos WHERE checkout_id = ? FOR UPDATE', [checkoutId]);
                        lockedPayment = rows[0] || null;
                    } else if (preferenceId) {
                        const [rows] = await connection.query('SELECT * FROM pagamentos WHERE preference_id = ? FOR UPDATE', [preferenceId]);
                        lockedPayment = rows[0] || null;
                    }

                    if (lockedPayment && lockedPayment.status === 'pago' && lockedPayment.sala) {
                        salaId = lockedPayment.sala;
                    } else {
                        const [horarioRows] = await connection.query('SELECT * FROM horarios_disponiveis WHERE id = ? FOR UPDATE', [data.horarioId]);
                        if (horarioRows.length === 0 || horarioRows[0].status !== 'disponivel') {
                            await connection.rollback();
                            transactionStarted = false;
                            return res.status(404).render('pages/pagamento_erro', { error: 'O horário selecionado não está mais disponível.' });
                        }
                        const horario = horarioRows[0];

                        const [agendamentoExistente] = await connection.query('SELECT id, sala_id FROM agendamentos WHERE horario_id = ? AND status = ? FOR UPDATE', [data.horarioId, 'ativo']);
                        if (agendamentoExistente.length > 0) {
                            salaId = agendamentoExistente[0].sala_id;
                            if (lockedPayment && salaId) {
                                await connection.query('UPDATE pagamentos SET sala = COALESCE(sala, ?), payment_id = COALESCE(payment_id, ?) WHERE id = ?', [salaId, payment_id || null, lockedPayment.id]);
                            }
                        } else {
                            await connection.query('UPDATE horarios_disponiveis SET status = ?, aluno_id = ? WHERE id = ?', ['agendado', data.alunoId, data.horarioId]);

                            salaId = crypto.randomBytes(16).toString('hex');
                            await connection.query(
                                'INSERT INTO agendamentos (aluno_id, professor_id, horario_id, sala_id, data, hora, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
                                [data.alunoId, data.profId, data.horarioId, salaId, horario.data, horario.hora_inicio, 'ativo']
                            );

                            const [aluno] = await connection.query('SELECT nome FROM alunos WHERE id = ?', [data.alunoId]);
                            const [professores] = await connection.query('SELECT nome FROM professores WHERE id = ?', [data.profId]);
                            professor = professores[0];
                            const mensagemProfessor = `Nova aula agendada com ${aluno[0].nome} para o dia ${horario.data} às ${horario.hora_inicio}.`;
                            const mensagemAluno = `Sua aula com ${professor.nome} foi agendada para o dia ${horario.data} às ${horario.hora_inicio}.`;
                            await connection.query(
                                'INSERT INTO notificacoes (usuario_id, usuario_tipo, tipo, mensagem) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
                                [data.profId, 'professor', 'novo_agendamento', mensagemProfessor, data.alunoId, 'aluno', 'novo_agendamento', mensagemAluno]
                            );

                            if (lockedPayment) {
                                await connection.query('UPDATE pagamentos SET sala = COALESCE(sala, ?), payment_id = COALESCE(payment_id, ?) WHERE id = ?', [salaId, payment_id || null, lockedPayment.id]);
                            } else {
                                await connection.query(
                                    `INSERT INTO pagamentos (checkout_id, preference_id, payment_id, sala, descricao, valor, criado_por, professor_id, status)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
                                    [checkoutId, preferenceId, payment_id || null, salaId, 'Aula agendada', approvedPayment?.transaction_amount || 0, data.alunoId, data.profId]
                                );
                            }

                            try {
                                if (data.from_recomendacao === '1' || data.origem_recomendacao === 'recomendados') {
                                    await RecomendacaoTrackingService.registrarAgendamentoCriado({
                                        alunoId: data.alunoId,
                                        professorId: data.profId,
                                        tentativaId: data.tentativa_id || null,
                                        posicao: data.posicao ? Number(data.posicao) : null,
                                        score: data.score ? Number(data.score) : null
                                    });
                                }
                            } catch (err) {
                            }
                        }
                    }

                    await connection.commit();
                    transactionStarted = false;
                } catch (error) {
                    if (transactionStarted) await connection.rollback();
                    throw error;
                } finally {
                    connection.release();
                }
            }

            if (!salaId) {
                const [appts] = await pool.query('SELECT sala_id FROM agendamentos WHERE horario_id = ? AND aluno_id = ? AND status = ? LIMIT 1', [data.horarioId, data.alunoId, 'ativo']);
                salaId = appts[0]?.sala_id || null;
            }

            const settlement = await PaymentSettlementService.settleApprovedPayment({
                checkoutId,
                preferenceId,
                paymentId: payment_id || null,
                professorId: data.profId,
                salaId
            });
            if (!settlement) {
                const existing = (checkoutId && await PagamentoModel.findByCheckoutId(checkoutId))
                    || (payment_id && await PagamentoModel.findByPaymentId(payment_id))
                    || (preferenceId && await PagamentoModel.findByPreferenceId(preferenceId));
                if (!existing) {
                    throw new Error('Pagamento confirmado sem registro correspondente para liquidação.');
                }
            }

            const room = req.query.room;
            if (room && typeof room === 'string' && room.startsWith('chat_')) {
                const io = req.app.locals.io;
                if (io) io.to(room).emit('paymentConfirmed', { checkoutId, id: payment_id || null, amount: Number(approvedPayment?.transaction_amount || pendingPayment?.valor || 0), payer: req.session.user_aluno?.nome || 'Aluno', status: status || 'approved', time: Date.now() });
            }
            return res.render('pages/pagamento_sucesso', {
                paymentId: payment_id,
                status: status,
                message: "Agendamento da aula concluído com sucesso!"
            });
        }

        // Checkout sem dados de agendamento/passe (ex.: pagamento avulso/chat) ou referência legada desconhecida:
        // confirma de forma idempotente quando houver identificadores e não trata como erro.
        if (checkoutId || payment_id) {
            try {
                await PaymentSettlementService.settleApprovedPayment({
                    checkoutId: checkoutId || null,
                    paymentId: payment_id || null
                });
            } catch (e) {
                console.warn('Confirmação best-effort no sucesso do pagamento falhou:', e?.message || e);
            }
            if (checkoutId) {
                try { await paymentsStore.updateByCheckoutId(checkoutId, { status: status || 'approved', paymentId: payment_id || undefined }); } catch (_) {}
            }
            const room = req.query.room;
            if (room && typeof room === 'string' && room.startsWith('chat_')) {
                const io = req.app.locals.io;
                if (io) io.to(room).emit('paymentConfirmed', { checkoutId, id: payment_id || null, amount: 0, payer: req.session.user_aluno?.nome || req.session.user_prof?.nome || 'Pagador', status: status || 'approved', time: Date.now() });
            }
            return res.render('pages/pagamento_sucesso', {
                paymentId: payment_id,
                status: status,
                message: req.query.room ? 'Pagamento confirmado com sucesso!' : 'Pagamento concluído com sucesso!'
            });
        }

        return res.render('pages/pagamento_sucesso', {
            paymentId: payment_id,
            status: status,
            message: 'Pagamento concluído com sucesso!'
        });

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
        
        const agora = getSaoPauloDateTime();
        const inicioMes = `${agora.slice(0, 7)}-01 00:00:00`;

        const [agendamentos] = await pool.query(
            `SELECT ag.id, ag.sala_id, ag.data, ag.hora, ag.status, ag.aluno_id,
                    a.nome as alunoNome, h.preco, h.hora_fim
             FROM agendamentos ag
             JOIN alunos a ON ag.aluno_id = a.id
             LEFT JOIN horarios_disponiveis h ON ag.horario_id = h.id
             WHERE ag.professor_id = ? AND ag.status IN ('ativo','concluido')`,
            [user.id]
        );

        const toDateTime = (d, t) => {
            const dataStr = d instanceof Date
                ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                : String(d).slice(0, 10);
            const horaStr = String(t || '').slice(0, 5);
            return { data: dataStr, hora: horaStr, local: `${dataStr} ${horaStr}:00` };
        };

        const aulas = agendamentos.map(ag => {
            const inicio = toDateTime(ag.data, ag.hora);
            const fim = ag.hora_fim ? toDateTime(ag.data, ag.hora_fim) : null;
            return {
                ...ag,
                data: inicio.data,
                hora: `${inicio.hora}:00`,
                horaInicio: inicio.hora,
                horaFim: fim ? fim.hora : null,
                salaId: ag.sala_id,
                aluno: { id: ag.aluno_id, nome: ag.alunoNome },
                inicioLocal: inicio.local,
                fimLocal: fim ? fim.local : null
            };
        }).sort((a, b) => a.inicioLocal.localeCompare(b.inicioLocal));

        const agoraDate = new Date();
        const limite24h = new Date(agoraDate.getTime() + 24 * 60 * 60 * 1000);
        const agora24 = getSaoPauloDateTime(agoraDate);
        const limite24 = getSaoPauloDateTime(limite24h);

        const aulasAtivas = aulas.filter(ag => ag.status === 'ativo');
        const proximaAula = aulasAtivas.find(ag => (ag.fimLocal || ag.inicioLocal) >= agora24) || null;
        const aulasProximas24h = aulasAtivas.filter(ag => ag.inicioLocal >= agora24 && ag.inicioLocal < limite24).length;

        const pagamentosAprovados = await FinanceService.getProfessorEarnings(user.id, inicioMes);
        const ganhosMes = {
            total: pagamentosAprovados.reduce((sum, p) => sum + Number(p.valor_liquido || 0), 0),
            concluidas: pagamentosAprovados.length,
            futuras: aulasAtivas.filter(ag => ag.inicioLocal >= agora24).length,
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
        
        // Registrar impressões das recomendações
        try {
            const recomendacoes = recomendacoesProfessores.recomendacoes || [];
            await Promise.allSettled(
                recomendacoes.map((rec, idx) => 
                    RecomendacaoTrackingService.registrarImpressao({
                        alunoId: user.id,
                        professorId: rec.id,
                        tentativaId: recomendacoesProfessores.tentativaId || null,
                        posicao: idx + 1,
                        score: rec.score || null
                    })
                )
            );
        } catch (err) {
            // Não quebrar fluxo por falha de log
        }
        
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
            const searchField = userType === 'aluno' ? 'p.nome' : 'al.nome';
            const raw = searchQuery.trim();
            const datePatterns = [];
            const br = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
            if (br) {
                const y = br[3].length === 2 ? `20${br[3]}` : br[3];
                datePatterns.push(`${y}-${String(br[2]).padStart(2,'0')}-${String(br[1]).padStart(2,'0')}`);
            }
            const iso = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
            if (iso) {
                datePatterns.push(`${iso[1]}-${String(iso[2]).padStart(2,'0')}-${String(iso[3]).padStart(2,'0')}`);
            }
            const like = `%${raw}%`;
            let where = `(${searchField} LIKE ? OR 'Matemática' LIKE ? OR DATE_FORMAT(a.data, '%d/%m/%Y') LIKE ? OR DATE_FORMAT(a.data, '%Y-%m-%d') LIKE ?)`;
            params.push(like, like, like, like);
            if (datePatterns.length) {
                where += ` OR DATE(a.data) IN (${datePatterns.map(() => '?').join(',')})`;
                params.push(...datePatterns);
            }
            query += ` AND ${where}`;
        }

        query += ` ORDER BY a.data DESC, h.hora_inicio DESC, a.id DESC`;

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

router.post('/api/recomendacao/registrar-clique', async (req, res) => {
    const user = req.session.user_aluno;
    if (!user) return res.status(401).json({ success: false });

    const { professorId, tentativaId = null, posicao = null, score = null } = req.body;
    if (!professorId) return res.status(400).json({ success: false });

    try {
        await RecomendacaoTrackingService.registrarClique({
            alunoId: user.id,
            professorId,
            tentativaId,
            posicao: posicao !== null && posicao !== '' ? Number(posicao) : null,
            score: score !== null && score !== '' ? Number(score) : null
        });
        res.json({ success: true });
    } catch (err) {
        res.json({ success: true });
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

            const keywords = !hasOptions
                ? (Array.isArray(sourceQuestion.keywords) && sourceQuestion.keywords.length ? sourceQuestion.keywords : activityNormalizer.parseKeywords(sourceQuestion.correctAnswer || r.resposta || ''))
                : [];
            return {
                text: r.enunciado,
                type: hasOptions ? 'multiple_choice' : (sourceQuestion.type || 'short_text'),
                options: options,
                correct: correctKey,
                correctAnswer: hasOptions
                    ? (r.explicacao || (options[correctKey] || correctKey))
                    : (r.explicacao || r.resposta || sourceQuestion.correctAnswer || ''),
                keywords
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

    // Integridade do gabarito: a alternativa "correta" informada pela atividade
    // é conferida contra o cálculo do backend antes de virar texto para o aluno.
    // Se houver incoerência, não geramos explicação sobre um gabarito falso.
    const conferencia = conferenceGabarito(question);
    if (!conferencia.ok) {
      console.error('[IA][GABARITO_INVALIDO] Explicação bloqueada |', conferencia.motivo);
      return res.status(409).json({ message: 'Não foi possível gerar a explicação: o gabarito desta questão é inconsistente.' });
    }

    const optionsText = Object.entries(question.options || {}).map(([k, v]) => `${k}) ${v}`).join(', ');
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
        const response = await postJson('/ia/generate-exercise', { prompt });

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

        // Trava de validação: nada é salvo se alguma questão for inválida.
        const resultado = await gerarQuestoesValidadas(iaPrompt);
        if (!resultado.ok) {
            return res.status(502).json({
                message: 'Não foi possível gerar uma atividade matematicamente válida. Tente um prompt diferente.'
            });
        }

        const data = resultado.data;
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
        const response = await postJson('/ia/generate-exercise', { prompt });
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

        try {
            const recomendacoes = recomendacoesProfessores.recomendacoes || [];
            await Promise.allSettled(
                recomendacoes.map((rec, idx) =>
                    RecomendacaoTrackingService.registrarImpressao({
                        alunoId: user.id,
                        professorId: rec.id,
                        tentativaId: details.tentativa.id || null,
                        posicao: idx + 1,
                        score: rec.score || null
                    })
                )
            );
        } catch (err) {
        }
        
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
    uploadProfileEdit(req, res, async (err) => {
        const isProf = !!req.session.user_prof;
        const isAluno = !!req.session.user_aluno;
        if (!isProf && !isAluno) return res.redirect('/login');

        const user = isProf ? req.session.user_prof : req.session.user_aluno;
        const renderPage = isProf ? 'pages/editar_perfil_prof' : 'pages/editar_perfil_aluno';
        const files = req.files || {};
        const fotoFile = Array.isArray(files.foto) ? files.foto[0] : null;
        const previaFile = Array.isArray(files.previa_arquivo) ? files.previa_arquivo[0] : null;

        if (err) {
            if (previaFile?.path && fs.existsSync(previaFile.path)) { try { fs.unlinkSync(previaFile.path); } catch (_) {} }
            const errField = err.field === 'previa_arquivo' ? 'previa_arquivo' : 'foto';
            const errMsg = err.code === 'LIMIT_FILE_SIZE'
                ? (errField === 'previa_arquivo' ? 'O vídeo de aula prévia deve ter no máximo 100MB.' : 'A foto deve ter no máximo 5MB.')
                : (err.message || 'Erro ao enviar arquivo.');
            return res.render(renderPage, { user, erros: { [errField]: { msg: errMsg } }, dados: req.body, session: req.session });
        }

        const previaErr = null;
        if (previaErr) {
            return res.render(renderPage, { user, erros: { previa_arquivo: { msg: previaErr.code === 'LIMIT_FILE_SIZE' ? 'O vídeo de aula prévia deve ter no máximo 100MB.' : (previaErr.message || 'Erro ao enviar vídeo de aula prévia.') } }, dados: req.body, session: req.session });
        }

        await body('nome').notEmpty().withMessage('O nome é obrigatório.').run(req);
        await body('email').isEmail().withMessage('O e-mail é inválido.').run(req);

        const erros = validationResult(req);
        if (!erros.isEmpty()) {
            if (req.filePrevia?.path && fs.existsSync(req.filePrevia.path)) { try { fs.unlinkSync(req.filePrevia.path); } catch (_) {} }
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

            if (fotoFile) {
                const base64Image = fotoFile.buffer.toString('base64');
                const dataUri = `data:${fotoFile.mimetype};base64,${base64Image}`;
                updatedData.foto_perfil = dataUri;
            }

            if (isProf) {
                updatedData.descricao = req.body.descricao || user.descricao;
                updatedData.status = req.body.status || user.status;

                const removerLinkPrevia = req.body.remover_link_previa === '1';
                const removerArquivoPrevia = req.body.remover_previa_arquivo === '1';
                const linkPreviaBody = typeof req.body.link_previa === 'string' ? req.body.link_previa.trim() : '';
                const previaFileSaved = previaFile || null;
                const temLinkAtual = !!user.link_previa;
                const temArquivoAtual = !!user.previa_arquivo;

                let linkPrevia = user.link_previa || null;
                let previaArquivo = user.previa_arquivo || null;

                if (previaFileSaved) {
                    if (previaArquivo) {
                        const oldBase = path.basename(String(previaArquivo).replace(/\\/g, '/'));
                        const oldPath = path.join(__dirname, '..', 'private', 'aulas_previas', oldBase);
                        if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
                    }
                    const dir = path.join(__dirname, '..', 'private', 'aulas_previas');
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    const ext = path.extname(previaFileSaved.originalname).toLowerCase() || '.mp4';
                    const filename = 'previa-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
                    fs.writeFileSync(path.join(dir, filename), previaFileSaved.buffer);
                    previaArquivo = `aulas_previas/${filename}`;
                    linkPrevia = null; // arquivo substitui link
                } else if (removerArquivoPrevia) {
                    if (previaArquivo) {
                        const oldBase = path.basename(String(previaArquivo).replace(/\\/g, '/'));
                        const oldPath = path.join(__dirname, '..', 'private', 'aulas_previas', oldBase);
                        if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
                    }
                    previaArquivo = null;
                }

                if (removerLinkPrevia) {
                    linkPrevia = null;
                } else if (linkPreviaBody) {
                    linkPrevia = linkPreviaBody;
                    if (previaArquivo) {
                        const oldBase = path.basename(String(previaArquivo).replace(/\\/g, '/'));
                        const oldPath = path.join(__dirname, '..', 'private', 'aulas_previas', oldBase);
                        if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
                    }
                    previaArquivo = null; // link substitui arquivo
                } else if (!previaFileSaved && !removerArquivoPrevia && temArquivoAtual) {
                    // manter arquivo existente implica sem link duplicado
                    linkPrevia = null;
                } else if (!previaFileSaved && !removerLinkPrevia && temLinkAtual && !temArquivoAtual) {
                    linkPrevia = user.link_previa;
                }

                updatedData.link_previa = linkPrevia;
                updatedData.previa_arquivo = previaArquivo;

                await pool.query('UPDATE professores SET nome=?, email=?, descricao=?, link_previa=?, previa_arquivo=?, status=?, foto_perfil=? WHERE id=?',
                    [updatedData.nome, updatedData.email, updatedData.descricao, updatedData.link_previa, updatedData.previa_arquivo, updatedData.status, updatedData.foto_perfil || user.foto_perfil, user.id]
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
    const itemsPerPage = somenteRecomendados ? 3 : 12;
    let recomendacoesProfessores = { focos: [], recomendacoes: [] };

    try {
        let sql = `
            SELECT p.id, p.nome, p.foto_perfil, p.descricao, p.status,
                   GROUP_CONCAT(d.nome SEPARATOR ', ') as disciplinas,
                   COALESCE(AVG(c.nota), 0) as avaliacao_media,
                   COUNT(c.id) as num_avaliacoes
            FROM professores p
            LEFT JOIN disciplinas d ON p.id = d.professor_id
            LEFT JOIN comentarios c ON c.professor_id = p.id AND c.nota IS NOT NULL
        `;
        const params = [];
        let hasWhere = false;

        // Apenas professores aprovados aparecem na busca pública e nos cards
        if (query) {
            sql += `
                WHERE (p.nome LIKE ? OR p.descricao LIKE ? OR d.nome LIKE ?)
                  AND p.aprovacao_status = 'approved'
                  AND p.status = 'disponivel'
            `;
            hasWhere = true;
            const likeQuery = `%${query}%`;
            params.push(likeQuery, likeQuery, likeQuery);
        }

        if (!hasWhere) {
            sql += ` WHERE p.aprovacao_status = 'approved' AND p.status = 'disponivel'`;
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

            try {
                const recomendacoes = recomendacoesProfessores.recomendacoes || [];
                await Promise.allSettled(
                    recomendacoes.map((rec, idx) =>
                        RecomendacaoTrackingService.registrarImpressao({
                            alunoId: req.session.user_aluno.id,
                            professorId: rec.id,
                            tentativaId: recomendacoesProfessores.tentativaId || null,
                            posicao: idx + 1,
                            score: rec.score || null
                        })
                    )
                );
            } catch (err) {
            }
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

    const agora = getSaoPauloDateTime();
    const inicioMes = `${agora.slice(0, 7)}-01 00:00:00`;

    try {
        const pagamentosAprovados = await FinanceService.getProfessorEarnings(user.id, inicioMes);

        const [aulasAgendadas] = await pool.query(
            `SELECT COUNT(*) as total
             FROM agendamentos ag
             WHERE ag.professor_id = ?
               AND ag.status = 'ativo'
               AND CONCAT(DATE_FORMAT(ag.data, '%Y-%m-%d'), ' ', DATE_FORMAT(ag.hora, '%H:%i:%s')) >= ?`,
            [user.id, agora]
        );

        const toAmount = value => Number(value || 0);
        let resumo = {
            mes: new Date().toLocaleString('pt-BR', {
                month: 'long',
                year: 'numeric',
                timeZone: 'America/Sao_Paulo'
            }),
            totalBruto: pagamentosAprovados.reduce((sum, pagamento) => sum + toAmount(pagamento.valor), 0),
            totalTaxas: pagamentosAprovados.reduce((sum, pagamento) => sum + toAmount(pagamento.taxa_plataforma), 0),
            totalGanhos: pagamentosAprovados.reduce((sum, pagamento) => sum + toAmount(pagamento.valor_liquido), 0),
            aulasConcluidas: pagamentosAprovados.length,
            aulasAgendadas: aulasAgendadas[0].total,
            ticketMedio: pagamentosAprovados.length > 0
                ? pagamentosAprovados.reduce((sum, pagamento) => sum + toAmount(pagamento.valor_liquido), 0) / pagamentosAprovados.length
                : 0
        };

        let movimentacoes = pagamentosAprovados.map(pagamento => ({
            titulo: `Aula com ${pagamento.aluno_nome}`,
            data: new Date(pagamento.liberado_em).toLocaleDateString('pt-BR', {
                timeZone: 'America/Sao_Paulo'
            }),
            hora: pagamento.hora || 'Pagamento aprovado',
            valorBruto: toAmount(pagamento.valor),
            taxa: toAmount(pagamento.taxa_plataforma),
            valor: toAmount(pagamento.valor_liquido)
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
        newActivity.questions = Object.values(newActivity.questions).map(q => {
            const keywords = Array.isArray(q.keywords)
                ? q.keywords.map(k => ({ text: String(k.text || '').trim(), required: String(k.required) === '1' || k.required === true, peso: Math.max(0.1, Number(k.peso) || 1) })).filter(k => k.text)
                : (q.keywords && typeof q.keywords === 'object' ? Object.values(q.keywords).map(k => ({ text: String(k.text || '').trim(), required: String(k.required) === '1' || k.required === true, peso: Math.max(0.1, Number(k.peso) || 1) })).filter(k => k.text) : []);
            const correctAnswer = q.correctAnswer || (keywords.length ? keywords.map(k => k.required ? (k.text + '*') : k.text).join(', ') : '');
            return { ...q, correctAnswer, keywords, options: q.options ? Object.values(q.options) : [] };
        });
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
    let atividadesRealizadas = new Set();

    if (user && user.tipo === 'aluno') {
        limiteDiario = await ActivityLimitService.getContagemAtividadesHoje(user.id);
        passeAtivo = await PasseEstudoService.verificarPasseAtivo(user.id);
        try {
            const [rows] = await pool.query(
                'SELECT DISTINCT atividade_id FROM tentativas_teste WHERE aluno_id = ? AND atividade_id IS NOT NULL',
                [user.id]
            );
            atividadesRealizadas = new Set(rows.map(r => String(r.atividade_id)));
        } catch (e) {
            console.error('Erro ao buscar atividades realizadas do aluno:', e);
        }
    }

    const activities = (await Promise.all(activitiesData.activities
        .filter(activity => !activity.isTest && !activity.alunoId)
        .map(async (activity) => {
            const creatorId = activity.alunoId || activity.professorId;
            if (!creatorId) return null; 
            const creator = await getUserById(creatorId, false);
            if (!creator || creator.tipo !== 'professor') return null;
            if (creator.aprovacao_status !== 'approved') return null;
            return {
                ...activity,
                professorNome: creator.nome || 'Professor',
                realizada: atividadesRealizadas.has(String(activity.id))
            };
        })
    )).filter(Boolean);

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

        const isWritten = !question.options || ['short_text', 'long_text', 'written'].includes(String(question.type || '').toLowerCase());

        // Integridade do gabarito: para objetiva, confere alternativa correta;
        // para escrita, não há gabarito de alternativa para conferir matematicamente.
        if (!isWritten) {
            const conferencia = conferenceGabarito(question);
            if (!conferencia.ok) {
                console.error('[IA][GABARITO_INVALIDO] Dica bloqueada |', conferencia.motivo);
                return res.status(409).json({ message: 'Não foi possível gerar a dica: o gabarito desta questão é inconsistente.' });
            }
        }

        const optionsText = question.options ? Object.entries(question.options).map(([key, value]) => `${key}) ${value}`).join('\n') : '';
        const keywords = Array.isArray(question.keywords) ? question.keywords.map(k => k.text).filter(Boolean) : [];
        const referenceAnswer = String(question.correctAnswer || question.correct || '').trim();

        const instrucao = isWritten
            ? `Aja como um tutor de matemática chamado Regi.

Sua tarefa é dar UMA dica curta para ajudar o aluno a responder uma questão escrita/dissertativa, sem entregar a resposta.

Questão: "${question.text}"
${referenceAnswer ? `Resposta/modelo esperado (NÃO revele): ${referenceAnswer}` : ''}
${keywords.length ? `Conceitos/palavras-chave importantes (NÃO cite diretamente como resposta): ${keywords.join(', ')}` : ''}

REGRAS INEGOCIÁVEIS:
1. NÃO escreva a resposta pronta, nem um trecho que possa ser copiado como resposta.
2. NÃO liste as palavras-chave/modelo esperado.
3. NÃO resolva completamente; apenas indique o raciocínio, conceito, fórmula ou dado que o aluno deve observar.
4. Se for cálculo, sugira o primeiro passo ou a operação/conceito a aplicar, sem dar o resultado final.
5. Dê no máximo UMA pergunta orientadora ou UMA sugestão de raciocínio.
6. Responda em 1 a 3 frases, em português do Brasil.`
            : `Aja como um tutor de matemática chamado Regi.

Sua tarefa é dar UMA dica curta para ajudar o aluno a resolver a questão abaixo, sem entregar a resposta.

Questão: "${question.text}"
${optionsText ? `Alternativas:\n${optionsText}` : ''}

REGRAS INEGOCIÁVEIS:
1. NÃO diga qual é a alternativa correta.
2. NÃO mencione a letra da resposta.
3. NÃO entregue o resultado final.
4. NÃO resolva a questão por completo.
5. Dê no máximo UMA pergunta orientadora ou UMA sugestão de raciocínio.
6. Responda em 1 a 3 frases, em português do Brasil.`;

        const response = await postJson('/ia/tutor/texto', { instrucao }, { timeoutMs: 60000 });

        if (!response.ok) {
            console.error('Erro da API de IA:', await response.text());
            throw new Error('A resposta do servidor de IA não foi OK.');
        }

        const data = await response.json();
        const dica = typeof data?.description === 'string' ? data.description.trim() : '';

        if (!dica) {
            throw new Error('A IA não retornou uma dica utilizável.');
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
        // Trava de validação: o teste de nivelamento só é criado se todas as
        // questões passarem na verificação matemática do backend.
        const resultado = await gerarQuestoesValidadas(prompt);
        if (!resultado.ok) {
            return res.status(502).send('Não foi possível gerar um teste matematicamente válido. Tente novamente.');
        }

        const data = resultado.data;
        const normalizedQuestions = activityNormalizer.normalizeActivityQuestions({ questions: data.questions || [] });

        const activities = activityStore.getActivities();

        const newActivity = {
            id: crypto.randomBytes(8).toString('hex'),
            alunoId: user.id,
            isTest: true,
            // O nivel escolhido precisa ser guardado: sem ele a trilha adaptativa
            // nao sabe a que serie o aluno pertence e serve qualquer habilidade.
            nivelEscolar: level || null,
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

        if (tarefa.tarefaTipo === 'CONCLUIDO' || tarefa.tarefaTipo === 'COTA_DIARIA') {
            return res.render('pages/trilha_concluida', { motivoCota: tarefa.tarefaTipo === 'COTA_DIARIA' });
        }

        const passeAtivo = await PasseEstudoService.verificarPasseAtivo(user.id);

        res.render('pages/trilha', {
            user,
            tarefa: tarefa,
            progresso,
            passeAtivo,
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
        const paymentClient = req.app.locals.mpPaymentClient;
        if (!paymentClient) {
          throw new Error('Cliente de pagamentos do Mercado Pago não está configurado.');
        }
        const paymentRes = await paymentClient.get({ id: paymentId });
        const payment = paymentRes || {};

        if (payment.status === 'approved') {
          const prefId = payment.preference_id;
          let room = payment.metadata?.room;
          const checkoutId = payment.metadata?.checkoutId || (typeof payment.external_reference === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payment.external_reference) ? payment.external_reference : null);

          if (!room && prefId) {
            const storedPref = await paymentsStore.getByPreferenceId(prefId);
            if (storedPref) room = storedPref.room;
          }

          if (room) {
            const io = req.app.locals.io;
            if (io) io.to(room).emit('paymentConfirmed', {
              id: paymentId,
              prefId,
              checkoutId,
              amount: payment.transaction_amount || 0,
              payer: payment.payer?.email || 'Pagador Desconhecido',
              status: payment.status,
              time: Date.now()
            });
          }

          if (prefId) {
            await paymentsStore.updateByPreferenceId(prefId, { status: payment.status, paymentId: String(paymentId), checkoutId: checkoutId || undefined });
          }
          if (checkoutId) {
            await paymentsStore.updateByCheckoutId(checkoutId, { status: payment.status, paymentId: String(paymentId), preferenceId: prefId || undefined });
          }

          const settlement = await PaymentSettlementService.settleApprovedPayment({
            checkoutId,
            preferenceId: prefId,
            paymentId: String(paymentId)
          });
          if (settlement) {
            console.log(`Pagamento confirmado/atualizado: checkout=${checkoutId || '-'}, pagamento=${settlement.pagamentoId}, repasse=${settlement.repasseId || '-'}`);
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
router.post('/admin/denuncias/:id/delete-comment', AdminDenunciaController.deleteReportedComment);
router.get('/admin/denuncias/:id/historico', AdminDenunciaController.getDenunciaHistorico);

// ============================================================================
// Configurações da Plataforma (Taxa, etc.)
// ============================================================================
router.get('/admin/config/platform-fee', async (req, res) => {
  try {
    const PlatformConfigService = require('../services/PlatformConfigService');
    const percentual = await PlatformConfigService.getPlatformFeePercent();
    res.json({ percentual });
  } catch (err) {
    console.error('Erro ao obter taxa da plataforma:', err);
    res.status(500).json({ error: 'Erro ao obter taxa da plataforma' });
  }
});

router.post('/admin/config/platform-fee', async (req, res) => {
  try {
    const { percentual } = req.body;
    if (percentual === undefined || percentual === null) {
      return res.status(400).json({ error: 'Percentual é obrigatório' });
    }
    const p = parseFloat(percentual);
    if (isNaN(p) || p < 0 || p > 100) {
      return res.status(400).json({ error: 'Percentual deve estar entre 0 e 100' });
    }
    const PlatformConfigService = require('../services/PlatformConfigService');
    await PlatformConfigService.setConfig('platform_fee_percent', String(p));
    res.json({ success: true, percentual: p });
  } catch (err) {
    console.error('Erro ao salvar taxa da plataforma:', err);
    res.status(500).json({ error: 'Erro ao salvar taxa da plataforma' });
  }
});

async function renderPerfilAdmin(req, res) {
    if (!req.session.user_admin) {
        return res.redirect('/admin/login');
    }
    try {
        const [rows] = await pool.query('SELECT id, nome, email, role FROM admins WHERE id = ?', [req.session.user_admin.id]);
        if (rows.length === 0) {
            req.session.destroy(() => {});
            return res.redirect('/admin/login');
        }
        const admin = rows[0];
        req.session.user_admin = { ...req.session.user_admin, ...admin };
        return res.render('pages/perfil_admin', { user: admin, session: req.session });
    } catch (error) {
        console.error('Erro ao carregar perfil do admin:', error);
        return res.redirect('/admin/dashboard');
    }
}

async function renderEditarPerfilAdmin(req, res, dados = {}, erros = {}) {
    if (!req.session.user_admin) {
        return res.redirect('/admin/login');
    }
    try {
        const [rows] = await pool.query('SELECT id, nome, email, role FROM admins WHERE id = ?', [req.session.user_admin.id]);
        if (rows.length === 0) {
            req.session.destroy(() => {});
            return res.redirect('/admin/login');
        }
        return res.render('pages/editar_perfil_admin', { user: rows[0], dados, erros, session: req.session });
    } catch (error) {
        console.error('Erro ao carregar edição de perfil do admin:', error);
        return res.redirect('/perfil_adm');
    }
}

router.get('/perfil_adm', renderPerfilAdmin);

router.get('/editar_perfil_adm', (req, res) => renderEditarPerfilAdmin(req, res));

router.post('/perfil_admin/editar', [
    body('nome').trim().isLength({ min: 3 }).withMessage('O nome deve ter pelo menos 3 caracteres.'),
    body('email').trim().isEmail().withMessage('Por favor, insira um email válido.').normalizeEmail(),
], async (req, res) => {
    if (!req.session.user_admin) {
        return res.redirect('/admin/login');
    }

    const adminId = req.session.user_admin.id;
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
        return renderEditarPerfilAdmin(req, res, req.body, erros.mapped());
    }

    const { nome, email } = req.body;
    try {
        const [existing] = await pool.query('SELECT id FROM admins WHERE email = ? AND id <> ?', [email, adminId]);
        if (existing.length > 0) {
            return renderEditarPerfilAdmin(req, res, req.body, { email: { msg: 'Este e-mail já está em uso.' } });
        }

        await pool.query('UPDATE admins SET nome = ?, email = ? WHERE id = ?', [nome, email, adminId]);
        req.session.user_admin = { ...req.session.user_admin, nome, email };
        req.session.save(() => res.redirect('/perfil_adm'));
    } catch (error) {
        console.error('Erro ao atualizar perfil do admin:', error);
        return renderEditarPerfilAdmin(req, res, req.body, { general: { msg: 'Erro ao salvar. Tente novamente.' } });
    }
});

router.get('/trilha_concluida', (req, res) => {
    res.render('pages/trilha_concluida', { motivoCota: false });
});

module.exports = router;