'use strict';

/**
 * Guarda de deriva de schema (code ↔ banco).
 *
 * Extrai as colunas usadas nas queries SQL do código e compara com o schema
 * real. Existe porque o projeto já sofreu três vezes do mesmo bug: uma coluna foi
 * adicionada ao código (ou à migração) com um nome ligeiramente diferente do que
 * existe no banco, e o erro só apareceu em produção, como
 * "Unknown column 'x' in 'field list'".
 *
 * Este módulo é a análise estática (sem I/O). A verificação contra o banco fica
 * em `check_schema_drift.js`.
 *
 * O que NÃO é possível verificar (e é ignorado de propósito, para não gerar
 * falso positivo):
 *  - tabelas/colunas montadas por interpolação (`${table}`, `${key} = ?`);
 *  - `SELECT *` e `alias.*`;
 *  - colunas sem qualificação quando a query traz subquery/CTE.
 */

/** Palavras que nunca são alias de tabela. */
const NAO_ALIAS = new Set([
  'on', 'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'as', 'set', 'values',
  'and', 'or', 'not', 'in', 'is', 'null', 'like', 'between', 'group', 'order', 'by', 'having',
  'limit', 'offset', 'union', 'all', 'distinct', 'into', 'for', 'use', 'force', 'ignore', 'index',
  'key', 'primary', 'unique', 'exists', 'if', 'case', 'when', 'then', 'else', 'end', 'asc', 'desc'
]);

/** Funções SQL cujo nome não é coluna. */
const FUNCOES = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'ifnull', 'nullif', 'now', 'curdate', 'curtime',
  'date', 'datediff', 'year', 'month', 'day', 'concat', 'concat_ws', 'length', 'lower', 'upper',
  'trim', 'round', 'floor', 'ceil', 'abs', 'cast', 'convert', 'json_extract', 'json_value',
  'group_concat', 'substring', 'left', 'right', 'values', 'if', 'greatest', 'least', 'random', 'uuid'
]);

const IDENT = '[A-Za-z_][A-Za-z0-9_$]*';

/**
 * Normaliza uma query: remove comentários e literais de texto, e neutraliza
 * interpolações `${...}` (que viram identificador dinâmico não verificável).
 */
