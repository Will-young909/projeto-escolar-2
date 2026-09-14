const pool = require('../../config/pool');
const C = require('../constants/trilha');

const RevisaoService = {
  async findAgendamento(alunoId, questaoId) {
    const [rows] = await pool.query('SELECT * FROM revisao_agendada WHERE aluno_id = ? AND questao_id = ?', [alunoId, questaoId]);
    return rows[0] || null;
  },

  async agendarProximaRevisao(alunoId, questaoId, acertou) {
    const current = await this.findAgendamento(alunoId, questaoId);
    let easeFactor = current ? Number(current.fator_facilidade) : 2.5;
    let interval = current ? Number(current.intervalo_dias) : 0;

    if (acertou) {
      if (interval === 0) {
        interval = 1;
      } else if (interval === 1) {
        interval = 6;
      } else {
        interval = Math.round(interval * easeFactor);
      }
      easeFactor = Math.max(1.3, easeFactor + 0.1);
    } else {
      interval = 0;
      easeFactor = Math.max(1.3, easeFactor - 0.2);
    }

    const date = new Date();
    date.setDate(date.getDate() + interval);
    await pool.query(`INSERT INTO revisao_agendada (aluno_id, questao_id, data_revisao, fator_facilidade, intervalo_dias)
      VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE data_revisao = VALUES(data_revisao), fator_facilidade = VALUES(fator_facilidade),
      intervalo_dias = VALUES(intervalo_dias), atualizado_em = NOW()`, [alunoId, questaoId, date.toISOString().slice(0, 10), easeFactor, interval]);
  },

  async getQuestaoParaRevisar(alunoId) {
    const [rows] = await pool.query(`SELECT ra.questao_id FROM revisao_agendada ra
      WHERE ra.aluno_id = ? AND ra.data_revisao <= CURDATE() ORDER BY ra.data_revisao ASC LIMIT 1`, [alunoId]);
    return rows[0]?.questao_id || null;
  }
};

module.exports = RevisaoService;
