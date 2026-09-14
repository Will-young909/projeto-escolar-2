const TrilhaService = require('../services/trilhaService');

const TrilhaAdaptativaController = {
  async iniciarTrilha(req, res) {
    try {
      const alunoId = req.session.user_aluno?.id;
      if (!alunoId) return res.status(401).json({ message: 'Aluno não autenticado.' });
      const proximaTarefa = await TrilhaService.iniciarTrilhaParaAluno(alunoId);
      return res.status(200).json(proximaTarefa);
    } catch (error) {
      console.error('Erro ao iniciar trilha:', error);
      return res.status(500).json({ message: 'Erro interno ao iniciar a trilha.' });
    }
  },

  async processarResposta(req, res) {
    try {
      const alunoId = req.session.user_aluno?.id;
      const { submittedId, respostaDada, tempoResposta } = req.body;
      if (!alunoId) return res.status(401).json({ message: 'Aluno não autenticado.' });
      if (!Number.isInteger(Number(submittedId)) || respostaDada === undefined) {
        return res.status(400).json({ message: 'Dados incompletos para processar a resposta.' });
      }
      const tempo = Number(tempoResposta);
      const resultado = await TrilhaService.processarRespostaEProximaQuestao(alunoId, Number(submittedId), respostaDada, Number.isFinite(tempo) && tempo >= 0 ? tempo : null);
      return res.status(200).json(resultado);
    } catch (error) {
      console.error('Erro ao processar resposta da trilha:', error);
      const status = error.message.includes('já foi registrada') ? 409 : 500;
      return res.status(status).json({ message: error.message || 'Erro interno ao processar a resposta.' });
    }
  },

  async obterProgresso(req, res) {
    try {
      const alunoId = req.session.user_aluno?.id;
      if (!alunoId) return res.status(401).json({ message: 'Aluno não autenticado.' });
      return res.json(await TrilhaService.obterProgresso(alunoId));
    } catch (error) {
      console.error('Erro ao obter progresso:', error);
      return res.status(500).json({ message: 'Erro ao obter progresso.' });
    }
  },

  async marcarConteudoConsumido(req, res) {
    try {
        const alunoId = req.session.user_aluno?.id;
        const { itemId, tempoConsumido } = req.body;
        if (!alunoId) return res.status(401).json({ message: 'Aluno não autenticado.' });
        if (!itemId) return res.status(400).json({ message: 'ID do item não fornecido.' });

        const proximaTarefa = await TrilhaService.marcarConteudoConsumido(alunoId, Number(itemId), Number.isFinite(Number(tempoConsumido)) ? Number(tempoConsumido) : null);
        return res.status(200).json(proximaTarefa);
    } catch (error) {
        console.error('Erro ao marcar conteúdo como consumido:', error);
        return res.status(500).json({ message: error.message || 'Erro interno ao processar a solicitação.' });
    }
  }
};

module.exports = TrilhaAdaptativaController;
