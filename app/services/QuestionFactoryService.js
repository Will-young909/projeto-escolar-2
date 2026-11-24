'use strict';

/**
 * Pipeline de geração de questões por IA — o backend é a autoridade.
 *
 *   IA gera o PROBLEMA estruturado
 *        -> solucionador determina a resposta
 *        -> backend gera os distratores
 *        -> backend embaralha e define `correct`
 *        -> QuestionValidationService (barreira final, já existente)
 *        -> salva ou regenera
 *
 * Nada aqui aceita `options` nem `correct` vindos da IA. Se a IA produzir
 * qualquer um deles, são DESCARTADOS e recalculados aqui.
 */

const M = require('./MathValueService');
const Solvers = require('./ProblemSolverService');
const Distractors = require('./DistractorService');
const C = require('../constants/trilha');

/* ------------------------------------------------------------------ *
 * Montagem do prompt
 * ------------------------------------------------------------------ */

const PROIBICOES = [
  'NÃO escreva as alternativas (campo "options").',
  'NÃO escreva a resposta correta (campo "correct" é proibido).',
  'NÃO calcule o resultado: o sistema calcula.',
  'NÃO use tipos fora da lista permitida.',
  'NÃO escreva LaTeX nas frações: use o formato "3/5".',
  'Responda APENAS com o objeto JSON, sem texto antes ou depois.'
].join(' ');

/** Monta o prompt pedindo um PROBLEMA, não uma questão completa. */
function montarPrompt({ habilidade, dificuldade, tipo, tentativa = 1, feedback = null }) {
  const catalogo = Solvers.catalogoTipos([tipo]).filter(t => t.type === tipo);
  const cat = catalogo.length ? catalogo[0] : Solvers.catalogoTipos([tipo])[0];

  const linhas = [
    'Você cria PROBLEMAS matemáticos para uma trilha adaptativa.',
    `Habilidade: ${habilidade}.`,
    `Dificuldade: ${dificuldade}.`,
    '',
    'Use EXATAMENTE este tipo de problema, que é o único permitido nesta chamada:',
    `- type: "${cat.type}"`,
    `- O que ele representa: ${cat.descricao}`,
    '- Exemplo de estrutura:',
    JSON.stringify(cat.exemplo),
    '',
    'Regras:',
    PROIBICOES,
    'Todos os números usados no enunciado DEVEM aparecer em "data" (é assim que o sistema confere o problema).',
    'Escreva o enunciado em português do Brasil, natural e coerente com "data".'
  ];

  if (tentativa > 1) {
    linhas.push('', `Esta é a tentativa ${tentativa}. A anterior foi descartada. ${feedback || 'Gere um problema mais simples e direto.'}`);
  }
  return linhas.join('\n');
}

/* ------------------------------------------------------------------ *
 * Validação estrutural da resposta da IA
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Coerência entre o enunciado e problem.data
 *
 * A IA pode descrever um problema e enviar OUTROS números no `data`. O
 * solucionador é determinístico, então calcula com êxito a resposta dos
 * números errados e a questão é salva como se estivesse correta — foi
 * exatamente o que gerou "31/32" para um enunciado que diz 3/12.
 *
 * Aqui comparamos o que está ESCRITO com o que está DECLARADO, por valor
 * exato: "0,6", "3/5" e "\frac{3}{5}" são equivalentes e não acusam erro.
 * ------------------------------------------------------------------ */

/** Valores exatos de todos os números citados no enunciado. */
function numerosDoEnunciado(enunciado) {
  const texto = String(enunciado || '');
  const valores = [];
  // Pontuação que vem depois do número ("7/12,", "1350.") quebra o parser, mas
  // o enunciado real sempre traz vírgula/ponto. Remove só isso, preservando
  // as chaves do LaTeX (\frac{7}{12}) e o barra da fração (3/5).
  const registrar = bruto => {
    const limpo = String(bruto).replace(/[.,;:!?)\]}]*$/, m => (/[{}]/.test(m) ? m : ''));
    const v = M.lerValor(limpo.trim());
    if (v) valores.push(v);
  };

  // Frações primeiro ("\frac{3}{5}", "3/5") para não parti-las em 3 e 5.
  const semFracao = texto
    .replace(/\\d?frac\s*\{-?[\d.]+\}\s*\{[\d.]+\}/gi, m => { registrar(m); return ' '; })
    .replace(/[-+]?\d[\d.,]*\s*\/\s*[-+]?\d[\d.,]*/g, m => { registrar(m); return ' '; });
  (semFracao.match(/[-+]?\d[\d.,]*/g) || []).forEach(registrar);
  return valores;
}

/** Valores exatos declarados em `data`. `op`/`shape` são rótulos, não medidas. */
function numerosDoData(data, chave = 'dado', saida = []) {
  if (data === null || data === undefined) return saida;
  if (Array.isArray(data)) { data.forEach((item, i) => numerosDoData(item, `${chave}[${i}]`, saida)); return saida; }
  if (typeof data === 'object') {
    for (const [k, valor] of Object.entries(data)) {
      if (k === 'op' || k === 'shape' || k === 'operation') continue;
      numerosDoData(valor, chave ? `${chave}.${k}` : k, saida);
    }
    return saida;
  }
  const v = M.lerValor(data);
  if (v) saida.push({ chave, valor: v });
  return saida;
}

/**
 * Confere que enunciado e `data` falam dos mesmos números.
 * @returns {{ok: boolean, semTexto?: boolean, erros: string[]}}
 */
