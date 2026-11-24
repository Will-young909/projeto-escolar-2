'use strict';

/**
 * Valores matemáticos exatos para o pipeline de questões por IA.
 *
 * A IA pode errar a conta; o backend não. Para isso a resposta precisa ser
 * manipulada como valor matemático e não como texto. Suporta:
 *
 *   racional  { kind: 'rational', n, d }         142990, 62/105, -15.5
 *   radical   { kind: 'radical',  n, d, c, r, k } 3∛3, 2√5
 *              onde (n/d) · c · √[k]{r}
 *
 * Tudo em BigInt: `0.1 + 0.2` seria 0.30000000000000004 em Number, e isso
 * poderia reprovar uma alternativa correta.
 */

/* ------------------------------------------------------------------ *
 * Racionais
 * ------------------------------------------------------------------ */

const gcd = (a, b) => { let x = a < 0n ? -a : a; let y = b < 0n ? -b : b; while (y) { [x, y] = [y, x % y]; } return x; };

const rat = (n, d = 1n) => {
  let num = BigInt(n);
  let den = BigInt(d);
  if (den === 0n) throw new Error('Divisão por zero');
  if (den < 0n) { num = -num; den = -den; }
  const g = gcd(num, den) || 1n;
  return { kind: 'rational', n: num / g, d: den / g };
};

const ZERO = () => rat(0);
const soma = (a, b) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const subtrai = (a, b) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const multiplica = (a, b) => rat(a.n * b.n, a.d * b.d);
const divide = (a, b) => (b.n === 0n ? null : rat(a.n * b.d, a.d * b.n));

const eRacional = v => !!v && v.kind === 'rational';
const eRadical = v => !!v && v.kind === 'radical';

/* ------------------------------------------------------------------ *
 * Radicais
 * ------------------------------------------------------------------ */

/** Fatora números pequenos (limite para não travar com radicandos grandes). */
function fatorar(n) {
  const fatores = new Map();
  let resto = n;
  for (let p = 2n; p * p <= resto && p < 10n ** 7n; p += (p === 2n ? 1n : 2n)) {
    while (resto % p === 0n) { fatores.set(p, (fatores.get(p) || 0n) + 1n); resto /= p; }
  }
  if (resto > 1n) fatores.set(resto, (fatores.get(resto) || 0n) + 1n);
  return fatores;
}

/**
 * Simplifica c·√[k]{r} extraindo potências perfeitas: ∛81 -> 3∛3.
 * @returns {{c: bigint, r: bigint}} coeficiente e radicando livres de k-ésimas
 */
function simplificarRadical(c, r, k) {
  if (r <= 0n) return { c: 0n, r: 1n };
  const fatores = fatorar(r);
  let coeficiente = c < 0n ? -c : c;
  let radicando = 1n;
  for (const [primo, expoente] of fatores) {
    const fora = expoente / k;           // quantas k-ésimas saem
    const dentro = expoente % k;         // o que sobra dentro
    for (let i = 0n; i < fora; i++) coeficiente *= primo;
    for (let i = 0n; i < dentro; i++) radicando *= primo;
  }
  return { c: c < 0n ? -coeficiente : coeficiente, r: radicando };
}

/**
 * Cria um radical a partir de um radicando inteiro já conhecido.
 * Valor = 1 · √[k]{r}, simplificado (∛81 -> 3∛3).
 */
const criarRadical = (r, k) => {
  const { c, r: rad } = simplificarRadical(1n, BigInt(r), BigInt(k));
  if (rad === 1n) return rat(c); // raiz perfeita -> é racional
  return { kind: 'radical', n: c, d: 1n, r: rad, k: BigInt(k) };
};

/** Multiplica um radical por um racional. */
const multiplicarPorRacional = (fator, radicalValor) => {
  if (eRacional(radicalValor)) return multiplica(fator, radicalValor);
  return { kind: 'radical', n: fator.n, d: fator.d, r: radicalValor.r, k: radicalValor.k };
};

/**
 * Raiz k-ésima de um racional. √[k]{a/b} = √[k]{a} / √[k]{b}.
 * Devolve racional quando a raiz é exata, radical quando não, ou null.
 */
const raizDe = (v, k) => {
  if (!eRacional(v) || v.n < 0n || BigInt(k) < 2n) return null;
  const raizInteira = x => {
    if (x === 0n) return 0n;
    const s = BigInt(Math.round(Number(x) ** (1 / Number(k))));
    for (let i = -3n; i <= 3n; i++) {
      const cand = s + i;
      if (cand > 0n && cand ** BigInt(k) === x) return cand;
    }
    return null;
  };
  const rn = raizInteira(v.n);
  const rd = raizInteira(v.d);
  if (v.n === 0n) return rat(0);
  if (rn !== null && rd !== null) return rat(rn, rd);
  // √[k]{a/b} = (1/√[k]{b})·√[k]{a}   quando só o denominador tem raiz exata
  if (rd !== null) {
    const { c, r } = simplificarRadical(1n, v.n, BigInt(k));
    if (r === 1n) return rat(c, rd);
    return { kind: 'radical', n: c, d: rd, r, k: BigInt(k) };
  }
  // √[k]{a/b} = (√[k]{a}/√[k]{b'}) quando só o numerador tem raiz exata
  if (rn !== null) {
    const { c, r } = simplificarRadical(1n, v.d, BigInt(k));
    if (r === 1n) return rat(rn, c);
    return { kind: 'radical', n: rn * c, d: 1n, r, k: BigInt(k) };
  }
  return null; // raiz irracional de fração: fora do escopo suportado
};

