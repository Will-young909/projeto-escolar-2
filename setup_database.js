const fs = require('fs').promises;
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function setupDatabase() {
    console.log('Iniciando a configuração do banco de dados...');
    let connection;

    try {
        // Passo 1: Conectar sem um banco de dados para garantir que ele exista
        const initialConnection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            database: process.env.DB_DATABASE,
            password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT
        });

        const dbName = process.env.DB_DATABASE;
        console.log(`Verificando e, se necessário, criando o banco de dados '${dbName}'`);
        await initialConnection.query(`DROP DATABASE \`${dbName}\`;`);
        await initialConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
        await initialConnection.end();

        // Passo 2: Conectar ao banco de dados específico com suporte a múltiplos comandos
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: dbName,
            port: process.env.DB_PORT,
            multipleStatements: true
        });
        console.log('Conexão com o banco de dados estabelecida com sucesso.');

        // Passo 3: Ler e combinar os arquivos de schema
        console.log('Lendo arquivos de schema...');
        const schemaFiles = ['database.sql'];
        let fullSchema = '';

        for (const fileName of schemaFiles) {
            const schemaPath = path.join(__dirname, 'config', fileName);
            const sqlContent = await fs.readFile(schemaPath, 'utf8');
            fullSchema += sqlContent + '\n';
            console.log(`Arquivo ${fileName} lido e adicionado ao script.`);
        }

        // Passo 4: Executar o script combinado
        console.log('Executando o script de schema combinado...');
        await connection.query(fullSchema);
        console.log('Script de schema executado com sucesso.');

        console.log('\n\n✅✅✅ BANCO DE DADOS PRONTO! ✅✅✅');
        console.log('O banco de dados e todas as tabelas foram configurados corretamente.');

    } catch (error) {
        console.error('\n❌ Falha grave durante a configuração do banco de dados:', error);
    } finally {
        if (connection) {
            await connection.end();
            console.log('Conexão com o banco de dados encerrada.');
        }
    }
}

setupDatabase();
