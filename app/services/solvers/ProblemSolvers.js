'use strict';

/**
 * Solucionadores determinísticos de problemas estruturados.
 *
 * A IA propõe o PROBLEMA (tipo + parâmetros); estes serviços determinam a
 * VERDADE matemática. Tipo fora do registro => `unsupported_problem_type`.
 * Nunca se adivinha a resposta e nunca se usa o `correct` da IA.
 */

const M = require('../MathValueService');

const naoSuportado = (tipo, motivo) => ({ success: false, reason: 'unsupported_problem_type', tipo, motivo });

/** Lê um parâmetro numérico (string, número ou fração "3/5"). */
const num = v => M.lerValor(v);

const tipoDe = r => (M.eRacional(r) && r.d !== 1n ? 'fraction' : 'rational');

/* ------------------------------------------------------------------ *
 * Aritmética
 * ------------------------------------------------------------------ */

function addition({ values }) {
  if (!Array.isArray(values) || values.length < 2) {
    return { success: false, reason: 'invalid_data', motivo: 'addition exige ao menos 2 valores' };
  }
  const nums = values.map(num);
  if (nums.some(n => !n)) return { success: false, reason: 'invalid_data', motivo: 'valor não numérico em values' };
  const r = nums.reduce((a, b) => M.soma(a, b));
  return { success: true, answer: r, answerType: tipoDe(r) };
}

function subtraction({ minuend, subtrahends = [] }) {
  const a = num(minuend);
  const lista = Array.isArray(subtrahends) ? subtrahends : [subtrahends];
  const bs = lista.map(num);
  if (!a || bs.length === 0 || bs.some(b => !b)) {
    return { success: false, reason: 'invalid_data', motivo: 'subtraction inválida' };
  }
  const r = bs.reduce((acc, b) => M.subtrai(acc, b), a);
  return { success: true, answer: r, answerType: tipoDe(r) };
}

function multiplication({ values }) {
  if (!Array.isArray(values) || values.length < 2) {
    return { success: false, reason: 'invalid_data', motivo: 'multiplication exige ao menos 2 fatores' };
  }
  const nums = values.map(num);
  if (nums.some(n => !n)) return { success: false, reason: 'invalid_data', motivo: 'valor não numérico em values' };
  const r = nums.reduce((a, b) => M.multiplica(a, b));
  return { success: true, answer: r, answerType: tipoDe(r) };
}

function division({ dividend, divisor }) {
  const a = num(dividend);
  const b = num(divisor);
  if (!a || !b) return { success: false, reason: 'invalid_data', motivo: 'division inválida' };
  if (b.n === 0n) return { success: false, reason: 'invalid_data', motivo: 'divisão por zero' };
  const r = M.divide(a, b);
  return { success: true, answer: r, answerType: tipoDe(r) };
}

/** Soma dos n primeiros termos de uma PA: Sn = n·(a1 + an)/2. */
function arithmetic_progression({ first, last, terms }) {
  const a1 = num(first); const an = num(last); const n = num(terms);
  if (!a1 || !an || !n || n.n <= 0n) return { success: false, reason: 'invalid_data', motivo: 'PA inválida' };
  const r = M.multiplica(M.divide(M.soma(a1, an), M.rat(2)), n);
  return { success: true, answer: r, answerType: tipoDe(r) };
}

module.exports = { addition, subtraction, multiplication, division, arithmetic_progression, naoSuportado, num, tipoDe };

/* ------------------------------------------------------------------ *
 * Frações — o caso que a validação por texto não resolvia
 * ------------------------------------------------------------------ */

/**
 * Sequência de operações sobre frações de um "total".
 *
 *   { initial: "3/5",
 *     steps: [ { op: "remove_fraction_of_current", value: "4/7" },
 *              { op: "add_fraction_of_total",    value: "1/3" } ] }
 *
 * Devolve a fração final DO TOTAL (ex.: 62/105) ou o volume absoluto quando
 * `total` é informado.
 */
