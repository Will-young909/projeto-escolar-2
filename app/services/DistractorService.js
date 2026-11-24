'use strict';

/**
 * Geração de distratores (alternativas erradas) com propósito pedagógico.
 *
 * Números aleatórios são inúteis para o aluno: ele chuta sem raciocinar. Cada
 * distrator aqui reproduz um ERRO TÍPICO — transporte errado, sinal trocado,
 * operação invertida, denominador somado, etapa omitida — para que a questão
 * diagnostique onde o aluno está errando.
 *
 * O backend é a autoridade: a resposta correta entra como argumento e os
 * distratores são DERIVADOS dela, nunca propostos pela IA.
 */

const M = require('./MathValueService');

/** Descarta negativos e valores absurdos em contexto de escola básica. */
const plausivel = (v, referencia) => {
  if (!v) return false;
  if (M.eRacional(v) && v.n <= 0n) return false;
  const num = M.paraNumero(v);
  if (!Number.isFinite(num)) return false;
  const ref = M.paraNumero(referencia);
  return ref <= 0 || (num > 0 && num < ref * 1000);
};

const listaNumeros = valores => (Array.isArray(valores) ? valores : [valores])
  .map(v => M.lerValor(v)).filter(Boolean);

/* ------------------------------------------------------------------ *
 * Erros típicos por tipo de problema
 * ------------------------------------------------------------------ */

