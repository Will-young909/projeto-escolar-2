const pool = require('../../config/pool');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer'); // Importa o Nodemailer

async function findUserByEmail(email) {
    let [user] = await pool.query('SELECT id, \'aluno\' as tipo FROM alunos WHERE email = ?', [email]);
    if (user.length > 0) return { ...user[0], tipo: 'aluno' };

    [user] = await pool.query('SELECT id, \'professor\' as tipo FROM professores WHERE email = ?', [email]);
    if (user.length > 0) return { ...user[0], tipo: 'professor' };

    return null;
}

async function createPasswordResetToken(email) {
    const user = await findUserByEmail(email);
    if (!user) {
        console.log(`Tentativa de redefinição de senha para e-mail não cadastrado: ${email}`);
        return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutos

    await pool.query(
        'INSERT INTO password_reset_tokens (user_id, user_type, token_hash, expires_at) VALUES (?, ?, ?, ?)',
        [user.id, user.tipo, tokenHash, expiresAt]
    );

    const resetLink = `${process.env.SITE_URL}/reset-password/${token}`;

    // --- Início da Implementação com Nodemailer ---

    // 1. Cria um "transportador" SMTP reutilizável
    const transporter = nodemailer.createTransport({
        service: 'gmail', // Usaremos o Gmail como exemplo
        host: 'smtp.gmail.com',
        port: 465,
        secure: true, // `true` para a porta 465, `false` para outras portas
        auth: {
            user: process.env.EMAIL_USER, // Seu e-mail do Gmail
            pass: process.env.EMAIL_PASS, // A senha de aplicativo gerada
        },
    });

    // 2. Define as opções do e-mail
    const mailOptions = {
        from: { // O endereço do remetente
            name: 'Regimath',
            address: process.env.EMAIL_USER
        },
        to: email, // O endereço do destinatário
        subject: 'Redefinição de Senha - Regimath', // Assunto
        html: `<p>Olá,</p><p>Você solicitou a redefinição da sua senha. Clique no link a seguir para criar uma nova senha:</p><p><a href="${resetLink}">${resetLink}</a></p><p>Este link expira em 30 minutos.</p><p>Se você não solicitou isso, ignore este e-mail.</p>`, // Corpo do e-mail em HTML
    };

    // 3. Envia o e-mail
    try {
        await transporter.sendMail(mailOptions);
        console.log('E-mail de redefinição enviado com sucesso para:', email);
    } catch (error) {
        console.error('Erro ao enviar e-mail com Nodemailer:', error);
        // Lança um erro genérico para não expor detalhes da falha
        throw new Error('O serviço de e-mail não pôde enviar a mensagem. Verifique a configuração do servidor de e-mail.');
    }
    // --- Fim da Implementação com Nodemailer ---
}

async function verifyPasswordResetToken(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [tokens] = await pool.query('SELECT * FROM password_reset_tokens WHERE token_hash = ?', [tokenHash]);

    if (tokens.length === 0) {
        throw new Error('Token inválido ou expirado.');
    }

    const tokenData = tokens[0];
    if (new Date() > new Date(tokenData.expires_at)) {
        await pool.query('DELETE FROM password_reset_tokens WHERE id = ?', [tokenData.id]);
        throw new Error('Token inválido ou expirado.');
    }

    return tokenData;
}

async function resetPassword(token, newPassword) {
    const tokenData = await verifyPasswordResetToken(token);

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    const tableName = tokenData.user_type === 'aluno' ? 'alunos' : 'professores';

    await pool.query(`UPDATE ${tableName} SET senha = ? WHERE id = ?`, [hashedPassword, tokenData.user_id]);

    await pool.query('DELETE FROM password_reset_tokens WHERE id = ?', [tokenData.id]);
}

module.exports = {
    createPasswordResetToken,
    verifyPasswordResetToken,
    resetPassword,
};