function fraction_operation(data) {
  const inicial = data.initial !== undefined ? data.initial : data.initial_fraction;
  let atual = num(inicial);
  if (!atual) return { success: false, reason: 'invalid_data', motivo: 'fração inicial ausente ou inválida' };
  if (atual.d === 1n && atual.n > 1n) {
    // A IA mandou a capacidade como "initial": não tratar inteiro como fração.
    return { success: false, reason: 'invalid_data', motivo: 'initial deve ser uma fração (ex.: "3/5")' };
  }

  for (const passo of (Array.isArray(data.steps) ? data.steps : [])) {
    const valor = num(passo && passo.value !== undefined ? passo.value : passo);
    if (!valor) return { success: false, reason: 'invalid_data', motivo: `passo inválido: ${JSON.stringify(passo)}` };
    const op = String((passo && passo.op) || '').toLowerCase();

    if (op === 'add_fraction_of_current' || op === 'add_fraction_of_present') atual = M.soma(atual, M.multiplica(atual, valor));
    else if (op === 'remove_fraction_of_current' || op === 'remove_fraction_of_present') atual = M.subtrai(atual, M.multiplica(atual, valor));
    else if (op === 'add_fraction_of_total' || op === 'add_fraction_of_capacity') atual = M.soma(atual, valor);
    else if (op === 'remove_fraction_of_total' || op === 'remove_fraction_of_capacity') atual = M.subtrai(atual, valor);
    else if (op === 'add_absolute' || op === 'add') atual = M.soma(atual, valor);
    else if (op === 'remove_absolute' || op === 'remove' || op === 'subtract') atual = M.subtrai(atual, valor);
    else return { success: false, reason: 'unsupported_operation', tipo: 'fraction_operation', motivo: `operação desconhecida: "${op}"` };

    if (atual.n < 0n) return { success: false, reason: 'invalid_data', motivo: 'resultado negativo (problema mal formulado)' };
  }

  const total = data.total !== undefined && data.total !== null ? num(data.total) : null;
  const final = total ? M.multiplica(atual, total) : atual;
  return { success: true, answer: final, answerType: tipoDe(final), fractionOfTotal: atual, total };
}

/** Operação simples entre duas frações. */
function fraction_arithmetic({ operation, a, b }) {
  const x = num(a); const y = num(b);
  if (!x || !y) return { success: false, reason: 'invalid_data', motivo: 'operandos de fração ausentes' };
  const op = String(operation || '').toLowerCase();
  let r;
  if (['add', 'soma', 'addition'].includes(op)) r = M.soma(x, y);
  else if (['subtract', 'subtracao', 'subtrai', 'subtraction'].includes(op)) r = M.subtrai(x, y);
  else if (['multiply', 'multiplica', 'multiplicacao', 'multiplication'].includes(op)) r = M.multiplica(x, y);
  else if (['divide', 'divisao', 'division'].includes(op)) {
    if (y.n === 0n) return { success: false, reason: 'invalid_data', motivo: 'divisão por zero' };
    r = M.divide(x, y);
  } else return naoSuportado('fraction_arithmetic', `operação desconhecida: "${op}"`);
  return { success: true, answer: r, answerType: tipoDe(r) };
}

/* ------------------------------------------------------------------ *
 * Porcentagem
 * ------------------------------------------------------------------ */

function percentage({ operation = 'of', percent, base }) {
  const p = num(percent); const b = num(base);
  if (!p || !b) return { success: false, reason: 'invalid_data', motivo: 'percentual ou base ausentes' };
  const centesimos = M.divide(p, M.rat(100));
  const op = String(operation).toLowerCase();
  let r;
  if (['of', 'de', 'percentual_de'].includes(op)) r = M.multiplica(b, centesimos);
  else if (['increase', 'aumento', 'acrescimo'].includes(op)) r = M.soma(b, M.multiplica(b, centesimos));
  else if (['decrease', 'desconto', 'reducao'].includes(op)) r = M.subtrai(b, M.multiplica(b, centesimos));
  else if (['increase_by', 'variacao'].includes(op)) r = M.multiplica(centesimos, M.rat(100));
  else if (['reverse', 'inversa'].includes(op)) { r = centesimos; }
  else return naoSuportado('percentage', `operação desconhecida: "${op}"`);
  return { success: true, answer: r, answerType: tipoDe(r) };
}

/* ------------------------------------------------------------------ *
 * Equações de 1º grau: ax + b = c  ->  x = (c - b)/a
 * ------------------------------------------------------------------ */

function linear_equation({ a, b, c }) {
  const A = num(a); const B = num(b); const C = num(c);
  if (!A || !B || !C) return { success: false, reason: 'invalid_data', motivo: 'coeficientes ausentes' };
  if (A.n === 0n) return { success: false, reason: 'invalid_data', motivo: 'coeficiente a não pode ser zero' };
  const r = M.divide(M.subtrai(C, B), A);
  return { success: true, answer: r, answerType: tipoDe(r) };
}

/* ------------------------------------------------------------------ *
 * Geometria
 * ------------------------------------------------------------------ */

