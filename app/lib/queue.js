require('dotenv').config();

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');

const MachineLearningService = require('../services/MachineLearningService');

// --- Configuração da fila ---
const QUEUE_NAME = 'pedagogical-tasks';

// --- Conexão Redis Upstash ---
const redisConnection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Eventos de debug
redisConnection.on('connect', () => {
  console.log('✅ Redis Upstash conectado');
});

redisConnection.on('error', (err) => {
  console.error('❌ Erro Redis:', err);
});

// --- Fila principal ---
const pedagogicalQueue = new Queue(QUEUE_NAME, {
  connection: redisConnection
});

// --- Worker ---
const createWorker = () => {

  const worker = new Worker(
    QUEUE_NAME,

    async (job) => {

      console.log(`[Worker] Iniciando trabalho: ${job.name} (ID: ${job.id})`);

      switch (job.name) {

        case 'train-ml-model':

          await MachineLearningService.treinarModelo();
          break;

        default:

          console.warn(`[Worker] Trabalho desconhecido: ${job.name}`);
      }

    },

    {
      connection: redisConnection
    }
  );

  // Eventos do Worker
  worker.on('completed', (job) => {

    console.log(`[Worker] Trabalho concluído: ${job.name} (ID: ${job.id})`);

  });

  worker.on('failed', (job, err) => {

    console.error(
      `[Worker] Falha no trabalho ${job?.name} (ID: ${job?.id}):`,
      err
    );

  });

  return worker;
};

module.exports = {
  pedagogicalQueue,
  createWorker,
  redisConnection
};