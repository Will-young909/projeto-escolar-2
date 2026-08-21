require('dotenv').config(); // Adicionado para carregar as variáveis de ambiente

const redis = require("redis");

// Usa a URL do .env, que deve ser a do Upstash
const client = redis.createClient({
  url: process.env.REDIS_URL
});

// Função de teste assíncrona
async function testRedisConnection() {
  console.log("Iniciando teste de conexão com o Redis...");

  // Escuta por eventos de erro durante a execução
  client.on("error", err => console.error("Evento de Erro do Cliente Redis:", err));

  try {
    // 1. Tenta conectar
    await client.connect();
    console.log("✅ Conectado ao Redis com sucesso!");

    // 2. Envia um comando de teste para verificar a comunicação
    console.log("Enviando comando PING...");
    const pong = await client.ping();
    console.log(`✅ Resposta do Redis: ${pong}`); // Deve imprimir PONG

  } catch (err) {
    console.error("❌ Falha durante o teste de conexão:", err);
  } finally {
    // 3. Fecha a conexão para que o script termine
    console.log("Fechando conexão...");
    await client.quit();
  }
}

// Executa o teste
testRedisConnection();