function area({ shape, a, b, h, side }) {
  const A = num(a); const B = num(b); const H = num(h); const L = num(side);
  const s = String(shape || '').toLowerCase();

  if (['rectangle', 'retangulo'].includes(s)) {
    if (!A || !B) return { success: false, reason: 'invalid_data', motivo: 'retângulo exige a e b' };
    const r = M.multiplica(A, B);
    return { success: true, answer: r, answerType: tipoDe(r) };
  }
  if (['square', 'quadrado'].includes(s)) {
    if (!L) return { success: false, reason: 'invalid_data', motivo: 'quadrado exige side' };
    const r = M.multiplica(L, L);
    return { success: true, answer: r, answerType: tipoDe(r) };
  }
  if (['triangle', 'triangulo'].includes(s)) {
    if (!A || !H) return { success: false, reason: 'invalid_data', motivo: 'triângulo exige base (a) e altura (h)' };
    const r = M.divide(M.multiplica(A, H), M.rat(2));
    return { success: true, answer: r, answerType: tipoDe(r) };
  }
  if (['parallelogram', 'paralelogramo'].includes(s)) {
    if (!A || !H) return { success: false, reason: 'invalid_data', motivo: 'paralelogramo exige base e altura' };
    const r = M.multiplica(A, H);
    return { success: true, answer: r, answerType: tipoDe(r) };
  }
  if (['trapezoid', 'trapezio'].includes(s)) {
    if (!A || !B || !H) return { success: false, reason: 'invalid_data', motivo: 'trapézio exige bases e altura' };
    const r = M.divide(M.multiplica(M.soma(A, B), H), M.rat(2));
    return { success: true, answer: r, answerType: tipoDe(r) };
  }
  return naoSuportado('area', `figura não suportada: "${shape}"`);
}

function perimeter({ shape, a, b, h, side }) {
  const A = num(a); const B = num(b); const H = num(h); const L = num(side);
  const s = String(shape || '').toLowerCase();

  if (['rectangle', 'retangulo', 'quadrilatero'].includes(s)) {
    if (!A || !B) return { success: false, reason: 'invalid_data', motivo: 'retângulo exige a e b' };
    const r = M.multiplica(M.rat(2), M.soma(A, B));
    return { success: true, answer: r, answerType: tipoDe(r) };
  }
  if (['square', 'quadrado'].includes(s)) {
    if (!L) return { success: false, reason: 'invalid_data', motivo: 'quadrado exige side' };
    const r = M.multiplica(M.rat(4), L);
    return { success: true, answer: r, answerType: tipoDe(r) };
  }
  if (['triangle', 'triangulo'].includes(s)) {
    if (!A || !B || !H) return { success: false, reason: 'invalid_data', motivo: 'triângulo exige 3 lados' };
    const r = M.soma(A, M.soma(B, H));
    return { success: true, answer: r, answerType: tipoDe(r) };
  }
  return naoSuportado('perimeter', `figura não suportada: "${shape}"`);
}

function volume({ shape, a, b, h, side }) {
  const A = num(a); const B = num(b); const H = num(h); const L = num(side);
  const s = String(shape || '').toLowerCase();

  if (['cuboid', 'paralelepipedo', 'box', 'caixa'].includes(s)) {
    if (!A || !B || !H) return { success: false, reason: 'invalid_data', motivo: 'paralelepípedo exige 3 medidas' };
    const r = M.multiplica(A, M.multiplica(B, H));
    return { success: true, answer: r, answerType: tipoDe(r) };
  }
  if (['cube', 'cubo'].includes(s)) {
    if (!L) return { success: false, reason: 'invalid_data', motivo: 'cubo exige side' };
    const r = M.multiplica(L, M.multiplica(L, L));
    return { success: true, answer: r, answerType: tipoDe(r) };
  }
  return naoSuportado('volume', `sólido não suportado: "${shape}"`);
}

/**
 * Esfera com o MESMO volume de um cilindro (caso "3∛3 cm").
 *
 *   V_cilindro = πr²h ;  V_esfera = (4/3)πR³
 *   (4/3)πR³ = πr²h  ->  R³ = 3·r²·h/4
 *
 * Ex.: r=3, h=12 -> R³ = 3·9·12/4 = 81 -> R = ∛81 = 3∛3
 */
function equal_volume_cylinder_sphere({ cylinder_radius, cylinder_height }) {
  const r = num(cylinder_radius); const h = num(cylinder_height);
  if (!r || !h) return { success: false, reason: 'invalid_data', motivo: 'exige cylinder_radius e cylinder_height' };
  if (r.n <= 0n || h.n <= 0n) return { success: false, reason: 'invalid_data', motivo: 'medidas devem ser positivas' };
  const cubo = M.divide(M.multiplica(M.rat(3), M.multiplica(M.multiplica(r, r), h)), M.rat(4));
  const R = M.raizDe(cubo, 3);
  if (!R) return naoSuportado('equal_volume_cylinder_sphere', 'raiz cúbica não representável');
  return { success: true, answer: R, answerType: M.eRacional(R) && R.d === 1n ? 'rational' : 'radical', cuboRaio: cubo };
}

module.exports = {
  addition, subtraction, multiplication, division, arithmetic_progression,
  fraction_operation, fraction_arithmetic, percentage, linear_equation,
  area, perimeter, volume, equal_volume_cylinder_sphere,
  naoSuportado, num, tipoDe
};
