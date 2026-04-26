const pool = require('../../config/pool');

const AtividadeModel = {

  async findAll() {
    const [rows] = await pool.query(
      'SELECT * FROM atividades ORDER BY criado_em DESC'
    );
    return rows;
  },

  async findById(id) {
    const [rows] = await pool.query(
      'SELECT * FROM atividades WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  },

  async findByProfessor(professorId) {
    const [rows] = await pool.query(
      'SELECT * FROM atividades WHERE professor_id = ? ORDER BY criado_em DESC',
      [professorId]
    );
    return rows;
  },

  async create({ professor_id, titulo, descricao }) {
    const [result] = await pool.query(
      'INSERT INTO atividades (professor_id, titulo, descricao) VALUES (?, ?, ?)',
      [professor_id, titulo, descricao || '']
    );
    return { id: result.insertId, professor_id, titulo, descricao };
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
      `UPDATE atividades SET ${campos.join(', ')} WHERE id = ?`,
      valores
    );
    return result.affectedRows > 0;
  },

  async delete(id) {
    const [result] = await pool.query('DELETE FROM atividades WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }
};

module.exports = AtividadeModel;
