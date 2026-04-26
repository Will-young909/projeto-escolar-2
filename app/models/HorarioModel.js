const pool = require('../../config/pool');

const HorarioModel = {

  async findByProfessor(professorId) {
    const [rows] = await pool.query(
      'SELECT * FROM horarios_disponiveis WHERE professor_id = ? ORDER BY data, hora_inicio',
      [professorId]
    );
    return rows;
  },

  async findById(id) {
    const [rows] = await pool.query(
      'SELECT * FROM horarios_disponiveis WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  },

  async findDisponiveis(professorId) {
    const [rows] = await pool.query(
      `SELECT * FROM horarios_disponiveis
       WHERE professor_id = ? AND status = 'disponivel'
       ORDER BY data, hora_inicio`,
      [professorId]
    );
    return rows;
  },

  async create({ professor_id, data, hora_inicio, hora_fim, preco }) {
    const [result] = await pool.query(
      `INSERT INTO horarios_disponiveis (professor_id, data, hora_inicio, hora_fim, preco)
       VALUES (?, ?, ?, ?, ?)`,
      [professor_id, data, hora_inicio, hora_fim, preco || 50]
    );
    return { id: result.insertId, professor_id, data, hora_inicio, hora_fim, preco };
  },

  async update(id, dados) {
    const campos = [];
    const valores = [];

    for (const [key, val] of Object.entries(dados)) {
      campos.push(`${key} = ?`);
      valores.push(val);
    }

    if (campos.length === 0) return false;
    valores.push(id);

    const [result] = await pool.query(
      `UPDATE horarios_disponiveis SET ${campos.join(', ')} WHERE id = ?`,
      valores
    );
    return result.affectedRows > 0;
  },

  async deleteByProfessorAndData(professorId, data) {
    const [result] = await pool.query(
      'DELETE FROM horarios_disponiveis WHERE professor_id = ? AND data = ?',
      [professorId, data]
    );
    return result.affectedRows;
  }
};

module.exports = HorarioModel;
