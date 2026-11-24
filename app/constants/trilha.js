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
  DOMINIO: 'dominio'
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
  CONCLUIDA: 'concluida',
  PAUSADA: 'pausada',
  ABANDONADA: 'abandonada'
});

// Horas sin movimento tras las cuales una sesión activa se considera abandonada.
const SESSAO_ABANDONO_HORAS = 4;

const DECISAO_ACAO = Object.freeze({
  REVISAO: 'revisao',
  PREREQUISITO: 'prerequisito',
  REFORCO: 'reforco',
  AVANCAR: 'avancar',
  PRATICAR: 'praticar'
});

const DIFICULDADE = Object.freeze({
  FACIL: 'facil',
  MEDIO: 'medio',
  DIFICIL: 'dificil'
});

const DOMINIO_STATUS = Object.freeze({
  // Estados canónicos do motor
  NAO_INICIADO: 'nao_iniciado',
  EM_DESENVOLVIMENTO: 'em_desenvolvimento',
  PRECISA_REFORCO: 'precisa_reforco',
  PROFICIENTE: 'proficiente',
  DOMINADA: 'dominada',
  // Aliases legados leídos en perfiles escritos por versiones antigas
  // (se normalizan a los canónicos en AdaptiveTrailEngine.normalizeStatus).
  EM_PROGRESSO: 'em_progresso',
  DOMINADO: 'dominado',
  REFORCO: 'reforco'
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

// Revisión espaciada balanceada: la revisión NO debe tener prioridad absoluta
// sobre el objetivo curricular actual de la trilha.
const REVISAO_LIMITE_DIARIO = 5;
const REVISAO_SESSAO_CAP = 2;
const REVISAO_ATRASO_PRIORITARIO_DIAS = 3;

// Cota diária de questões da trilha.
// O total é derivado: revisões devidas hoje + 1 nova questão por habilidade ativa
// não dominada, com piso mínimo para o aluno nunca ficar sem nada para fazer.
const QUESTOES_DIARIAS_MINIMO = 3;
const QUESTOES_DIARIAS_POR_HABILIDADE = 1;

// Limite total de questÃµes por trilha (parada definitiva).
// Quando a trilha atinge esse total de itens criados, ela Ã© encerrada
// definitivamente, impedindo que a trilha seja infinita.
const QUESTOES_MAX_POR_TRILHA = 50;

// Metadatos enriquecidos de las preguntas (evaluación: selección fina)
const FORMATO_QUESTAO = Object.freeze({
  TEXTO: 'texto',
  VISUAL: 'visual',
  CONTEXTUALIZADO: 'contextualizado',
  PROCEDURAL: 'procedural'
});

const ORIGEN_QUESTAO = Object.freeze({
  CURADOR: 'curador',
  IA_PENDENTE: 'ia_pendente',
  IA_APROVADO: 'ia_aprovado'
});

const VALIDACION_QUESTAO = Object.freeze({
  APROVADO: 'aprovado',
  PENDENTE: 'pendente',
  REJEITADO: 'rejeitado'
});

// Geração determinística de questões por IA (pipeline estruturado).
//
// A IA propõe o PROBLEMA; o backend resolve, gera os distratores e define o
// gabarito. `IA_VALIDACAO` cobre a geração legada (IA sugere `correct`).
const IA_ESTRUTURADO = Object.freeze({
  // Nº de regenerações. Ampliar NÃO é a solução: a cada tentativa a estratégia
  // muda (tipo mais simples / tipo explicitamente suportado).
  MAX_TENTATIVAS: 3,
  // Endpoint que devolve apenas o problema estruturado.
  ENDPOINT: '/ia/generate-problem',
  // Embaralhamento das alternativas: varia por tentativa para não repetir
  // sempre a mesma posição de gabarito.
  SEMENTE_BASE: 1000
});

// Validação determinística das questões geradas por IA antes de entrarem na trilha.
// A IA sugere `correct`; o backend é a autoridade sobre a correção.
const IA_VALIDACAO = Object.freeze({
  // Nº máximo de regenerações antes de desistir (evita laço infinito).
  MAX_TENTATIVAS: 3,
  // RegiMath trabalha com alternativa_a..alternativa_d.
  TOTAL_ALTERNATIVAS: 4,
  // Comprimento mínimo do enunciado para descartar saídas truncadas da IA.
  ENUNCIADO_MIN_CARACTERES: 15,
  // Divisão exata: frações como 1/3 são válidas se a alternativa tiver o mesmo valor.
  CASAS_DECIMAIS: 6
});

// Tentativas do aluno no MESMO item antes de a resposta ser definitiva.
//
// Errar não encerra a questão: o item continua `pendente` e o aluno repete.
// Só a resolução definitiva (acerto ou esgotamento) alimenta proficiência,
// streak, revisão e histórico — punir cada tentativa penalizaria um erro que o
// aluno corrigiria sozinho na seguinte.
//
// O valor conta a 1ª resposta: 3 = tentativa inicial + 2 repetições.
const ITEM_MAX_TENTATIVAS = 3;

module.exports = {
  ITEM_MAX_TENTATIVAS,
  TRILHA_TIPOS,
  TRILHA_STATUS,
  ITEM_BLOCO,
  ITEM_STATUS,
  SESSAO_TIPO,
  SESSAO_STATUS,
  SESSAO_ABANDONO_HORAS,
  DECISAO_ACAO,
  DIFICULDADE,
  DOMINIO_STATUS,
  GAMIFICATION,
  REVISAO_INTERVALOS,
  REVISAO_LIMITE_DIARIO,
  REVISAO_SESSAO_CAP,
  REVISAO_ATRASO_PRIORITARIO_DIAS,
  QUESTOES_DIARIAS_MINIMO,
  QUESTOES_DIARIAS_POR_HABILIDADE,
  QUESTOES_MAX_POR_TRILHA,
  FORMATO_QUESTAO,
  ORIGEN_QUESTAO,
  VALIDACION_QUESTAO,
  IA_VALIDACAO,
  IA_ESTRUTURADO,
  PEDAGOGICAL
};
