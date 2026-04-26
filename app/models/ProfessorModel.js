const pool = require('../../config/pool');

const ProfessorModel = {

  async findAll() {
    const [rows] = await pool.query('SELECT * FROM professores ORDER BY nome');
    return rows;
  },

  async findById(id) {
    const [rows] = await pool.query('SELECT * FROM professores WHERE id = ?', [id]);
    return rows[0] || null;
  },

  async findByEmail(email) {
    const [rows] = await pool.query('SELECT * FROM professores WHERE email = ?', [email]);
    return rows[0] || null;
  },

  async create({ nome, email, senha, foto, descricao, link_previa, status }) {
    const [result] = await pool.query(
      `INSERT INTO professores (nome, email, senha, foto, descricao, link_previa, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        nome,
        email,
        senha,
        foto || '/imagens/imagem_perfil.jpg',
        descricao || '',
        link_previa || '',
        status || 'disponivel'
      ]
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
      `UPDATE professores SET ${campos.join(', ')} WHERE id = ?`,
      valores
    );
    return result.affectedRows > 0;
  },

  async delete(id) {
    const [result] = await pool.query('DELETE FROM professores WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }
};

module.exports = ProfessorModel;
