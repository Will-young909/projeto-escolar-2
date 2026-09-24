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
    const currentInterval = current ? Number(current.intervalo_dias) : 0;
    let interval = currentInterval;

    if (acertou) {
      const scheduleIndex = C.REVISAO_INTERVALOS.indexOf(currentInterval);
      // The first five successful recalls follow the pedagogical schedule
      // exactly (1, 3, 7, 14, 30 days). After that, preserve the existing
      // ease-factor behaviour for long-term reviews.
      interval = scheduleIndex === -1
        ? C.REVISAO_INTERVALOS[0]
        : C.REVISAO_INTERVALOS[scheduleIndex + 1] || Math.round(currentInterval * easeFactor);
      easeFactor = Math.max(1.3, easeFactor + 0.1);
    } else {
      // A missed review is brought back the next day instead of becoming due
      // immediately, which avoids repeatedly serving the same item in one run.
      interval = C.REVISAO_INTERVALOS[0];
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