function verificarCoerenciaTextoDados(enunciado, problem) {
  const doTexto = numerosDoEnunciado(enunciado);
  // Sem número no enunciado não há o que comparar (ex.: enunciado genérico).
  if (!doTexto.length) return { ok: true, semTexto: true, erros: [] };

  const doData = numerosDoData(problem && problem.data, '');
  const erros = [];

  for (const { chave, valor } of doData) {
    if (!doTexto.some(t => M.iguais(t, valor))) {
      erros.push(`problem.data.${chave} = ${M.formatar(valor)} não aparece no enunciado`);
    }
  }
  // Fração citada no enunciado e ausente do `data` = transcrição incorreta.
  for (const t of doTexto) {
    if (M.eRacional(t) && t.d !== 1n && !doData.some(d => M.iguais(d.valor, t))) {
      erros.push(`enunciado cita ${M.formatar(t)}, ausente de problem.data`);
    }
  }
  return { ok: erros.length === 0, erros };
}

/** Confere que a IA devolveu um problema utilizável (e descartou options/correct). */
function validarProblema(bruto) {
  const erros = [];
  if (!bruto || typeof bruto !== 'object') return { ok: false, erros: ['resposta não é um objeto'] };

  const enunciado = String(bruto.question || bruto.enunciado || bruto.title || '').trim();
  if (enunciado.length < 20) erros.push('enunciado ausente ou curto demais');

  const problem = bruto.problem;
  if (!problem || typeof problem !== 'object') {
    return { ok: false, erros: [...erros, 'campo "problem" ausente (obrigatório)'] };
  }
  if (!problem.type) erros.push('problem.type ausente');
  if (!problem.data || typeof problem.data !== 'object') erros.push('problem.data ausente');

  // O enunciado e o `data` precisam descrever o MESMO problema.
  if (problem.type && problem.data && typeof problem.data === 'object') {
    const coerencia = verificarCoerenciaTextoDados(enunciado, problem);
    if (!coerencia.ok) erros.push(...coerencia.erros);
  }

  return { ok: erros.length === 0, erros, enunciado, problem };
}

/* ------------------------------------------------------------------ *
 * Montagem da questão final
 * ------------------------------------------------------------------ */

const LETRA_POR_INDICE = i => ['A', 'B', 'C', 'D', 'E'][i] || String(i + 1);

/**
 * Converte um problema validado em questão pronta para a trilha.
 * @returns {{ok: true, question} |{ok: false, reason, erros}}
 */
function construirQuestao({ bruto, habilidade, dificuldade, semente = 1, tipoSolicitado = null }) {
  // Tipo fora do registro morre aqui, antes de qualquer análise de coerência:
  // assim o motivo da rejeição continua sendo "tipo não suportado" e não uma
  // falha genérica de estrutura.
  if (bruto && bruto.problem && bruto.problem.type && !Solvers.REGISTRO[bruto.problem.type]) {
    return { ok: false, reason: 'unsupported_problem_type', tipo: bruto.problem.type, motivo: `tipo "${bruto.problem.type}" não está no registro` };
  }

  // O prompt pede UM tipo específico. Se a IA responder outro tipo suportado,
  // a questão seria salva com a etiqueta errada — foi o que gerou uma soma
  // ("Qual é a soma dos números 12, 15 e 20?") rotulada como Equações do 2º
  // Grau. Divergência regenera em vez de servir conteúdo de outro assunto.
  if (tipoSolicitado && bruto && bruto.problem && bruto.problem.type
      && bruto.problem.type !== tipoSolicitado) {
    return {
      ok: false,
      reason: 'tipo_divergente',
      tipo: bruto.problem.type,
      erros: [`a IA devolveu o tipo "${bruto.problem.type}" mas foi pedido "${tipoSolicitado}"`]
    };
  }

  const estrutura = validarProblema(bruto);
  if (!estrutura.ok) {
    return { ok: false, reason: 'invalid_structure', erros: estrutura.erros };
  }
  const { problem, enunciado } = estrutura;

  // O enunciado vai junto porque alguns solvers precisam recusar o que não
  // sabem resolver — `linear_equation`, por exemplo, não pode "validar" uma
  // equação de 2º grau e devolver um número inventado com toda confiança.
  const solucao = Solvers.solveStructuredProblem(
    problem && typeof problem === 'object' ? { ...problem, enunciado } : problem
  );
  if (!solucao.success) {
    // Tipo não suportado ou dados inválidos: regenera, nunca salva.
    return { ok: false, reason: solucao.reason, motivo: solucao.motivo, tipo: solucao.tipo };
  }

  const unidade = bruto.unit || bruto.unidade || null;
  const alternativas = Distractors.montarAlternativas({
    problem, tipo: solucao.tipo, answer: solucao.answer, unidade, quantidade: C.IA_VALIDACAO.TOTAL_ALTERNATIVAS, semente
  });
  if (!alternativas.ok) return { ok: false, reason: alternativas.reason };

  const indice = Number(alternativas.correct) - 1;
  const question = {
    title: bruto.title || enunciado.slice(0, 90),
    description: bruto.description || enunciado,
    question: enunciado,
    habilidade: bruto.habilidade || habilidade,
    dificuldade: bruto.dificuldade || dificuldade,
    options: alternativas.options,
    // `correct` é a posição da alternativa que o backend calculou.
    correct: alternativas.correct,
    // Campos de auditoria: deixam rastro de onde veio a resposta.
    _origem: 'pipeline_estruturado',
    _problemType: solucao.tipo,
    _respostaExata: solucao.exactAnswer,
    _distractors: alternativas.distractors
  };
  question.resposta = LETRA_POR_INDICE(indice);

  return { ok: true, question, solucao, alternativas };
}

module.exports = {
  montarPrompt, validarProblema, construirQuestao, LETRA_POR_INDICE,
  numerosDoEnunciado, numerosDoData, verificarCoerenciaTextoDados
};
