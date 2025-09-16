const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

router.get('/', (req, res) => {
    res.render('pages/home');
});

router.get('/cadastro', (req, res) => {
    res.render('pages/cadastro', { erros: {}, dados: {} });
});

router.post('/cadastro', [
    body('email')
        .isEmail().withMessage('Por favor, insira um email válido.')
        .normalizeEmail(),
    body('nome').notEmpty().withMessage('O nome é obrigatório.'),
    body('senha')
        .isLength({ min: 6 }).withMessage('A senha deve ter pelo menos 6 caracteres.'),
    body('confirmar')
        .custom((value, { req }) => value === req.body.senha).withMessage('As senhas não coincidem.'),
    body('tipo').notEmpty().withMessage('Selecione um tipo (Aluno ou Professor).'),
], (req, res) => {
    const erros = validationResult(req);
    
    if (!erros.isEmpty()) {
        return res.render('pages/cadastro', { erros: erros.mapped(), dados: req.body });
    }

    // Aqui salva na sessão (simulação, normalmente iria pro banco também)
    req.session.user = {
        nome: req.body.nome,
        email: req.body.email,
        tipo: req.body.tipo
    };

    // Redireciona de acordo com o tipo
    if (req.body.tipo === "aluno") {
        return res.redirect('/logado_aluno');
    } else {
        return res.redirect('/logado_prof');
    }
});

router.get('/login', (req, res) => {
  res.render('pages/login', { erros: {}, dados: {} });
});

router.post('/login', [
    body('email')
        .isEmail().withMessage('Por favor, insira um email válido.')
        .normalizeEmail(),
    body('senha')
        .isLength({ min: 6 }).withMessage('A senha deve ter pelo menos 6 caracteres.'),
    body('tipo').notEmpty().withMessage('Selecione um tipo (Aluno ou Professor).'),
], (req, res) => {
    const erros = validationResult(req);
    
    if (!erros.isEmpty()) {
        return res.render('pages/login', { erros: erros.mapped(), dados: req.body });
    }

    // Aqui seria a autenticação no banco (simulação por enquanto)
    // Se email e senha forem válidos, salva na sessão
    req.session.user = {
        email: req.body.email,
        tipo: req.body.tipo
    };

    // Redireciona de acordo com o tipo
    if (req.body.tipo === "aluno") {
        return res.redirect('/perfil_aluno');
    } else {
        return res.redirect('/perfil_prof');
    }
});

router.get('/forgot', (req, res) => {
    res.render('pages/forgot_password', { erros: {}, dados: {} });
});

router.post('/forgot', [
    body('email')
        .isEmail().withMessage('Por favor, insira um email válido.')
        .normalizeEmail(),
    body('senha')
        .isLength({ min: 6 }).withMessage('A senha deve ter pelo menos 6 caracteres.'),
    body('confirmar')
        .custom((value, { req }) => value === req.body.senha).withMessage('As senhas não coincidem.'),    
    body('tipo').notEmpty().withMessage('Selecione um tipo (Aluno ou Professor).'),
], (req, res) => {
    const erros = validationResult(req);
    
    if (!erros.isEmpty()) {
        return res.render('pages/forgot_password', { erros: erros.mapped(), dados: req.body });
    }

    // Aqui seria a autenticação no banco (simulação por enquanto)
    // Se email e senha forem válidos, salva na sessão
    req.session.user = {
        email: req.body.email,
        tipo: req.body.tipo
    };

    // Redireciona de acordo com o tipo
    if (req.body.tipo === "aluno") {
        return res.redirect('/perfil_aluno');
    } else {
        return res.redirect('/perfil_prof');
    }
});

router.get('/logado_prof', (req, res) => {
    res.render('pages/logado_prof');
});

router.get('/logado_aluno', (req, res) => {
    res.render('pages/logado_aluno');
});

router.get('/perfil_aluno', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    res.render('pages/perfil_aluno', { user: req.session.user });
});

router.get('/perfil_prof', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    res.render('pages/perfil_prof', { user: req.session.user });
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

module.exports = router;