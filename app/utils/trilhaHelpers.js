const sanitizeAnswer = value => String(value ?? '').trim().toLowerCase();

const normalizeForComparison = value => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  const numeric = Number(raw);
  if (!Number.isNaN(numeric) && String(numeric) === raw) {
    return String.fromCharCode(96 + numeric);
  }
  return raw;
};

const feedbackFor = (questao, acertou, resposta) => {
  if (acertou) return questao.explicacao || 'Muito bem! Você acertou.';
  const key = `distrator_${sanitizeAnswer(resposta)}`;
  const distratorFeedback = questao[key] || questao.explicacao || 'Vamos reforçar este conceito antes de avançar.';
  const concepcaoKey = `concepcao_${sanitizeAnswer(resposta)}`;
  const concepcao = questao[concepcaoKey];
  if (concepcao) {
    return `${distratorFeedback} <br><small><strong>Concepção equivocada:</strong> ${concepcao}</small>`;
  }
  return distratorFeedback;
};

module.exports = {
  sanitizeAnswer,
  normalizeForComparison,
  feedbackFor
};
