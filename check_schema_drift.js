// check_schema_drift.js
// Deterta divergência entre as colunas usadas nas queries do código e o schema
// real do banco. Sai com código 1 se encontrar problema (uso em CI/deploy).
//
//   node check_schema_drift.js            compara com o banco ao vivo
//   node check_schema_drift.js --sql      compara com config/database.sql
//
// Existe porque o projeto já teve 3 vezes o mesmo bug em produção:
// "Unknown column 'x' in 'field list'", por nome de coluna divergir entre
// código, migração e banco.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Guard = require('./app/utils/schemaGuard');

const RAIZ = __dirname;
const ALVOS = ['app', 'config', 'migrations'];
const IGNORAR = /node_modules|__tests__|\.backup$|jest_out/;

/** Arquivos .js do projeto (fontes de queries). */
function listarFontes() {
  const arquivos = [];
  const percorrer = dir => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (IGNORAR.test(completo)) continue;
      if (entrada.isDirectory()) percorrer(completo);
      else if (entrada.name.endsWith('.js')) arquivos.push(completo);
    }
  };
  ALVOS.forEach(dir => { const p = path.join(RAIZ, dir); if (fs.existsSync(p)) percorrer(p); });
  return arquivos;
}

/** Coleta todos os usos de coluna com o arquivo de origem. */
function coletarUsos() {
  const usos = [];
  for (const arquivo of listarFontes()) {
    const codigo = fs.readFileSync(arquivo, 'utf8');
    for (const { sql } of Guard.extrairQueries(codigo)) {
      const linhaBase = codigo.slice(0, codigo.indexOf(sql)).split(/\r?\n/).length;
      for (const uso of Guard.extrairColunas(sql)) {
        usos.push({
          ...uso,
          arquivo: path.relative(RAIZ, arquivo).replace(/\\/g, '/'),
          linha: linhaBase,
          sql: sql.replace(/\s+/g, ' ').trim().slice(0, 160)
        });
      }
    }
  }
  return usos;
}

/** Schema lido do MySQL (information_schema). */
async function schemaDoBanco() {
  const pool = require('./config/pool');
  const [tabelas] = await pool.query(
    'SELECT TABLE_NAME AS tabela, COLUMN_NAME AS coluna FROM information_schema.columns WHERE table_schema = DATABASE()'
  );
  const schema = new Map();
  for (const linha of tabelas) {
    const t = String(linha.tabela).toLowerCase();
    if (!schema.has(t)) schema.set(t, new Set());
    schema.get(t).add(String(linha.coluna).toLowerCase());
  }
  return schema;
}

async function main() {
  const usarSql = process.argv.includes('--sql');
  const usos = coletarUsos();
  const resolvidos = usos.filter(u => u.tabela && u.tabela.toUpperCase() !== '__DINAMICO__');

  let schema;
  let origem;
  if (usarSql) {
    const arquivo = path.join(RAIZ, 'config', 'database.sql');
    if (!fs.existsSync(arquivo)) {
      console.error('config/database.sql não encontrado.');
      process.exit(1);
    }
    schema = Guard.carregarSchemaDeSql(fs.readFileSync(arquivo, 'utf8'));
    origem = 'config/database.sql';
  } else {
    const pool = require('./config/pool');
    try {
      schema = await schemaDoBanco();
    } catch (erro) {
      console.error('Não foi possível consultar o banco:', erro.message);
      console.error('Use --sql para comparar com config/database.sql sem conexão.');
      await pool.end().catch(() => {});
      process.exit(2);
    }
    origem = `banco "${process.env.DB_DATABASE || ''}"`;
  }

  const divergencias = Guard.compararComSchema(resolvidos, schema);
  const semResolucao = usos.length - resolvidos.length;

  console.log(`Origem do schema : ${origem}`);
  console.log(`Tabelas no schema: ${schema.size}`);
  console.log(`Usos de coluna   : ${usos.length} (${resolvidos.length} com tabela resolvida)`);
  console.log(`Ignorados (dinâmicos/ambíguos): ${semResolucao}`);

  if (divergencias.length === 0) {
    console.log('\nOK: nenhuma divergência entre o código e o schema.');
    if (!usarSql) await require('./config/pool').end().catch(() => {});
    process.exit(0);
  }

  console.log(`\nDIVERGÊNCIAS (${divergencias.length}):`);
  const vistas = new Set();
  for (const d of divergencias) {
    const chave = `${d.tabela}.${d.coluna}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    const locais = usos.filter(u => u.coluna === d.coluna && u.tabela === d.tabela);
    console.log(`  - ${d.motivo}: ${chave}`);
    [...new Set(locais.map(l => `${l.arquivo}:${l.linha}`))].forEach(f => console.log(`      em ${f}`));
    const exemplo = locais[0];
    if (exemplo) console.log(`      SQL: ${exemplo.sql}`);
  }
  if (!usarSql) await require('./config/pool').end().catch(() => {});
  process.exit(1);
}

main().catch(erro => {
  console.error('Falha na verificação de schema:', erro.message);
  process.exit(2);
});
