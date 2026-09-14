const pool = require('../../config/pool');
const Engine = require('./AdaptiveTrailEngine');
const C = require('../constants/trilha');
const CurriculoAlunoModel = require('../models/CurriculoAlunoModel');

const LEGACY_STATUS = {
  nao_iniciado: C.DOMINIO_STATUS.NAO_INICIADO, em_progresso: C.DOMINIO_STATUS.EM_PROGRESSO,
  reforco: C.DOMINIO_STATUS.PRECISA_REFORCO, dominado: C.DOMINIO_STATUS.DOMINADO
};

const MotorAdaptativoService = {
  async obterPerfilHabilidades(alunoId) {
    const [rows] = await pool.query(`SELECT uh.*, h.codigo, h.descricao AS habilidade_nome
      FROM usuario_habilidades uh JOIN habilidades h ON h.id = uh.habilidade_id
      WHERE uh.aluno_id = ? ORDER BY uh.ultima_vez_praticado ASC`, [alunoId]);
    return rows.map(row => ({ ...row, status_dominio: LEGACY_STATUS[row.status_dominio] || row.status_dominio }));
  },

  async obterHistorico(alunoId, habilidadeId) {
    const [rows] = await pool.query(`SELECT hq.acertou, q.dificuldade, hq.data_resposta
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
    return rows.map(row => ({ ...row, status_dominio: LEGACY_STATUS[row.status_dominio] || row.status_dominio }));
  },

  async atualizarProficiencia(alunoId, habilidadeId) {
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
      const [history] = await connection.query(`SELECT hq.acertou, q.dificuldade FROM historico_questoes hq
        JOIN questoes q ON q.id = hq.questao_id WHERE hq.aluno_id = ? AND hq.habilidade_id = ? ORDER BY hq.data_resposta ASC`, [alunoId, habilidadeId]);
      const mastery = Engine.masteryState({ history, currentPercent: profile.percentual_dominio });
      const last = history[history.length - 1];
      const errors = last && !last.acertou ? Number(profile.n_erros_consecutivos || 0) + 1 : 0;
      const correct = last && last.acertou ? Number(profile.n_acertos_consecutivos || 0) + 1 : 0;
      await connection.query(`UPDATE usuario_habilidades SET percentual_dominio = ?, status_dominio = ?, respostas_consistentes_acerto = ?,
        n_tentativas = ?, n_acertos_consecutivos = ?, n_erros_consecutivos = ?, ultima_vez_praticado = NOW() WHERE id = ?`,
        [mastery.percentual, mastery.status, mastery.consecutiveCorrect, history.length, correct, errors, profile.id]);
      await connection.commit();
      return { ...mastery, habilidadeId };
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
      WHERE sa.aluno_id = ? AND sa.habilidade_foco_id = ? AND sa.status = ?
      ORDER BY sa.criado_em DESC LIMIT 1`, [alunoId, habilidadeId, C.SESSAO_STATUS.ATIVA]);
    return rows[0] || null;
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

  async selecionarProximaQuestao(alunoId) {
    const curriculo = await CurriculoAlunoModel.findByAluno(alunoId);
    let habilidadesCurriculoIds = null;
    if (curriculo) {
      const habilidadesCurriculo = await CurriculoAlunoModel.listHabilidades(curriculo.id);
      if (habilidadesCurriculo.length > 0) {
        habilidadesCurriculoIds = habilidadesCurriculo.map(h => h.id);
      }
    }

    let baseQuery = `SELECT h.id AS habilidade_id, h.descricao AS habilidade_nome,
      COALESCE(uh.percentual_dominio, 0) AS percentual_dominio, COALESCE(uh.status_dominio, ?) AS status_dominio, uh.ultima_vez_praticado
      FROM habilidades h LEFT JOIN usuario_habilidades uh ON uh.habilidade_id = h.id AND uh.aluno_id = ?
      WHERE 1=1`;
    const params = [C.DOMINIO_STATUS.NAO_INICIADO, alunoId];
    if (habilidadesCurriculoIds) {
      baseQuery += ' AND h.id IN (?)';
      params.push(habilidadesCurriculoIds);
    }
    baseQuery += ` ORDER BY FIELD(COALESCE(uh.status_dominio, ?), ?, ?, ?, ?, ?, ?, ?), uh.ultima_vez_praticado ASC, h.id ASC`;
    params.push(
      C.DOMINIO_STATUS.NAO_INICIADO,
      C.DOMINIO_STATUS.PRECISA_REFORCO, C.DOMINIO_STATUS.EM_DESENVOLVIMENTO, C.DOMINIO_STATUS.EM_PROGRESSO,
      C.DOMINIO_STATUS.PROFICIENTE, C.DOMINIO_STATUS.NAO_INICIADO, C.DOMINIO_STATUS.DOMINADA, C.DOMINIO_STATUS.DOMINADO
    );

    const [skills] = await pool.query(baseQuery, params);
    if (skills.length === 0) return null;

    const skillIds = skills.map(s => s.habilidade_id);
    const [historyRows] = await pool.query(`SELECT hq.acertou, q.dificuldade, hq.data_resposta, hq.habilidade_id
      FROM historico_questoes hq JOIN questoes q ON q.id = hq.questao_id
      WHERE hq.aluno_id = ? AND hq.habilidade_id IN (?) ORDER BY hq.data_resposta ASC`, [alunoId, skillIds]);
    const [prereqRows] = await pool.query(`SELECT h.id AS habilidade_id, h.descricao AS habilidade_nome,
      COALESCE(uh.status_dominio, ?) AS status_dominio
      FROM habilidade_prerequisitos hp JOIN habilidades h ON h.id = hp.prerequisito_id
      LEFT JOIN usuario_habilidades uh ON uh.habilidade_id = h.id AND uh.aluno_id = ?
      WHERE hp.habilidade_id IN (?)`, [C.DOMINIO_STATUS.NAO_INICIADO, alunoId, skillIds]);

    const historyBySkill = historyRows.reduce((acc, row) => {
      if (!acc[row.habilidade_id]) acc[row.habilidade_id] = [];
      acc[row.habilidade_id].push(row);
      return acc;
    }, {});

    const prereqsBySkill = prereqRows.reduce((acc, row) => {
      if (!acc[row.habilidade_id]) acc[row.habilidade_id] = [];
      acc[row.habilidade_id].push(row);
      return acc;
    }, {});

    for (const rawSkill of skills) {
      const skill = { ...rawSkill, status_dominio: LEGACY_STATUS[rawSkill.status_dominio] || rawSkill.status_dominio };
      const history = historyBySkill[skill.habilidade_id] || [];
      const prerequisites = prereqsBySkill[skill.habilidade_id] || [];
      const decision = Engine.determineNextStep({ skill, history, prerequisites, currentDifficulty: history.at(-1)?.dificuldade || C.DIFICULDADE.FACIL });

      if (decision.action === C.DECISAO_ACAO.AVANCAR) continue;

      if (decision.action === C.DECISAO_ACAO.APRENDER) {
        const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM materiais_aprendizagem WHERE habilidade_id = ?', [decision.skillId]);
        const total = countRows[0]?.total || 0;
        if (total > 0) {
          const offset = Math.floor(Math.random() * total);
          const [learningMaterials] = await pool.query('SELECT * FROM materiais_aprendizagem WHERE habilidade_id = ? LIMIT 1 OFFSET ?', [decision.skillId, offset]);
          if (learningMaterials.length > 0) {
            const sessao = await this.buscarSessaoAtiva(alunoId, decision.skillId) || await this.criarSessaoAtividade(alunoId, decision.skillId, C.SESSAO_TIPO.PRATICA, 'Aprender antes de praticar', { skillId: decision.skillId, etapa: decision.etapa });
            return { material: learningMaterials[0], decisao: decision, sessao };
          }
        }
        decision.action = C.DECISAO_ACAO.REFORCO;
      }

      const [questions] = await pool.query(`SELECT q.*, h.descricao AS habilidade_nome FROM questoes q JOIN habilidades h ON h.id = q.habilidade_id
        WHERE q.habilidade_id = ? AND q.dificuldade = ? AND NOT EXISTS (SELECT 1 FROM historico_questoes hq WHERE hq.aluno_id = ? AND hq.questao_id = q.id)
        ORDER BY q.id ASC LIMIT 1`, [decision.skillId, decision.difficulty, alunoId]);
      if (questions[0]) {
        const sessao = await this.buscarSessaoAtiva(alunoId, decision.skillId) || await this.criarSessaoAtividade(alunoId, decision.skillId, C.SESSAO_TIPO.PRATICA, decision.reason, { skillId: decision.skillId, etapa: decision.etapa, dificuldade: decision.difficulty });
        return { questao: questions[0], decisao: decision, sessao };
      }
      const [similar] = await pool.query(`SELECT q.*, h.descricao AS habilidade_nome FROM questoes q JOIN habilidades h ON h.id = q.habilidade_id
        WHERE q.habilidade_id = ? AND q.dificuldade = ? AND NOT EXISTS (
          SELECT 1 FROM historico_questoes hq
          WHERE hq.aluno_id = ? AND hq.questao_id = q.id AND hq.data_resposta >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        )
        ORDER BY q.id ASC LIMIT 1`, [decision.skillId, decision.difficulty, alunoId]);
      if (similar[0]) {
        const sessao = await this.buscarSessaoAtiva(alunoId, decision.skillId) || await this.criarSessaoAtividade(alunoId, decision.skillId, C.SESSAO_TIPO.PRATICA, decision.reason, { skillId: decision.skillId, etapa: decision.etapa, dificuldade: decision.difficulty });
        return { questao: similar[0], decisao: decision, sessao };
      }
      const [fallback] = await pool.query(`SELECT q.*, h.descricao AS habilidade_nome FROM questoes q JOIN habilidades h ON h.id = q.habilidade_id
        WHERE q.habilidade_id = ? ORDER BY q.dificuldade ASC, q.id ASC LIMIT 1`, [decision.skillId]);
      if (fallback[0]) {
        const sessao = await this.buscarSessaoAtiva(alunoId, decision.skillId) || await this.criarSessaoAtividade(alunoId, decision.skillId, C.SESSAO_TIPO.PRATICA, decision.reason, { skillId: decision.skillId, etapa: decision.etapa, dificuldade: decision.difficulty });
        return { questao: fallback[0], decisao: decision, sessao };
      }
    }
    return null;
  }
};

module.exports = MotorAdaptativoService;
