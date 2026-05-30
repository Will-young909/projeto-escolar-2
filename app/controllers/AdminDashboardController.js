const pool = require('../../config/pool');

exports.getDashboard = async (req, res) => {
    const { status = 'pending', search, page = 1 } = req.query;
    const limit = 10; // Itens por página
    const offset = (page - 1) * limit;

    try {
        const connection = await pool.getConnection();

        // Lógica de filtragem e paginação para a tabela principal (professores pendentes)
        let whereClauses = ['aprovacao_status = ?'];
        let params = [status];

        if (search) {
            whereClauses.push('(nome LIKE ? OR email LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }

        const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

        const mainQuery = `
            SELECT id, nome, email, aprovacao_status, criado_em 
            FROM professores 
            ${whereSql} 
            ORDER BY criado_em DESC 
            LIMIT ? OFFSET ?;
        `;
        const mainParams = [...params, limit, offset];

        const countQuery = `SELECT COUNT(*) as total FROM professores ${whereSql}`;
        const countParams = params;

        const [filteredTeachers] = await connection.query(mainQuery, mainParams);
        const [countResult] = await connection.query(countQuery, countParams);

        const totalItems = countResult[0].total;
        const totalPages = Math.ceil(totalItems / limit);

        // Busca as outras listas sem filtro para as demais tabelas
        const [approvedTeachers] = await connection.query('SELECT * FROM professores WHERE aprovacao_status = \'approved\' ORDER BY criado_em DESC');
        const [inactiveTeachers] = await connection.query('SELECT * FROM professores WHERE aprovacao_status IN (\'rejected\', \'suspended\') ORDER BY criado_em DESC');
        
        connection.release();

        res.render('pages/painel_adm', {
            layout: 'admin_layout',
            // Mantemos as listas separadas para cada tabela na view
            pendingTeachers: filteredTeachers, // A lista principal agora é paginada e filtrada
            approvedTeachers: approvedTeachers,
            inactiveTeachers: inactiveTeachers,
            pagination: {
                page: parseInt(page),
                totalPages,
                status,
                search,
                totalItems
            },
            kpis: {}
        });

    } catch (error) {
        console.error('Error loading the admin dashboard with filters:', error);
        res.status(500).send('Error loading dashboard');
    }
};


// A função getDashboardSummary permanece a mesma
exports.getDashboardSummary = async (req, res) => {
    const range = req.query.range || 'month';
    let startDate = new Date();

    if (range === 'month') {
        startDate.setDate(1);
        startDate.setHours(0, 0, 0, 0);
    } else if (range === 'week') {
        startDate.setDate(startDate.getDate() - 7);
    }

    const connection = await pool.getConnection();
    try {
        const [newStudentsResult] = await connection.query(
            'SELECT COUNT(*) as count FROM alunos WHERE criado_em >= ?', [startDate]
        );

        const [newTeachersResult] = await connection.query(
            'SELECT COUNT(*) as count FROM professores WHERE criado_em >= ?', [startDate]
        );

        const [completedClassesResult] = await connection.query(
            'SELECT COUNT(*) as count FROM agendamentos WHERE status = \'concluido\' AND data >= ?', [startDate]
        );

        const [canceledClassesResult] = await connection.query(
            'SELECT COUNT(*) as count FROM agendamentos WHERE status = \'cancelado\' AND data >= ?', [startDate]
        );

        const [revenueResult] = await connection.query(
            `SELECT SUM(h.preco) as total FROM agendamentos a
             JOIN horarios_disponiveis h ON a.horario_id = h.id
             WHERE a.status = 'concluido' AND a.data >= ?`,
            [startDate]
        );

        const [openReportsResult] = await connection.query(
            'SELECT COUNT(*) as count FROM denuncias'
        );

        res.json({
            newStudents: newStudentsResult[0].count,
            newTeachers: newTeachersResult[0].count,
            completedClasses: completedClassesResult[0].count,
            canceledClasses: canceledClassesResult[0].count,
            monthlyRevenue: revenueResult[0].total || 0,
            openReports: openReportsResult[0].count,
            pendingPayments: 0, 
            avgResolutionTime: 0
        });

    } catch (error) {
        console.error('Error fetching dashboard summary:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard summary' });
    } finally {
        connection.release();
    }
};