const GERADORES = {
  /** Soma: esqueceu uma parcela, repetiu parcela, ordem invertida. */
  addition(data) {
    const vals = listaNumeros(data.values);
    if (vals.length < 2) return [];
    const total = vals.reduce((a, b) => M.soma(a, b));
    const out = [vals.slice(0, -1).reduce((a, b) => M.soma(a, b))];
    out.push(M.soma(total, vals[vals.length - 1]));            // parcela repetida
    out.push(vals.reduce((a, b) => M.multiplica(a, b)));        // multiplicou
    const maior = vals.reduce((a, b) => (M.paraNumero(a) > M.paraNumero(b) ? a : b));
    const menor = vals.reduce((a, b) => (M.paraNumero(a) < M.paraNumero(b) ? a : b));
    out.push(M.subtrai(maior, menor));                          // ordem invertida
    return out;
  },

  /** Subtração: esqueceu um subtraendo, somou em vez de subtrair. */
  subtraction(data) {
    const min = M.lerValor(data.minuend);
    const subs = listaNumeros(data.subtrahends);
    if (!min || !subs.length) return [];
    const total = subs.reduce((a, b) => M.soma(a, b));
    const out = [M.subtrai(min, subs[0])];
    if (subs.length > 1) out.push(M.subtrai(min, subs.slice(1).reduce((a, b) => M.soma(a, b))));
    out.push(M.soma(min, total));                               // somou
    out.push(M.subtrai(min, total));
    out.push(M.subtrai(subs[0], min));                           // ordem invertida
    return out;
  },

  /** Multiplicação: esqueceu um fator, somou. */
  multiplication(data) {
    const vals = listaNumeros(data.values);
    if (vals.length < 2) return [];
    const total = vals.reduce((a, b) => M.multiplica(a, b));
    const out = [vals.slice(0, -1).reduce((a, b) => M.multiplica(a, b))];
    if (vals.length > 2) out.push(M.multiplica(vals[0], vals[1]));
    out.push(vals.reduce((a, b) => M.soma(a, b)));              // somou
    out.push(M.multiplica(total, vals[0]));                      // fator repetido
    return out;
  },

  /** Divisão: multiplicou, inverteu, esqueceu o resto. */
  division(data) {
    const a = M.lerValor(data.dividend);
    const b = M.lerValor(data.divisor);
    if (!a || !b || b.n === 0n) return [];
    const out = [M.multiplica(a, b)];
    if (a.n !== 0n) out.push(M.divide(b, a));
    const q = M.divide(a, b);
    if (M.eRacional(q) && q.d === 1n) out.push(M.soma(q, M.rat(1)));
    return out;
  },

  fraction_arithmetic(data) {
    const a = M.lerValor(data.a); const b = M.lerValor(data.b);
    if (!a || !b) return [];
    const out = [M.soma(a, b), M.subtrai(a, b), M.multiplica(a, b)];
    if (b.n !== 0n) out.push(M.divide(a, b));
    if (M.eRacional(a) && M.eRacional(b) && a.d !== 1n && b.d !== 1n) {
      out.push(M.divide(M.soma(a.n, b.n), M.soma(a.d, b.d))); // MMC errado: somou
    }
    return out;
  },

  /**
   * Frações sucessivas sobre um total — o caso 3/5 · 3/7 + 1/3.
   * Reproduz: etapa omitida, base errada, denominador somado, sinal invertido.
   *
   * Quando há `total`, os erros saem na MESMA unidade da resposta (litros),
   * senão a questão misturaria "660 litros" com frações sem sentido.
   */
  fraction_operation(data) {
    const inicial = M.lerValor(data.initial !== undefined ? data.initial : data.initial_fraction);
    const passos = Array.isArray(data.steps) ? data.steps : [];
    if (!inicial) return [];
    const total = data.total !== undefined && data.total !== null ? M.lerValor(data.total) : null;

    const valor = p => M.lerValor(p && p.value !== undefined ? p.value : p);
    const op = p => String((p && p.op) || '').toLowerCase();

    /** Executa a sequência; `pular` ignora um passo (erro de etapa omitida). */
    const executar = (pular = -1) => {
      let atual = inicial;
      for (let j = 0; j < passos.length; j++) {
        if (j === pular) continue;
        const v = valor(passos[j]); if (!v) continue;
        const o = op(passos[j]);
        if (o.includes('_of_current')) {
          atual = o.startsWith('remove') ? M.subtrai(atual, M.multiplica(atual, v)) : M.soma(atual, M.multiplica(atual, v));
        } else if (o.startsWith('remove') || o === 'remove_absolute' || o === 'remove' || o === 'subtract') {
          atual = M.subtrai(atual, v);
        } else {
          atual = M.soma(atual, v);
        }
      }
      return total ? M.multiplica(atual, total) : atual;
    };

    const out = [];
    for (let i = -1; i < passos.length; i++) out.push(executar(i)); // inclui -1 (nenhuma etapa)

    // Aplicou a fração sobre o TOTAL em vez de sobre o que já existe.
    for (let p = 0; p < passos.length; p++) {
      if (!op(passos[p]).includes('_of_current')) continue;
      let cand = inicial;
      for (let j = 0; j < passos.length; j++) {
        const v = valor(passos[j]); if (!v) continue;
        const o = op(passos[j]);
        if (j === p) cand = o.startsWith('remove') ? M.subtrai(cand, v) : M.soma(cand, v);
        else if (o.includes('_of_current')) cand = M.multiplica(cand, M.subtrai(M.rat(1), v));
        else cand = o.startsWith('remove') ? M.subtrai(cand, v) : M.soma(cand, v);
      }
      out.push(total ? M.multiplica(cand, total) : cand);
    }

    // Inverteu a subtração de um passo.
    for (let p = 0; p < passos.length; p++) {
      if (!op(passos[p]).startsWith('remove')) continue;
      let cand = inicial;
      for (let j = 0; j < passos.length; j++) {
        const v = valor(passos[j]); if (!v) continue;
        const o = op(passos[j]);
        if (o.includes('_of_current')) cand = M.soma(cand, M.multiplica(cand, v));
        else cand = o.startsWith('remove') ? M.soma(cand, v) : M.subtrai(cand, v);
      }
      out.push(total ? M.multiplica(cand, total) : cand);
    }

    // Denominadores somados em vez de multiplicados (erro clássico de MMC).
    if (M.eRacional(inicial) && inicial.d !== 1n) {
      for (let p = 0; p < passos.length; p++) {
        const v = valor(passos[p]);
        if (!v || !M.eRacional(v) || v.d === 1n) continue;
        let cand = M.soma(inicial, v);
        for (let j = 0; j < passos.length; j++) {
          if (j === p) continue;
          const qv = valor(passos[j]);
          if (!qv || !M.eRacional(qv) || qv.d === 1n) continue;
          cand = M.soma(cand, qv);
        }
        out.push(total ? M.multiplica(cand, total) : cand);
      }
    }
    return out;
  },

  percentage(data) {
    const p = M.lerValor(data.percent); const b = M.lerValor(data.base);
    if (!p || !b) return [];
    const c = M.divide(p, M.rat(100));
    return [
      M.multiplica(b, c),
      M.subtrai(b, M.multiplica(b, c)),
      M.soma(b, M.multiplica(b, c)),
      M.multiplica(b, p),            // esqueceu a divisão por 100
      M.soma(b, M.multiplica(b, p))
    ];
  },

  linear_equation(data) {
    const A = M.lerValor(data.a); const B = M.lerValor(data.b); const C = M.lerValor(data.c);
    if (!A || !B || !C || A.n === 0n) return [];
    const x = M.divide(M.subtrai(C, B), A);
    return [M.divide(C, A), M.divide(M.soma(C, B), A), M.multiplica(x, A), M.soma(x, B)];
  },

  area(data) {
    const L = M.lerValor(data.side); const A = M.lerValor(data.a);
    const B = M.lerValor(data.b); const H = M.lerValor(data.h);
    const out = [];
    if (L) out.push(M.multiplica(M.rat(4), L), M.multiplica(L, L));
    if (A && B) out.push(M.multiplica(A, B), M.soma(A, B), M.multiplica(M.rat(2), M.soma(A, B)));
    if (A && H) out.push(M.divide(M.multiplica(A, H), M.rat(2)), M.multiplica(A, H));
    return out;
  },

  perimeter(data) {
    const A = M.lerValor(data.a); const B = M.lerValor(data.b); const L = M.lerValor(data.side);
    const out = [];
    if (L) out.push(M.multiplica(M.rat(2), L), M.multiplica(L, L));
    if (A && B) out.push(M.multiplica(A, B), M.multiplica(M.rat(2), M.soma(A, B)), M.soma(A, B));
    return out;
  },

  volume(data) {
    const A = M.lerValor(data.a); const B = M.lerValor(data.b);
    const H = M.lerValor(data.h); const L = M.lerValor(data.side);
    const out = [];
    if (A && B && H) {
      out.push(M.multiplica(A, B), M.soma(M.soma(A, B), H));
      out.push(M.multiplica(M.rat(2), M.multiplica(A, M.multiplica(B, H))));
    }
    if (L) out.push(M.multiplica(M.rat(2), L), M.multiplica(L, L));
    return out;
  },

  equal_volume_cylinder_sphere(data) {
    const r = M.lerValor(data.cylinder_radius); const h = M.lerValor(data.cylinder_height);
    if (!r || !h) return [];
    return [r, h, M.multiplica(r, h), M.multiplica(M.rat(2), r), M.multiplica(M.multiplica(r, r), h)];
  }
};

