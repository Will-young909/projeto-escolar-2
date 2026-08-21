// db_query.js
// Arquivo de utilidade para executar consultas SQL no banco de dados.

// Carrega as variáveis de ambiente (DB_HOST, DB_USER, etc.) do arquivo .env
require('dotenv').config();

// Importa o pool de conexões do banco de dados já configurado
const pool = require('./config/pool');

// Função principal assíncrona para executar a consulta
async function executeQuery() {
    // A consulta SQL é pega do primeiro argumento passado na linha de comando
    const query = process.argv[2];

    // Verifica se uma consulta foi fornecida
    if (!query) {
        console.error('ERRO: Nenhuma consulta SQL foi fornecida.');
        console.log('Uso: node db_query.js "SUA CONSULTA SQL AQUI"');
        console.log('Exemplo: node db_query.js "SHOW TABLES"');
        process.exit(1); // Encerra o script com um código de erro
    }

    let connection;
    try {
        // Obtém uma conexão do pool
        connection = await pool.getConnection();
        console.log('✅ Conexão com o banco de dados estabelecida com sucesso.');
        console.log(`⚡ Executando a consulta: "${query}"`);

        // Executa a consulta e obtém os resultados
        const [rows, fields] = await connection.execute(query);

        // Exibe os resultados
        if (rows.length === 0) {
            console.log('📭 A consulta foi executada, mas não retornou resultados.');
        } else {
            console.log('---------- RESULTADOS ----------');
            // console.table é ótimo para exibir arrays de objetos de forma formatada
            console.table(rows);
            console.log('------------------------------');
        }

    } catch (error) {
        // Captura e exibe quaisquer erros que ocorram durante o processo
        console.error('❌ Erro ao executar a consulta:', error.message);
    } finally {
        // Bloco 'finally' garante que a conexão será liberada e o pool encerrado,
        // ocorrendo erro ou não.
        if (connection) {
            connection.release(); // Devolve a conexão para o pool
            console.log('🔌 Conexão com o banco de dados liberada.');
        }
        // Encerra todas as conexões no pool para que o script possa terminar
        await pool.end();
    }
}

// Chama a função principal para iniciar a execução do script
executeQuery();
