'use strict';

/**
 * Registro central dos tipos de problema que o RegiMath sabe resolver.
 *
 * Este registro é a ÚNICA fonte de verdade sobre o que é gerável:
 * - `tiposSuportados()` alimenta o prompt (a IA só pode propor o que existe);
 * - `solveStructuredProblem()` resolve o problema estruturado;
 * - tipo fora do registro => `unsupported_problem_type` (regenera, nunca salva).
 */

const solvers = require('./solvers/ProblemSolvers');
const M = require('./MathValueService');

/** Mapa tipo -> { fn, descricao, exemplo, habilidades } */
const REGISTRO = {
  addition: {
    fn: solvers.addition,
    descricao: 'soma de dois ou mais números',
    exemplo: { type: 'addition', data: { values: [48756, 39845, 54389] } },
    habilidades: ['Soma', 'Aritmética', 'Números Naturais']
  },
  subtraction: {
    fn: solvers.subtraction,
    descricao: 'subtração de vários valores a partir de um minuendo',
    exemplo: { type: 'subtraction', data: { minuend: 8500, subtrahends: [1320, 890] } },
    habilidades: ['Subtração', 'Aritmética', 'Números Naturais']
  },
  multiplication: {
    fn: solvers.multiplication,
    descricao: 'multiplicação de dois ou mais fatores',
    exemplo: { type: 'multiplication', data: { values: [25, 40, 12] } },
    habilidades: ['Multiplicação', 'Aritmética', 'Números Naturais']
  },
  division: {
    fn: solvers.division,
    descricao: 'divisão de um dividendo por um divisor',
    exemplo: { type: 'division', data: { dividend: 8400, divisor: 35 } },
    habilidades: ['Divisão', 'Aritmética', 'Números Naturais']
  },
  arithmetic_progression: {
    fn: solvers.arithmetic_progression,
    descricao: 'soma dos n primeiros termos de uma PA',
    exemplo: { type: 'arithmetic_progression', data: { first: 3, last: 30, terms: 10 } },
    habilidades: ['PA', 'Progressão Aritmética', 'Progressões', 'Sequências', 'Aritmética']
  },
  fraction_operation: {
    fn: solvers.fraction_operation,
    descricao: 'operações sucessivas com frações de um total (3/5 do total, tira 4/7 do que há, soma 1/3 do total)',
    exemplo: {
      type: 'fraction_operation',
      data: { initial: '3/5', steps: [{ op: 'remove_fraction_of_current', value: '4/7' }, { op: 'add_fraction_of_total', value: '1/3' }] }
    },
    habilidades: ['Frações', 'Razão e Proporção']
  },
  fraction_arithmetic: {
    fn: solvers.fraction_arithmetic,
    descricao: 'operação direta entre duas frações (add/subtract/multiply/divide)',
    exemplo: { type: 'fraction_arithmetic', data: { operation: 'add', a: '3/5', b: '1/4' } },
    habilidades: ['Frações']
  },
  percentage: {
    fn: solvers.percentage,
    descricao: 'porcentagem de uma base, aumento, desconto ou variação',
    exemplo: { type: 'percentage', data: { operation: 'increase', percent: 20, base: 850 } },
    habilidades: ['Porcentagem', 'Razão e Proporção']
  },
  linear_equation: {
    fn: solvers.linear_equation,
    descricao: 'equação de 1º grau na forma ax + b = c (pedir x)',
    exemplo: { type: 'linear_equation', data: { a: 3, b: 7, c: 100 } },
    habilidades: ['Equações', 'Álgebra']
  },
  area: {
    fn: solvers.area,
    descricao: 'área de retângulo, quadrado, triângulo, paralelogramo ou trapézio',
    exemplo: { type: 'area', data: { shape: 'triangle', a: 14, h: 9 } },
    habilidades: ['Geometria', 'Área', 'Perímetro']
  },
  perimeter: {
    fn: solvers.perimeter,
    descricao: 'perímetro de retângulo, quadrado ou triângulo',
    exemplo: { type: 'perimeter', data: { shape: 'rectangle', a: 12, b: 7 } },
    habilidades: ['Geometria', 'Perímetro', 'Área']
  },
  volume: {
    fn: solvers.volume,
    descricao: 'volume de paralelepípedo ou cubo',
    exemplo: { type: 'volume', data: { shape: 'cuboid', a: 8, b: 5, h: 3 } },
    habilidades: ['Geometria', 'Volume']
  },
  equal_volume_cylinder_sphere: {
    fn: solvers.equal_volume_cylinder_sphere,
    descricao: 'raio da esfera que tem o mesmo volume de um cilindro',
    exemplo: { type: 'equal_volume_cylinder_sphere', data: { cylinder_radius: 3, cylinder_height: 12 } },
    habilidades: ['Geometria', 'Volume', 'Esfera', 'Cilindro']
  }
};

/** Lista de tipos suportados (consumida pelo prompt). */
const tiposSuportados = () => Object.keys(REGISTRO);

/**
 * Tipos de problema sugeridos para uma habilidade específica.
 *
 * A comparação parcial precisa ser `nomeDaHabilidade.includes(tagDoTipo)`:
 * "Geometria Plana" CONTÉM a tag "Geometria". O inverso (`tag.includes(nome)`)
 * só funcionava por acaso com as tags idênticas ao nome (Soma, Frações,
 * Geometria) e fazia toda habilidade criada pela IA cair no catálogo inteiro,
 * servindo `addition` rotulado como "Equações do 2º Grau".
 *
 * Devolve lista VAZIA quando nada tem a ver com a habilidade: nesse caso o
 * pipeline determinístico não deve inventar um tipo — quem responde é o fluxo
 * legado, que pelo menos acerta o tema.
 */