/** Embaralhamento determinístico (Fisher-Yates com PRNG semeado). */
function embaralhar(lista, semente = 1) {
  const arr = [...lista];
  let s = Number(semente) || 1;
  const proximo = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(proximo() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Formata um valor no estilo brasileiro, com unidade opcional. */
function formatarAlternativa(valor, unidade) {
  if (M.eRacional(valor) && valor.d === 1n) {
    const inteiro = Math.abs(Number(valor.n));
    const texto = String(inteiro).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const comSinal = valor.n < 0n ? `-${texto}` : texto;
    return unidade ? `${comSinal} ${unidade}` : comSinal;
  }
  const base = M.formatar(valor);
  return unidade && M.eRacional(valor) && valor.d === 1n ? `${base} ${unidade}` : base;
}

/**
 * Monta as alternativas de uma questão a partir da resposta já calculada.
 *
 * A IA NÃO participa desta etapa: a resposta entra pronta e os distratores
 * são erros típicos do tipo de problema. O `correct` é a POSIÇÃO da resposta
 * calculada dentro da lista embaralhada.
 *
 * @returns {{ok: true, options: object, correct: string, correctOption: string,
 *            distractors: string[]}
 *          |{ok: false, reason: string}}
 */
function montarAlternativas({
  problem, tipo, answer, unidade = null, quantidade = 4, semente = 1
}) {
  if (!answer) return { ok: false, reason: 'missing_answer' };
  const total = Math.max(2, Number(quantidade) || 4);

  const brutos = (GERADORES[tipo] && typeof GERADORES[tipo] === 'function')
    ? GERADORES[tipo](problem && problem.data ? problem.data : {}) || []
    : [];

  // Filtra: plausíveis, diferentes da resposta e sem repetição entre si.
  const vistos = new Set();
  const unicos = [];
  for (const v of brutos) {
    if (!v) continue;
    if (!plausivel(v, answer)) continue;
    if (M.iguais(v, answer)) continue;
    const chave = M.formatar(v);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    unicos.push(v);
  }

  // Se os erros típicos não bastaram, completa com perturbações próximas.
  if (unicos.length < total - 1 && M.eRacional(answer)) {
    const base = M.paraNumero(answer);
    const passo = Math.max(1, Math.round(Math.abs(base) * 0.05));
    const candidatos = [
      M.soma(answer, M.rat(passo)),
      M.subtrai(answer, M.rat(passo)),
      M.soma(answer, M.rat(passo * 2)),
      M.subtrai(answer, M.rat(passo * 2)),
      M.soma(answer, M.rat(passo * 5)),
      M.subtrai(answer, M.rat(passo * 5))
    ];
    for (const v of candidatos) {
      if (unicos.length >= total - 1) break;
      if (!plausivel(v, answer) || M.iguais(v, answer)) continue;
      const chave = M.formatar(v);
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      unicos.push(v);
    }
  }

  if (unicos.length < total - 1) return { ok: false, reason: 'insufficient_distractors' };

  const selecionados = embaralhar(unicos.slice(0, total - 1), semente);
  // Posição da correta: usa o PRNG, não um resto de divisão (o resto % 4
  // com sementesSequenciais distribuiria mal e tenderia a repetir a posição).
  const posicoes = embaralhar([...Array(total).keys()], semente + 7919);
  const indiceCorreto = posicoes[0]; // 0..total-1

  // Monta a lista final já com a correta na posição sorteada.
  const itens = selecionados.map(v => formatarAlternativa(v, unidade));
  itens.splice(indiceCorreto, 0, formatarAlternativa(answer, unidade));

  const options = {};
  itens.forEach((texto, i) => { options[String(i + 1)] = texto; });

  return {
    ok: true,
    options,
    correct: String(indiceCorreto + 1),
    correctOption: itens[indiceCorreto],
    distractors: selecionados.map(v => formatarAlternativa(v, unidade))
  };
}

module.exports = { GERADORES, plausivel, listaNumeros, montarAlternativas, embaralhar, formatarAlternativa };
