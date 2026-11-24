const pool = require('../../config/pool');
const bcrypt = require('bcryptjs');

exports.getLogin = (req, res) => {
    if (req.session && req.session.user_admin) {
        return res.redirect('/admin/dashboard');
    }
    res.render('pages/admin_login', { erros: {}, dados: {} });
};

exports.postLogin = async (req, res) => {
    const { email, senha } = req.body;

    if (!email || !senha) {
        return res.render('pages/admin_login', {
            erros: { general: { msg: 'E-mail e senha são obrigatórios.' } },
            dados: { email },
        });
    }

    try {
        const [rows] = await pool.query(
            'SELECT id, nome, email, senha, role FROM admins WHERE email = ?',
            [email.toLowerCase()]
        );

        const admin = rows[0];
        if (!admin || !bcrypt.compareSync(senha, admin.senha)) {
            return res.render('pages/admin_login', {
                erros: { general: { msg: 'E-mail ou senha incorretos.' } },
                dados: { email },
            });
        }

        req.session.user_admin = {
            id: admin.id,
            nome: admin.nome,
            email: admin.email,
            role: admin.role,
        };

        return res.redirect('/admin/dashboard');
    } catch (error) {
        console.error('Erro no login do admin:', error);
        return res.render('pages/admin_login', {
            erros: { general: { msg: 'Erro interno ao tentar fazer login.' } },
            dados: { email },
        });
    }
};

exports.logout = (req, res) => {
    req.session.destroy(() => {
        res.redirect('/admin/login');
    });
};
