
const fs = require('fs').promises;
const path = require('path');

// Define o caminho para o arquivo que armazenará as mensagens do chat
const CHAT_HISTORY_PATH = path.join(__dirname, '..', '..', 'chat_history.json');

// Garante que o diretório e o arquivo existam
async function initialize() {
    try {
        await fs.access(CHAT_HISTORY_PATH);
    } catch (error) {
        // Se o arquivo não existir, cria um com um objeto vazio
        await fs.writeFile(CHAT_HISTORY_PATH, JSON.stringify({}));
    }
}

// Carrega todas as mensagens do arquivo
async function loadMessages() {
    try {
        const data = await fs.readFile(CHAT_HISTORY_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Erro ao carregar o histórico de chat:', error);
        return {}; // Retorna um objeto vazio em caso de erro
    }
}

// Salva uma nova mensagem no arquivo
async function saveMessage(room, message) {
    try {
        const allMessages = await loadMessages();
        if (!allMessages[room]) {
            allMessages[room] = [];
        }
        allMessages[room].push(message);

        // Limita o histórico para as últimas 200 mensagens para não sobrecarregar
        if (allMessages[room].length > 200) {
            allMessages[room].shift();
        }

        await fs.writeFile(CHAT_HISTORY_PATH, JSON.stringify(allMessages, null, 2));
    } catch (error) {
        console.error('Erro ao salvar a mensagem do chat:', error);
    }
}

// Obtém o histórico de uma sala específica
async function getRoomHistory(room) {
    const allMessages = await loadMessages();
    return allMessages[room] || [];
}

// Inicializa o armazenamento ao carregar o módulo
initialize();

module.exports = {
    saveMessage,
    getRoomHistory,
    loadMessages // Adicionado para que as rotas possam carregar todo o histórico
};
