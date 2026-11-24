/**
 * Núcleo puro do motor adaptativo. Não acessa banco nem IA: isso torna as
 * decisões reproduzíveis e fáceis de testar.
 *
 * Evolución 2026 (avaliación profesional de la trilha):
 *  - Estados canónicos: `dominado`→`dominada`, `reforco`→`precisa_reforco`, `em_progresso`→`em_desenvolvimento`.
 *  - Modelo probabilístico de domínio por habilidade (recência, dificultad, tempo, incertidumbre, tendência, olvido).
 *  - Cierre de actividad por evidencia da sesión actual (no por histórico acumulado).
 *  - Revisión pendiente sin prioridad absoluta sobre el objetivo curricular.
 *  - Selección de objetivo por grafo curricular (frontera de pre-requisitos).
 *  - Escalera de intervención instruccional para el refuerzo.
 *  - Dificuldade ponderada por série escolar (todas las series ven las tres
 *    dificultades; cambia la proporción, no el acceso).
 */
const { dificuldadePorPeso } = require('../utils/trilhaHelpers');

const DEFAULTS = Object.freeze({
  thresholds: { reforco: 50, desenvolvimento: 70, proficiente: 85 },
  minimumAttemptsForMastery: 4,
  recentWindow: 4,
  recurringErrors: 2,
  difficultyWeights: { facil: 0.8, medio: 1, dificil: 1.2 },
  reviewIntervals: [1, 3, 7, 14, 30],
  activityCompletionMinAccuracy: 0.7,
  activityCompletionMinAttempts: 3,
  activityCompletionMaxErrors: 4,

  // Modelo probabilístico por habilidade
  prior: { alpha: 1, beta: 1 },
  recencyHalfLifeDays: 30,
  forgettingHalfLifeDays: 21,
  guessTimeSeconds: 3,
  slowTimeRatio: 2.5,
  slowAnswerFactor: 0.6,
  guessAnswerFactor: 0.4,
  trendDelta: 0.15,

  // Revisión espaciada balanceada (no prioridad absoluta)
  reviewOverdueThresholdDays: 3,
  reviewMaxPerDay: 5,
  reviewSessionCap: 2
});

/** Estados canónicos do motor. */
const MASTERY_STATUSES = Object.freeze(['dominada']);
/** Aliases de estados legados escritos por versões antigas de Regimath. */
const STATUS_ALIASES = Object.freeze({
  dominado: 'dominada',
  reforco: 'precisa_reforco',
  em_progresso: 'em_desenvolvimento'
});
const STATUS_CANONICO = Object.freeze(['nao_iniciado', 'em_desenvolvimento', 'proficiente', 'dominada', 'precisa_reforco']);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const diasEntre = (inicial, final) => Math.max(0, (final - inicial) / 86400000);

/**
 * Normaliza un estado de dominio a su forma canónica.
 * `dominado`→`dominada`, `reforco`→`precisa_reforco`, `em_progresso`→`em_desenvolvimento`.
 */
function normalizeStatus(status) {
  if (!status || typeof status !== 'string') return status;
  return STATUS_ALIASES[status] || status;
}

/**
 * Estado de dominio reconstruido a partir del histórico.
 * Los umbrales (>=85% proficiente/dominada, <50% reforço) están corregidos:
 * un resultado alto ya no puede caer en `em_desenvolvimento`.
 */
function masteryState({ history = [], currentPercent = 0 }, options = DEFAULTS) {
  if (!history.length) return { percentual: Number(currentPercent) || 0, status: 'nao_iniciado', consecutiveCorrect: 0, recentAccuracy: 0 };
  const weights = options.difficultyWeights;
  const weightedTotal = history.reduce((sum, item) => sum + (weights[item.dificuldade] || 1), 0);
  const weightedCorrect = history.reduce((sum, item) => sum + (item.acertou ? (weights[item.dificuldade] || 1) : 0), 0);
  const percentual = clamp((weightedCorrect / weightedTotal) * 100, 0, 100);
  const recent = history.slice(-options.recentWindow);
  const recentAccuracy = recent.filter(item => item.acertou).length / recent.length * 100;
  let consecutiveCorrect = 0;
  for (let index = history.length - 1; index >= 0 && history[index].acertou; index -= 1) consecutiveCorrect += 1;

  let status = 'em_desenvolvimento';
  if (history.length >= options.minimumAttemptsForMastery && percentual >= options.thresholds.proficiente && recentAccuracy >= options.thresholds.proficiente && consecutiveCorrect >= 2) status = 'dominada';
  else if (percentual >= options.thresholds.proficiente) status = 'proficiente';
  else if (percentual < options.thresholds.reforco || (recent.length >= options.recurringErrors && recent.filter(item => !item.acertou).length >= options.recurringErrors)) status = 'precisa_reforco';
  return { percentual: Number(percentual.toFixed(2)), status, consecutiveCorrect, recentAccuracy: Number(recentAccuracy.toFixed(2)) };
}

