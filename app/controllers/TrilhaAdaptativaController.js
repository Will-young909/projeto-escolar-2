const TrilhaService = require('../services/trilhaService');
const TutorIAService = require('../services/TutorIAService');
const PasseEstudoService = require('../services/PasseEstudoService');
const C = require('../constants/trilha');

/**
 * Consumo de passe para o tutor de IA da trilha.
 *
 * Premium por decisão de produto: o botão de IA fica SEMPRE visível na trilha —
 * não depende do limite diário de atividades, ao contrário dos endpoints de
 * tutor de `atividades`. Quem clica e não tem passe recebe 402 e a tela oferece
 * a compra.
 *
 * Passes de tempo (`diario`/`semanal`) são ilimitados no período: liberam sem
 * consumir. Passe `quantidade` consome 1 unidade.
 *
 * @returns {Promise<{liberado: boolean, tipo: string|null, restantes?: number, motivo?: string}>}
 */
async function consumirPasseParaTutor(alunoId) {
  const passe = await PasseEstudoService.verificarPasseAtivo(alunoId);
  if (!passe.passeAtivo) {
    return { liberado: false, motivo: 'sem_passe', tiposDisponiveis: ['quantidade_10', 'diario', 'semanal'] };
  }
  if (passe.tipo !== 'quantidade') {
    return { liberado: true, tipo: passe.tipo, restantes: null };
  }
  if (!(passe.atividadesRestantes > 0)) {
    return { liberado: false, motivo: 'passe_esgotado', tiposDisponiveis: ['quantidade_10', 'diario', 'semanal'] };
  }
  await PasseEstudoService.consumirAtividadePasse(alunoId);
  return { liberado: true, tipo: 'quantidade', restantes: passe.atividadesRestantes - 1 };
}

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

  /**
   * Dica de IA para o item atual da trilha.
   *
   * Só faz sentido enquanto a questão está em aberto (tentativas 1-2): a dica
   * não revela a resposta justamente para não anular a repetição. Quando o item
   * já foi resolvido, o aluno deve pedir a explicação.
   *
   * Cacheia por item: o segundo pedido é grátis, sem chamar IA nem consumir
   * passe — senão cada clique queimaria uma unidade por texto idêntico.
   */
  async pedirDica(req, res) {
    try {
      const alunoId = req.session.user_aluno?.id;
      if (!alunoId) return res.status(401).json({ message: 'Aluno não autenticado.' });

      const itemId = Number(req.body.itemId);
      if (!Number.isInteger(itemId)) {
        return res.status(400).json({ message: 'itemId é obrigatório.' });
      }

      const item = await TrilhaService.buscarItemComQuestao(alunoId, itemId);
      if (!item) return res.status(404).json({ message: 'Item da trilha não encontrado.' });

      if (item.status !== C.ITEM_STATUS.PENDENTE) {
        return res.status(409).json({ message: 'Esta questão já foi respondida. Peça a explicação do erro.' });
      }

      // Já pediu antes neste item? Devolve o cache sem cobrar de novo.
      const cache = await TrilhaService.obterTutorCache(alunoId, itemId);
      if (cache?.dica) {
        return res.json({ dica: cache.dica, cache: true, restantes: cache.restantes ?? null });
      }

      const acesso = await consumirPasseParaTutor(alunoId);
      if (!acesso.liberado) {
        return res.status(402).json({
          message: acesso.motivo === 'passe_esgotado'
            ? 'Seu passe de estudos acabou. Adquira outro para continuar usando a IA.'
            : 'Você precisa de um Passe de Estudos para usar o tutor de IA.',
          tiposDisponiveis: acesso.tiposDisponiveis
        });
      }

      const resultado = await TutorIAService.pedirDica({
        questao: item,
        tentativaAtual: Number(item.tentativa) || 1
      });

      if (!resultado.ok) {
        if (resultado.bloqueado) {
          return res.status(409).json({ message: 'Não foi possível gerar a dica: o gabarito desta questão é inconsistente.' });
        }
        return res.status(502).json({ message: 'Não foi possível gerar a dica agora. Tente novamente.' });
      }

      await TrilhaService.gravarTutorCache(alunoId, itemId, { dica: resultado.texto, restantes: acesso.restantes });
      return res.json({ dica: resultado.texto, cache: false, restantes: acesso.restantes });

    } catch (error) {
      console.error('Erro ao gerar dica da trilha:', error);
      return res.status(500).json({ message: 'Erro interno ao gerar a dica.' });
    }
  },

  /**
   * Explicação completa do erro, para a resolução definitiva.
   *
   * Diferente da dica, aqui a resposta aparece: o aluno já esgotou as
   * tentativas, e explicar o erro é o produto. Só é oferecida para item já
   * resolvido — pedir explicação no meio da repetição entregaria a resposta e
   * anularia as tentativas restantes.
   */
  async explicarErro(req, res) {
    try {
      const alunoId = req.session.user_aluno?.id;
      if (!alunoId) return res.status(401).json({ message: 'Aluno não autenticado.' });

      const itemId = Number(req.body.itemId);
      if (!Number.isInteger(itemId)) {
        return res.status(400).json({ message: 'itemId é obrigatório.' });
      }

      const item = await TrilhaService.buscarItemComQuestao(alunoId, itemId);
      if (!item) return res.status(404).json({ message: 'Item da trilha não encontrado.' });

      if (item.status !== C.ITEM_STATUS.CONCLUIDO) {
        return res.status(409).json({ message: 'A explicação fica disponível depois que você responder esta questão.' });
      }

      const cache = await TrilhaService.obterTutorCache(alunoId, itemId);
      if (cache?.explicacao) {
        return res.json({ explicacao: cache.explicacao, cache: true, restantes: cache.restantes ?? null });
      }

      const acesso = await consumirPasseParaTutor(alunoId);
      if (!acesso.liberado) {
        return res.status(402).json({
          message: acesso.motivo === 'passe_esgotado'
            ? 'Seu passe de estudos acabou. Adquira outro para continuar usando a IA.'
            : 'Você precisa de um Passe de Estudos para usar o tutor de IA.',
          tiposDisponiveis: acesso.tiposDisponiveis
        });
      }

      const resultado = await TutorIAService.explicarErro({
        questao: item,
        respostaDada: item.resposta_aluno
      });

      if (!resultado.ok) {
        if (resultado.bloqueado) {
          return res.status(409).json({ message: 'Não foi possível gerar a explicação: o gabarito desta questão é inconsistente.' });
        }
        return res.status(502).json({ message: 'Não foi possível gerar a explicação agora. Tente novamente.' });
      }

      await TrilhaService.gravarTutorCache(alunoId, itemId, { explicacao: resultado.texto, restantes: acesso.restantes });
      return res.json({ explicacao: resultado.texto, cache: false, restantes: acesso.restantes });

    } catch (error) {
      console.error('Erro ao gerar explicação da trilha:', error);
      return res.status(500).json({ message: 'Erro interno ao gerar a explicação.' });
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
};

module.exports = TrilhaAdaptativaController;
