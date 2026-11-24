const DenunciaService = require('../services/DenunciaService');

function wantsJson(req) {
    return req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));
}

// Função auxiliar para padronizar o tratamento de requisições e respostas
async function handleRequest(servicePromise, req, res, successRedirect = '/admin/dashboard#page-moderation', successMessage = 'Ação realizada com sucesso.') {
    try {
        const result = await servicePromise;
        if (res.headersSent) return;
        if (wantsJson(req)) {
            return res.json({ success: true, message: successMessage, result });
        }
        res.redirect(successRedirect);
    } catch (error) {
        console.error('Erro na operação de denúncia:', error);
        if (wantsJson(req)) {
            return res.status(400).json({ success: false, message: error.message || 'Ocorreu um erro interno.' });
        }
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
    handleRequest(DenunciaService.atribuir(id, adminId, adminUserId), req, res, undefined, 'Denúncia atribuída.');
};

// Atualiza o status de uma denúncia
exports.updateStatusDenuncia = (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.updateStatus(id, status, adminUserId), req, res, undefined, 'Status atualizado.');
};

// Resolve (aprova) uma denúncia, marcando-a como 'Resolvida'
exports.approveDenuncia = (req, res) => {
    const { id } = req.params;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.updateStatus(id, 'Resolvida', adminUserId), req, res, undefined, 'Denúncia resolvida.');
};

// Adverte um usuário com base em uma denúncia
exports.warnUser = (req, res) => {
    const { id } = req.params;
    const { userId, message } = req.body;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.warnUser(id, userId, message, adminUserId), req, res, undefined, 'Advertência enviada.');
};

// Suspende um usuário com base em uma denúncia
exports.suspendUser = (req, res) => {
    const { id } = req.params;
    const { userId, reason, duration } = req.body;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.suspendUser(id, userId, reason, duration, adminUserId), req, res, undefined, 'Usuário suspenso.');
};

// Bane um usuário com base em uma denúncia
exports.banUser = (req, res) => {
    const { id } = req.params;
    const { userId, reasonBan } = req.body; 
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.banUser(id, userId, reasonBan, adminUserId), req, res, undefined, 'Usuário banido.');
};

// Adiciona uma nota interna a uma denúncia
exports.addInternalNote = (req, res) => {
    const { id } = req.params;
    const { note } = req.body;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.addInternalNote(id, note, adminUserId), req, res, undefined, 'Nota salva.');
};

// Exclui o comentário denunciado associado à denúncia
exports.deleteReportedComment = (req, res) => {
    const { id } = req.params;
    const adminUserId = req.session?.user_admin?.id || null;
    handleRequest(DenunciaService.deleteReportedComment(id, adminUserId), req, res, undefined, 'Comentário excluído.');
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