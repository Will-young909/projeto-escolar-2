const pool = require('../../config/pool');
const crypto = require('crypto');
const Engine = require('./AdaptiveTrailEngine');
const C = require('../constants/trilha');
const CurriculoAlunoModel = require('../models/CurriculoAlunoModel');
const { postJson } = require('../utils/internalFetch');
const Validacao = require('./QuestionValidationService');
const QuestionFactory = require('./QuestionFactoryService');
const Solvers = require('./ProblemSolverService');

const LEGACY_STATUS = {
  nao_iniciado: C.DOMINIO_STATUS.NAO_INICIADO, em_progresso: C.DOMINIO_STATUS.EM_PROGRESSO,
  reforco: C.DOMINIO_STATUS.PRECISA_REFORCO, dominado: C.DOMINIO_STATUS.DOMINADO
};

// Normaliza a estados canónicos (dominado� dominada, reforco� precisa_reforco, ...)
const normalizarStatus = (status) => Engine.normalizeStatus(LEGACY_STATUS[status] || status);

const MotorAdaptativoService = {
  async obterPerfilHabilidades(alunoId) {
    const [rows] = await pool.query(`SELECT uh.*, h.codigo, h.descricao AS habilidade_nome
      FROM usuario_habilidades uh JOIN habilidades h ON h.id = uh.habilidade_id
      WHERE uh.aluno_id = ? ORDER BY uh.ultima_vez_praticado ASC`, [alunoId]);
    return rows.map(row => ({ ...row, status_dominio: normalizarStatus(row.status_dominio) }));
  },

  async obterHistorico(alunoId, habilidadeId) {
    const [rows] = await pool.query(`SELECT hq.acertou, hq.tempo_resposta_seg, hq.data_resposta,
      q.dificuldade, q.tempo_esperado_seg, q.formato, q.status_validacao
      FROM historico_questoes hq JOIN questoes q ON q.id = hq.questao_id
      WHERE hq.aluno_id = ? AND hq.habilidade_id = ? ORDER BY hq.data_resposta ASC`, [alunoId, habilidadeId]);
    return rows;
  },

  async obterPreRequisitos(alunoId, habilidadeId) {
    const [rows] = await pool.query(`SELECT h.id AS habilidade_id, h.descricao AS habilidade_nome,
      COALESCE(uh.status_dominio, ?) AS status_dominio
      FROM habilidade_prerequisitos hp JOIN habilidades h ON h.id = hp.prerequisito_id
      LEFT JOIN usuario_habilidades uh ON uh.habilidade_id = h.id AND uh.aluno_id = ?
      WHERE hp.habilidade_id = ?`, [C.DOMINIO_STATUS.NAO_INICIADO, alunoId, habilidadeId]);
    return rows.map(row => ({ ...row, status_dominio: normalizarStatus(row.status_dominio) }));
  },

  /**
   * Actualiza la proficiência separando DOMINIO GLOBAL (todo el histórico) de
   * DESEMPE�O DA SESI�N ACTUAL (evidencia desde `sessaoInicio`). El cierre de
   * la actividad usa solo la evidencia de la sesión, y el contenido generado
   * por IA aún no validado no puede servir como evidencia fuerte de dominio.
   */
  async atualizarProficiencia(alunoId, habilidadeId, { sessaoId = null, sessaoInicio = null } = {}) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [profileRows] = await connection.query('SELECT * FROM usuario_habilidades WHERE aluno_id = ? AND habilidade_id = ? FOR UPDATE', [alunoId, habilidadeId]);
      let profile = profileRows[0];
      if (!profile) {
        const [created] = await connection.query('INSERT INTO usuario_habilidades (aluno_id, habilidade_id) VALUES (?, ?)', [alunoId, habilidadeId]);
        const [createdRows] = await connection.query('SELECT * FROM usuario_habilidades WHERE id = ?', [created.insertId]);
        profile = createdRows[0];
      }
      const [history] = await connection.query(`SELECT hq.acertou, hq.tempo_resposta_seg, hq.data_resposta,
        q.dificuldade, q.tempo_esperado_seg, q.status_validacao
        FROM historico_questoes hq JOIN questoes q ON q.id = hq.questao_id
        WHERE hq.aluno_id = ? AND hq.habilidade_id = ? ORDER BY hq.data_resposta ASC`, [alunoId, habilidadeId]);

      // 1) DOMINIO GLOBAL con el modelo probabilístico (recência, dificultad, tempo, incertidumbre).
      const mastery = Engine.estimateProficiency({ history, currentPercent: profile.percentual_dominio });

      // 2) Evidencia de la SESI�N actual: solo respuestas desde el inicio de la sesión.
      let sessionHistory = history;
      if (sessaoInicio) {
        const inicioMs = new Date(sessaoInicio).getTime();
        sessionHistory = history.filter(item => {
          const date = item.data_resposta ? new Date(item.data_resposta).getTime() : null;
          return date === null || date >= inicioMs;
        });
      }
      const sessionMastery = Engine.estimateProficiency({ history: sessionHistory.slice(-Math.max(6, Engine.DEFAULTS.recentWindow * 2)) });

      // 3) Contenido no validado no puede ser evidencia fuerte de dominio.
      const evidenciaNoValidada = history.filter(h => ['pendente', 'ia_pendente', 'rejeitado'].includes(String(h.status_validacao || 'aprovado'))).length;
      const statusFinal = (evidenciaNoValidada >= 2 && mastery.status === 'dominada') ? 'proficiente' : mastery.status;
      mastery.atividadeConcluida = Engine.shouldEndActivity({ sessionHistory });
      mastery.estadoSesion = sessionMastery.status;
      mastery.percentualSesion = sessionMastery.percentual;

      const last = history[history.length - 1];
      const errors = last && !last.acertou ? Number(profile.n_erros_consecutivos || 0) + 1 : 0;
      const correct = last && last.acertou ? Number(profile.n_acertos_consecutivos || 0) + 1 : 0;
      await connection.query(`UPDATE usuario_habilidades SET
        percentual_dominio = ?, status_dominio = ?, respostas_consistentes_acerto = ?,
        n_tentativas = ?, n_acertos_consecutivos = ?, n_erros_consecutivos = ?,
        probabilidade_dominio = ?, incerteza = ?, tendencia = ?, risco_esquecimento = ?,
        ultima_resposta_em = NOW(), ultima_vez_praticado = NOW()
        WHERE id = ?`,
        [mastery.percentual, statusFinal, mastery.consecutiveCorrect, history.length, correct, errors,
         mastery.probDominio, mastery.incerteza, mastery.tendencia, mastery.riscoEsquecimento, profile.id]);
      await connection.commit();
      return {
        ...mastery,
        status: statusFinal,
        habilidadeId,
        sessao: { id: sessaoId, nEvidencia: sessionHistory.length, percentual: sessionMastery.percentual, status: sessionMastery.status }
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  },

  calcularDificuldadeIdeal(percentualDominio) {
    if (percentualDominio >= 85) return [C.DIFICULDADE.DIFICIL, C.DIFICULDADE.MEDIO];
    if (percentualDominio >= 70) return [C.DIFICULDADE.MEDIO, C.DIFICULDADE.DIFICIL, C.DIFICULDADE.FACIL];
    return [C.DIFICULDADE.FACIL, C.DIFICULDADE.MEDIO];
  },

  async buscarSessaoAtiva(alunoId, habilidadeId) {
    const [rows] = await pool.query(`SELECT sa.* FROM sessoes_adaptativas sa
      WHERE sa.aluno_id = ? AND sa.habilidade_foco_id = ? AND sa.status IN (?, ?)
      ORDER BY sa.criado_em DESC LIMIT 1`, [alunoId, habilidadeId, C.SESSAO_STATUS.ATIVA, C.SESSAO_STATUS.PAUSADA]);
    const sessao = rows[0];
    if (!sessao) return null;
    // Abandono: sesión activa sin movimiento durante más de N horas.
    const referencia = sessao.ultima_atividade_em || sessao.inicio_em || sessao.criado_em;
    const horasInactivas = referencia ? (Date.now() - new Date(referencia).getTime()) / 3600000 : 0;
    if (sessao.status === C.SESSAO_STATUS.ATIVA && horasInactivas >= C.SESSAO_ABANDONO_HORAS) {
      await this.abandonarSessao(sessao.id);
      return null;
    }
    return sessao;
  },

  async registrarActividadSesion(sessaoId) {
    if (!sessaoId) return;
    await pool.query('UPDATE sessoes_adaptativas SET ultima_atividade_em = NOW() WHERE id = ?', [sessaoId]);
  },

  async pausarSessao(sessaoId) {
    if (!sessaoId) return;
    await pool.query(`UPDATE sessoes_adaptativas SET status = ?, pausada_em = NOW() WHERE id = ?`, [C.SESSAO_STATUS.PAUSADA, sessaoId]);
  },

  async retomarSessao(sessaoId) {
    if (!sessaoId) return;
    await pool.query(`UPDATE sessoes_adaptativas SET status = ?, retomada_em = NOW(), pausada_em = NULL WHERE id = ?`, [C.SESSAO_STATUS.ATIVA, sessaoId]);
  },

  async abandonarSessao(sessaoId) {
    if (!sessaoId) return;
    await pool.query(`UPDATE sessoes_adaptativas SET status = ?, status_termino = ?, fim_em = COALESCE(fim_em, NOW())
      WHERE id = ?`, [C.SESSAO_STATUS.ABANDONADA, 'abandonada', sessaoId]);
  },

  async criarSessaoAtividade(alunoId, habilidadeId, tipoSessao, objetivo = null, contexto = null) {
    try {
      const [result] = await pool.query(`INSERT INTO sessoes_adaptativas (aluno_id, habilidade_foco_id, tipo_sessao, objetivo, contexto_json, status, inicio_em)
        VALUES (?, ?, ?, ?, ?, ?, NOW())`, [alunoId, habilidadeId, tipoSessao, objetivo, contexto ? JSON.stringify(contexto) : null, C.SESSAO_STATUS.ATIVA]);
      return { id: result.insertId, aluno_id: alunoId, habilidade_foco_id: habilidadeId, tipo_sessao: tipoSessao, objetivo, contexto_json: contexto };
    } catch (error) {
      const [result] = await pool.query(`INSERT INTO sessoes_adaptativas (aluno_id, habilidade_foco_id, tipo_sessao, status)
        VALUES (?, ?, ?, ?)`, [alunoId, habilidadeId, tipoSessao, C.SESSAO_STATUS.ATIVA]);
      return { id: result.insertId, aluno_id: alunoId, habilidade_foco_id: habilidadeId, tipo_sessao: tipoSessao, objetivo: null, contexto_json: null };
    }
  },

  async obterSessaoParaDecisao(alunoId, decisao) {
    const tipoSessao = decisao.etapa === C.ITEM_BLOCO.REFORCO
      ? C.SESSAO_TIPO.REFORCO
      : decisao.etapa === C.ITEM_BLOCO.DOMINIO
        ? C.SESSAO_TIPO.DESAFIO
        : C.SESSAO_TIPO.PRATICA;
    return this.buscarSessaoAtiva(alunoId, decisao.skillId)
      || this.criarSessaoAtividade(alunoId, decisao.skillId, tipoSessao, decisao.reason, {
        skillId: decisao.skillId,
        etapa: decisao.etapa,
        dificuldade: decisao.difficulty,
        atividade_dinamica: true
      });
  },

  async selecionarQuestaoInedita(alunoId, habilidadeId, dificuldade, { formatosRecentes = [], limite = 4 } = {}) {
    const prioridades = Engine.difficultyPool(dificuldade);
    const [rows] = await pool.query(`SELECT q.*, h.descricao AS habilidade_nome
      FROM questoes q
      JOIN habilidades h ON h.id = q.habilidade_id
      WHERE q.habilidade_id = ?
        AND q.dificuldade IN (?)
        AND COALESCE(q.status_validacao, 'aprovado') = 'aprovado'
        AND NOT EXISTS (
          SELECT 1 FROM historico_questoes hq
          WHERE hq.aluno_id = ? AND hq.questao_id = q.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM respostas_teste rt
          JOIN tentativas_teste tt ON tt.id = rt.tentativa_id
          WHERE tt.aluno_id = ? AND rt.questao_id = q.id
        )
      ORDER BY FIELD(q.dificuldade, ?, ?, ?) ASC,
        COALESCE(q.dificuldade_calibrada, 0) DESC,
        q.numero_aplicacoes ASC, q.id ASC
      LIMIT ?`, [habilidadeId, prioridades, alunoId, alunoId, ...prioridades, limite]);
    if (!rows.length) return null;
    // Variedad controlada: preferir un formato distinto de los servidos recientemente.
    const conFormatoNuevo = rows.find(row => row.formato && !formatosRecentes.includes(row.formato));
    return conFormatoNuevo || rows[0];
  },

  /** Métrica para calibrar dificultad empíricamente: cada aplicación suma 1. */
  async registrarAplicacaoQuestao(questaoId) {
    if (!questaoId) return;
    await pool.query('UPDATE questoes SET numero_aplicacoes = numero_aplicacoes + 1 WHERE id = ?', [questaoId]);
  },

  /** Chama a IA uma vez e devolve a questão bruta (ainda NÒO validada). */
  async obterQuestaoBrutaDaIA({ habilidade, dificuldade, tentativa }) {
    const prompt = [
      'Gere exatamente uma questão inédita de múltipla escolha para uma trilha adaptativa de matemática.',
      `Habilidade: ${habilidade.descricao || habilidade.habilidade_nome}.`,
      `Dificuldade: ${dificuldade}.`,
      'Não repita enunciados já respondidos pelo aluno. Inclua quatro alternativas, indique apenas uma correta y explique por qué las demás son incorrectas.',
      'La questão debe ser matemáticamente coherente y alineada con la habilidad indicada.'
    ].join(' ');

    const response = await postJson('/ia/generate-exercise', { prompt });
    if (!response.ok) return null;
    const generated = await response.json();
    return { question: generated.questions?.[0] || null, description: generated.description || null };
  },

  /**
   * Pipeline determinístico: a IA cria o PROBLEMA, o backend resolve.
   *
   * A cada tentativa a ESTRAT�0GIA muda em vez de repetir a mesma chamada
   * (aumentar tentativas só encarece a falha):
   *   1ª � tipo preferido para a habilidade
   *   2ª � tipo mais simples da categoria
   *   3ª � tipo de aritmética, o mais previsível
   */
  async obterProblemaEstruturadoDaIA({ habilidade, dificuldade, tentativa, tipo }) {
    const nomeHabilidade = (habilidade && (habilidade.descricao || habilidade.habilidade_nome)) || habilidade || '';
    const candidatos = Solvers.tiposParaHabilidade(nomeHabilidade);
    const tipoEscolhido = tipo || candidatos[Math.min(tentativa - 1, candidatos.length - 1)];

    // Nenhum tipo do registro tem relação com esta habilidade (ex.: Logaritmos,
    // Sistemas Lineares). Inventar um tipo produziria conteúdo com etiqueta
    // errada — foi assim que um aluno de EM recebeu uma soma de 12+15+20
    // rotulada "Equações do 2º Grau". Recusando aqui, o gerador determinístico
    // devolve null e quem responde passa a ser o caminho legado, que acerta
    // o tema (mesmo sem conferência matemática automática).
    if (!tipoEscolhido) {
      return { ok: false, reason: 'sem_tipo_suportado', motivo: `nenhum tipo suportado serve a "${nomeHabilidade}"` };
    }

    const prompt = QuestionFactory.montarPrompt({
      habilidade: nomeHabilidade, dificuldade, tipo: tipoEscolhido, tentativa
    });

    const response = await postJson(C.IA_ESTRUTURADO.ENDPOINT, { prompt, tipo: tipoEscolhido, dificuldade });
    if (!response.ok) return { ok: false, reason: 'ia_http_error', status: response.status };
    const bruto = await response.json();
    return { ok: true, bruto, tipoSolicitado: tipoEscolhido };
  },

  /**
   * Gera uma questão complementar usando o pipeline estruturado.
   *
   * Só grava se a questão passar por TUDO: estrutura -> solucionador ->
   * alternativas geradas pelo backend -> QuestionValidationService. Qualquer
   * falha regenera com outra estratégia; ao esgotar, devolve null e nada é salvo.
   */
  async gerarQuestaoDeterministica({ habilidade, dificuldade }) {
    if (typeof fetch !== 'function') return null;

    let ultimoMotivo = 'desconhecido';
    for (let tentativa = 1; tentativa <= C.IA_ESTRUTURADO.MAX_TENTATIVAS; tentativa++) {
      let proposta;
      try {
        proposta = await this.obterProblemaEstruturadoDaIA({ habilidade, dificuldade, tentativa });
      } catch (error) {
        ultimoMotivo = `falha de comunicação com a IA: ${error.message}`;
        console.error('[TRILHA][IA][DETERMINISTICA] Tentativa:', tentativa, '|', ultimoMotivo);
        continue;
      }
      if (!proposta || !proposta.ok) {
        ultimoMotivo = (proposta && proposta.reason) || 'IA não retornou problema';
        console.error('[TRILHA][IA][DETERMINISTICA] Tentativa:', tentativa, '|', ultimoMotivo);
        continue;
      }

      // A IA pode ter mandado options/correct: são DESCARTADOS aqui.
      const construcao = QuestionFactory.construirQuestao({
        bruto: proposta.bruto,
        habilidade: (habilidade && (habilidade.descricao || habilidade.habilidade_nome)) || '',
        dificuldade,
        semente: C.IA_ESTRUTURADO.SEMENTE_BASE + tentativa,
        // Sem isso a IA poderia responder outro tipo suportado e a questão
        // seria salva com a etiqueta da habilidade errada.
        tipoSolicitado: proposta.tipoSolicitado
      });

      if (!construcao.ok) {
        ultimoMotivo = `${construcao.reason}${construcao.motivo ? ` (${construcao.motivo})` : ''}`;
        console.error(
          '[TRILHA][IA][DETERMINISTICA_REJECTED] Tentativa:', tentativa,
          '| Motivo:', ultimoMotivo,
          '| Tipo pedido:', proposta.tipoSolicitado,
          '| Nada foi salvo.'
        );
        continue;
      }

      // Barreira final: o QuestionValidationService existente continua valendo.
      const relatorio = Validacao.validar(construcao.question);
      if (!relatorio.valid) {
        ultimoMotivo = relatorio.errors.join(' ');
        console.error(
          '[TRILHA][IA][VALIDATION_FAILED] Tentativa:', tentativa,
          '| Motivo:', ultimoMotivo,
          '| Resposta calculada:', relatorio.calculatedAnswer ?? 'n/d'
        );
        continue;
      }

      const alternativas = Validacao.normalizarAlternativas(construcao.question.options);
      const textos = alternativas.map(a => String(a.texto ?? '').trim());
      const enunciado = construcao.question.question;

      const atividadeId = `trilha-ia-${crypto.randomBytes(12).toString('hex')}`;
      await pool.query('INSERT INTO atividades (id, professor_id, titulo, descricao) VALUES (?, NULL, ?, ?)', [
        atividadeId,
        `Práctica complementar: ${habilidade.descricao || habilidade.habilidade_nome}`,
        'Questão complementar gerada por IA com resposta calculada pelo backend.'
      ]);
      const [inserted] = await pool.query(`INSERT INTO questoes
        (atividade_id, habilidade_id, enunciado, alternativa_a, alternativa_b, alternativa_c, alternativa_d, resposta, dificuldade, explicacao,
         origem, status_validacao, versao, formato)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        atividadeId, habilidade.habilidade_id, enunciado,
        textos[0] || null, textos[1] || null, textos[2] || null, textos[3] || null,
        relatorio.correctOption, dificuldade, construcao.question.description || null,
        C.ORIGEN_QUESTAO.IA_APROVADO, C.VALIDACION_QUESTAO.APROVADO, 1, C.FORMATO_QUESTAO.TEXTO
      ]);
      const [created] = await pool.query(`SELECT q.*, h.descricao AS habilidade_nome
        FROM questoes q JOIN habilidades h ON h.id = q.habilidade_id WHERE q.id = ?`, [inserted.insertId]);

      console.log(
        '[TRILHA][IA][DETERMINISTICA_OK] Tentativa:', tentativa,
        '| Tipo:', construcao.solucao.tipo,
        '| Resposta exata:', construcao.solucao.exactAnswer,
        '| Gabarito:', relatorio.correctOption,
        '| Distratores:', JSON.stringify(construcao.question._distractors)
      );
      return created[0] || null;
    }

    console.error(
      '[TRILHA][IA][DETERMINISTICA_FAILED]',
      `Falha após ${C.IA_ESTRUTURADO.MAX_TENTATIVAS} tentativa(s). �altima razão:`, ultimoMotivo,
      '| Nenhuma questão foi salva.'
    );
    return null;
  },

  /**
   * Gera uma questão complementar pela IA e a S� devolve se passar na
   * validação determinística (QuestionValidationService). Regenera até
   * C.IA_VALIDACAO.MAX_TENTATIVAS; ao esgotar, devolve null e a questão NÒO é
   * salva � nunca entra na trilha uma questão não validada.
   */
  async gerarQuestaoComplementarComIA({ habilidade, dificuldade }) {
    if (typeof fetch !== 'function') return null;

    let ultimoRelatorio = null;
    for (let tentativa = 1; tentativa <= C.IA_VALIDACAO.MAX_TENTATIVAS; tentativa++) {
      let bruto;
      try {
        bruto = await this.obterQuestaoBrutaDaIA({ habilidade, dificuldade, tentativa });
      } catch (error) {
        console.error('[TRILHA][IA][GERACAO_FAILED] Tentativa:', tentativa, '| Motivo:', error.message);
        ultimoRelatorio = { valid: false, errors: [`falha de comunicação com a IA: ${error.message}`] };
        continue;
      }

      if (!bruto || !bruto.question) {
        console.error('[TRILHA][IA][VALIDATION_FAILED] Tentativa:', tentativa, '| Motivo: IA não retornou nenhuma questão');
        ultimoRelatorio = { valid: false, errors: ['IA não retornou nenhuma questão'] };
        continue;
      }

      // ---- Validação determinística: a IA sugere, o backend decide ----
      const relatorio = Validacao.validar(bruto.question);
      // Rejeita quando o backend NÃO conseguiu conferir. A única exceção é o
      // resgate por DOMINÂNCIA, já decidido dentro do QuestionValidationService:
      // quando não há fórmula para a conta, o gabarito da IA só é aceito se a
      // alternativa apontada for a única que se separa das demais.
      //
      // Não basta checar `validavel` aqui: `validavel: false` sem dominância
      // significa "o validador não cobre isto" e NÃO traz gabarito nenhum —
      // salvar assim publicaria questão sem resposta.
      const resgatada = relatorio.detalhes && relatorio.detalhes.aceitoPorDominancia;
      if (!relatorio.valid && !resgatada) {
        ultimoRelatorio = relatorio;
        console.error(
          '[TRILHA][IA][VALIDATION_FAILED]',
          'Tentativa:', tentativa,
          '| Motivo:', relatorio.errors.join(' '),
          '| Resposta calculada:', relatorio.calculatedAnswer ?? 'n/d',
          '| Alternativas:', JSON.stringify(relatorio.detalhes.alternativas || []),
          '| correct informado:', relatorio.detalhes.correctInformado ?? 'n/d'
        );
        continue;
      }
      if (resgatada) {
        console.warn(
          '[TRILHA][IA][VALIDATION_SKIPPED]',
          'Tentativa:', tentativa,
          '| Motivo:', relatorio.errors.join(' '),
          '| Aceita por dominância:', resgatada.motivo,
          '| Gabarito:', relatorio.correctOption
        );
      }

      // Gabarito vem do cálculo do backend, não do campo `correct` da IA.
      const alternativas = Validacao.normalizarAlternativas(bruto.question.options);
      const gabarito = relatorio.correctOption;
      const textos = alternativas.map(a => String(a.texto ?? '').trim());
      const enunciado = relatorio.detalhes.enunciado;

      const atividadeId = `trilha-ia-${crypto.randomBytes(12).toString('hex')}`;
      await pool.query('INSERT INTO atividades (id, professor_id, titulo, descricao) VALUES (?, NULL, ?, ?)', [
        atividadeId,
        `Práctica complementar: ${habilidade.descricao || habilidade.habilidade_nome}`,
        'Questão complementar generada por IA validada automaticamente.'
      ]);
      const [inserted] = await pool.query(`INSERT INTO questoes
        (atividade_id, habilidade_id, enunciado, alternativa_a, alternativa_b, alternativa_c, alternativa_d, resposta, dificuldade, explicacao,
         origem, status_validacao, versao, formato)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        atividadeId, habilidade.habilidade_id, enunciado,
        textos[0] || null, textos[1] || null, textos[2] || null, textos[3] || null,
        gabarito, dificuldade, bruto.description || null,
        C.ORIGEN_QUESTAO.IA_APROVADO, C.VALIDACION_QUESTAO.APROVADO, 1, C.FORMATO_QUESTAO.TEXTO
      ]);
      const [created] = await pool.query(`SELECT q.*, h.descricao AS habilidade_nome
        FROM questoes q JOIN habilidades h ON h.id = q.habilidade_id WHERE q.id = ?`, [inserted.insertId]);

      console.log(
        '[TRILHA][IA][VALIDATION_OK] Tentativa:', tentativa,
        '| Gabarito calculado:', gabarito,
        '| Valor:', relatorio.calculatedAnswer,
        '| Fonte:', relatorio.detalhes.fonte
      );
      return created[0] || null;
    }

    console.error(
      '[TRILHA][IA][GENERATION_FAILED]',
      `Falha após ${C.IA_VALIDACAO.MAX_TENTATIVAS} tentativa(s). �altima razão:`,
      ultimoRelatorio ? ultimoRelatorio.errors.join(' ') : 'desconhecida',
      '| Nenhuma questão foi salva.'
    );
    return null;
  },

  async selecionarProximaQuestao(alunoId) {
    const curriculo = await CurriculoAlunoModel.findByAluno(alunoId);
    let habilidadesCurriculoIds = null;
    const ordemPorHabilidade = new Map();
    if (curriculo) {
      const habilidadesCurriculo = await CurriculoAlunoModel.listHabilidades(curriculo.id);
      if (habilidadesCurriculo.length > 0) {
        habilidadesCurriculoIds = habilidadesCurriculo.map(h => h.id);
        habilidadesCurriculo.forEach((h, index) => ordemPorHabilidade.set(h.id, Number.isFinite(h.ordem) ? Number(h.ordem) : index));
      }
    }

    let baseQuery = `SELECT h.id AS habilidade_id, h.descricao AS habilidade_nome, h.ano_escolar,
      COALESCE(uh.percentual_dominio, 0) AS percentual_dominio, COALESCE(uh.status_dominio, ?) AS status_dominio, uh.ultima_vez_praticado
      FROM habilidades h LEFT JOIN usuario_habilidades uh ON uh.habilidade_id = h.id AND uh.aluno_id = ?
      WHERE 1=1`;
    const params = [C.DOMINIO_STATUS.NAO_INICIADO, alunoId];
    if (habilidadesCurriculoIds) {
      baseQuery += ' AND h.id IN (?)';
      params.push(habilidadesCurriculoIds);
    }
    baseQuery += ' ORDER BY h.ano_escolar ASC, h.id ASC';

    const [skillRows] = await pool.query(baseQuery, params);
    if (skillRows.length === 0) return null;

    const skills = skillRows.map(s => ({
      ...s,
      status_dominio: normalizarStatus(s.status_dominio),
      ordem: ordemPorHabilidade.get(s.habilidade_id)
    }));
    const skillIds = skills.map(s => s.habilidade_id);

    // Aristas del grafo curricular (pre-requisitos entre las habilidades candidatas).
    const [edgeRows] = await pool.query(`SELECT habilidade_id, prerequisito_id FROM habilidade_prerequisitos
      WHERE habilidade_id IN (?) OR prerequisito_id IN (?)`, [skillIds, skillIds]);
    const edges = edgeRows.map(e => ({ habilidade_id: e.habilidade_id, prerequisito_id: e.prerequisito_id }));

    const [historyRows] = await pool.query(`SELECT hq.acertou, hq.tempo_resposta_seg, hq.data_resposta, hq.habilidade_id,
        q.dificuldade, q.tempo_esperado_seg, q.formato, q.status_validacao
      FROM historico_questoes hq JOIN questoes q ON q.id = hq.questao_id
      WHERE hq.aluno_id = ? AND hq.habilidade_id IN (?) ORDER BY hq.data_resposta ASC`, [alunoId, skillIds]);
    const [prereqRows] = await pool.query(`SELECT hp.habilidade_id AS habilidade_principal_id,
        h.id AS prerequisito_id, h.descricao AS prerequisito_nome,
        COALESCE(uh.status_dominio, ?) AS status_dominio
      FROM habilidade_prerequisitos hp JOIN habilidades h ON h.id = hp.prerequisito_id
      LEFT JOIN usuario_habilidades uh ON uh.habilidade_id = h.id AND uh.aluno_id = ?
      WHERE hp.habilidade_id IN (?)`, [C.DOMINIO_STATUS.NAO_INICIADO, alunoId, skillIds]);

    const historyBySkill = historyRows.reduce((acc, row) => {
      if (!acc[row.habilidade_id]) acc[row.habilidade_id] = [];
      acc[row.habilidade_id].push(row);
      return acc;
    }, {});

    // Corrección: los pre-requisitos se agrupan por la habilidad PRINCIPAL.
    const prereqsBySkill = prereqRows.reduce((acc, row) => {
      if (!acc[row.habilidade_principal_id]) acc[row.habilidade_principal_id] = [];
      acc[row.habilidade_principal_id].push({
        habilidade_id: row.prerequisito_id,
        habilidade_nome: row.prerequisito_nome,
        status_dominio: row.status_dominio
      });
      return acc;
    }, {});

    // Orden por GRAFO curricular: la frontera (habilidades con pre-requisitos
    // listos) primero, luego las habilidades bloqueadas por pre-requisito.
    const grafo = Engine.grafoCurricular({ skills, edges });
    const candidatas = [...grafo.frontera, ...grafo.bloqueadas];

    for (const skill of candidatas) {
      const history = historyBySkill[skill.habilidade_id] || [];
      const prerequisites = (prereqsBySkill[skill.habilidade_id] || []).map(p => ({ ...p, status_dominio: normalizarStatus(p.status_dominio) }));
      const formatosRecentes = history.slice(-4).map(h => h.formato).filter(Boolean);
      // A série pondera a dificuldade sorteada; a semente avança a cada questão
      // da habilidade para que as três dificuldades apareçam ao longo da trilha
      // na proporção da série, em vez de repetir sempre a mesma.
      const anoEscolar = curriculo?.ano_escolar ?? null;
      const semente = 1 + history.length * 31 + skill.habilidade_id;
      const decision = Engine.determineNextStep({
        skill,
        history,
        prerequisites,
        sessionHistory: [],
        currentDifficulty: history.length ? history[history.length - 1].dificuldade : C.DIFICULDADE.FACIL,
        anoEscolar,
        semente
      });

      // Para decisiones tipo `prerequisito` la habilidad realmente trabajada es
      // la del pre-requisito faltante (decision.skillId), no la bloqueada.
      const skillObjetivo = skills.find(s => s.habilidade_id === decision.skillId) || skill;

      if (decision.action === C.DECISAO_ACAO.AVANCAR) continue;

      const question = await this.selecionarQuestaoInedita(alunoId, decision.skillId, decision.difficulty, { formatosRecentes });
      if (question) {
        const sessao = await this.obterSessaoParaDecisao(alunoId, decision);
        return { questao: question, decisao: decision, sessao, habilidade: skillObjetivo };
      }
      // Pipeline determinístico (IA propõe o problema, o backend resolve).
      // Cai para o fluxo legado apenas se o estruturado não existir.
      let generatedQuestion = await this.gerarQuestaoDeterministica({ habilidade: skillObjetivo, dificuldade: decision.difficulty });
      if (!generatedQuestion) {
        generatedQuestion = await this.gerarQuestaoComplementarComIA({ habilidade: skillObjetivo, dificuldade: decision.difficulty });
      }
      if (generatedQuestion) {
        const sessao = await this.obterSessaoParaDecisao(alunoId, decision);
        return { questao: generatedQuestion, decisao: { ...decision, reason: 'questao_gerada_complementar' }, sessao, habilidade: skillObjetivo };
      }
    }

    // DEGRADAÇÃO GRACIOSA: nenhuma habilidade da trilha gerou questão (a IA
    // falhou, ou reprovou tudo). Sem isto o aluno receberia CONCLUIDO sem ter
    // visto nenhuma questão. Busca uma questão já aprovada no banco, nunca
    // servida a este aluno, e mantém a trilha viva.
    const reserva = await this.buscarQuestaoReserva(alunoId);
    if (reserva) {
      console.warn('[TRILHA][FALLBACK] Nenhuma questão gerada; usando questão do banco:', reserva.id);
      const decisaoReserva = {
        // `praticar` (e não `avancar`) de propósito: `avancar` carrega
        // etapa `dominio` e `endActivity: true`, o que encerraria a sessão
        // como se a habilidade tivesse sido dominada.
        action: C.DECISAO_ACAO.PRATICAR,
        etapa: C.ITEM_BLOCO.PRATICA,
        reason: 'questao_reserva_banco',
        skillId: reserva.habilidade_id,
        dificuldade: reserva.dificuldade,
        endActivity: false,
        explicacao: 'Questão do banco usada porque a geração automática não retornou questão válida.'
      };
      const sessao = await this.obterSessaoParaDecisao(alunoId, decisaoReserva).catch(() => null);
      return {
        questao: reserva,
        decisao: decisaoReserva,
        sessao,
        habilidade: skills.find(s => s.habilidade_id === reserva.habilidade_id) || null
      };
    }

    return null;
  },

  /**
   * Última instância: uma questão já aprovada no banco, nunca servida a este
   * aluno. Existe para a trilha nunca quebrar por falha da IA.
   */
  async buscarQuestaoReserva(alunoId) {
    try {
      const [rows] = await pool.query(`SELECT q.*, h.descricao AS habilidade_nome
        FROM questoes q JOIN habilidades h ON h.id = q.habilidade_id
        WHERE COALESCE(q.status_validacao, 'aprovado') = 'aprovado'
          AND NOT EXISTS (
            SELECT 1 FROM historico_questoes hq
            WHERE hq.aluno_id = ? AND hq.questao_id = q.id
          )
        ORDER BY q.numero_aplicacoes ASC, RAND() LIMIT 1`, [alunoId]);
      return rows[0] || null;
    } catch (error) {
      console.error('[TRILHA][FALLBACK] Falha ao buscar questão de reserva:', error.message);
      return null;
    }
  }
};

module.exports = MotorAdaptativoService;
