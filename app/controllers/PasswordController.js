const passwordService = require('../services/PasswordService');

exports.forgotPassword = async (req, res) => {
    const { email } = req.body;
    try {
        await passwordService.createPasswordResetToken(email);
        res.render('pages/message', { message: 'Se um usuário com este e-mail existir, um link para redefinição de senha foi enviado.' });
    } catch (error) {
        console.error(error);
        res.render('pages/message', { message: 'Ocorreu um erro ao processar sua solicitação.' });
    }
};

exports.getResetPassword = async (req, res) => {
    const { token } = req.params;
    try {
        const tokenData = await passwordService.verifyPasswordResetToken(token);
        res.render('pages/reset_password', { token, error: null });
    } catch (error) {
        res.render('pages/message', { message: error.message });
    }
};

exports.postResetPassword = async (req, res) => {
    const { token, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword) {
        return res.render('pages/reset_password', { token, error: 'As senhas não coincidem.' });
    }

    try {
        await passwordService.resetPassword(token, newPassword);
        res.render('pages/message', { message: 'Sua senha foi redefinida com sucesso! Você já pode fazer login com a nova senha.' });
    } catch (error) {
        res.render('pages/reset_password', { token, error: error.message });
    }
};
