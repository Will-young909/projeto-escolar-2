const pool = require('../../config/pool');

class FinanceService {
    static async getPendingPayouts() {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(`
                SELECT 
                    r.id,
                    r.professor_id,
                    p.nome as professor_nome,
                    r.valor,
                    r.status,
                    r.data_solicitacao
                FROM repasses r
                JOIN professores p ON r.professor_id = p.id
                WHERE r.status = 'pendente'
                ORDER BY r.data_solicitacao ASC
            `);
            return rows;
        } finally {
            connection.release();
        }
    }

    static async getTransactionHistory(filters = {}) {
        const { page = 1, limit = 15, professorId, startDate, endDate, type } = filters;
        const offset = (page - 1) * limit;

        let query = `
            SELECT 
                p.id as pagamento_id,
                p.descricao,
                p.valor,
                p.status,
                p.criado_em,
                a.aluno_id,
                al.nome as aluno_nome,
                a.professor_id,
                prof.nome as professor_nome
            FROM pagamentos p
            LEFT JOIN agendamentos ag ON p.sala = ag.sala_id
            LEFT JOIN alunos al ON ag.aluno_id = al.id
            LEFT JOIN professores prof ON ag.professor_id = prof.id
        `;

        const whereClauses = [];
        const params = [];

        if (professorId) {
            whereClauses.push('ag.professor_id = ?');
            params.push(professorId);
        }
        if (startDate) {
            whereClauses.push('p.criado_em >= ?');
            params.push(startDate);
        }
        if (endDate) {
            whereClauses.push('p.criado_em <= ?');
            params.push(endDate);
        }
        if (type) {
            // This might need more complex logic depending on what 'type' means
            // For now, let's assume it's a status filter
            whereClauses.push('p.status = ?');
            params.push(type);
        }

        if (whereClauses.length > 0) {
            query += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        query += ' ORDER BY p.criado_em DESC';
        
        const countQuery = query.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) as total FROM');

        query += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const connection = await pool.getConnection();
        try {
            const [transactions] = await connection.query(query, params);
            const [countResult] = await connection.query(countQuery, params.slice(0, -2));
            const totalItems = countResult[0].total;
            const totalPages = Math.ceil(totalItems / limit);

            return {
                transactions,
                pagination: { page, totalPages, totalItems, limit }
            };
        } finally {
            connection.release();
        }
    }
}

module.exports = FinanceService;
