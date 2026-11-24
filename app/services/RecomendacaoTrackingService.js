const pool = require('../../config/pool');

async function registrarEvento({ alunoId, professorId, tentativaId = null, posicao = null, score = null, evento, origem = 'recomendados' }) {
    try {
        if (!alunoId || !professorId || !evento) return;
        await pool.query(
            `INSERT INTO recomendacao_eventos (aluno_id, professor_id, tentativa_id, posicao, score, evento, origem)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [alunoId, professorId, tentativaId, posicao, score, evento, origem]
        );
    } catch (err) {
        // Não quebrar fluxo da aplicação por falha de log
    }
}

async function registrarImpressao({ alunoId, professorId, tentativaId = null, posicao = null, score = null }) {
    return registrarEvento({ alunoId, professorId, tentativaId, posicao, score, evento: 'impressao' });
}

async function registrarClique({ alunoId, professorId, tentativaId = null, posicao = null, score = null }) {
    return registrarEvento({ alunoId, professorId, tentativaId, posicao, score, evento: 'clique' });
}

async function registrarContato({ alunoId, professorId, tentativaId = null, posicao = null, score = null }) {
    return registrarEvento({ alunoId, professorId, tentativaId, posicao, score, evento: 'contato' });
}

async function registrarAgendamentoCriado({ alunoId, professorId, tentativaId = null, posicao = null, score = null }) {
    return registrarEvento({ alunoId, professorId, tentativaId, posicao, score, evento: 'agendamento_criado' });
}

module.exports = {
    registrarEvento,
    registrarImpressao,
    registrarClique,
    registrarContato,
    registrarAgendamentoCriado
};
