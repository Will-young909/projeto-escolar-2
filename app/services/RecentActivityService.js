const pool = require('../../config/pool');

class RecentActivityService {
    static async getRecentActivities() {
        const connection = await pool.getConnection();
        try {
            const query = `
                (SELECT
                    'new_teacher' as type,
                    p.nome as subject,
                    p.criado_em as timestamp,
                    p.aprovacao_status as status,
                    null as anonimo,
                    JSON_OBJECT('teacher_id', p.id, 'teacher_name', p.nome) as details
                FROM professores p
                WHERE p.aprovacao_status = 'pending'
                ORDER BY p.criado_em DESC
                LIMIT 5)

                UNION ALL

                (SELECT
                    'new_class' as type,
                    a.id as subject,
                    a.criado_em as timestamp,
                    a.status,
                    null as anonimo,
                    JSON_OBJECT(
                        'aluno_id', a.aluno_id,
                        'aluno_nome', al.nome,
                        'professor_id', a.professor_id,
                        'professor_nome', pr.nome,
                        'preco', hd.preco
                    ) as details
                FROM agendamentos a
                JOIN alunos al ON a.aluno_id = al.id
                JOIN professores pr ON a.professor_id = pr.id
                JOIN horarios_disponiveis hd ON a.horario_id = hd.id
                WHERE a.status = 'concluido'
                ORDER BY a.criado_em DESC
                LIMIT 5)

                UNION ALL

                (SELECT
                    'new_report' as type,
                    d.titulo as subject,
                    d.criado_em as timestamp,
                    d.status,
                    d.anonimo,
                    JSON_OBJECT(
                        'denuncia_id', d.id,
                        'denunciante_id', d.denunciante_id,
                        'denunciante_nome', COALESCE(denunciante_prof.nome, denunciante_al.nome),
                        'denunciado_id', d.denunciado_id,
                        'denunciado_nome', COALESCE(denunciado_prof.nome, denunciado_al.nome)
                    ) as details
                FROM denuncias d
                LEFT JOIN professores denunciado_prof ON d.denunciado_id = denunciado_prof.id
                LEFT JOIN alunos denunciado_al ON d.denunciado_id = denunciado_al.id
                LEFT JOIN professores denunciante_prof ON d.denunciante_id = denunciante_prof.id
                LEFT JOIN alunos denunciante_al ON d.denunciante_id = denunciante_al.id
                ORDER BY d.criado_em DESC
                LIMIT 5)

                ORDER BY timestamp DESC
                LIMIT 5;
            `;

            const [activities] = await connection.query(query);
            return activities;

        } catch (error) {
            console.error('Error fetching recent activities:', error);
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = RecentActivityService;