function limpar(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    // Aspas escapadas vêm de strings JS: `\'aluno\'`. Converter para `'` ANTES
    // de remover literais, senão o regex de literal não casa e o conteúdo vaza
    // como se fosse coluna.
    .replace(/\\(['"])/g, '$1')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\$\{[^}]*\}/g, ' __DINAMICO__ ');
}

/** Verdadeiro se o trecho parece conter SQL de DML. */
function pareceSql(texto) {
  return /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(texto);
}

/**
 * Extrai os trechos de SQL do código-fonte: template literals e strings
 * simples/duplas que contenham DML.
 */
function extrairQueries(codigo) {
  const textos = [];
  const fonte = String(codigo || '');

  // Template literals (permitem interpolação).
  const template = /`([\s\S]*?)`/g;
  let m;
  while ((m = template.exec(fonte)) !== null) {
    if (pareceSql(m[1])) textos.push({ sql: m[1], interpolado: /\$\{/.test(m[1]) });
  }

  // Strings simples e duplas (SQL sem interpolação).
  const simples = /(['"])((?:[^'"\\]|\\.)*?)\1/g;
  while ((m = simples.exec(fonte)) !== null) {
    if (pareceSql(m[2])) textos.push({ sql: m[2], interpolado: false });
  }

  return textos;
}

/**
 * Coleta as tabelas da query e seus aliases.
 * Inclui subqueries/CTEs: um nome entre parênteses seguido de `AS` é CTE, e
 * ignoramos (não é tabela física).
 */
function extrairTabelas(sql) {
  const limpo = limpar(sql);
  const tabelas = new Map(); // alias -> tabela
  const fisicas = new Set();

  const registrar = (tabela, alias) => {
    if (!tabela || tabela === '__DINAMICO__') return;
    const t = tabela.toLowerCase();
    fisicas.add(t);
    if (alias && !NAO_ALIAS.has(alias.toLowerCase()) && !FUNCOES.has(alias.toLowerCase())) {
      tabelas.set(alias.toLowerCase(), t);
    }
  };

  const re = new RegExp(
    `\\b(FROM|JOIN|INTO|UPDATE)\\s+(${IDENT})(?:\\s+(?:AS\\s+)?(${IDENT}))?`,
    'gi'
  );
  let m;
  while ((m = re.exec(limpo)) !== null) {
    const palavra = m[1].toUpperCase();
    const proxima = m[3] ? m[3].toLowerCase() : '';
    // "FROM (SELECT ...)" é subquery, não tabela nomeada.
    if (palavra === 'FROM' && proxima && NAO_ALIAS.has(proxima) && proxima !== 'dual') {
      if (proxima === 'select') continue;
    }
    registrar(m[2], m[3]);
  }

  return { tabelas, fisicas: [...fisicas] };
}

/** Divide uma lista por vírgulas respeitando parênteses. */
function dividirPorVirgula(texto) {
  const partes = [];
  let profundidade = 0;
  let atual = '';
  for (const ch of texto) {
    if (ch === '(') profundidade++;
    if (ch === ')') profundidade--;
    if (ch === ',' && profundidade === 0) { partes.push(atual); atual = ''; continue; }
    atual += ch;
  }
  if (atual.trim()) partes.push(atual);
  return partes.map(p => p.trim()).filter(Boolean);
}

/** Remove wrappers de função e extrai o identificador final (`t.col` ou `col`). */
function extrairIdentificador(fragmento) {
  let texto = String(fragmento || '').trim();
  if (!texto) return null;
  if (/\*/.test(texto)) return null; // `*` ou `t.*` não é coluna nomeada
  // Remove operadores de acesso a JSON e casts.
  texto = texto.replace(/->>?\s*'[^']*'/g, '').replace(/->>?\s*"[^"]*"/g, '').replace(/::\s*\w+(\(\d+\))?/g, '');
  // Pega o último identificador, ignorando chamadas de função.
  const tokens = texto.match(new RegExp(IDENT, 'g'));
  if (!tokens || tokens.length === 0) return null;
  const ultimo = tokens[tokens.length - 1];
  if (FUNCOES.has(ultimo.toLowerCase())) return null;
  const anterior = tokens[tokens.length - 2];
  if (anterior && new RegExp(`\\(\\s*${IDENT}\\s*\\)$`).test(texto.slice(texto.lastIndexOf(anterior)))) {
    return null; // era apenas o nome da função
  }
  const prefixo = anterior && !/\(/.test(texto.slice(texto.lastIndexOf(anterior), texto.lastIndexOf(ultimo))) ? anterior : null;
  return { coluna: ultimo, qualificador: prefixo };
}

/** Trecho entre `SELECT` e o `FROM` correspondente (primeiro, no nível 0). */
function listaDeColunasSelect(limpo) {
  const inicio = limpo.search(/\bSELECT\b/i);
  if (inicio === -1) return null;
  const from = limpo.slice(inicio).search(/\bFROM\b/i);
  if (from === -1) return null;
  return limpo.slice(inicio + 6, inicio + from);
}

/** Colunas declaradas explicitamente num INSERT: `INSERT INTO t (a, b)`. */
function colunasDoInsert(limpo) {
  const m = limpo.match(/\bINSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/i);
  return m ? { tabela: m[1].toLowerCase(), colunas: dividirPorVirgula(m[2]) } : null;
}

/** Colunas atribuídas num UPDATE: `UPDATE t SET a = ?, b = ?`. */
function colunasDoUpdate(limpo) {
  const m = limpo.match(/\bUPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?=\bWHERE\b|\bLIMIT\b|$)/i);
  if (!m) return null;
  return { tabela: m[1].toLowerCase(), colunas: dividirPorVirgula(m[2]) };
}

/**
 * Remove `AS alias` para não confundir alias de projeção com coluna.
 * Cria a regex a cada chamada: com a flag `g`, um objeto compartilhado
 * carregaria `lastIndex` entre usos e falharia alternadamente.
 */
function semAlias(fragmento) {
  return String(fragmento).replace(new RegExp(`\\s+AS\\s+\`?${IDENT}\`?`, 'gi'), ' ');
}

/** Palavras SQL que nunca são coluna. */
const PALAVRAS = new Set([
  'and', 'or', 'not', 'null', 'is', 'in', 'like', 'between', 'as', 'distinct', 'case', 'when',
  'then', 'else', 'end', 'asc', 'desc', 'limit', 'offset', 'union', 'all', 'exists', 'if', 'div',
  'mod', 'binary', 'using', 'on', 'where', 'order', 'group', 'having', 'by', 'from', 'join',
  'select', 'insert', 'into', 'update', 'set', 'values', 'duplicate', 'key', 'primary', 'unique',
  'default', 'table', 'index', 'force', 'ignore', 'interval', 'regexp', 'rlike', 'collate',
  'separator', 'delimiter', 'streamed', 'stored', 'virtual', 'generated', 'true', 'false'
]);

/**
 * Extrai TODOS os identificadores de coluna de um fragmento de expressão,
 * ignorando nomes de função, palavras SQL e aliases de projeção.
 *
 * `COALESCE(uh.percentual_dominio, 0) AS x` -> [{coluna:'percentual_dominio', qualificador:'uh'}]
 */
function extrairIdentificadores(fragmento) {
  const texto = String(fragmento || '')
    .replace(/->>?\s*'[^']*'/g, '')
    .replace(/->>?\s*"[^"]*"/g, '')
    .replace(/::\s*\w+(\(\d+\))?/g, ' ');
  // Fragmentos que são só curinga: `*` ou `alias.*`
  if (/^\s*(?:[A-Za-z_][\w$]*\s*\.\s*)?\*+\s*$/.test(texto)) return [];

  const re = new RegExp(`(${IDENT})\\s*(\\(?)`, 'g');
  const brutos = [];
  let m;
  while ((m = re.exec(texto)) !== null) {
    const nome = m[1];
    if (m[2] === '(') continue;                              // chamada de função
    const nomeMin = nome.toLowerCase();
    if (PALAVRAS.has(nomeMin) || FUNCOES.has(nomeMin)) continue;
    if (nomeMin === '__dinamico__') continue;
    brutos.push({ coluna: nomeMin, _pos: m.index, _nome: nome });
  }

  // Resolve qualificadores: token anterior separado apenas por `.`.
  // O token usado como qualifier NÃO é emitido como coluna.
  const usadosComoQualificador = new Set();
  const resultado = brutos.map((a, i) => {
    const anterior = brutos[i - 1];
    if (anterior && /^\s*\.\s*$/.test(texto.slice(anterior._pos + anterior._nome.length, a._pos))) {
      usadosComoQualificador.add(anterior._pos);
      return { coluna: a.coluna, qualificador: anterior._nome.toLowerCase() };
    }
    return { coluna: a.coluna, qualificador: null };
  });
  return resultado.filter((r, i) => !usadosComoQualificador.has(brutos[i]._pos));
}

/** Aliases de projeção (`... AS x`) — não são colunas da tabela. */
function extrairAliases(lista) {
  const aliases = new Set();
  if (!lista) return aliases;
  const re = new RegExp(`\\s+AS\\s+\`?${IDENT}\`?`, 'gi');
  let m;
  while ((m = re.exec(lista)) !== null) aliases.add(m[0].trim().split(/\s+/).pop().replace(/`/g, '').toLowerCase());
  return aliases;
}

/**
 * Coleta os usos de coluna de uma query, resolvendo o alias para a tabela real.
 * @returns {Array<{coluna: string, qualificador: string|null, tabela: string|null}>}
 */
function extrairColunas(sql) {
  // Query com interpolação aninhada (`${itens.map(x => `${x} = ?`)}`) monta
  // colunas dinamicamente: não é verificável estaticamente, então é ignorada.
  if (/\$\{[^}]*\{/.test(String(sql))) return [];

  const limpo = limpar(sql);
  // Sobrou `${...}` sem fechamento: o scanner de template literal cortou a
  // interpolação, então as colunas vêm de variáveis e não são verificáveis.
  if (limpo.includes('${')) return [];

  const { tabelas: aliasMap, fisicas } = extrairTabelas(sql);
  const usos = [];
  const tabelaUnica = fisicas.length === 1 ? fisicas[0] : null;
  const tabelaDoInsert = (limpo.match(/\bINSERT\s+INTO\s+(\w+)/i) || [])[1];
  const tabelaDoUpdate = (limpo.match(/\bUPDATE\s+(\w+)/i) || [])[1];
  const lista = listaDeColunasSelect(limpo);
  // Aliases da projeção não são colunas: `HAVING cancelamentos > 10` e
  // `ORDER BY mediaPercentual DESC` referenciam o alias, não a tabela.
  const aliases = extrairAliases(lista);

  const adicionar = (coluna, qualificador) => {
    if (!coluna || coluna === '__dinamico__') return;
    if (!qualificador && aliases.has(coluna)) return;
    const viaAlias = qualificador ? aliasMap.get(qualificador) : null;
    const tabela = viaAlias
      || (!qualificador ? (tabelaUnica || tabelaDoInsert || tabelaDoUpdate || null) : null);
    usos.push({ coluna, qualificador: qualificador || null, tabela });
  };

  // INSERT: lista explícita de colunas (confiável).
  const insert = colunasDoInsert(limpo);
  if (insert) {
    insert.colunas.forEach(c => {
      extrairIdentificadores(c).forEach(id => adicionar(id.coluna, null));
    });
    return usos;
  }

  // UPDATE: lado esquerdo das atribuições.
  const update = colunasDoUpdate(limpo);
  if (update) {
    update.colunas.forEach(c => {
      const ladoEsquerdo = String(c).split('=')[0];
      extrairIdentificadores(semAlias(ladoEsquerdo)).forEach(id => adicionar(id.coluna, id.qualificador));
    });
  }

  // SELECT: lista de projeção (aliases removidos).
  if (lista) {
    dividirPorVirgula(lista).forEach(item => {
      if (/__DINAMICO__/.test(item)) return;
      extrairIdentificadores(semAlias(item)).forEach(id => adicionar(id.coluna, id.qualificador));
    });
  }

  // ON/WHERE/ORDER BY/GROUP BY/HAVING também consomem colunas.
  // Começa depois da lista de projeção para não reprocessá-la.
  if (lista) {
    const posFimLista = limpo.search(/\bSELECT\b/i) + 6 + lista.length;
    const cauda = limpo.slice(posFimLista);
    const partes = cauda.split(/\b(?=ON\b|WHERE\b|ORDER\s+BY\b|GROUP\s+BY\b|HAVING\b)/i);
    partes.forEach(bloco => {
      if (!/^(ON|WHERE|ORDER\s+BY|GROUP\s+BY|HAVING)\b/i.test(bloco.trim())) return;
      const corpo = bloco.replace(/^(ON|WHERE|ORDER\s+BY|GROUP\s+BY|HAVING)\b/i, '')
        .split(/\b(?=ON\b|WHERE\b|ORDER\s+BY\b|GROUP\s+BY\b|HAVING\b|SELECT\b|FROM\b|JOIN\b|UNION\b)/i)[0];
      dividirPorVirgula(corpo).forEach(item => {
        if (/__DINAMICO__/.test(item)) return;
        // Lado esquerdo da comparação e, se qualificado, o direito.
        const lados = item.split(/(?<![\w.])(?:=|<>|!=|<=|>=|<|>)(?!=)/);
        extrairIdentificadores(semAlias(lados[0])).forEach(id => adicionar(id.coluna, id.qualificador));
        if (lados[1] && /\w\s*\.\s*\w/.test(lados[1])) {
          extrairIdentificadores(semAlias(lados[1])).forEach(id => adicionar(id.coluna, id.qualificador));
        }
      });
    });
  }

  return usos;
}

/**
 * Lê o schema a partir de um arquivo .sql (CREATE TABLE + ALTER TABLE ADD COLUMN).
 * @returns {Map<string, Set<string>>} tabela -> colunas (minúsculas)
 */
function carregarSchemaDeSql(texto) {
  const schema = new Map();
  const garantir = tabela => {
    const t = tabela.toLowerCase();
    if (!schema.has(t)) schema.set(t, new Set());
    return schema.get(t);
  };

  // CREATE TABLE nome ( ... );
  const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(([\s\S]*?)\)\s*(?:ENGINE|;)/gi;
  let m;
  while ((m = create.exec(texto)) !== null) {
    const tabela = m[1].toLowerCase();
    const colunas = garantir(tabela);
    m[2].split(/\r?\n/).forEach(linha => {
      const texto0 = linha.split('--')[0].trim();
      if (!texto0) return;
      if (/^(CONSTRAINT|PRIMARY|UNIQUE|KEY|INDEX|FOREIGN|FULLTEXT|CHECK)\b/i.test(texto0)) return;
      const nome = texto0.match(/^`?(\w+)`?\s+/);
      if (nome) colunas.add(nome[1].toLowerCase());
    });
  }

  // ALTER TABLE t ADD COLUMN col ...
  const alter = /ALTER\s+TABLE\s+`?(\w+)`?([\s\S]*?);/gi;
  while ((m = alter.exec(texto)) !== null) {
    const colunas = garantir(m[1]);
    const adds = m[2].matchAll(/ADD\s+(?:COLUMN\s+)?`?(\w+)`?/gi);
    for (const a of adds) colunas.add(a[1].toLowerCase());
  }

  return schema;
}

/**
 * Compara os usos de coluna com o schema.
 * Só reporta quando o uso é inequívoco (tabela resolvida) ou quando a coluna não
 * existe em nenhuma tabela da query (evita falso positivo em ambiguidade).
 *
 * @returns {Array<{tabela: string, coluna: string, arquivo?: string, motivo: string}>}
 */
function compararComSchema(usos, schema) {
  const divergencias = [];
  for (const uso of usos) {
    const { coluna, tabela } = uso;
    if (!coluna || coluna === '__dinamico__') continue;

    if (tabela) {
      if (!schema.has(tabela)) {
        divergencias.push({ tabela, coluna, motivo: `tabela "${tabela}" não existe no schema` });
      } else if (!schema.get(tabela).has(coluna)) {
        divergencias.push({ tabela, coluna, motivo: `coluna não existe em "${tabela}"` });
      }
      continue;
    }

    // Sem tabela resolvida: só reporta se não existir em nenhuma tabela do schema.
    if (tabela === undefined) continue;
  }
  return divergencias;
}

module.exports = {
  NAO_ALIAS,
  FUNCOES,
  PALAVRAS,
  IDENT,
  limpar,
  pareceSql,
  extrairQueries,
  extrairTabelas,
  extrairColunas,
  extrairAliases,
  dividirPorVirgula,
  extrairIdentificadores,
  carregarSchemaDeSql,
  compararComSchema
};