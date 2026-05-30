const pool = require('../../config/pool');

const DenunciaModel = {

  async findAll(filtros = {}) {
    let query = 'SELECT d.*, u.nome as responsavel_nome FROM denuncias d LEFT JOIN usuarios u ON d.responsavel_id = u.id';
    const params = [];

    if (filtros) {
      const clausulas = [];
      if (filtros.status) {
        clausulas.push('d.status = ?');
        params.push(filtros.status);
      }
      if (filtros.prioridade) {
        clausulas.push('d.prioridade = ?');
        params.push(filtros.prioridade);
      }
      if (filtros.responsavel_id) {
        clausulas.push('d.responsavel_id = ?');
        params.push(filtros.responsavel_id);
      }

      if (clausulas.length > 0) {
        query += ' WHERE ' + clausulas.join(' AND ');
      }
    }

    query += ' ORDER BY d.criado_em DESC';

    const [rows] = await pool.query(query, params);
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
      `INSERT INTO denuncias (tipo, titulo, descricao, email, evidencia, anonimo, status)
       VALUES (?, ?, ?, ?, ?, ?, 'aberta')`,
      [tipo, titulo, descricao, email || null, evidencia || null, anonimo ? 1 : 0]
    );
    return { id: result.insertId };
  },

  async update(id, campos) {
    const nomesDosCampos = Object.keys(campos);
    const valores = Object.values(campos);
    
    const sql = `UPDATE denuncias SET ${nomesDosCampos.map(campo => `${campo} = ?`).join(', ')} WHERE id = ?`;
    valores.push(id);

    const [result] = await pool.query(sql, valores);
    return result;
  },

  async getHistory(denunciaId) {
    const [rows] = await pool.query(
      'SELECT * FROM denuncia_historico WHERE denuncia_id = ? ORDER BY criado_em DESC',
      [denunciaId]
    );
    return rows;
  },

  async addHistory(denunciaId, { usuario_id, acao, detalhes }) {
    await pool.query(
      'INSERT INTO denuncia_historico (denuncia_id, usuario_id, acao, detalhes) VALUES (?, ?, ?, ?)',
      [denunciaId, usuario_id, acao, detalhes]
    );
  }
};

module.exports = DenunciaModel;