/**
 * Clasifica el resultado de una tentativa de diagnóstico por habilidad.
 * Corrección de la evaluación: >=85% ya no puede quedar en `em_desenvolvimento`.
 * `dominada` exige evidencia mínima; con pocas respuestas `proficiente` es el tope.
 */
function clasificarDiagnostico(percentual, total = 0, options = DEFAULTS) {
  if (total <= 0) return 'nao_iniciado';
  if (percentual >= options.thresholds.proficiente) {
    return total >= options.minimumAttemptsForMastery ? 'dominada' : 'proficiente';
  }
  if (percentual < options.thresholds.reforco) return 'precisa_reforco';
  return 'em_desenvolvimento';
}

const tendenciaDe = ({ recentAccuracy, overallAccuracy, delta }) => {
  const diff = recentAccuracy - overallAccuracy;
  if (diff >= delta) return 'ascendente';
  if (-diff >= delta) return 'declinante';
  return 'estable';
};

/**
 * Modelo probabilístico de domínio por habilidad.
 * Estimación tipo Beta-Bernoulli con ponderación por:
 *  - recência (half-life exponencial sobre los días desde la respuesta);
 *  - dificultad (pesos por dificultad);
 *  - tiempo de respuesta (chute <3s y respuestas lentas pesan menos);
 * Además estima incertidumbre, tendência e risco de olvido.
 */
function estimateProficiency({ history = [], now = null, currentPercent = 0 }, options = DEFAULTS) {
  const refDate = now && !Number.isNaN(new Date(now).getTime()) ? new Date(now) : new Date();
  const nowMs = refDate.getTime();
  const { alpha: priorAlpha, beta: priorBeta } = options.prior;
  let alpha = priorAlpha;
  let beta = priorBeta;
  let lastDateMs = null;
  let evidenciaPonderada = 0;

  const recent = history.slice(-options.recentWindow);
  const recentCorrect = recent.filter(item => item.acertou).length;
  const recentTotal = recent.length;

  for (const item of history) {
    const date = item.data_resposta ? new Date(item.data_resposta) : null;
    const itemMs = date && !Number.isNaN(date.getTime()) ? date.getTime() : null;
    if (itemMs !== null && (lastDateMs === null || itemMs > lastDateMs)) lastDateMs = itemMs;

    const daysAgo = itemMs !== null ? diasEntre(itemMs, nowMs) : 0;
    const freshness = Math.exp(-(Math.LN2 * daysAgo) / options.recencyHalfLifeDays);
    const dificultad = options.difficultyWeights[item.dificuldade] || 1;

    let factorTempo = 1;
    const tempo = Number(item.tempo_resposta_seg);
    if (Number.isFinite(tempo) && tempo >= 0) {
      const esperado = Number(item.tempo_esperado_seg);
      if (!item.acertou && tempo < options.guessTimeSeconds) factorTempo = options.guessAnswerFactor; // posible chute
      else if (item.acertou && Number.isFinite(esperado) && esperado > 0 && tempo > esperado * options.slowTimeRatio) factorTempo = options.slowAnswerFactor; // resolución lenta
    }

    const evidencia = freshness * dificultad * factorTempo;
    evidenciaPonderada += evidencia;
    if (item.acertou) alpha += evidencia;
    else beta += evidencia;
  }

  const total = alpha + beta;
  const probabilidad = total > 0 ? alpha / total : 0.5;
  const percentual = probabilidad * 100;

  let consecutiveCorrect = 0;
  for (let index = history.length - 1; index >= 0 && history[index].acertou; index -= 1) consecutiveCorrect += 1;

  const incerteza = total > 0 ? Math.sqrt((probabilidad * (1 - probabilidad)) / (total + 1)) : 0.5;
  const overallAccuracy = history.length ? history.filter(item => item.acertou).length / history.length : 0;
  const recencyAccuracy = recentTotal ? recentCorrect / recentTotal : overallAccuracy;
  const tendencia = tendenciaDe({ recentAccuracy: recencyAccuracy, overallAccuracy, delta: options.trendDelta });

  const daysSinceLast = lastDateMs !== null ? diasEntre(lastDateMs, nowMs) : null;
  const forgettingRisk = daysSinceLast !== null
    ? Math.min(1, 1 - Math.exp(-(Math.LN2 * daysSinceLast) / options.forgettingHalfLifeDays))
    : 0;

  let status = 'em_desenvolvimento';
  if (history.length >= options.minimumAttemptsForMastery && percentual >= options.thresholds.proficiente && recencyAccuracy >= options.thresholds.proficiente / 100 && consecutiveCorrect >= 2) status = 'dominada';
  else if (percentual >= options.thresholds.proficiente) status = 'proficiente';
  else if (percentual < options.thresholds.reforco || (recentTotal >= options.recurringErrors && (recentTotal - recentCorrect) >= options.recurringErrors)) status = 'precisa_reforco';

  return {
    probDominio: Number(probabilidad.toFixed(4)),
    incerteza: Number(incerteza.toFixed(4)),
    tendencia,
    riscoEsquecimento: Number(forgettingRisk.toFixed(4)),
    percentual: Number(percentual.toFixed(2)),
    status,
    consecutiveCorrect,
    recentAccuracy: Number((recencyAccuracy * 100).toFixed(2)),
    nEvidence: history.length,
    evidenciaPonderada: Number(evidenciaPonderada.toFixed(4)),
    diasDesdeUltimaResposta: daysSinceLast === null ? null : Number(daysSinceLast.toFixed(1)),
    ultimaRespostaEm: lastDateMs !== null ? new Date(lastDateMs).toISOString() : null
  };
}