/** Coeficiente inteiro × √[k]{r} — atalho semântico (usado pelo parser). */
const radicalComCoeficiente = (coeficiente, r, k) => {
  const base = criarRadical(r, k);
  return multiplicarPorRacional(coeficiente, base);
};

/* ------------------------------------------------------------------ *
 * Igualdade e conversão
 * ------------------------------------------------------------------ */

const CHAVE = v => (eRacional(v)
  ? `r:${v.n}/${v.d}`
  : `x:${v.n}/${v.d}:${v.r}:${v.k}`);

/** Radical que é na verdade racional (ex.: 2√9 -> 6). */
const racionalizar = v => {
  if (!eRadical(v)) return v;
  if (v.r === 1n) return rat(v.n, v.d);
  return null;
};

/** Compara dois valores exatos. */
function iguais(a, b) {
  if (!a || !b) return false;
  const ra = racionalizar(a);
  const rb = racionalizar(b);
  if (ra && rb) return ra.n === rb.n && ra.d === rb.d;
  if (eRadical(a) && eRadical(b)) return CHAVE(a) === CHAVE(b);
  // Um irracional nunca é igual a um racional.
  return false;
}

/** Valor decimal aproximado — só para exibição/relatório, nunca para decidir. */
function paraNumero(v) {
  if (!v) return null;
  if (eRacional(v)) return Number(v.n) / Number(v.d);
  if (eRadical(v)) {
    const base = (Number(v.n) / Number(v.d));
    return base * Math.pow(Number(v.r), 1 / Number(v.k));
  }
  return null;
}

/** Formatação canônica para exibição. */
function formatar(v) {
  if (!v) return null;
  if (eRacional(v)) {
    if (v.d === 1n) return String(v.n);
    return `${v.n}/${v.d}`;
  }
  if (eRadical(v)) {
    const n = v.n, d = v.d;
    const inteiro = d === 1n;
    let sinal = '';
    if (n < 0n) sinal = '-';
    const coefAbs = n < 0n ? -n : n;
    let corpo;
    if (inteiro) {
      corpo = coefAbs === 1n ? '' : String(coefAbs);
    } else {
      corpo = `${coefAbs}/${d}`;
    }
    const raiz = v.k === 2n ? '√' : v.k === 3n ? '∛' : v.k === 4n ? '∜' : `√[${v.k}]`;
    return `${sinal}${corpo}${raiz}${v.r}`;
  }
  return String(v);
}

/** Formatação com unidade herdada do enunciado (ex.: "630 litros"). */
function formatarComUnidade(v, unidade) {
  const base = formatar(v);
  if (!base) return null;
  if (!unidade) return base;
  if (eRacional(v) && v.d !== 1n) return base;
  return `${base} ${unidade}`;
}

/* ------------------------------------------------------------------ *
 * Leitura: texto -> valor exato
 * ------------------------------------------------------------------ */

const UNIDADES = /^(?:r\$|us\$|€|kg|kgs|g|mg|t|toneladas?|km|cm|mm|m|l|litros?|ml|un|unidades?|%|reais?|alunos?|itens?|anos?|dias?|horas?|min|segundos?|adotados?|metros?|centímetros?|milímetros?|gramas?|quilogramas?)$/i;

/** Detecta a unidade no final do texto ("630 litros" -> "litros"). */
function extrairUnidade(texto) {
  const partes = String(texto || '').trim().split(/\s+/);
  if (partes.length < 2) return null;
  const ultima = partes[partes.length - 1].replace(/[.;,]+$/, '');
  return UNIDADES.test(ultima) ? ultima : null;
}

/** Converte string decimal pt-BR em racional exato. */
function decimalParaRacional(bruto) {
  const limpo = String(bruto).replace(/[–—−]/g, '-');
  const negativo = /^\s*-/.test(limpo);
  const s = limpo.replace(/\s/g, '').replace(/^[+-]/, '');
  const temPonto = s.includes('.');
  const temVirgula = s.includes(',');
  let normalizado;

  if (temPonto && temVirgula) {
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const milhar = decimal === '.' ? ',' : '.';
    normalizado = s.split(milhar).join('').replace(decimal, '.');
  } else if (temVirgula) {
    normalizado = /^\d{1,3}(?:,\d{3})+$/.test(s) ? s.split(',').join('') : s.replace(',', '.');
  } else if (temPonto) {
    normalizado = /^\d{1,3}(?:\.\d{3})+$/.test(s) ? s.split('.').join('') : s;
  } else {
    normalizado = s;
  }

  if (!/^\d+(?:\.\d+)?$/.test(normalizado)) return null;
  const [i, f = ''] = normalizado.split('.');
  const den = f.length ? 10n ** BigInt(f.length) : 1n;
  const valor = BigInt(i + f);
  return negativo ? rat(-valor, den) : rat(valor, den);
}

