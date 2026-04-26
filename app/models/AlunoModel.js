const pool = require('../../config/pool');

const AlunoModel = {

  async findAll() {
    const [rows] = await pool.query('SELECT * FROM alunos ORDER BY nome');
    return rows;
  },

  async findById(id) {
    const [rows] = await pool.query('SELECT * FROM alunos WHERE id = ?', [id]);
    return rows[0] || null;
  },

  async findByEmail(email) {
    const [rows] = await pool.query('SELECT * FROM alunos WHERE email = ?', [email]);
    return rows[0] || null;
  },

  async create({ nome, email, senha }) {
    const [result] = await pool.query(
      'INSERT INTO alunos (nome, email, senha) VALUES (?, ?, ?)',
      [nome, email, senha]
    );
    return { id: result.insertId, nome, email };
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
      `UPDATE alunos SET ${campos.join(', ')} WHERE id = ?`,
      valores
    );
    return result.affectedRows > 0;
  },

  async delete(id) {
    const [result] = await pool.query('DELETE FROM alunos WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }
};

module.exports = AlunoModel;