/**
 * Escolhe a dificuldade da próxima questão.
 *
 * Não é um piso nem um teto: as três dificuldades continuam acessíveis em
 * qualquer série. O que a série faz é definir o PONTO DE PARTIDA sorteado —
 * quanto menor o ano, mais sorteios caem em fácil; quanto maior, em difícil.
 * O sinal do aluno (acerto/erro recente e status de domínio) desloca esse
 * ponto em um passo, o que mantém a trilha adaptativa sem perder a calibragem
 * curricular.
 */
function selectDifficulty({
  history = [],
  status = 'em_desenvolvimento',
  anoEscolar = null,
  semente = 1
}) {
  const order = ['facil', 'medio', 'dificil'];
  const preferencia = Math.max(0, order.indexOf(dificuldadePorPeso(anoEscolar, semente)));

  const recent = history.slice(-3);
  const correct = recent.filter(item => item.acertou).length;

  let ajuste = 0;
  if (status === 'precisa_reforco' || (recent.length >= 2 && correct === 0)) ajuste = -1;
  else if (recent.length >= 2 && correct === recent.length) ajuste = 1;

  return order[clamp(preferencia + ajuste, 0, order.length - 1)];
}

function difficultyPool(targetDifficulty = 'facil') {
  const order = ['facil', 'medio', 'dificil'];
  const index = Math.max(0, order.indexOf(targetDifficulty));
  return order
    .map((difficulty, position) => ({ difficulty, distance: Math.abs(position - index) }))
    .sort((left, right) => left.distance - right.distance || order.indexOf(left.difficulty) - order.indexOf(right.difficulty))
    .map(item => item.difficulty);
}

function isMastered(status) {
  return MASTERY_STATUSES.includes(normalizeStatus(status));
}

/**
 * Prioriza la revisión pendiente de forma balanceada.
 * La revisión NO tiene prioridad absoluta: solo interrumpe cuando no hay un
 * objetivo de aprendizaje activo (habilidad no iniciada o ya dominada) o cuando
 * el atraso supera `reviewOverdueThresholdDays`.
 */
