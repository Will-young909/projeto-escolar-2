const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const pool = require('../../config/pool');

function buildLoginUrl(req) {
  const siteUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
  return new URL('/admin/login', siteUrl).toString();
}

async function sendAdminCredentialsEmail({ to, email, senha, role, loginUrl }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const roleLabel = role === 'superadmin' ? 'Superadmin' : 'Admin';
  const mailOptions = {
    from: {
      name: 'Regimath',
      address: process.env.EMAIL_USER,
    },
    to,
    subject: 'Acesso Administrativo - Regimath',
    html: `
      <p>Olá,</p>
      <p>Uma conta administrativa foi criada para você na plataforma Regimath.</p>
      <p><strong>E-mail:</strong> ${email}<br>
      <strong>Senha:</strong> ${senha}<br>
      <strong>Perfil:</strong> ${roleLabel}</p>
      <p>Acesse o painel administrativo pelo link abaixo:</p>
      <p><a href="${loginUrl}">${loginUrl}</a></p>
      <p>Por segurança, altere sua senha após o primeiro acesso.</p>
    `,
  };

  await transporter.sendMail(mailOptions);
}

exports.createAdmin = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'superadmin') {
      return res.status(403).json({ success: false, message: 'Acesso negado. Apenas superadmin pode cadastrar administradores.' });
    }

    const { email, senha, role } = req.body || {};
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const password = String(senha || '');
    const normalizedRole = String(role || '').trim().toLowerCase();

    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'E-mail inválido.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'A senha deve ter pelo menos 6 caracteres.' });
    }
    if (!['admin', 'superadmin'].includes(normalizedRole)) {
      return res.status(400).json({ success: false, message: 'Role inválida. Use "admin" ou "superadmin".' });
    }

    const [existing] = await pool.query('SELECT id FROM admins WHERE email = ?', [normalizedEmail]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Já existe um administrador com este e-mail.' });
    }

    const id = crypto.randomUUID();
    const nome = (normalizedEmail.split('@')[0] || 'Administrador').slice(0, 150);
    const hash = bcrypt.hashSync(password, 10);

    await pool.query(
      'INSERT INTO admins (id, nome, email, senha, role) VALUES (?, ?, ?, ?, ?)',
      [id, nome, normalizedEmail, hash, normalizedRole]
    );

    const loginUrl = buildLoginUrl(req);
    try {
      await sendAdminCredentialsEmail({
        to: normalizedEmail,
        email: normalizedEmail,
        senha: password,
        role: normalizedRole,
        loginUrl,
      });
      return res.json({ success: true, message: 'Administrador cadastrado e e-mail de acesso enviado com sucesso.' });
    } catch (mailError) {
      console.error('Admin criado, mas falha ao enviar e-mail de credenciais:', mailError);
      return res.status(201).json({
        success: true,
        emailSent: false,
        loginUrl,
        message: 'Administrador cadastrado, mas não foi possível enviar o e-mail de acesso. Verifique a configuração de e-mail.',
      });
    }
  } catch (error) {
    console.error('Erro ao cadastrar admin:', error);
    return res.status(500).json({ success: false, message: 'Erro ao cadastrar administrador.' });
  }
};
