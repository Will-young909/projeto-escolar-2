'use strict';

/**
 * Conferência de integridade do gabarito de uma questão JÁ SALVA.
 *
 * Antes isto era a função privada `conferenceGabarito` em `router.js`. Foi
 * extraída para serviço porque a trilha adaptativa precisa da MESMA regra nos
 * endpoints de tutor (dica e explicação): não se gera texto pedagógico a partir
 * de um gabarito falso. Duplicar a política criaria duas fontes da mesma regra —
 * foi justamente uma divergência dessas que produziu o bug de dominância
 * corrigido no QuestionValidationService.
 *
 * Política (idêntica à original): quando a questão não é validável com segurança
 * (ex.: geometria sem fórmula fechada), a conferência é LIBERADA. Não é possível
 * provar o erro, e barrar nesses casos reprovaria conteúdo correto por falta de
 * cobertura do validador textual.
 */

const Validacao = require('./QuestionValidationService');

/**
 * Confere se o gabarito informado pela questão é matematicamente coerente.
 *
 * @param {object} question Questão já salva. Aceita `text`/`title`/`enunciado`
 *   para o enunciado e `options` + `correct` para as alternativas.
 * @returns {{ok: boolean, motivo: string}}
 *   `ok: false` apenas quando o backend CONSEGUIU conferir e achou incoerente.
 */
function conferenceGabarito(question) {
  const enunciado = String(question.text || question.title || question.enunciado || '').trim();
  const enunciadoSafe = enunciado.length < 10 ? (`Questão legada: ${enunciado}`).padEnd(20, '.') : enunciado;
  const relatorio = Validacao.validar({
    question: enunciadoSafe,
    title: enunciadoSafe,
    habilidade: String(question.habilidade || 'legado').trim() || 'legado',
    dificuldade: String(question.dificuldade || 'facil').trim() || 'facil',
    options: question.options,
    correct: question.correct
  });
  // Não validável => não há como provar incoerência: não bloqueia.
  if (!relatorio.validavel) return { ok: true, motivo: 'não validável' };
  // Falhas estruturais em questões legadas (metadados curtos/ausentes) não
  // comprovam gabarito matematicamente errado; só bloqueia erros estruturais
  // que impedem conferência segura do gabarito.
  if (relatorio.detalhes?.etapa === 'estrutura') {
    const errosBloqueantes = relatorio.errors.filter(e =>
      !/enunciado demasiado curto|habilidade ausente|dificuldade inválida/.test(e)
    );
    return errosBloqueantes.length === 0
      ? { ok: true, motivo: `estrutura legada ignorada: ${relatorio.errors.join(' ')}` }
      : { ok: false, motivo: errosBloqueantes.join(' ') };
  }
  return { ok: relatorio.valid, motivo: relatorio.errors.join(' ') };
}

module.exports = { conferenceGabarito };