/**
 * Lê uma alternativa textual e devolve o valor matemático exato.
 *
 * Formatos aceitos (com ou sem unidade, em pt-BR ou en-US):
 *   "142.990"  "142990"  "142 990"  "142,990"  "R$ 142.990,00"
 *   "62/105"   "0,6"     "0.6"
 *   "3∛3"      "3raiz3"  "3 raiz cubica de 3"  "3√3"  "2√5"  "√2"
 *
 * @returns {object|null} valor exato ou null se não for número/radical
 */
function lerValor(entrada) {
  if (typeof entrada === 'bigint') return rat(entrada);
  if (typeof entrada === 'number') {
    return Number.isFinite(entrada) ? decimalParaRacional(String(entrada)) : null;
  }
  if (entrada === null || entrada === undefined) return null;

  let texto = String(entrada).trim();
  if (!texto) return null;
  // LaTeX常见: \frac{62}{105}, \sqrt[3]{3}
  const fracLatex = texto.match(/\\d?frac\s*\{(-?[\d.]+)\}\s*\{([\d.]+)\}/);
  if (fracLatex) {
    const num = decimalParaRacional(fracLatex[1]);
    const den = decimalParaRacional(fracLatex[2]);
    if (num && den && den.n !== 0n) return divide(num, den);
    return null;
  }
  const raizLatex = texto.match(/\\sqrt\s*(?:\[\s*(\d+)\s*\])?\s*\{([^{}]+)\}/);
  if (raizLatex) {
    const k = raizLatex[1] ? BigInt(raizLatex[1]) : 2n;
    const base = decimalParaRacional(raizLatex[2]);
    if (!base || base.n < 0n) return null;
    return raizDe(base, k);
  }

  texto = texto.replace(/\s+/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/[×x]\s*/gi, '*')
    .replace(/[÷]/g, '/');

  // Fração "a/b" (inclusive com sinal).
  const fracao = texto.match(/^([+-]?[\d.,\s]+)\s*\/\s*([+-]?[\d.,\s]+)$/);
  if (fracao) {
    const num = decimalParaRacional(fracao[1]);
    const den = decimalParaRacional(fracao[2]);
    if (!num || !den || den.n === 0n) return null;
    return divide(num, den);
  }

  // Radical escrito por extenso ou com símbolo: "3∛3", "3raiz cubica de 3", "2√5", "√2".
  const ehCubes = /∛|raiz\s+c[úu]bica/i.test(texto);
  const ehQuartica = /∜|raiz\s+quartica/i.test(texto);
  const temSimboloRaiz = /√|∛|∜/.test(texto);
  const radicalTexto = texto.match(/^([+-]?[\d.,]+)?\s*((?:√|∛|∜|raiz\s+(?:c[úu]bica|quartica|quadratica)(?:\s+de)?)?)\s*([\d.,]+)?/);
  if (radicalTexto && (radicalTexto[1] || radicalTexto[3]) && (temSimboloRaiz || /raiz/i.test(texto))) {
    const coeficiente = radicalTexto[1] ? decimalParaRacional(radicalTexto[1]) : rat(1);
    const radicando = radicalTexto[3] ? decimalParaRacional(radicalTexto[3]) : null;
    const k = ehCubes ? 3n : ehQuartica ? 4n : 2n;
    if (coeficiente && radicando && radicando.n > 0n) {
      const base = criarRadical(radicando.n, k);
      if (eRacional(radicando) && radicando.d !== 1n) {
        // radicando fracionário: usa raizDe para manter a fração exata
        const viaRaiz = raizDe(radicando, k);
        if (viaRaiz) return multiplicarPorRacional(coeficiente, viaRaiz);
      }
      return multiplicarPorRacional(coeficiente, base);
    }
  }

  // Por fim: número simples, ignorando a unidade.
  const apenasNumeros = texto.replace(/[^\d.,\-+/ ]/g, ' ').trim();
  if (!apenasNumeros) return null;
  return decimalParaRacional(apenasNumeros);
}

module.exports = {
  rat, criarRadical, radicalComCoeficiente, multiplicarPorRacional, raizDe,
  soma, subtrai, multiplica, divide,
  iguais, paraNumero, formatar, formatarComUnidade, racionalizar, lerValor, extrairUnidade,
  eRacional, eRadical, simplificarRadical, fatorar, gcd
};
