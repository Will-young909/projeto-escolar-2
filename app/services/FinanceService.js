const pool = require('../../config/pool');

class FinanceService {
    static async getProfessorEarnings(professorId, startDate) {
        const [rows] = await pool.query(
            `SELECT p.valor, p.taxa_plataforma, r.valor AS valor_liquido,
                    COALESCE(a.nome, 'Aluno') AS aluno_nome,
                    ag.hora, p.liberado_em
             FROM repasses r
             JOIN pagamentos p ON p.payment_id = r.referencia_transacao
             JOIN agendamentos ag ON ag.sala_id = p.sala
             LEFT JOIN alunos a ON a.id = ag.aluno_id
             WHERE r.professor_id = ?
               AND r.status IN ('pendente', 'pago')
               AND ag.status = 'concluido'
               AND p.status = 'pago'
               AND p.liberado_em IS NOT NULL
               AND p.liberado_em >= ?
             ORDER BY p.liberado_em DESC`,
            [professorId, startDate]
        );
        return rows;
    }

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
                WHERE r.status IN ('retido', 'pendente')
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
                p.taxa_plataforma,
                p.valor_liquido,
                p.status,
                COALESCE(p.pago_em, p.criado_em) as criado_em,
                ag.aluno_id,
                al.nome as aluno_nome,
                COALESCE(ag.professor_id, p.professor_id) as professor_id,
                prof.nome as professor_nome
            FROM pagamentos p
            LEFT JOIN agendamentos ag ON p.sala = ag.sala_id
            LEFT JOIN alunos al ON ag.aluno_id = al.id
            LEFT JOIN professores prof ON prof.id = COALESCE(ag.professor_id, p.professor_id)
        `;

        const whereClauses = [];
        const params = [];

        if (professorId) {
            whereClauses.push('COALESCE(ag.professor_id, p.professor_id) = ?');
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
    static async cleanupOldTransactions() {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const [oldPayments] = await connection.query(
                `SELECT p.id, p.payment_id, p.preference_id
                 FROM pagamentos p
                 LEFT JOIN repasses r ON r.referencia_transacao = p.payment_id
                    OR (p.preference_id IS NOT NULL AND r.referencia_transacao = CONCAT('preference:', p.preference_id))
                 WHERE COALESCE(p.pago_em, p.criado_em) < DATE_SUB(NOW(), INTERVAL 1 MONTH)
                 GROUP BY p.id, p.payment_id, p.preference_id
                 HAVING SUM(CASE WHEN r.status IN ('retido', 'pendente') THEN 1 ELSE 0 END) = 0`
            );

            if (!oldPayments.length) {
                await connection.commit();
                return { deletedPayments: 0, deletedRepasses: 0 };
            }

            const refs = [];
            for (const p of oldPayments) {
                if (p.payment_id) refs.push(p.payment_id);
                if (p.preference_id) refs.push(`preference:${p.preference_id}`);
            }

            let deletedRepasses = 0;
            if (refs.length) {
                const placeholders = refs.map(() => '?').join(',');
                const [repasseResult] = await connection.query(
                    `DELETE FROM repasses
                     WHERE referencia_transacao IN (${placeholders})
                       AND status IN ('pago', 'falhou', 'estornado')`,
                    refs
                );
                deletedRepasses = repasseResult.affectedRows || 0;
            }

            const ids = oldPayments.map(p => p.id);
            const idPlaceholders = ids.map(() => '?').join(',');
            const [paymentResult] = await connection.query(
                `DELETE FROM pagamentos WHERE id IN (${idPlaceholders})`,
                ids
            );

            await connection.commit();
            return { deletedPayments: paymentResult.affectedRows || 0, deletedRepasses };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = FinanceService;
