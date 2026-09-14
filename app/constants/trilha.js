const TRILHA_TIPOS = Object.freeze({
  DIAGNOSTICO: 'diagnostico',
  APRENDIZAGEM: 'aprendizagem',
  REFORCO: 'reforco'
});

const TRILHA_STATUS = Object.freeze({
  ATIVA: 'ativa',
  CONCLUIDA: 'concluida',
  CANCELADA: 'cancelada'
});

const ITEM_BLOCO = Object.freeze({
  REVISAO: 'revisao',
  PRATICA: 'pratica',
  CHECKPOINT: 'checkpoint',
  APRENDIZAGEM: 'aprendizagem',
  REFORCO: 'reforco',
  DOMINIO: 'dominio',
  MICROCHECK: 'microcheck'
});

const ITEM_STATUS = Object.freeze({
  PENDENTE: 'pendente',
  CONCLUIDO: 'concluido',
  ERRO: 'erro'
});

const SESSAO_TIPO = Object.freeze({
  AVALIACAO: 'avaliacao',
  PRATICA: 'pratica',
  REFORCO: 'reforco',
  DESAFIO: 'desafio'
});

const SESSAO_STATUS = Object.freeze({
  ATIVA: 'ativa',
  CONCLUIDA: 'concluida'
});

const DECISAO_ACAO = Object.freeze({
  REVISAO: 'revisao',
  PREREQUISITO: 'prerequisito',
  REFORCO: 'reforco',
  AVANCAR: 'avancar',
  PRATICAR: 'praticar',
  APRENDER: 'aprender'
});

const DIFICULDADE = Object.freeze({
  FACIL: 'facil',
  MEDIO: 'medio',
  DIFICIL: 'dificil'
});

const DOMINIO_STATUS = Object.freeze({
  NAO_INICIADO: 'nao_iniciado',
  EM_PROGRESSO: 'em_progresso',
  EM_DESENVOLVIMENTO: 'em_desenvolvimento',
  PRECISA_REFORCO: 'precisa_reforco',
  PROFICIENTE: 'proficiente',
  DOMINADA: 'dominada',
  DOMINADO: 'dominado'
});

const GAMIFICATION = Object.freeze({
  XP_POR_ACERTO: 10,
  NIVEL_BASE_XP: 100
});

const REVISAO_INTERVALOS = Object.freeze([1, 3, 7, 14, 30]);

const PEDAGOGICAL = Object.freeze({
  PROFICIENCIA_MINIMA_PARA_INTERVENCAO: 0.40,
  ERROS_CONSECUTIVOS_PARA_INTERVENCAO: 3,
  FATOR_APRENDIZAGEM: 0.20
});

module.exports = {
  TRILHA_TIPOS,
  TRILHA_STATUS,
  ITEM_BLOCO,
  ITEM_STATUS,
  SESSAO_TIPO,
  SESSAO_STATUS,
  DECISAO_ACAO,
  DIFICULDADE,
  DOMINIO_STATUS,
  GAMIFICATION,
  REVISAO_INTERVALOS,
  PEDAGOGICAL
};
