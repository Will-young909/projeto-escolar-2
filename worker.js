
// worker.js - Ponto de Entrada para o Processo de Fila
require('dotenv').config(); // <-- ADICIONADO: Carrega as variáveis de ambiente do arquivo .env

console.log("Iniciando processo worker...");

const { createWorker } = require('./app/lib/queue');

// Cria e inicia o worker. Ele ficará escutando por novos trabalhos na fila.
const worker = createWorker();

// --- Graceful Shutdown ---
// É uma boa prática garantir que o worker termine o trabalho atual antes de fechar.
const shutdown = async () => {
  console.log('Desligando o worker...');
  await worker.close();
  console.log('Worker desligado.');
  process.exit(0);
};

process.on('SIGINT', shutdown); // Captura Ctrl+C
process.on('SIGTERM', shutdown); // Captura sinais de término (ex: do Docker ou systemd)

console.log("Worker iniciado e aguardando por trabalhos.");
