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

const feedbackFor = (questao, acertou, resposta, { ocultarExplicacao = false } = {}) => {
  if (acertou) return questao.explicacao || 'Muito bem! Você acertou.';
  // Na repetição a explicação geral NÃO pode ir ao aluno: ela descreve o caminho
  // da resposta certa e anularia a nova tentativa.
  const generico = ocultarExplicacao
    ? 'Ainda não é essa. Reveja o enunciado e tente novamente.'
    : (questao.explicacao || 'Vamos reforçar este conceito antes de avançar.');
  const key = `distrator_${sanitizeAnswer(resposta)}`;
  const distratorFeedback = questao[key]
    ? `Sua resposta não é correta porque: ${questao[key]}`
    : generico;
  const concepcaoKey = `concepcao_${sanitizeAnswer(resposta)}`;
  const concepcao = questao[concepcaoKey];
  if (concepcao) {
    return `${distratorFeedback} <br><small><strong>Concepção equivocada:</strong> ${concepcao}</small>`;
  }
  return distratorFeedback;
};

/** Traduce la escalera de refuerzo del motor a pasos legibles para el alumno. */
const LEGENDA_REFORCO = Object.freeze({
  feedback_explicativo: 'Te explicamos por qué tu respuesta no era correcta.',
  representacion_diferente: 'Cambiamos la representación (gráfica, tabla o ejemplo concreto).',
  ejemplo_resuelto: 'Primero resolvemos juntos un ejemplo paso a paso.',
  verificar_prerequisito: 'Repasamos el prerrequisito necesario antes de continuar.',
  retomar_prerequisito: 'Volvemos al prerrequisito para asegurar la base.',
  pregunta_semelhante: 'Practicamos con una pregunta del mismo tipo.',
  practica_independiente: 'Finalmente resolvés un ejercicio por tu cuenta.'
});

const planoReforcoLegible = pasos => (pasos || []).filter(p => LEGENDA_REFORCO[p]).map(p => LEGENDA_REFORCO[p]);

/** Converte o nível escolhido na tela de nivelamento (ex.: "medio1") em ano. */
const anoDoNivel = (nivel) => {
  const n = String(nivel || '').toLowerCase().trim();
  const m = n.match(/^(?:fundamental|medio)(\d+)$/);
  if (!m) return null;
  const numero = Number(m[1]);
  if (!Number.isFinite(numero)) return null;
  return n.startsWith('medio') ? 9 + numero : numero; // médio 1º ano = 10
};

/**
 * Distribuição de dificuldade por série.
 *
 * Não é um PISO: toda série enxerga fácil, médio e difícil. O que muda é o peso
 * — quanto menor o ano, mais fácil do que difícil; quanto maior, o inverso.
 * Fund1-5 ainda podem ter questão difícil, e o médio não é só difícil (as
 * primeiras questões de um aluno novo tendem a cair no meio).
 */
const PESOS_DIFICULDADE = Object.freeze({
  fundamental_inicial: Object.freeze({ facil: 0.64, medio: 0.28, dificil: 0.08 }), // anos 1-5
  fundamental_final: Object.freeze({ facil: 0.36, medio: 0.44, dificil: 0.20 }),  // anos 6-9
  medio: Object.freeze({ facil: 0.20, medio: 0.44, dificil: 0.36 }),
  desconhecido: Object.freeze({ facil: 0.34, medio: 0.33, dificil: 0.33 })
});

const faixaDoAno = (ano) => {
  const n = Number(ano);
  if (!Number.isFinite(n) || n <= 0) return 'desconhecido';
  if (n <= 5) return 'fundamental_inicial';
  if (n <= 9) return 'fundamental_final';
  return 'medio';
};

const pesosDoAno = (ano) => PESOS_DIFICULDADE[faixaDoAno(ano)];

/**
 * Mistura a semente antes de sortear. Sem isto, sementes consecutivas como
 * 1, 2, 3... produzem valores quase iguais e a trilha repetiria a mesma
 * dificuldade várias vezes seguidas.
 */
const misturarSemente = (n) => {
  let h = (Number(n) || 1) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2654435761) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
};

/**
 * Sorteia uma dificuldade respeitando os pesos da série.
 * Determinístico: a mesma semente devolve sempre o mesmo resultado, para a
 * trilha não oscilar entre dificuldades a cada recarga da página.
 */
const dificuldadePorPeso = (ano, semente = 1) => {
  const pesos = pesosDoAno(ano);
  const r = misturarSemente(semente);
  const ordem = ['facil', 'medio', 'dificil'];
  let acumulado = 0;
  for (const d of ordem) {
    acumulado += pesos[d];
    if (r < acumulado) return d;
  }
  return ordem[ordem.length - 1];
};

module.exports = {
  sanitizeAnswer,
  normalizeForComparison,
  feedbackFor,
  planoReforcoLegible,
  anoDoNivel,
  faixaDoAno,
  pesosDoAno,
  dificuldadePorPeso,
  PESOS_DIFICULDADE
};
