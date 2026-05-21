const UsuarioHabilidadesModel = require('../models/UsuarioHabilidadesModel');
const QuestaoModel = require('../models/QuestaoModel');
const HistoricoQuestoesModel = require('../models/HistoricoQuestoesModel');
const RevisaoService = require('./RevisaoService');

const NIVEL_DOMINIO = 80.0;
const CONSISTENCIA_MINIMA = 3;
const LIMITE_REFORCO = 40.0;
const TENTATIVAS_MINIMAS_REFORCO = 5;

const MotorAdaptativoService = {

  async selecionarProximaQuestao(alunoId) {
    // PRIORIDADE ZERO: Revisão Espaçada
    const questaoRevisaoId = await RevisaoService.getQuestaoParaRevisar(alunoId);
    if (questaoRevisaoId) {
      const questao = await QuestaoModel.findById(questaoRevisaoId);
      if (questao) {
        console.log(`[MotorAdaptativo] Entregando questão de REVISÃO: ${questao.id}`)
        // AJUSTE: Retorna no formato padronizado
        return { tipo: 'REVISAO', questao: questao };
      }
    }

    // Prioridade 1: Reforço
    const habilidadesReforco = await UsuarioHabilidadesModel.findHabilidadesParaReforco(alunoId);
    if (habilidadesReforco.length > 0) {
      const questao = await QuestaoModel.findNewQuestionBySkillAndDifficulty(alunoId, habilidadesReforco[0].habilidade_id, ['facil', 'medio']);
      if (questao) {
        // AJUSTE: Retorna no formato padronizado
        return { tipo: 'QUESTAO', questao: questao };
      }
    }

    // Prioridade 2: Em Progresso
    const habilidadesEmProgresso = await UsuarioHabilidadesModel.findByStatus(alunoId, 'em_progresso');
    for (const habilidade of habilidadesEmProgresso) {
      const prereqsOk = await UsuarioHabilidadesModel.checkPrerequisitosDominados(alunoId, habilidade.habilidade_id);
      if (prereqsOk) {
        const dificuldadeIdeal = this.calcularDificuldadeIdeal(habilidade.percentual_dominio);
        const questao = await QuestaoModel.findNewQuestionBySkillAndDifficulty(alunoId, habilidade.habilidade_id, dificuldadeIdeal);
        if (questao) {
          // AJUSTE: Retorna no formato padronizado
          return { tipo: 'QUESTAO', questao: questao };
        }
      }
    }

    // Prioridade 3: Novas Habilidades
    const novasHabilidades = await UsuarioHabilidadesModel.findHabilidadesNaoIniciadas(alunoId);
    for (const habilidade of novasHabilidades) {
      const prereqsOk = await UsuarioHabilidadesModel.checkPrerequisitosDominados(alunoId, habilidade.id);
      if (prereqsOk) {
        const questao = await QuestaoModel.findNewQuestionBySkillAndDifficulty(alunoId, habilidade.id, ['facil']);
        if (questao) {
          // AJUSTE: Retorna no formato padronizado
          return { tipo: 'QUESTAO', questao: questao };
        }
      }
    }

    return null; // Nenhuma questão encontrada
  },

  async atualizarProficiencia(alunoId, habilidadeId, acertou) {
    const proficiencia = await UsuarioHabilidadesModel.findOrCreate(alunoId, habilidadeId);
    const historico = await HistoricoQuestoesModel.findByAlunoAndHabilidade(alunoId, habilidadeId);
    
    const total = historico.length;
    const acertos = historico.filter(h => h.acertou).length;
    const novoPercentual = total > 0 ? (acertos / total) * 100 : 0;

    let novoStatus = proficiencia.status_dominio;
    let consistencia = acertou ? (proficiencia.respostas_consistentes_acerto || 0) + 1 : 0;
    let precisaDeRevisao = false;

    const statusAnterior = proficiencia.status_dominio;

    if (novoPercentual >= NIVEL_DOMINIO && consistencia >= CONSISTENCIA_MINIMA) {
      novoStatus = 'dominado';
    } else if (novoPercentual < LIMITE_REFORCO && total >= TENTATIVAS_MINIMAS_REFORCO) {
      novoStatus = 'reforco';
      consistencia = 0; 
      if (statusAnterior !== 'reforco') {
        precisaDeRevisao = true;
      }
    } else {
      if (statusAnterior === 'reforco' && novoPercentual >= LIMITE_REFORCO) {
        novoStatus = 'em_progresso';
      } else if (statusAnterior !== 'reforco') {
        novoStatus = 'em_progresso';
      }
    }
    
    await UsuarioHabilidadesModel.updateDominio(proficiencia.id, {
      percentual: novoPercentual,
      status: novoStatus,
      acertoConsistente: consistencia
    });

    return { novoPercentual, novoStatus, precisaDeRevisao };
  },
  
  calcularDificuldadeIdeal(percentualDominio) {
    if (percentualDominio > 85) return ['dificil', 'medio'];
    if (percentualDominio > 60) return ['medio', 'dificil', 'facil'];
    return ['facil', 'medio'];
  }
};

module.exports = MotorAdaptativoService;
