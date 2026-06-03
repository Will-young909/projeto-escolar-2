const DenunciaModel = require('../models/DenunciaModel');

const AdminDenunciaController = {

  async getDenuncias(req, res) {
    try {
      const denuncias = await DenunciaModel.findAll(req.query);
      res.json(denuncias);
    } catch (error) {
      res.status(500).send(error.message);
    }
  },

  async atribuirDenuncia(req, res) {
    try {
      const { id } = req.params;
      const { responsavel_id } = req.body;

      await DenunciaModel.update(id, { responsavel_id, status: 'em_analise' });
      await DenunciaModel.addHistory(id, {
        usuario_id: req.user?.id || req.session?.user_admin?.id || null,
        acao: 'Atribuição',
        detalhes: `Denúncia atribuída ao usuário com ID ${responsavel_id}`
      });

      res.redirect('/admin/dashboard#page-moderation');
    } catch (error) {
      res.status(500).send(error.message);
    }
  },

  async updateStatusDenuncia(req, res) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      await DenunciaModel.update(id, { status });
      await DenunciaModel.addHistory(id, {
        usuario_id: req.user?.id || req.session?.user_admin?.id || null,
        acao: 'Mudança de Status',
        detalhes: `Status da denúncia alterado para ${status}`
      });

      res.redirect('/admin/dashboard#page-moderation');
    } catch (error) {
      res.status(500).send(error.message);
    }
  },

  async resolverDenuncia(req, res) {
    try {
      const { id } = req.params;

      await DenunciaModel.update(id, { status: 'resolvida' });
      await DenunciaModel.addHistory(id, {
        usuario_id: req.user?.id || req.session?.user_admin?.id || null,
        acao: 'Resolução',
        detalhes: 'Denúncia marcada como resolvida'
      });

      res.redirect('/admin/dashboard#page-moderation');
    } catch (error) {
      res.status(500).send(error.message);
    }
  },

  async getDenunciaHistorico(req, res) {
    try {
      const { id } = req.params;
      const historico = await DenunciaModel.getHistory(id);
      res.json(historico);
    } catch (error) {
      res.status(500).send(error.message);
    }
  }

};

module.exports = AdminDenunciaController;
