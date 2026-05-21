const TrilhaService = require('../services/trilhaService');

const TrilhaAdaptativaController = {

  async iniciarTrilha(req, res) {
    try {
      const { alunoId } = req.params;
      if (!alunoId) {
        return res.status(400).json({ message: 'ID do aluno é obrigatório.' });
      }

      const proximaTarefa = await TrilhaService.iniciarTrilhaParaAluno(alunoId);

      if (proximaTarefa.tarefaTipo === 'CONCLUIDO') {
        return res.status(200).json({ message: 'Parabéns, você concluiu a trilha!', ...proximaTarefa });
      }

      res.status(200).json(proximaTarefa);

    } catch (error) {
      console.error('Erro no controller ao iniciar trilha:', error);
      res.status(500).json({ message: 'Erro interno ao iniciar a trilha.' });
    }
  },

  async processarResposta(req, res) {
    try {
      const { alunoId, submittedId, respostaDada } = req.body;

      if (!alunoId || !submittedId || respostaDada === undefined) {
        return res.status(400).json({ message: 'Dados incompletos para processar a resposta.' });
      }

      // Este serviço agora retorna um objeto combinado
      const resultadoCompleto = await TrilhaService.processarRespostaEProximaQuestao(alunoId, submittedId, respostaDada, 0 /* tempo resposta mock */);

      res.status(200).json(resultadoCompleto);
    } catch (error) {
      console.error('Erro no controller ao processar resposta:', error);
      res.status(500).json({ message: 'Erro interno ao processar a resposta.' });
    }
  },

  async marcarConteudoConsumido(req, res) {
    try {
        const { alunoId, conteudoId } = req.body;

        if (!alunoId || !conteudoId) {
            return res.status(400).json({ message: 'IDs do aluno e do conteúdo são obrigatórios.' });
        }

        // Chama o serviço para registrar o consumo
        await TrilhaService.marcarConteudoComoConsumido(alunoId, conteudoId);

        res.status(200).json({ message: 'Conteúdo marcado como consumido.' });

    } catch (error) {
        console.error('Erro no controller ao marcar conteúdo como consumido:', error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  }
};

module.exports = TrilhaAdaptativaController;
