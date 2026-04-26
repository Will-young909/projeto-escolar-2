const pool = require('../../config/pool');

const DisciplinaModel = {

  async findByProfessor(professorId) {
    const [rows] = await pool.query(
      'SELECT * FROM disciplinas WHERE professor_id = ? ORDER BY nome',
      [professorId]
    );
    return rows;
  },

  async create(professorId, nome) {
    const [result] = await pool.query(
      'INSERT INTO disciplinas (professor_id, nome) VALUES (?, ?)',
      [professorId, nome]
    );
    return { id: result.insertId, professor_id: professorId, nome };
  },

  async deleteByProfessor(professorId) {
    const [result] = await pool.query(
      'DELETE FROM disciplinas WHERE professor_id = ?',
      [professorId]
    );
    return result.affectedRows;
  },

  async syncProfessor(professorId, nomes) {
    await this.deleteByProfessor(professorId);
    for (const nome of nomes) {
      if (nome && nome.trim()) {
        await this.create(professorId, nome.trim());
      }
    }
  }
};

module.exports = DisciplinaModel;