function shouldServeReview({ skill = {}, history = [], dueReview = null, options = DEFAULTS }) {
  if (!dueReview) return false;
  const mastery = masteryState({ history, currentPercent: skill.percentual_dominio });
  const objetivoActivo = history.length > 0
    && mastery.status !== 'nao_iniciado'
    && mastery.status !== 'dominada'
    && mastery.status !== 'proficiente';
  const atraso = Number(dueReview.atraso_dias ?? dueReview.overdue_dias ?? dueReview.dias_atraso ?? 0);
  const urgente = atraso >= options.reviewOverdueThresholdDays;
  return !objetivoActivo || urgente;
}

/**
 * Grafo curricular: separa habilidades listas (frontera, con todos los
 * pre-requisitos dominados) de las bloqueadas, respetando el orden curricular.
 */
function grafoCurricular({ skills = [], edges = [] }) {
  const byId = new Map(skills.map(s => [s.habilidade_id, s]));
  const prereqsOf = (id) => edges.filter(e => e.habilidade_id === id).map(e => e.prerequisito_id);
  const pronta = (skill) => prereqsOf(skill.habilidade_id).every(pid => {
    const prereq = byId.get(pid);
    return !prereq || isMastered(prereq.status_dominio);
  });
  const ordemDe = (s) => Number.isFinite(s.ordem) ? Number(s.ordem) : Number.MAX_SAFE_INTEGER;
  const candidatas = skills
    .filter(s => !isMastered(s.status_dominio))
    .sort((a, b) => ordemDe(a) - ordemDe(b) || a.habilidade_id - b.habilidade_id);
  const frontera = candidatas.filter(pronta);
  const bloqueadas = candidatas.filter(s => !pronta(s)).map(s => ({
    ...s,
    prerequisitosFaltantes: prereqsOf(s.habilidade_id).filter(pid => {
      const prereq = byId.get(pid);
      return !prereq || !isMastered(prereq.status_dominio);
    })
  }));
  return { candidatas, frontera, bloqueadas, pronta };
}

/**
 * Elige el MEJOR próximo objetivo usando el grafo (no solo el orden por estado):
 *  - primera habilidad de la frontera en orden curricular, o
 *  - si ninguna está lista, el pre-requisito que bloquea la primera bloqueada.
 */
function selectNextObjective({ skills = [], edges = [] }) {
  const grafo = grafoCurricular({ skills, edges });
  if (grafo.frontera.length > 0) {
    const skill = grafo.frontera[0];
    return { skillId: skill.habilidade_id, skill, motivo: 'proximo_objetivo_curricular' };
  }
  if (grafo.bloqueadas.length > 0) {
    const bloqueada = grafo.bloqueadas[0];
    const prerequisitoId = bloqueada.prerequisitosFaltantes[0];
    return { skillId: prerequisitoId, skill: bloqueada, habilidadeBloqueadaId: bloqueada.habilidade_id, motivo: 'habilidade_bloqueada_por_prerequisito' };
  }
  return null;
}

/**
 * Escalera de intervención instruccional para el refuerzo.
 * Cada error consecutivo sube un nivel: explicación → representación →
 * ejemplo resuelto → verificar pre-requisito → retomar pre-requisito →
 * pregunta semejante → práctica independiente.
 */
function planReforco({ history = [] }) {
  let erroresConsecutivos = 0;
  for (let index = history.length - 1; index >= 0 && !history[index].acertou; index -= 1) erroresConsecutivos += 1;

  const pasos = [];
  if (erroresConsecutivos >= 1) pasos.push('feedback_explicativo');
  if (erroresConsecutivos >= 2) pasos.push('representacion_diferente');
  if (erroresConsecutivos >= 3) pasos.push('ejemplo_resuelto');
  if (erroresConsecutivos >= 4) pasos.push('verificar_prerequisito');
  if (erroresConsecutivos >= 5) pasos.push('retomar_prerequisito');
  pasos.push('pregunta_semelhante');
  pasos.push('practica_independiente');

  const nivel = Math.min(erroresConsecutivos + 1, pasos.length);
  return { erroresConsecutivos, nivelIntervencion: nivel, intervencionActual: pasos[Math.min(Math.max(erroresConsecutivos, 1), pasos.length) - 1], pasos };
}

/**
 * Cálculo puro del próximo intervalo de revisión espaciada.
 * Mantiene la secuencia pedagógica 1, 3, 7, 14, 30 y ajusta por confianza.
 */