/**
 * Habilidades cujo enunciado é, na prática, de grau > 1. `linear_equation` não
 * pode atendê-las: offering o tipo aqui só produziria uma resposta validada
 * errado. Sem esta lista a IA traduz a quadrática para {a,b,c} e o backend
 * "confere" um número inventado.
 */
const exigeGrauAcimaDeUm = /2\s*(?:º|o)?\s*grau|segundo\s*grau|2\s*a\s*grau|equa[cç][oõ]e\s+quadr[aá]tica/i;

function tiposParaHabilidade(habilidade) {
  const alvo = String(habilidade || '').toLowerCase().trim();
  if (!alvo) return tiposSuportados();
  const compat = tipo => {
    if (tipo === 'linear_equation' && exigeGrauAcimaDeUm.test(alvo)) return false;
    return true;
  };
  const exatos = Object.keys(REGISTRO).filter(tipo =>
    compat(tipo) && REGISTRO[tipo].habilidades.some(h => h.toLowerCase() === alvo));
  if (exatos.length) return exatos;
  return Object.keys(REGISTRO).filter(tipo =>
    compat(tipo) && REGISTRO[tipo].habilidades.some(h => alvo.includes(h.toLowerCase())));
}

/** Descrição completa dos tipos, para embedding no prompt. */
function catalogoTipos(lista = null) {
  // Array vazio é uma decisão explícita ("nada serve aqui") e NÃO pode cair no
  // catálogo inteiro: senão a correção acima seria anulada na hora de virar
  // prompt. Só `null`/`undefined` significa "não filtrado".
  const alvos = Array.isArray(lista) ? lista : tiposSuportados();
  return alvos.filter(t => REGISTRO[t]).map(tipo => ({
    type: tipo,
    descricao: REGISTRO[tipo].descricao,
    exemplo: REGISTRO[tipo].exemplo
  }));
}

/**
 * Resolve um problema estruturado de forma determinística.
 *
 * @param {{type: string, data: object}} problem
 * @returns {{success: true, tipo, answer, answerType, exactAnswer, display}
 *          |{success: false, reason: string, tipo, motivo}}
 */
/**
 * Grau que cada tipo de solver realmente sabe resolver.
 *
 * `linear_equation` só faz `x = (c - b) / a`. Alimentado com uma equação de
 * 2º grau ele devolve um número plausível e ERRADO com total confiança — o
 * pior tipo de falha, porque parece uma conferência bem-sucedida. Por isso o
 * dispatcher recusa enunciados de grau diferente do que ele sabe resolver.
 */
const GRAU_SUPORTADO = Object.freeze({
  linear_equation: 1
});

const SUPERESCRITO = { '²': 2, '³': 3 };

const padroesDeGrau = [
  /x\s*(?:\^|\*\*)\s*(\d+)/i,
  /x\s*([²³])/u,
  /x\s*([2-9])\s*(?:\+|-|=|²|³|$)/i
];

/**
 * Detecta o grau da equação no enunciado, ou null se não houver equação.
 *
 * O grupo capturado pode ser um dígito normal (`2` em `x^2`) ou um caractere
 * Unicode de superescrito (`²`). `Number('²')` é NaN, então o superescrito é
 * convertido explicitamente — sem isso os padrões abaixo nunca casariam e uma
 * equação de 2º grau passaria inteira pelo solver.
 */
function grauDoEnunciado(texto) {
  const t = String(texto || '');
  for (const padrao of padroesDeGrau) {
    const m = t.match(padrao);
    if (!m) continue;
    const n = SUPERESCRITO[m[1]] !== undefined ? SUPERESCRITO[m[1]] : Number(m[1]);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return null;
}

function solveStructuredProblem(problem) {
  if (!problem || typeof problem !== 'object') {
    return { success: false, reason: 'unsupported_problem_type', motivo: 'problema ausente ou não é objeto' };
  }
  const tipo = String(problem.type || '').trim();
  if (!tipo) return { success: false, reason: 'unsupported_problem_type', motivo: 'campo "type" ausente' };

  const entrada = REGISTRO[tipo];
  if (!entrada) {
    return { success: false, reason: 'unsupported_problem_type', tipo, motivo: `tipo "${tipo}" não está no registro` };
  }

  const grauEsperado = GRAU_SUPORTADO[tipo];
  if (grauEsperado !== undefined && problem.enunciado) {
    const grau = grauDoEnunciado(problem.enunciado);
    if (grau !== null && grau !== grauEsperado) {
      return {
        success: false,
        reason: 'unsupported_operation',
        tipo,
        motivo: `enunciado de grau ${grau}; "${tipo}" só resolve grau ${grauEsperado}`
      };
    }
  }

  const data = problem.data && typeof problem.data === 'object' ? problem.data : {};
  let resultado;
  try {
    resultado = entrada.fn(data);
  } catch (erro) {
    return { success: false, reason: 'solver_error', tipo, motivo: erro && erro.message ? erro.message : String(erro) };
  }

  if (!resultado || !resultado.success) {
    return { ...(resultado || {}), success: false, reason: (resultado && resultado.reason) || 'invalid_data', tipo };
  }
  if (!resultado.answer) {
    return { success: false, reason: 'invalid_data', tipo, motivo: 'solucionador não devolveu resposta' };
  }

  return {
    success: true,
    tipo,
    answer: resultado.answer,
    answerType: resultado.answerType || 'rational',
    exactAnswer: M.formatar(resultado.answer),
    display: M.formatar(resultado.answer),
    detalhe: resultado
  };
}

module.exports = {
  REGISTRO,
  tiposSuportados,
  tiposParaHabilidade,
  catalogoTipos,
  solveStructuredProblem
};
