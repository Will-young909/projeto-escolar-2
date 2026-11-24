const mysql = require('mysql2/promise');

require('dotenv').config();

const getEnv = (key, fallback = '') => {
  const value = process.env[key];
  if (value === undefined || value === null) return fallback;
  return String(value).replace(/^[\"']+|[\"']+$/g, '').trim();
};

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || 'regimath',
  charset:  'utf8mb4',
  timezone: 'Z',
  dateStrings: ['DATE'],
  waitForConnections: true,
  connectionLimit:    4,
  queueLimit:         0,

  // --- Resiliência contra banco REMOTO (ex.: Clever Cloud) ---
  // O proxy de rede derruba TCP ocioso em silêncio (30-60s em vários NATs e
  // balanceadores). Sem keepalive, o mysql2 só descobre na próxima query e
  // estoura "read ECONNRESET" fatal — ex.: em iniciarTrilhaParaAluno, derrubando
  // a resposta do aluno logo após o commit. Com keepalive curto a conexão
  // "respira" e o mapeamento do proxy não expira.
  enableKeepAlive:     true,
  keepAliveInitialDelay: 10000, // 1ª sonda TCP 10s depois de ficar ociosa
  idleTimeout:         15000,   // pool descarta ociosas ANTES do proxy matar
  maxIdle:             4,
  connectTimeout:      10000
});

// --- Retry único para statements somente-leitura ---
// Mesmo com keepalive, a corrida existe: conexão morre entre o checkout do pool
// e o envio da query. Reexecutar um INSERT cegamente duplicaria dados, então o
// retry vale APENAS para leituras (idempotentes). Transações (getConnection +
// beginTransaction) nunca passam por aqui de propósito: o chamador é quem
// decide o que repetir.
const poolQuery = pool.query.bind(pool);

const ERROS_CONEXAO = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'
]);

const ehSomenteLeitura = (sql) =>
  typeof sql === 'string' && /^\s*(select|show|explain|describe|desc|with)\b/i.test(sql);

pool.query = async (...args) => {
  // Assinatura com callback (estilo mysql1): devolve direto, sem embrulho.
  if (typeof args[args.length - 1] === 'function') return poolQuery(...args);
  try {
    return await poolQuery(...args);
  } catch (error) {
    const transiente = error && ERROS_CONEXAO.has(error.code);
    if (!transiente || !ehSomenteLeitura(args[0])) throw error;
    console.warn(`Pool MySQL: conexão caiu (${error.code}) numa leitura; repetindo uma vez.`);
    return poolQuery(...args);
  }
};

pool.getConnection()
  .then(conn => {
    console.log('✅ Conectado ao MySQL');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Erro ao conectar no MySQL:', err);
  });

module.exports = pool;