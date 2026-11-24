const pool = require('../../config/pool');
const C = require('../constants/trilha');
const Engine = require('./AdaptiveTrailEngine');

const RevisaoService = {
  async findAgendamento(alunoId, questaoId) {
    const [rows] = await pool.query('SELECT * FROM revisao_agendada WHERE aluno_id = ? AND questao_id = ?', [alunoId, questaoId]);
    return rows[0] || null;
  },

  /**
   * Agenda la próxima revisión de una pregunta usando `Engine.proximaRevisao`
   * (secuencia pedagógica 1,3,7,14,30 con ajuste por confianza) y además agenda
   * una revisión a nivel de HABILIDAD para cubrir conceptos relacionados.
   */
  async agendarProximaRevisao(alunoId, questaoId, acertou, { confianca = null, dificuldade = null, habilidadeId = null } = {}) {
    const current = await this.findAgendamento(alunoId, questaoId);
    const schedule = Engine.proximaRevisao({ intervaloDias: current?.intervalo_dias ?? 0, acertou, confianca });
    const date = new Date();
    date.setDate(date.getDate() + schedule.intervaloDias);
    await pool.query(`INSERT INTO revisao_agendada (aluno_id, questao_id, data_revisao, fator_facilidade, intervalo_dias)
      VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE data_revisao = VALUES(data_revisao), fator_facilidade = VALUES(fator_facilidade),
      intervalo_dias = VALUES(intervalo_dias), atualizado_em = NOW()`, [alunoId, questaoId, date.toISOString().slice(0, 10), schedule.fatorFacilidade, schedule.intervaloDias]);
    if (habilidadeId) {
      await this.agendarRevisaoHabilidade(alunoId, habilidadeId, schedule.intervaloDias);
    }
  },

  /** Agendamiento de revisión por habilidad, no solo por pregunta. */
  async agendarRevisaoHabilidade(alunoId, habilidadeId, intervaloDias = 1, { confianca = null, motivo = 'tras_respuesta' } = {}) {
    const schedule = Engine.proximaRevisao({ intervaloDias, acertou: true, confianca });
    const date = new Date();
    date.setDate(date.getDate() + schedule.intervaloDias);
    await pool.query(`INSERT INTO revisao_habilidades (aluno_id, habilidade_id, data_revisao, intervalo_dias, fator_facilidade, motivo)
      VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE data_revisao = VALUES(data_revisao), intervalo_dias = VALUES(intervalo_dias),
      fator_facilidade = VALUES(fator_facilidade), atualizado_em = NOW()`,
      [alunoId, habilidadeId, date.toISOString().slice(0, 10), schedule.intervaloDias, schedule.fatorFacilidade, motivo]);
  },

  /**
   * Devuelve un LOTE de preguntas pendientes de revisión que aún no fueron
   * presentadas hoy (evita re-servir el mismo ítem dentro de una sesión).
   */
  async getQuestoesParaRevisar(alunoId, limit = C.REVISAO_LIMITE_DIARIO) {
    const [rows] = await pool.query(`SELECT ra.questao_id, ra.data_revisao, ra.intervalo_dias, q.habilidade_id, q.dificuldade,
        DATEDIFF(CURDATE(), ra.data_revisao) AS atraso_dias
      FROM revisao_agendada ra JOIN questoes q ON q.id = ra.questao_id
      WHERE ra.aluno_id = ? AND ra.data_revisao <= CURDATE()
        AND (ra.ultima_apresentacao_em IS NULL OR DATE(ra.ultima_apresentacao_em) < CURDATE())
      ORDER BY ra.data_revisao ASC, atraso_dias DESC LIMIT ?`, [alunoId, limit]);
    return rows;
  },

  async getQuestaoParaRevisar(alunoId) {
    const rows = await this.getQuestoesParaRevisar(alunoId, 1);
    return rows[0]?.questao_id || null;
  },

  /** Marca una revisión como presentada hoy (control del tope diario). */
  async marcarPresentada(alunoId, questaoId) {
    await pool.query(`UPDATE revisao_agendada SET ultima_apresentacao_em = NOW(), n_apresentacoes = n_apresentacoes + 1
      WHERE aluno_id = ? AND questao_id = ?`, [alunoId, questaoId]);
  },

  async contarPresentadasHoy(alunoId) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS total FROM revisao_agendada
      WHERE aluno_id = ? AND DATE(ultima_apresentacao_em) = CURDATE()`, [alunoId]);
    return Number(rows[0]?.total || 0);
  },

  async getHabilidadesParaRevisar(alunoId, limit = C.REVISAO_LIMITE_DIARIO) {
    const [rows] = await pool.query(`SELECT rh.*, h.descricao AS habilidade_nome, DATEDIFF(CURDATE(), rh.data_revisao) AS atraso_dias
      FROM revisao_habilidades rh JOIN habilidades h ON h.id = rh.habilidade_id
      WHERE rh.aluno_id = ? AND rh.data_revisao <= CURDATE()
      ORDER BY rh.data_revisao ASC LIMIT ?`, [alunoId, limit]);
    return rows;
  }
};

module.exports = RevisaoService;