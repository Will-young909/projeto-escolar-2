const pool = require('../../config/pool');

async function requireAdmin(req, res, next) {/*
    if (!req.session || !req.session.user_admin || !req.session.user_admin.id) {
        console.warn('Attempt to access admin route without session.');
        return res.status(401).send('Acesso não autorizado. Por favor, faça login.');
    }

    const adminId = req.session.user_admin.id;

    try {
        const [admins] = await pool.query('SELECT id, role FROM admins WHERE id = ?', [adminId]);

        if (admins.length === 0) {
            console.warn(`Admin user with ID ${adminId} from session not found in database.`);
            req.session.destroy();
            return res.status(403).send('Acesso negado. Sessão inválida.');
        }

        const adminFromDb = admins[0];

        if (adminFromDb.role !== 'admin' && adminFromDb.role !== 'superadmin') {
            console.warn(`User ${adminId} with role ${adminFromDb.role} attempted to access an admin-only route.`);
            return res.status(403).send('Acesso negado. Você não tem permissão para esta ação.');
        }

        req.user = adminFromDb;
        */next();/*

    } catch (error) {
        console.error('Error during admin authentication middleware:', error);
        res.status(500).send('Erro interno do servidor ao verificar permissões.');
    }*/
}

module.exports = requireAdmin;
