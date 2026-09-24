/**
 * Núcleo puro do motor adaptativo. Não acessa banco nem IA: isso torna as
 * decisões reproduzíveis e fáceis de testar.
 */
const DEFAULTS = Object.freeze({
  thresholds: { reforco: 50, desenvolvimento: 70, proficiente: 85 },
  minimumAttemptsForMastery: 4,
  recentWindow: 4,
  recurringErrors: 2,
  difficultyWeights: { facil: 0.8, medio: 1, dificil: 1.2 },
  reviewIntervals: [1, 3, 7, 14, 30],
  activityCompletionMinAccuracy: 0.7,
  activityCompletionMinAttempts: 3,
  activityCompletionMaxErrors: 4
});

const MASTERY_STATUSES = Object.freeze(['dominada', 'dominado']);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

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

function selectDifficulty({ history = [], currentDifficulty = 'facil', status = 'em_desenvolvimento' }) {
  const order = ['facil', 'medio', 'dificil'];
  const current = Math.max(0, order.indexOf(currentDifficulty));
  const recent = history.slice(-3);
  const correct = recent.filter(item => item.acertou).length;
  let target = current;
  if (status === 'precisa_reforco' || (recent.length >= 2 && correct === 0)) target -= 1;
  else if (recent.length >= 2 && correct === recent.length) target += 1;
  return order[clamp(target, 0, order.length - 1)];
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
  return MASTERY_STATUSES.includes(status);
}

function shouldEndActivity({ history = [], currentPercent = 0, consecutiveCorrect = 0, recentAccuracy = 0 }, options = DEFAULTS) {
  if (history.length < options.activityCompletionMinAttempts) return false;
  const accuracy = history.filter(item => item.acertou).length / history.length;
  if (accuracy >= options.activityCompletionMinAccuracy && consecutiveCorrect >= 2) return true;
  if (recentAccuracy >= 85 && history.length >= options.activityCompletionMinAttempts + 1) return true;
  if (history.filter(item => !item.acertou).length > options.activityCompletionMaxErrors) return false;
  return false;
}

function determineNextStep({ skill, prerequisites = [], history = [], dueReview = false, currentDifficulty = 'facil', activity = null }) {
  const mastery = masteryState({ history, currentPercent: skill.percentual_dominio });
  // `dominado` is kept for compatibility with profiles written by older
  // versions of Regimath. Both values mean that a prerequisite is ready.
  const missingPrerequisite = prerequisites.find(item => !isMastered(item.status_dominio));

  if (dueReview) return { action: 'revisao', etapa: 'revisao', skillId: dueReview.habilidade_id, difficulty: 'facil', reason: 'revisao_pendente', mastery, endActivity: false };
  if (missingPrerequisite) return { action: 'prerequisito', etapa: 'reforco', skillId: missingPrerequisite.habilidade_id, difficulty: 'facil', reason: 'prerequisito_nao_dominado', mastery, endActivity: false };
  
  if (mastery.status === 'precisa_reforco') {
      let consecutiveErrors = 0;
      for (let i = history.length - 1; i >= 0; i--) {
          if (!history[i].acertou) {
              consecutiveErrors++;
          } else {
              break;
          }
      }

      if (consecutiveErrors === 1) {
          return { action: 'aprender', etapa: 'aprendizagem', skillId: skill.habilidade_id, difficulty: 'facil', reason: 'erro_recente_sugere_aprender', mastery, endActivity: false };
      }
      
      return { action: 'reforco', etapa: 'reforco', skillId: skill.habilidade_id, difficulty: selectDifficulty({ history, currentDifficulty, status: mastery.status }), reason: 'baixo_desempenho_ou_erro_recorrente', mastery, endActivity: false };
  }

  if (mastery.status === 'dominada') return { action: 'avancar', etapa: 'dominio', skillId: skill.habilidade_id, difficulty: 'dificil', reason: 'habilidade_dominada', mastery, endActivity: true };
  
  const endActivity = shouldEndActivity({ history, currentPercent: skill.percentual_dominio, consecutiveCorrect: mastery.consecutiveCorrect, recentAccuracy: mastery.recentAccuracy });
  return { action: 'praticar', etapa: history.length ? 'pratica' : 'aprendizagem', skillId: skill.habilidade_id, difficulty: selectDifficulty({ history, currentDifficulty, status: mastery.status }), reason: 'progresso_gradual', mastery, endActivity };
}

module.exports = { DEFAULTS, MASTERY_STATUSES, masteryState, selectDifficulty, difficultyPool, determineNextStep, shouldEndActivity, isMastered };
