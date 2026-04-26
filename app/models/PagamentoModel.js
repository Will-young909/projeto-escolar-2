const pool = require('../../config/pool');

const PagamentoModel = {

  async findAll() {
    const [rows] = await pool.query(
      'SELECT * FROM pagamentos ORDER BY criado_em DESC'
    );
    return rows;
  },

  async findByPreferenceId(preferenceId) {
    const [rows] = await pool.query(
      'SELECT * FROM pagamentos WHERE preference_id = ?',
      [preferenceId]
    );
    return rows[0] || null;
  },

  async create({ preference_id, sala, descricao, valor, criado_por, status }) {
    const [result] = await pool.query(
      `INSERT INTO pagamentos (preference_id, sala, descricao, valor, criado_por, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [preference_id, sala || null, descricao || null, valor, criado_por || null, status || 'pending']
    );
    return { id: result.insertId };
  },

  async updateByPreferenceId(preferenceId, dados) {
    const campos = [];
    const valores = [];

    for (const [key, val] of Object.entries(dados)) {
      campos.push(`${key} = ?`);
      valores.push(val);
    }

    if (campos.length === 0) return false;
    valores.push(preferenceId);

    const [result] = await pool.query(
      `UPDATE pagamentos SET ${campos.join(', ')} WHERE preference_id = ?`,
      valores
    );
    return result.affectedRows > 0;
  },

  async updateByPaymentId(paymentId, dados) {
    const campos = [];
    const valores = [];

    for (const [key, val] of Object.entries(dados)) {
      campos.push(`${key} = ?`);
      valores.push(val);
    }

    if (campos.length === 0) return false;
    valores.push(paymentId);

    const [result] = await pool.query(
      `UPDATE pagamentos SET ${campos.join(', ')} WHERE payment_id = ?`,
      valores
    );
    return result.affectedRows > 0;
  }
};

module.exports = PagamentoModel;
