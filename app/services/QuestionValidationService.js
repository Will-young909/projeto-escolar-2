'use strict';

/**
 * Validação determinística das questões geradas por IA para a Trilha Adaptativa.
 *
 * Princípio: a IA SUGERE (`correct`), o backend DECIDE. Nenhuma questão entra na
 * trilha sem passar por aqui.
 *
 * A aritmética usa frações exatas (BigInt) em vez de `Number`, evitando erros de
 * vírgula flutuante (ex.: 0.1 + 0.2 !== 0.3) e dispensando `eval()`. A comparação
 * entre alternativas é feita por igualdade racional exata.
 */

const C = require('../constants/trilha');
const MathValue = require('./MathValueService');

const { TOTAL_ALTERNATIVAS, ENUNCIADO_MIN_CARACTERES, CASAS_DECIMAIS } = C.IA_VALIDACAO;

/* ------------------------------------------------------------------ *
 * Aritmética racional exata (BigInt). Sem dependências e sem eval().
 * ------------------------------------------------------------------ */

const gcd = (a, b) => { let x = a < 0n ? -a : a; let y = b < 0n ? -b : b; while (y) { [x, y] = [y, x % y]; } return x; };

/** Cria uma fração reduzida. Lança se o denominador for zero. */
function frac(numerador, denominador = 1n) {
  let n = BigInt(numerador);
  let d = BigInt(denominador);
  if (d === 0n) throw new Error('Divisão por zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

const ZERO = frac(0);
const soma = (a, b) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const subtrai = (a, b) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const multiplica = (a, b) => frac(a.n * b.n, a.d * b.d);
const divide = (a, b) => {
  if (b.n === 0n) throw new Error('Divisão por zero');
  return frac(a.n * b.d, a.d * b.n);
};
const igual = (a, b) => !!a && !!b && a.n === b.n && a.d === b.d;

/** Converte uma fração em decimal string, arredondando o módulo na metade para cima. */
function paraDecimal(f, casas = CASAS_DECIMAIS) {
  if (!f) return null;
  const escala = 10n ** BigInt(casas);
  // Arredonda o módulo para evitar o viés do truncamento inteiro em negativos
  // (ex.: -15.5 não pode virar -15.499999).
  const negativo = f.n < 0n;
  const absoluto = negativo ? -f.n : f.n;
  const arredondado = (absoluto * escala * 2n + f.d) / (f.d * 2n);
  const inteiro = arredondado / escala;
  const resto = arredondado % escala;
  const texto = casas > 0
    ? `${inteiro}.${String(resto).padStart(casas, '0')}`.replace(/0+$/, '').replace(/\.$/, '')
    : String(inteiro);
  return (negativo ? '-' : '') + texto;
}

/* ------------------------------------------------------------------ *
 * Normalização de valores (formato brasileiro)
 * ------------------------------------------------------------------ */

// Unidades e símbolos que fazem parte do texto da alternativa, não do número.
const NAO_NUMERICO = /^(?:r\$|us\$|€|kg|kgs|g|mg|t|toneladas?|km|cm|mm|m|l|litros?|ml|un|unidades?|%|reais?|alunos?|itens?|anos?|dias?|horas?|min|segundos?|adotados?)$/i;

const ehUnidade = texto => NAO_NUMERICO.test(String(texto).trim());

/** Lê um número já sem separadores de milhar (usado no ramo de fração). */
function lerInteiroOuDecimal(texto) {
  const limpo = String(texto).trim().replace(/^[-+]/, '');
  if (!/^\d+(?:\.\d+)?$/.test(limpo)) return { ok: false };
  const [i, f = ''] = limpo.split('.');
  return { ok: true, valor: frac(BigInt(i + f), f.length ? 10n ** BigInt(f.length) : 1n) };
}

/**
 * Converte texto numérico em formato brasileiro para fração exata.
 *
 * Regras (contexto pt-BR, sem converter indiscriminadamente):
 *  - "1.234,56" -> vírgula é decimal, ponto é milhar  => 1234.56
 *  - "1,234"    -> 3 dígitos após a vírgula e nenhum ponto => milhar => 1234
 *  - "142.990"  -> ponto com exatamente 3 dígitos => milhar => 142990
 *  - "0,5"      -> vírgula sem padrão de milhar => decimal => 0.5
 *  - "R$ 142.990,00 kg", "142 990", "142990" => 142990
 *
 * @returns {{ok: true, fracao: object, texto: string}|{ok: false, motivo: string}}
 */
function normalizarNumero(entrada) {
  if (typeof entrada === 'number') {
    if (!Number.isFinite(entrada)) return { ok: false, motivo: 'valor numérico não finito' };
    return normalizarNumero(String(entrada)); // evita artefatos de float do JSON da IA
  }
  if (entrada === null || entrada === undefined) return { ok: false, motivo: 'valor ausente' };

  const bruto = String(entrada).trim();
  if (bruto === '') return { ok: false, motivo: 'valor vazio' };

  // Mantém dígitos, separadores, sinal e barra; descarta o resto (moeda/unidades).
  const semUnidade = bruto
    .replace(/[–—−]/g, '-')
    .replace(/[^\d.,/+\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (semUnidade === '') return { ok: false, motivo: 'sem trecho numérico' };

  const negativo = /^\s*-/.test(semUnidade);

  // Fração explícita: "3/4", "1 / 2"
  const partes = semUnidade.split('/');
  if (partes.length === 2) {
    const num = lerInteiroOuDecimal(partes[0]);
    const den = lerInteiroOuDecimal(partes[1]);
    if (num.ok && den.ok && den.valor.n !== 0n) {
      // denominador da fração = numerador do divisor (ex.: 1/2 -> {n:1, d:2})
      const f = negativo ? frac(-num.valor.n, den.valor.n) : frac(num.valor.n, den.valor.n);
      return { ok: true, fracao: f, texto: bruto };
    }
    return { ok: false, motivo: 'fração inválida' };
  }

  const semSinal = semUnidade.replace(/ /g, '').replace(/^[-+]/, '');
  if (semSinal === '') return { ok: false, motivo: 'sem dígitos' };

  const temPonto = semSinal.includes('.');
  const temVirgula = semSinal.includes(',');
  let normalizado;

  if (temPonto && temVirgula) {
    // O separador decimal é o último a aparecer.
    const decimal = semSinal.lastIndexOf('.') > semSinal.lastIndexOf(',') ? '.' : ',';
    const milhar = decimal === '.' ? ',' : '.';
    normalizado = semSinal.split(milhar).join('').replace(decimal, '.');
  } else if (temVirgula) {
    normalizado = /^\d{1,3}(?:,\d{3})+$/.test(semSinal) ? semSinal.split(',').join('') : semSinal.replace(',', '.');
  } else if (temPonto) {
    normalizado = /^\d{1,3}(?:\.\d{3})+$/.test(semSinal) ? semSinal.split('.').join('') : semSinal;
  } else {
    normalizado = semSinal;
  }

  if (!/^\d+(?:\.\d+)?$/.test(normalizado)) return { ok: false, motivo: 'formato numérico não reconhecido' };

  const [inteiroTexto, casasTexto = ''] = normalizado.split('.');
  const casas = casasTexto.length;
  const denominador = casas > 0 ? 10n ** BigInt(casas) : 1n;
  const valorNumerico = BigInt(inteiroTexto) * denominador + (casas > 0 ? BigInt(casasTexto) : 0n);

  return {
    ok: true,
    fracao: negativo ? frac(-valorNumerico, denominador) : frac(valorNumerico, denominador),
    texto: bruto
  };
}

/* ------------------------------------------------------------------ *
 * Normalização das alternativas
 * ------------------------------------------------------------------ */

const LETRAS = ['A', 'B', 'C', 'D'];

/**
 * Converte `options` em lista ordenada e canônica.
 *
 * Aceita as três formas usadas no projeto:
 *  - array                     -> ["20", "30", "40", "50"]
 *  - objeto 1-based            -> { "1": ..., "4": ... }
 *  - objeto por letra          -> { A: ..., D: ... }   (atividades já normalizadas)
 */
function normalizarAlternativas(options) {
  if (Array.isArray(options)) {
    return options.map((valor, indice) => ({ indice, letra: LETRAS[indice], texto: valor }));
  }
  if (options && typeof options === 'object') {
    const chaves = Object.keys(options);
    if (chaves.length === 0) return [];

    const todasLetras = chaves.every(chave => /^[A-Da-d]$/.test(chave.trim()));
    if (todasLetras) {
      return chaves
        .map(chave => {
          const letra = chave.trim().toUpperCase();
          return { indice: LETRAS.indexOf(letra), letra, texto: options[chave] };
        })
        .sort((a, b) => a.indice - b.indice);
    }

    return chaves
      .map(chave => Number(chave))
      .filter(chave => Number.isInteger(chave) && chave >= 1 && chave <= LETRAS.length)
      .sort((a, b) => a - b)
      .map(chave => ({ indice: chave - 1, letra: LETRAS[chave - 1], texto: options[String(chave)] }));
  }
  return [];
}

/**
 * Converte `correct` para a letra canônica (A-D).
 * Aceita tanto o índice 1-based ("2") quanto a letra ("B"), usados no projeto.
 */
function normalizarCorrect(correct, total = TOTAL_ALTERNATIVAS) {
  const bruto = String(correct ?? '').trim();
  if (bruto === '') return null;
  if (/^[A-Da-d]$/.test(bruto)) {
    const letra = bruto.toUpperCase();
    return LETRAS.indexOf(letra) < total ? letra : null;
  }
  const numerico = Number(bruto);
  if (Number.isInteger(numerico) && numerico >= 1 && numerico <= total) return LETRAS[numerico - 1];
  return null;
}

/* ------------------------------------------------------------------ *
 * Interpretação matemática do enunciado
 * ------------------------------------------------------------------ */

// Expressões aritméticas explícitas: "48.756 + 39.845 + 54.389", "2/3 + 1/4".
const REGEX_EXPRESSAO = /((?:\d[\d.,]*)(?:\s*[-+*/×÷]\s*\d[\d.,]*)+)/g;
const OPERADORES = { '+': soma, '-': subtrai, '*': multiplica, '×': multiplica, '/': divide, '÷': divide };
const PRECEDENCIA = { '+': 1, '-': 1, '*': 2, '/': 2 };

/**
 * Avalia uma expressão aritmética restrita (apenas números e operadores + - * /).
 * Usa shunting-yard; nunca executa código vindo da IA.
 */
function avaliarExpressao(expressao) {
  const tokens = String(expressao)
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/,/g, '.')
    .match(/\d+\.?\d*|[+\-*/]/g);
  if (!tokens || tokens.length < 3) return null;

  const valores = [];
  const operadores = [];
  const aplicar = () => {
    const op = operadores.pop();
    const dir = valores.pop();
    const esq = valores.pop();
    if (op === undefined || dir === undefined || esq === undefined) throw new Error('expressão malformada');
    valores.push(OPERADORES[op](esq, dir));
  };

  for (const token of tokens) {
    if (/^\d/.test(token)) {
      const num = normalizarNumero(token);
      if (!num.ok) return null;
      valores.push(num.fracao);
    } else {
      while (operadores.length && PRECEDENCIA[operadores[operadores.length - 1]] >= PRECEDENCIA[token]) aplicar();
      operadores.push(token);
    }
  }
  while (operadores.length) aplicar();
  return valores.length === 1 ? valores[0] : null;
}

/** Números soltos no texto, na ordem em que aparecem. */
function extrairNumeros(texto) {
  const encontrados = [];
  const textoLimpo = String(texto || '').replace(/,/g, '.');
  const re = /\d+(?:\.\d+)?/g;
  let achado;
  while ((achado = re.exec(textoLimpo)) !== null) {
    const num = normalizarNumero(achado[0]);
    if (num.ok) encontrados.push({ fracao: num.fracao, texto: achado[0], posicao: achado.index });
  }
  return encontrados;
}

// Palavras que indicam a operação pedida quando não há expressão explícita.
const PALAVRAS_OPERACAO = [
  { padrao: /\btotal\b|\bjunt[oa]s?\b|\bsom[ao]\b|\bsomando\b|\bsoma\b/i, op: '+' },
  { padrao: /\bdiferen[çc]a\b|\bmenos\b|\bsobra(?:r|ou)?\b|\brestou\b|\bsubtra[çc]/i, op: '-' },
  { padrao: /\bvezes\b|\bmultiplic|\bproduto\b/i, op: '*' },
  { padrao: /\bdivis[ãa]o\b|\bdividid|\bmetade\b|\bter[çc]o\b|\bpartes\b/i, op: '/' }
];

/** Valor de uma fração/porcentagem dita por extenso (meio, um quarto, 10 por cento...). */
const EXTENSO = { meio: '1/2', metade: '1/2', 'um quarto': '1/4', 'dois quartos': '2/4', 'um terço': '1/3', 'um terco': '1/3' };

/** "10 por cento de 200" / "20% de 150" -> 20. */
function resolverPercentual(texto) {
  const re = /(\d+(?:[.,]\d+)?)\s*(?:%|por\s+cento)\s*(?:de|d[eé])\s*(\d+(?:[.,]\d+)?)/i;
  const achado = String(texto).match(re);
  if (!achado) return null;
  const percentual = normalizarNumero(achado[1]);
  const base = normalizarNumero(achado[2]);
  if (!percentual.ok || !base.ok) return null;
  return multiplica(base.fracao, divide(percentual.fracao, frac(100)));
}

/**
 * Percentual em contexto de variação: "desconto de 15% ... custava R$ 200",
 * "aumento de 10% ... era 50". Retorna o valor FINAL (após desconto/aumento).
 * Só aceita quando há exatamente 1 percentual e 1 valor-base monetário/numérico
 * claro, para evitar inferência ambígua.
 */
function resolverPercentualContexto(texto) {
  const t = String(texto || '');
  const percRe = /(\d+(?:[.,]\d+)?)\s*(?:%|por\s+cento)/gi;
  const percs = [];
  let m;
  while ((m = percRe.exec(t)) !== null) {
    const n = normalizarNumero(m[1]);
    if (n.ok) percs.push({ fracao: n.fracao, texto: m[1], index: m.index });
  }
  if (percs.length !== 1) return null;

  const tipoDesconto = /\bdescont\w*|abat\w*|redu[cç]\w*|barate\w*/i.test(t);
  const tipoAumento = /\baument\w*|acres[cç]\w*|reajust\w*|juros\b|inflac\w*|encarec\w*/i.test(t);
  if (tipoDesconto === tipoAumento) return null; // ambos ou nenhum: ambíguo

  // Base: preferir valor monetário; senão, número não-percentual mais plausível.
  const dinheiroRe = /R\$\s*(\d[\d.,]*)/gi;
  const basesDinheiro = [];
  while ((m = dinheiroRe.exec(t)) !== null) {
    const n = normalizarNumero(m[1]);
    if (n.ok) basesDinheiro.push({ fracao: n.fracao, texto: m[1], index: m.index });
  }

  let base = null;
  if (basesDinheiro.length === 1) {
    base = basesDinheiro[0];
  } else {
    const nums = extrairNumeros(t).filter(n => {
      // Exclui o próprio percentual e números colados ao símbolo %.
      if (Math.abs(n.posicao - percs[0].index) <= 1) return false;
      const depois = t.slice(n.posicao + n.texto.length, n.posicao + n.texto.length + 8);
      if (/^\s*(?:%|por\s+cento)/i.test(depois)) return false;
      const antes = t.slice(Math.max(0, n.posicao - 3), n.posicao);
      if (/R\$\s*$/.test(antes)) return true;
      // Evita anos/contexto pequeno demais.
      const val = Number(n.texto.replace(',', '.'));
      return !(Number.isInteger(val) && val >= 1900 && val <= 2100);
    });
    if (nums.length === 1) base = nums[0];
  }
  if (!base) return null;

  const taxa = divide(percs[0].fracao, frac(100));
  const delta = multiplica(base.fracao, taxa);
  const final = tipoDesconto ? subtrai(base.fracao, delta) : soma(base.fracao, delta);
  return { fracao: final, fonte: tipoDesconto ? 'percentual_desconto' : 'percentual_aumento', numeros: [base.texto, percs[0].texto] };
}

/** "metade de 10", "um terço de 12" -> 5 / 4. */
function resolverFracaoExtenso(texto) {
  const re = new RegExp(`(${Object.keys(EXTENSO).join('|')})\\s+(?:de|d[oa])\\s+(\\d+(?:[.,\\d]*)?)`, 'i');
  const achado = String(texto).match(re);
  if (!achado) return null;
  const fracao = normalizarNumero(EXTENSO[achado[1].toLowerCase()]);
  const base = normalizarNumero(achado[2]);
  if (!fracao.ok || !base.ok) return null;
  return multiplica(base.fracao, fracao.fracao);
}

/** "3/4 de 80" representa três quartos da base, não apenas a fração 3/4. */
function resolverFracaoAplicada(texto) {
  const achado = String(texto).match(/([+-]?\d+(?:[.,]\d+)?)\s*\/\s*([+-]?\d+(?:[.,]\d+)?)\s+(?:de|do|da|dos|das)\s+([+-]?\d+(?:[.,]\d+)?)/i);
  if (!achado) return null;
  const fracao = normalizarNumero(`${achado[1]}/${achado[2]}`);
  const base = normalizarNumero(achado[3]);
  if (!fracao.ok || !base.ok) return null;
  return multiplica(fracao.fracao, base.fracao);
}

/**
 * Determina, de forma determinística, o valor matemático da resposta.
 *
 * @returns {{ok: true, fracao: object, valor: string, fonte: string, numeros: string[]}
 *          |{ok: false, motivo: string}}
 */
function determinarResposta(enunciado, habilidade = '') {
  const texto = String(enunciado || '');

  // Resolver frações aplicadas à base antes da regex de expressão, que sem
  // esse caso interpretaria "3/4 de 80" como apenas a divisão 3/4.
  const fracaoAplicada = resolverFracaoAplicada(texto);
  if (fracaoAplicada) {
    return { ok: true, fracao: fracaoAplicada, valor: paraDecimal(fracaoAplicada), fonte: 'fracao_aplicada', numeros: extrairNumeros(texto).map(n => n.texto) };
  }

  // 1) Expressão aritmética explícita (caso mais confiável).
  REGEX_EXPRESSAO.lastIndex = 0;
  const expMatches = [];
  let achado;
  while ((achado = REGEX_EXPRESSAO.exec(texto)) !== null) {
    // Ignora pseudoexpressões como "2024-2025" (faixa de anos).
    if (/^\d{4}-\d{4}$/.test(achado[1])) continue;
    expMatches.push({ expr: achado[1], index: achado.index, end: achado.index + achado[0].length });
  }
  if (expMatches.length > 0) {
    const temPotenciaOuParens = /[()^²³¹⁰⁴⁵⁶⁷⁸⁹]/.test(texto);
    const temOperadorNaoCapturado = /\d\s+\.\s+[\d(]|\)\s*\.\s+[\d(]/.test(texto); // "2 . (5-3)" estilo
    const temSinalInicialNegativo = /:\s*-\s*\d/.test(texto) || /^\s*-\s*\d/.test(texto);
    const fragmentada = expMatches.length > 1 && temPotenciaOuParens;
    if (temPotenciaOuParens || temOperadorNaoCapturado || temSinalInicialNegativo || fragmentada) {
      return { ok: false, motivo: 'expressão com potência/parênteses/sintaxe não suportada pelo avaliador seguro' };
    }
    for (const item of expMatches) {
      const proximo = texto[item.end];
      if (proximo !== undefined && /[\u00B2\u00B3\u00B4\u2070-\u207F^n]/.test(proximo)) {
        return { ok: false, motivo: 'expressão com potência não é avaliada com segurança' };
      }
      try {
        const fracao = avaliarExpressao(item.expr);
        if (fracao) {
          return { ok: true, fracao, valor: paraDecimal(fracao), fonte: 'expressao_explicita', numeros: extrairNumeros(item.expr).map(n => n.texto) };
        }
      } catch { /* não determinística: cai na heurística */ }
    }
  }

  // 2) Geometria: fórmulas fechadas por figura/grandeza.
  const geometria = resolverGeometria(texto, habilidade);
  if (geometria) return geometria;

  // 3) Casos sem expressão explícita, mas com forma reconhecível.
  const percentual = resolverPercentual(texto);
  if (percentual) {
    return { ok: true, fracao: percentual, valor: paraDecimal(percentual), fonte: 'percentual', numeros: extrairNumeros(texto).map(n => n.texto) };
  }
  const percentualCtx = resolverPercentualContexto(texto);
  if (percentualCtx) {
    return { ok: true, fracao: percentualCtx.fracao, valor: paraDecimal(percentualCtx.fracao), fonte: percentualCtx.fonte, numeros: percentualCtx.numeros };
  }
  const fracaoExtenso = resolverFracaoExtenso(texto);
  if (fracaoExtenso) {
    return { ok: true, fracao: fracaoExtenso, valor: paraDecimal(fracaoExtenso), fonte: 'fracao_extenso', numeros: extrairNumeros(texto).map(n => n.texto) };
  }

  // 4) Heurística: operação inferida a partir dos números do enunciado.
  // Ruído de contexto (anos, datas) é tratado descartando os números que
  // aparecem ANTES do termo da operação — mas só quando ainda restam pelo menos
  // dois números utilizáveis depois dele.
  const regra = PALAVRAS_OPERACAO.find(item => item.padrao.test(`${habilidade} ${texto}`));
  if (!regra) {
    return { ok: false, motivo: 'não foi possível determinar a operação matemática requerida' };
  }

  const numerosTodos = extrairNumeros(texto);
  if (numerosTodos.length < 2) {
    return { ok: false, motivo: 'enunciado não contém números suficientes para cálculo determinístico' };
  }

  // Descarta anos (1900-2100) usados como contexto ("Em 2023, ..."): eles não
  // participam da conta. Só vale a exclusão se ainda restarem 2+ números.
  const semAnos = numerosTodos.filter(n => {
    const valor = Number(n.texto);
    return !(Number.isInteger(valor) && valor >= 1900 && valor <= 2100);
  });

  let numeros = semAnos.length >= 2 ? semAnos : numerosTodos;
  const marcaOperacao = new RegExp(regra.padrao.source, 'i').exec(texto);
  if (marcaOperacao && marcaOperacao.index > 0) {
    const depois = numerosTodos.filter(n => n.posicao >= marcaOperacao.index);
    if (depois.length >= 2) numeros = depois;
  }
  const reduzir = regra.op === '-'
    ? (acc, item) => subtrai(acc, item.fracao)
    : regra.op === '*'
      ? (acc, item) => multiplica(acc, item.fracao)
      : regra.op === '/'
        ? (acc, item) => divide(acc, item.fracao)
        : (acc, item) => soma(acc, item.fracao);

  let fracao = numeros[0].fracao;
  try {
    fracao = numeros.slice(1).reduce(reduzir, fracao);
  } catch {
    return { ok: false, motivo: 'operação matemática indefinida (divisão por zero)' };
  }

  // A operação foi INFERIDA por palavra-chave e aplicada a todos os números do
  // enunciado. Isso é um palpite, não uma conta: em "Um PRODUTO que custava
  // R$ 200 sofreu desconto de 15%" casaria "*" e devolveria 200 × 15 = 3000.
  // `confiavel: false` impede que esse palpite reprove uma questão CORRETA.
  return { ok: true, fracao, valor: paraDecimal(fracao), fonte: 'operacao_inferida', confiavel: false, numeros: numeros.map(n => n.texto) };
}

/* ------------------------------------------------------------------ *
 * Validação estrutural
 * ------------------------------------------------------------------ */

// Falha de ESTRUTURA (alternativa duplicada, vazia ou em número diferente,
// dificuldade inválida). Esses erros são PROVÁVEIS pela própria estrutura — não
// é falta de cobertura do validador — então `validavel` precisa ser `true` para
// que a trava de geração continue barrando a questão.
const resultadoVazio = () => ({ valid: false, validavel: true, errors: [], calculatedAnswer: null, correctOption: null, detalhes: {} });

/**
 * Etapa 1 — Estrutura do JSON produzido pela IA.
 * Não diz nada sobre a matemática: apenas se o objeto é utilizável.
 */
function validarEstrutura(question) {
  const erros = [];
  if (!question || typeof question !== 'object') {
    return { ok: false, errors: ['questão ausente ou com formato inválido'] };
  }

  // O enunciado exibido ao aluno é `question`; `title` é o rótulo curto.
  // Validar o campo certo é essencial: é o `question` que vai para o banco.
  const enunciado = String(question.question || question.enunciado || question.text || question.title || '').trim();
  if (!enunciado) erros.push('enunciado ausente');
  else if (enunciado.length < ENUNCIADO_MIN_CARACTERES) erros.push('enunciado demasiado curto');

  const habilidade = String(question.habilidade || '').trim();
  if (!habilidade) erros.push('habilidade ausente');

  const dificuldade = String(question.dificuldade || '').trim().toLowerCase();
  if (dificuldade && !Object.values(C.DIFICULDADE).includes(dificuldade)) {
    erros.push(`dificuldade inválida: "${dificuldade}"`);
  }

  const alternativas = normalizarAlternativas(question.options);
  if (alternativas.length !== TOTAL_ALTERNATIVAS) {
    erros.push(`quantidade de alternativas inválida: esperada ${TOTAL_ALTERNATIVAS}, recebida ${alternativas.length}`);
  }

  const textos = alternativas.map(a => String(a.texto ?? '').trim());
  if (textos.some(t => t === '')) erros.push('existe alternativa vazia');

  // Duplicatas comparadas pelo VALOR numérico, para não aceitar "30" e "30,00".
  // A comparação numérica só vale para QUANTIDADES. Havendo variável (x, y, z)
  // o texto é expressão algébrica, e comparar só os dígitos é errado: "x + 3" e
  // "3x" voltariam os dois como 3 e seriam marcados como duplicadas, sendo
  // expressões diferentes. Nesse caso cai para texto normalizado, que distingue
  // as duas. Unidade e moeda ("R$ 170,00", "12 cm") não têm variável e seguem
  // pela comparação numérica.
  const temVariavel = textos.some(t => /[xyz]/i.test(t));
  const valoresNumericos = textos.map(t => normalizarNumero(t));
  if (!temVariavel && valoresNumericos.every(v => v.ok)) {
    for (let i = 0; i < valoresNumericos.length; i++) {
      for (let j = i + 1; j < valoresNumericos.length; j++) {
        if (igual(valoresNumericos[i].fracao, valoresNumericos[j].fracao)) {
          erros.push(`alternativas duplicadas: "${textos[i]}" e "${textos[j]}"`);
        }
      }
    }
  } else {
    // Alguma alternativa não é numérica: compara o texto normalizado.
    const normalizados = textos.map(t => t.toLowerCase().replace(/\s+/g, ' '));
    if (new Set(normalizados).size !== normalizados.length) erros.push('existe alternativa duplicada');
  }

  const correct = normalizarCorrect(question.correct, TOTAL_ALTERNATIVAS);
  if (!correct) erros.push(`campo "correct" ausente ou inválido: "${question.correct ?? ''}"`);

  return { ok: erros.length === 0, errors: erros, enunciado, habilidade, dificuldade, alternativas, correct };
}

/* ------------------------------------------------------------------ *
 * Validação contra resposta já resolvida (pipeline estruturado)
 * ------------------------------------------------------------------ */

/**
 * Confere as alternativas contra a resposta que o SOLUCIONADOR calculou.
 *
 * Mantém as mesmas garantias do caminho textual — exatamente uma alternativa
 * correta, `correct` coerente, sem duplicatas — mas compara com
 * `MathValueService`, que entende frações exatas e radicais.
 */
function validarContraRespostaConhecida(alternativas, correct, respostaConhecida) {
  const erros = [];
  const alvo = respostaConhecida.valor; // valor exato do MathValueService

  const valores = alternativas.map(a => MathValue.lerValor(a.texto));
  if (valores.some(v => !v)) {
    return {
      ok: false,
      validavel: false,
      errors: ['existe alternativa que não pôde ser interpretada como valor numérico'],
      details: { motivoNaoValidavel: 'alternativa não numérica', calculatedAnswer: respostaConhecida.exato }
    };
  }

  const indicesCorretos = valores
    .map((v, indice) => (MathValue.iguais(v, alvo) ? indice : -1))
    .filter(indice => indice !== -1);

  if (indicesCorretos.length === 0) {
    erros.push(`a resposta calculada (${respostaConhecida.exato}) não está entre as alternativas`);
  } else if (indicesCorretos.length > 1) {
    const letras = indicesCorretos.map(i => alternativas[i].letra).join(', ');
    erros.push(`existem ${indicesCorretos.length} alternativas corretas (${letras}); deve existir exatamente uma`);
  }

  const calculatedLetter = indicesCorretos.length === 1 ? alternativas[indicesCorretos[0]].letra : null;
  if (calculatedLetter && correct && calculatedLetter !== correct) {
    erros.push(`o campo "correct" aponta para "${correct}", mas a alternativa correta é "${calculatedLetter}"`);
  }

  return {
    ok: erros.length === 0,
    // A resposta aqui já vem do solucionador, ou seja, é um valor CONHECIDO:
    // sempre podemos julgar a questão. Se nenhuma alternativa bate com ela, isso
    // é PROVA de que o conjunto está quebrado (e não falta de cobertura), então
    // a questão deve ser barrada — nunca aceita por "não sei responder".
    validavel: true,
    errors: erros,
    calculatedAnswer: respostaConhecida.exato,
    correctOption: calculatedLetter,
    details: {
      fonte: `solucionador:${respostaConhecida.tipo}`,
      totalCorretas: indicesCorretos.length
    }
  };
}

/* ------------------------------------------------------------------ *
 * Validação matemática
 * ------------------------------------------------------------------ */

/**
 * Etapa 2 — Matemática. Só roda com a estrutura já aprovada.
 *
 * Confere: (a) a resposta calculada existe entre as alternativas; (b) existe
 * exatamente uma alternativa correta; (c) o `correct` da IA aponta para ela.
 */
function validarMatematica({ enunciado, habilidade, alternativas, correct }, respostaConhecida = null) {
  const erros = [];

  // Resposta já determinada pelo ProblemSolverService (pipeline estruturado).
  // Nesse caso NÃO se re-deriva do texto: o texto é ambíguo por natureza
  // ("3/5 da capacidade", "4/7 do que há") e o regex não consegue recuperar
  // qual fração incide sobre qual base. A autoridade é o solucionador.
  if (respostaConhecida && respostaConhecida.valor) {
    return validarContraRespostaConhecida(alternativas, correct, respostaConhecida, erros);
  }

  const calculo = determinarResposta(enunciado, habilidade);

  if (!calculo.ok) {
    // Não há fórmula para este enunciado. Isso NÃO é motivo para descartar a
    // questão: significa apenas que o backend não sabe conferir. Antes de
    // reprovar (o que esvazia a trilha de conteúdo), tenta o resgate por
    // DOMINÂNCIA: aceita o `correct` da IA somente se a alternativa apontada
    // for a única que não se explica pelos números do enunciado.
    const valoresResgate = alternativas.map(a => normalizarNumero(a.texto));
    const resgatado = resgatarPorDominancia(alternativas, correct, valoresResgate, enunciado, {
      etapa: 'matematica',
      motivoNaoValidavel: calculo.motivo,
      fonte: 'dominancia'
    });
    if (resgatado) return resgatado;

    return {
      ok: false,
      validavel: false,
      errors: [`não foi possível validar matematicamente: ${calculo.motivo}`],
      details: { motivoNaoValidavel: calculo.motivo }
    };
  }

  const valores = alternativas.map(a => normalizarNumero(a.texto));
  if (valores.some(v => !v.ok)) {
    return {
      ok: false,
      validavel: false,
      errors: ['existe alternativa que não pôde ser interpretada numericamente'],
      details: { motivoNaoValidavel: 'alternativa não numérica', calculatedAnswer: calculo.valor }
    };
  }

  const indicesCorretos = valores
    .map((v, indice) => (igual(v.fracao, calculo.fracao) ? indice : -1))
    .filter(indice => indice !== -1);

  if (indicesCorretos.length === 0) {
    erros.push(`a resposta correta calculada (${calculo.valor}) não está entre as alternativas`);
  } else if (indicesCorretos.length > 1) {
    const letras = indicesCorretos.map(i => alternativas[i].letra).join(', ');
    erros.push(`existem ${indicesCorretos.length} alternativas corretas (${letras}); deve existir exatamente uma`);
  }

  const calculatedLetter = indicesCorretos.length === 1 ? alternativas[indicesCorretos[0]].letra : null;
  if (calculatedLetter && correct && calculatedLetter !== correct) {
    erros.push(`o campo "correct" aponta para "${correct}", mas a alternativa correta é "${calculatedLetter}"`);
  }

  // EXCEÇÃO: `operacao_inferida` é um PALPITE (a operação foi escolhida por
  // palavra-chave e aplicada a todos os números). Palpite que não casou com
  // nenhuma alternativa não pode reprovar ninguém — foi exatamente ele que
  // inventou "3000" para um desconto de 15%. Se o palpite caiu exatamente em
  // uma alternativa, ele tem credibilidade e continua sendo conferido.
  const operacaoChutada = calculo.fonte === 'operacao_inferida';
  const confiavel = !operacaoChutada || indicesCorretos.length >= 1;

  // EVITAR REJEIÇÃO DEMAIS: quando o backend não é capaz de decidir (não há
  // fórmula para este enunciado, ou o cálculo saiu de uma operação adivinhada
  // e não casou com nada), a questão não deve ser descartada só por isso —
  // Happens porque a conta pedida é nova. Nesses casos o gabarito é aceito se,
  // e somente se, a alternativa apontada por `correct` for a ÚNICA que se
  // sustenta sozinha. "Única e sustentável" aqui significa: os números das
  // demais alternativas foram todos obtidos a partir de números que aparecem no
  // próprio enunciado (típico distrator: trocar o sinal, dobrar, somar 1...).
  // Uma alternativa que dependa de um número "novo" é a que a IA calculou.
  // Sem essa checagem, aceitar qualquer `correct` seria devolver o problema
  // original (IA com gabarito errado entra sem conferência).
  if (!confiavel && correct) {
    const resgatado = resgatarPorDominancia(alternativas, correct, valores, enunciado, {
      fonte: calculo.fonte,
      numeros: calculo.numeros,
      totalCorretas: indicesCorretos.length,
      confiavel
    });
    if (resgatado) return resgatado;
  }

  return {
    ok: erros.length === 0,
    // Chegou até aqui, então o cálculo foi feito: a questão é conferível.
    // Se a resposta calculada não casa com NENHUMA alternativa, isso é PROVA
    // de que o gabarito da IA está errado — não falta de cobertura. Marcar
    // como "não validável" faria uma questão quebrada passar pela trava.
    validavel: confiavel,
    errors: erros,
    calculatedAnswer: calculo.valor,
    correctOption: calculatedLetter,
    details: { fonte: calculo.fonte, numeros: calculo.numeros, totalCorretas: indicesCorretos.length, confiavel }
  };
}

/**
 * Raiz quadrada EXATA de uma fração não-negativa, ou null.
 *
 * Só devolve algo quando a raiz é racional de verdade. Para 12²+5² = 169 dá
 * 13; para 12²+7² = 193 devolve null e o chamador prefere ficar em silêncio a
 * inventar um arredondamento — a questão segue para o resgate por dominância
 * em vez de ser reprovada por um número inventado.
 */
function raizInteiraExata(fracao) {
  if (!fracao || fracao.d !== 1n || fracao.n < 0n) return null;
  const alvo = fracao.n;
  if (alvo === 0n) return frac(0);
  // Busca binária em inteiros: exata e sem dependência de Number/BigInt Math.
  let lo = 1n;
  let hi = 1n;
  while (hi * hi < alvo) hi *= 2n;
  while (lo <= hi) {
    const meio = (lo + hi) / 2n;
    const quadrado = meio * meio;
    if (quadrado === alvo) return frac(meio);
    if (quadrado < alvo) lo = meio + 1n;
    else hi = meio - 1n;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Resgate do gabarito da IA quando o backend não consegue conferir
 * ------------------------------------------------------------------ */

/**
 * Características de um valor numérico, usadas para comparar alternativas entre
 * si. Não diz qual é o gabarito: apenas descreve COMO cada número foi feito,
 * para que se reconheça a "família" de distratores.
 */
function assinaturaDoValor(fracao) {
  return {
    negativo: fracao.n < 0n,
    inteiro: fracao.d === 1n,
    zero: fracao.n === 0n,
    // Valor absoluto medido por uma forma canônica, para comparar magnitude
    // sem depender de Number (que perde precisão acima de 2^53).
    magnitude: (f => f.n < 0n ? -f.n : f.n)(fracao),
    denominador: fracao.d
  };
}

/**
 * Decide se a alternativa apontada por `correct` é a ÚNICA que se sustenta
 * sozinha quando o backend não conseguiu conferir a conta.
 *
 * O critério é CONSERVADOR e não depende de o validador saber a resposta:
 * emitem não por acaso num item de múltipla escolha, o mesmo tipo de erro
 * repetido (sinal trocado, mesma casa, valor dobrado...). A alternativa certa
 * é a que se aparta desse padrão comum, e o enunciado precisa corroborar que
 * aquela casa é plausível.
 *
 * Rejeitamos quando:
 *   - o enunciado não tem números (nada a corroborar);
 *   - as alternativas repetem valores (enunciado mal formulado);
 *   - não há separação clara entre a alternativa apontada e o resto.
 *
 * @param {Array<{texto: string}>} alternativas Alternativas já normalizadas.
 * @param {number} indiceInformado Índice da alternativa apontada por `correct`.
 * @param {Array<{ok: boolean, fracao: object}>} valores Valores lidos das alternativas.
 * @param {string} enunciado Enunciado da questão (fonte de corroboração).
 * @returns {object|null} Detalhe do resgate, ou null se não há dominância.
 */
function alternativaDominante(alternativas, indiceInformado, valores, enunciado) {
  if (indiceInformado < 0 || indiceInformado >= valores.length) return null;
  if (valores.some(v => !v || !v.ok)) return null;

  const nums = extrairNumeros(enunciado).map(n => n.fracao);
  // Sem números no enunciado não há o que corroborar a dominância.
  if (nums.length === 0) return null;

  const chave = v => `${v.fracao.n}/${v.fracao.d}`;
  const unicos = new Set(valores.map(chave));
  // Gabarito repetido entre as alternativas não prova nada.
  if (unicos.size !== valores.length) return null;

  const dominante = valores[indiceInformado];
  const outros = valores.filter((_, i) => i !== indiceInformado);
  const assinaturas = outros.map(v => assinaturaDoValor(v.fracao));
  const aDominante = assinaturaDoValor(dominante.fracao);

  // O gabarito tem de se apartar das demais numa característica que TODAS as
  // outras compartilham. Mesmo sinal e mesma casa decimal não individualizam
  // nada; um único valor negativo entre positivos (ou um único fracionário
  // entre inteiros) é a assinatura típica da resposta calculada, enquanto o
  // autor costuma errar as outras trocando sinal ou acrescentando um zero.
  const criterios = [
    {
      nome: 'sinal',
      sePara: assinaturas.every(a => a.negativo === assinaturas[0].negativo) && aDominante.negativo !== assinaturas[0].negativo
    },
    {
      nome: 'casa decimal',
      sePara: assinaturas.every(a => a.inteiro === assinaturas[0].inteiro) && aDominante.inteiro !== assinaturas[0].inteiro
    },
    {
      nome: 'valor zero',
      sePara: assinaturas.every(a => a.zero) && aDominante.zero
    }
  ];

  const aplicaveis = criterios.filter(c => c.sePara);
  if (aplicaveis.length === 0) return null;

  return {
    indice: indiceInformado,
    texto: alternativas[indiceInformado]?.texto,
    criterios: aplicaveis.map(c => c.nome),
    motivo: `separa das demais em ${aplicaveis.map(c => c.nome).join(' e ')}`
  };
}

/**
 * Aplica o resgate por dominância. Devolve o relatório pronto para ser aceito,
 * ou null quando não há prova suficiente e a questão deve ser descartada.
 */
function resgatarPorDominancia(alternativas, correct, valores, enunciado, detailsBase) {
  const indiceInformado = alternativas.findIndex(a => a.letra === correct);
  const dominante = indiceInformado >= 0
    ? alternativaDominante(alternativas, indiceInformado, valores, enunciado)
    : null;
  if (!dominante) return null;
  return {
    ok: true,
    validavel: false,
    errors: [],
    calculatedAnswer: null,
    correctOption: correct,
    details: { ...detailsBase, aceitoPorDominancia: dominante }
  };
}

/* ------------------------------------------------------------------ *
 * API principal
 * ------------------------------------------------------------------ */

/**
 * Valida uma questão gerada por IA (estrutural + matemática).
 *
 * @returns {{valid: boolean, validavel: boolean, errors: string[],
 *            calculatedAnswer: string|null, correctOption: string|null, detalhes: object}}
 */
function validar(question) {
  const estrutura = validarEstrutura(question);
  if (!estrutura.ok) {
    return { ...resultadoVazio(), errors: estrutura.errors, detalhes: { etapa: 'estrutura' } };
  }

  // Se a questão veio do pipeline estruturado, a resposta já está resolvida:
  // `_respostaExata` (ex.: "62/105", "3∛3"). Nesse caso o texto NÃO é
  // re-interpretado — seria adivinhar de novo e recair no problema original.
  const respostaConhecida = question._respostaExata
    ? { valor: MathValue.lerValor(question._respostaExata), exato: question._respostaExata, tipo: question._problemType || 'desconhecido' }
    : null;

  const matematica = validarMatematica(estrutura, respostaConhecida);
  const detalhes = {
    etapa: 'matematica',
    ...matematica.details,
    enunciado: estrutura.enunciado,
    habilidade: estrutura.habilidade,
    alternativas: estrutura.alternativas.map(a => a.texto),
    correctInformado: question.correct
  };

  return {
    valid: matematica.ok,
    validavel: matematica.validavel,
    errors: matematica.errors,
    calculatedAnswer: matematica.calculatedAnswer || null,
    correctOption: matematica.correctOption || null,
    detalhes
  };
}

/* ------------------------------------------------------------------ *
 * Geometria — regras determinísticas por figura
 * ------------------------------------------------------------------ */

// Nome da figura (SEM acento, pois a comparação usa `semAcento`) => lados.
const POLIGONOS = Object.freeze({
  triangulo: 3,
  quadrilatero: 4, quadrado: 4, retangulo: 4,
  pentagono: 5,
  hexagono: 6,
  heptagono: 7,
  octogono: 8,
  nonagono: 9,
  decagono: 10
});

const emMinusculas = texto => String(texto || '').toLowerCase();

/**
 * Remove acentos para comparação estável.
 * Usado nas regras de geometria porqueoedos os arquivos do projeto trafegam
 * em UTF-8, mas textos vindos da IA podem chegar normalizados de formas
 * variadas ("ângulos", "angulos", "Ângulos").
 */
const semAcento = texto => emMinusculas(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Quantidade de lados citada no enunciado, ou null. */
function detectarLados(texto) {
  const alvo = semAcento(texto);
  for (const [figura, lados] of Object.entries(POLIGONOS)) {
    if (alvo.includes(figura)) return lados;
  }
  return null;
}

/**
 * Regras de geometria solvable sem ambiguidade.
 *
 * Só entram figuras e grandezas com fórmula fechada e números explícitos no
 * enunciado. Casos com π (círculo), figuras 3D sem medida ou enunciados vagos
 * NÃO são tratados aqui: seguem para o fluxo "não validável" (regenerar).
 */
function resolverGeometria(enunciado, habilidade = '') {
  // Toda comparação é feita sobre o texto SEM acentos e em minúsculas, para que
  // "ângulos"/"angulos"/"Ângulos" se comportem igual e a lógica não dependa da
  // codificação de literais acentuados no código-fonte.
  const texto = semAcento(enunciado);
  const nums = extrairNumeros(texto).map(n => n.fracao);
  const lados = detectarLados(texto);

  // "Pitágoras" não contém "geometria", mas é geometria: sem esta entrada, todo
  // enunciado de Pitágoras que não cite "área"/"superfície"/"diagonal" era
  // descartado antes mesmo de chegar nas fórmulas.
  const sinalizaGeometria = /perimetro|area|superficie|volume|diagon|angulos? internos|quantos lados|hipotenus/.test(texto);
  if (!sinalizaGeometria && !/geometr|pitagor/i.test(semAcento(habilidade))) return null;

  const retangular = /retangul|rectangul|quadrilater/.test(texto);
  const quadrado = /quadrado/.test(texto);
  // "triangulo" contém o radical "angul"; por isso o pedido de ângulos é
  // detectado por "angulo interno"/"angulos internos", nunca pelo radical solto.
  const triangular = /triangul/.test(texto);
  const cubico = /paralelepipedo|cubo|caixa|bloco/.test(texto);

  const pedirPerimetro = /perimetro|contorno/.test(texto);
  const pedirArea = /area|superficie/.test(texto);
  const pedirVolume = /volume|capacidade/.test(texto);
  const pedirLados = /quantos lados|numero de lados/.test(texto);
  const pedirDiagonais = /diagon/.test(texto);
  // Exige o termo "ângulo(s) interno(s)" para não confundir com "triângulo".
  const pedirAngulos = /angulos? internos/.test(texto);

  const responder = (fracao, fonte) => ({ ok: true, fracao, valor: paraDecimal(fracao), fonte, numeros: nums.map(n => paraDecimal(n)) });
  const exigir = (min, max) => nums.length >= min && (max === null || nums.length <= max);

  // --- Propriedades de polígono (dependem só do nome da figura) ---
  // "diagonais" e "ângulos" têm prioridade sobre "lados", pois enunciados como
  // "quantas diagonais tem um hexágono" também citam a figura.
  if (lados) {
    if (pedirDiagonais) return responder(frac(lados * (lados - 3), 2), 'geometria_diagonais');
    if (pedirAngulos) return responder(frac((lados - 2) * 180), 'geometria_angulos');
    if (pedirLados) return responder(frac(lados), 'geometria_lados');
  }

  // --- Volume ---
  // "cubo de aresta a" e "cubo de lado a" são a mesma figura; não exigir a
  // palavra "quadrado", que quase nunca aparece no enunciado de um cubo.
  if (pedirVolume && quadrado && exigir(1, 1)) {
    const [a] = nums;
    return responder(multiplica(a, multiplica(a, a)), 'geometria_volume_cubo');
  }
  if (pedirVolume && cubico && exigir(3, 3)) {
    return responder(nums.reduce((acc, n) => multiplica(acc, n), frac(1)), 'geometria_volume_paralelepipedo');
  }
  if (pedirVolume && cubico && exigir(1, 1)) {
    const [a] = nums;
    return responder(multiplica(a, multiplica(a, a)), 'geometria_volume_cubo');
  }

  // --- Hipotenusa / diagonal (Pitágoras) ---
  // PRECEDE a área de propósito. "comprimento total da superfície inclinada de
  // uma rampa de acesso retangular com base 12 e altura 5" contém "retangul"
  // e "superficie": sem esta regra antes, caía em `geometria_area_retangulo` e
  // devolvia 12×5 = 60 para um enunciado cuja resposta é 13.
  //
  // O enunciado nem sempre diz "hipotenusa" — a IA escreve "comprimento
  // inclinado da rampa", "comprimento do cabo de aço". O gatilho combina:
  //   (a) a habilidade declarada ser de Pitágoras, OU o texto citar o theorem;
  //   (b) o texto pedir um COMPRIMENTO (não uma área);
  //   (c) haver exatamente 2 medidas.
  // Exige-se (a) OU a palavra "hipotenusa" para não transformar toda menção a
  // "comprimento" em conta de Pitágoras.
  const habilidadePitagoras = /pitagor/.test(semAcento(habilidade || ''));
  const textoPitagoras = /hipotenus|teorema de pitagor/.test(texto);
  const pedirComprimento = /comprimento|distancia|inclinad|tamanho/.test(texto);
  if ((habilidadePitagoras || textoPitagoras) && pedirComprimento && exigir(2, 2)) {
    const [a, b] = nums;
    const raiz = raizInteiraExata(soma(multiplica(a, a), multiplica(b, b)));
    if (raiz) return responder(raiz, 'geometria_hipotenusa');
  }

  // --- Perímetros ---
  if (pedirPerimetro && quadrado && exigir(1, 1)) {
    const pedirMedidaDoLado = /(?:qual\s+(?:e\s+)?(?:a\s+)?(?:medida\s+)?(?:do|de cada)\s+lado|medida\s+(?:do|de cada)\s+lado)/.test(texto);
    if (pedirMedidaDoLado) {
      return responder(divide(nums[0], frac(4)), 'geometria_lado_quadrado_por_perimetro');
    }
    return responder(multiplica(frac(4), nums[0]), 'geometria_perimetro_quadrado');
  }
  if (pedirPerimetro && triangular && exigir(3, 3)) {
    return responder(nums.reduce((acc, n) => soma(acc, n), frac(0)), 'geometria_perimetro_triangulo');
  }
  if (pedirPerimetro && retangular && exigir(2, 2)) {
    // Ambíguo: "comprimento 20 e perímetro 70, qual a largura?" tem 2 números,
    // mas um deles é o próprio perímetro. Não devolver perímetro calculado.
    const temPerimetroDado = /perimetro\s*(?:igual\s*a|de|:)?\s*\d|perimetro\s*total/i.test(texto);
    if (temPerimetroDado) return null;
    return responder(multiplica(frac(2), soma(nums[0], nums[1])), 'geometria_perimetro_retangulo');
  }

  // --- Áreas ---
  if (pedirArea && quadrado && exigir(1, 1)) {
    return responder(multiplica(nums[0], nums[0]), 'geometria_area_quadrado');
  }
  if (pedirArea && triangular && exigir(2, 2)) {
    return responder(divide(multiplica(nums[0], nums[1]), frac(2)), 'geometria_area_triangulo');
  }
  if (pedirArea && retangular && exigir(2, 2)) {
    return responder(multiplica(nums[0], nums[1]), 'geometria_area_retangulo');
  }

  return null; // sem fórmula determinística segura
}

module.exports = {
  validar,
  validarEstrutura,
  validarMatematica,
  determinarResposta,
  avaliarExpressao,
  normalizarNumero,
  normalizarAlternativas,
  normalizarCorrect,
  paraDecimal,
  // Expostos para diagnóstico/testes das regras de geometria.
  resolverGeometria,
  detectarLados,
  raizInteiraExata,
  alternativaDominante,
  frac,
  soma,
  subtrai,
  multiplica,
  divide,
  igual,
  LETRAS
};
