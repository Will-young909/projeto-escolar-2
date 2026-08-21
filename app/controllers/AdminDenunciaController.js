const DenunciaService = require('../services/DenunciaService');

// Função auxiliar para padronizar o tratamento de requisições e respostas
async function handleRequest(servicePromise, res, successRedirect = '/admin/dashboard#page-moderation') {
    try {
        await servicePromise;
        if (res.headersSent) return; 
        res.redirect(successRedirect);
    } catch (error) {
        console.error('Erro na operação de denúncia:', error);
        res.status(500).send(error.message || 'Ocorreu um erro interno.');
    }
}

// Obtém todas as denúncias para exibição no painel
exports.getDenuncias = async (req, res) => {
    try {
        const denuncias = await DenunciaService.findAll(req.query);
        res.json(denuncias);
    } catch (error) {
        res.status(500).send(error.message);
    }
};

// Atribui uma denúncia a um administrador específico
exports.atribuirDenuncia = (req, res) => {
    const { id } = req.params;
    const { adminId } = req.body;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.atribuir(id, adminId, adminUserId), res);
};

// Atualiza o status de uma denúncia
exports.updateStatusDenuncia = (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.updateStatus(id, status, adminUserId), res);
};

// Resolve (aprova) uma denúncia, marcando-a como 'Resolvida'
exports.approveDenuncia = (req, res) => {
    const { id } = req.params;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.updateStatus(id, 'Resolvida', adminUserId), res);
};

// Adverte um usuário com base em uma denúncia
exports.warnUser = (req, res) => {
    const { id } = req.params;
    const { userId, message } = req.body;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.warnUser(id, userId, message, adminUserId), res);
};

// Suspende um usuário com base em uma denúncia
exports.suspendUser = (req, res) => {
    const { id } = req.params;
    const { userId, reason, duration } = req.body;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.suspendUser(id, userId, reason, duration, adminUserId), res);
};

// Bane um usuário com base em uma denúncia
exports.banUser = (req, res) => {
    const { id } = req.params;
    const { userId, reasonBan } = req.body; 
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.banUser(id, userId, reasonBan, adminUserId), res);
};

// Adiciona uma nota interna a uma denúncia
exports.addInternalNote = (req, res) => {
    const { id } = req.params;
    const { note } = req.body;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.addInternalNote(id, note, adminUserId), res);
};

// Obtém o histórico de denúncias de um usuário específico
exports.getUserDenunciaHistory = async (req, res) => {
    try {
        const { userId } = req.params;
        const history = await DenunciaService.findUserDenunciaHistory(userId);
        res.json(history);
    } catch (error) {
        res.status(500).send(error.message);
    }
};

// Obtém o histórico de ações de uma denúncia específica
exports.getDenunciaHistorico = async (req, res) => {
    try {
        const { id } = req.params;
        const historico = await DenunciaService.findDenunciaHistory(id);
        res.json(historico);
    } catch (error) {
        res.status(500).send(error.message);
    }
};