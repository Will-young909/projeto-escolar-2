'use strict';

/**
 * Tutor de IA para a TRILHA ADAPTATIVA.
 *
 * Dois recursos, com políticas de revelação OPOSTAS — e essa diferença é o ponto
 * central do desenho:
 *
 * - `pedirDica`    → usado nas tentativas 1-2. NÃO pode revelar a resposta, nem
 *   a letra do gabarito, nem o resultado da conta. A trilha tem repetição (3
 *   tentativas): se a dica entregasse a resposta, anularia a repetição que o
 *   aluno ainda tem pela frente.
 *
 * - `explicarErro` → usado na resolução definitiva, quando o aluno já errou e
 *   não há mais tentativa. Aí a explicação completa é o produto: por que errou,
 *   o conceito e o passo a passo até a resposta certa.
 *
 * Antes de chamar a IA, ambos passam por `conferenceGabarito`: não geramos texto
 * pedagógico a partir de gabarito falso. É a mesma trava dos endpoints de tutor
 * de `atividades`, extraída para `GabaritoConferenceService`.
 */

const { postJson } = require('../utils/internalFetch');
const { conferenceGabarito } = require('./GabaritoConferenceService');

// Explicação é mais lenta que gerar questão: o default de 30s do internalFetch
// é curto para texto longo com passo a passo.
const TIMEOUT_TUTOR_MS = 60000;

/** Monta o texto das alternativas para o prompt, sem expor qual é a correta. */
function listarAlternativas(questao) {
  if (!questao.options) return '(questão dissertativa, sem alternativas)';
  const entradas = Object.entries(questao.options).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');
  if (entradas.length === 0) return '(sem alternativas)';
  return entradas.map(([letra, texto]) => `${letra}) ${texto}`).join('\n');
}

/**
 * Chama o endpoint de texto do tutor e devolve a string gerada.
 * @returns {Promise<{ok: true, texto: string}|{ok: false, motivo: string}>}
 */
async function chamarTutor(instrucao) {
  let response;
  try {
    response = await postJson('/ia/tutor/texto', { instrucao }, { timeoutMs: TIMEOUT_TUTOR_MS });
  } catch (error) {
    return { ok: false, motivo: `falha de comunicação com a IA: ${error.message}` };
  }
  if (!response.ok) {
    // `text()` pode falhar se o corpo não for legível; não deixamos o erro de
    // log esconder o erro original.
    let detalhe = '';
    try { detalhe = (await response.text()).slice(0, 200); } catch { /* ignora */ }
    return { ok: false, motivo: `servidor de IA respondeu ${response.status} ${detalhe}`.trim() };
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, motivo: 'resposta da IA não é JSON válido' };
  }
  const texto = typeof data?.description === 'string' ? data.description.trim() : '';
  if (!texto) return { ok: false, motivo: 'IA não retornou texto' };
  return { ok: true, texto };
}

const TutorIAService = {
  /**
   * Dica para as tentativas 1-2. NÃO revela a resposta.
   *
   * A trava de gabarito roda igual: se o gabarito for incoerente, não geramos
   * dica nenhuma — uma dica construída sobre resposta errada ensinaria o errado.
   */
  async pedirDica({ questao, tentativaAtual = 1 }) {
    const conferencia = conferenceGabarito(questao);
    if (!conferencia.ok) {
      console.error('[TRILHA][TUTOR] Dica bloqueada |', conferencia.motivo);
      return { ok: false, bloqueado: true, motivo: conferencia.motivo };
    }

    const instrucao = `
Aja como um tutor de matemática chamado Regi, trabalhando com um aluno numa trilha adaptativa.

Sua tarefa é dar UMA dica curta que ajude o aluno a avançar NA PRÓPRIA TENTATIVA dele.

**Questão:**
"${questao.text || questao.titulo || questao.enunciado}"

**Alternativas:**
${listarAlternativas(questao)}

REGRAS INEGOCIÁVEIS (o aluno ainda vai tentar responder):
1. NÃO diga qual é a alternativa correta.
2. NÃO mencione a letra da resposta.
3. NÃO entregue o resultado final da conta.
4. NÃO resolva a questão.
5. Faça no máximo UMA pergunta orientadora ou UMA sugestão de raciocínio.
6. Sempre direto ao ponto, sem enrolação.

Tom: encorajador e direto. Escreva de 1 a 3 frases, em português do Brasil.
`.trim();

    const resultado = await chamarTutor(instrucao);
    if (!resultado.ok) {
      console.error('[TRILHA][TUTOR] Falha ao gerar dica |', resultado.motivo);
      return resultado;
    }
    console.log('[TRILHA][TUTOR][DICA] gerada | tentativa', tentativaAtual, '|', resultado.texto.length, 'caracteres');
    return { ok: true, texto: resultado.texto, tipo: 'dica' };
  },

  /**
   * Explicação completa do erro, para a resolução definitiva.
   * Aqui a resposta PODE (e deve) aparecer: não há mais tentativa em jogo.
   */
  async explicarErro({ questao, respostaDada = null }) {
    const conferencia = conferenceGabarito(questao);
    if (!conferencia.ok) {
      console.error('[TRILHA][TUTOR] Explicação bloqueada |', conferencia.motivo);
      return { ok: false, bloqueado: true, motivo: conferencia.motivo };
    }

    const gabarito = questao.correct || questao.resposta || null;
    const linhaAluno = respostaDada
      ? `- **Resposta do aluno:** alternativa "${respostaDada}"`
      : '- **Resposta do aluno:** não identificada';

    const instrucao = `
Aja como um tutor de matemática chamado Regi, trabalhando com um aluno numa trilha adaptativa.

O aluno já esgotou as tentativas nesta questão. Explique o erro com cuidado, sem humilhar.

**Questão:**
"${questao.text || questao.titulo || questao.enunciado}"

**Alternativas:**
${listarAlternativas(questao)}

${linhaAluno}
- **Resposta correta:** alternativa "${gabarito}"

**Sua resposta deve conter, nesta ordem:**
1. Por que a resposta do aluno está incorreta (uma frase, sem julgamento).
2. O conceito matemático necessário.
3. O passo a passo até a resposta correta, com os cálculos explícitos.
4. Uma frase final de incentivo.
5. Lembrando que você não tem acesso aos calculos do aluno, então explique de forma genérica, sem assumir o que ele fez.

Tom: amigável, didático e encorajador. Português do Brasil.
`.trim();

    const resultado = await chamarTutor(instrucao);
    if (!resultado.ok) {
      console.error('[TRILHA][TUTOR] Falha ao gerar explicação |', resultado.motivo);
      return resultado;
    }
    console.log('[TRILHA][TUTOR][EXPLICACAO] gerada |', resultado.texto.length, 'caracteres');
    return { ok: true, texto: resultado.texto, tipo: 'explicacao' };
  }
};

module.exports = TutorIAService;