function proximaRevisao({ intervaloDias = 0, acertou = true, confianca = null, options = DEFAULTS }) {
  const intervalos = options.reviewIntervals;
  const atual = Number(intervaloDias) || 0;
  if (!acertou) {
    return { intervaloDias: intervalos[0], fatorFacilidade: 2.3, motivo: 'resposta_incorrecta_revisar_mañana' };
  }
  const indice = intervalos.indexOf(atual);
  let intervalo;
  if (indice !== -1) intervalo = intervalos[indice + 1] || Math.max(intervalos[0], Math.round(atual * 2.5));
  else if (atual <= 0) intervalo = intervalos[0];
  else intervalo = Math.max(intervalos[0], Math.round(atual * 2.5));

  let factor = 1;
  if (Number.isFinite(confianca)) {
    if (confianca >= 0.8) factor = 1.2;
    else if (confianca <= 0.4) factor = 0.8;
  }
  if (factor !== 1) intervalo = Math.max(intervalos[0], Math.round(intervalo * factor));
  return { intervaloDias: intervalo, fatorFacilidade: 2.5, motivo: 'resposta_correcta_intervalo_creciente', confiancaUsada: Number.isFinite(confianca) ? confianca : null };
}

const MOTIVOS_EXPLICABLES = Object.freeze({
  revisao: (decisao, mastery) => decisao.atrasoDias && decisao.atrasoDias > 0
    ? `Revisión espaciada atrasada ${decisao.atrasoDias} día(s) para consolidar retención.`
    : 'Revisión espaciada programada para consolidar retención.',
  prerequisito: () => 'Antes de avanzar hay que consolidar un pré-requisito de esta habilidad.',
  reforco: (decisao, mastery) => `La evidencia muestra dificultad (${mastery ? Math.round(mastery.percentual ?? 0) : 0}% de dominio estimado). Intervención de refuerzo instruccional.`,
  avancar: (decisao, mastery) => `Dominio estable (${mastery ? Math.round(mastery.percentual ?? 0) : 0}%). Se desbloquea el próximo objetivo curricular.`,
  praticar: (decisao, mastery) => `Práctica con dificultad progresiva para consolidar (${mastery ? Math.round(mastery.percentual ?? 0) : 0}% actual).`
});

/**
 * Explicabilidad: responde por qué se eligió esta actividad, qué habilidad se
 * trabaja, qué evidencia motivó la decisión y qué falta para avanzar.
 */
function explicarDecisao({ decisao, skill = null, mastery = null }) {
  const nome = skill && (skill.descricao || skill.habilidade_nome)
    ? `"${skill.descricao || skill.habilidade_nome}"`
    : `la habilidad ${decisao.skillId ?? 'seleccionada'}`;
  const descritor = MOTIVOS_EXPLICABLES[decisao.action] || (() => `Motivo: ${decisao.reason ?? 'decisión del motor'}.`);
  const frase = descritor(decisao, mastery);
  const pista = decisao.action === 'avancar'
    ? 'Falta: ninguna. Podés avanzar al siguiente objetivo.'
    : (decisao.action === 'prerequisito' || decisao.action === 'reforco')
      ? 'Falta: responder correctamente la evidencia pendiente de refuerzo o aprendizaje.'
      : '';
  return `Habilidade: ${nome}. ${frase} ${pista}`.trim();
}

/**
 * Cierre de actividad basado en la evidencia de la SESIÓN ACTUAL.
 * `sessionHistory` (o `history`, por compatibilidad) debe ser la evidencia
 * recogida desde el inicio de la sesión, no el histórico acumulado del alumno.
 */
function shouldEndActivity({ sessionHistory = null, history = null, currentPercent = 0, consecutiveCorrect = null, recentAccuracy = null }, options = DEFAULTS) {
  const evidence = sessionHistory !== null ? sessionHistory : (history !== null ? history : []);
  if (evidence.length < options.activityCompletionMinAttempts) return false;
  const accuracy = evidence.filter(item => item.acertou).length / evidence.length;
  const recent = evidence.slice(-options.recentWindow);
  const recentAcc = recent.length ? recent.filter(item => item.acertou).length / recent.length : 0;
  let consec = 0;
  for (let index = evidence.length - 1; index >= 0 && evidence[index].acertou; index -= 1) consec += 1;
  const consFinal = consecutiveCorrect !== null ? consecutiveCorrect : consec;
  const recentPct = recentAccuracy !== null ? recentAccuracy : recentAcc * 100;
  if (accuracy >= options.activityCompletionMinAccuracy && consFinal >= 2) return true;
  if (recentPct >= options.thresholds.proficiente && evidence.length >= options.activityCompletionMinAttempts + 1) return true;
  if (evidence.filter(item => !item.acertou).length > options.activityCompletionMaxErrors) return false;
  return false;
}

