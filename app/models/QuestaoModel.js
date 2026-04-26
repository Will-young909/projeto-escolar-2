const pool = require('../../config/pool');

const QuestaoModel = {

  async findByAtividade(atividadeId) {
    const [rows] = await pool.query(
      'SELECT * FROM questoes WHERE atividade_id = ? ORDER BY id',
      [atividadeId]
    );
    return rows;
  },

  async create({ atividade_id, enunciado, alternativa_a, alternativa_b, alternativa_c, alternativa_d, resposta }) {
    const [result] = await pool.query(
      `INSERT INTO questoes (atividade_id, enunciado, alternativa_a, alternativa_b, alternativa_c, alternativa_d, resposta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [atividade_id, enunciado, alternativa_a || null, alternativa_b || null, alternativa_c || null, alternativa_d || null, resposta || null]
    );
    return { id: result.insertId };
  },

  async deleteByAtividade(atividadeId) {
    const [result] = await pool.query(
      'DELETE FROM questoes WHERE atividade_id = ?',
      [atividadeId]
    );
    return result.affectedRows;
  }
};

module.exports = QuestaoModel;
