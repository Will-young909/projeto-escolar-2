const pool = require('../../config/pool');

const DenunciaModel = {

  async findAll() {
    const [rows] = await pool.query(
      'SELECT * FROM denuncias ORDER BY criado_em DESC'
    );
    return rows;
  },

  async findById(id) {
    const [rows] = await pool.query(
      'SELECT * FROM denuncias WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  },

  async create({ tipo, titulo, descricao, email, evidencia, anonimo }) {
    const [result] = await pool.query(
      `INSERT INTO denuncias (tipo, titulo, descricao, email, evidencia, anonimo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tipo, titulo, descricao, email || null, evidencia || null, anonimo ? 1 : 0]
    );
    return { id: result.insertId };
  }
};

module.exports = DenunciaModel;