function determineNextStep({ skill, prerequisites = [], history = [], sessionHistory = null, dueReview = false, currentDifficulty = 'facil', activity = null, anoEscolar = null, semente = 1 }) {
  const mastery = masteryState({ history, currentPercent: skill.percentual_dominio });
  // `dominado` (legacy) se normaliza a `dominada`: ambos significan prerequisito listo.
  const missingPrerequisite = prerequisites.find(item => !isMastered(item.status_dominio));

  // Revisión balanceada: NO interrumpe un objetivo de aprendizaje activo salvo
  // que esté realmente vencida (ver shouldServeReview).
  if (dueReview && shouldServeReview({ skill, history, dueReview })) {
    return {
      action: 'revisao', etapa: 'revisao', skillId: dueReview.habilidade_id, questaoId: dueReview.questao_id ?? null,
      difficulty: 'facil', reason: 'revisao_pendente', mastery, endActivity: false,
      atrasoDias: Number(dueReview.atraso_dias ?? dueReview.overdue_dias ?? 0),
      explicacao: explicarDecisao({ decisao: { action: 'revisao', skillId: dueReview.habilidade_id, atrasoDias: Number(dueReview.atraso_dias ?? dueReview.overdue_dias ?? 0) }, skill, mastery })
    };
  }
  if (missingPrerequisite) return { action: 'prerequisito', etapa: 'reforco', skillId: missingPrerequisite.habilidade_id, difficulty: 'facil', reason: 'prerequisito_nao_dominado', mastery, endActivity: false, explicacao: explicarDecisao({ decisao: { action: 'prerequisito', skillId: skill.habilidade_id }, skill, mastery }) };

  if (mastery.status === 'precisa_reforco') {
    return {
      action: 'reforco', etapa: 'reforco', skillId: skill.habilidade_id,
      difficulty: selectDifficulty({ history, status: mastery.status, anoEscolar, semente }),
      reason: 'baixo_desempenho_ou_erro_recorrente', mastery, endActivity: false,
      planoReforco: planReforco({ history }),
      explicacao: explicarDecisao({ decisao: { action: 'reforco', skillId: skill.habilidade_id }, skill, mastery })
    };
  }

  if (mastery.status === 'dominada') return { action: 'avancar', etapa: 'dominio', skillId: skill.habilidade_id, difficulty: 'dificil', reason: 'habilidade_dominada', mastery, endActivity: true, explicacao: explicarDecisao({ decisao: { action: 'avancar', skillId: skill.habilidade_id }, skill, mastery }) };

  const endActivity = shouldEndActivity({
    sessionHistory: sessionHistory !== null ? sessionHistory : history,
    consecutiveCorrect: mastery.consecutiveCorrect,
    recentAccuracy: mastery.recentAccuracy
  });
  return {
    action: 'praticar', etapa: history.length ? 'pratica' : 'aprendizagem', skillId: skill.habilidade_id,
    difficulty: selectDifficulty({ history, status: mastery.status, anoEscolar, semente }),
    reason: 'progresso_gradual', mastery, endActivity,
    explicacao: explicarDecisao({ decisao: { action: 'praticar', skillId: skill.habilidade_id }, skill, mastery })
  };
}

module.exports = {
  DEFAULTS,
  MASTERY_STATUSES,
  STATUS_ALIASES,
  STATUS_CANONICO,
  normalizeStatus,
  masteryState,
  clasificarDiagnostico,
  estimateProficiency,
  selectDifficulty,
  difficultyPool,
  determineNextStep,
  shouldEndActivity,
  shouldServeReview,
  isMastered,
  grafoCurricular,
  selectNextObjective,
  planReforco,
  proximaRevisao,
  explicarDecisao
};