
const pool = require('../../config/pool');

const HabilidadeModel = {
  // Encontra uma habilidade pelo ID
  async findById(id) {
    try {
      const [rows] = await pool.query('SELECT * FROM habilidades WHERE id = ?', [id]);
      return rows[0];
    } catch (error) {
      console.error('Erro ao buscar habilidade por ID:', error);
      throw error;
    }
  },

  // Lista todas as habilidades
  async findAll() {
    try {
      const [rows] = await pool.query('SELECT * FROM habilidades');
      return rows;
    } catch (error) {
      console.error('Erro ao listar habilidades:', error);
      throw error;
    }
  },

  // Adiciona um pré-requisito a uma habilidade
  async addPrerequisite(habilidadeId, prerequisitoId) {
    try {
      await pool.query('INSERT INTO habilidades_prerequisitos (habilidade_id, prerequisito_id) VALUES (?, ?)', [habilidadeId, prerequisitoId]);
      return true;
    } catch (error) {
      console.error('Erro ao adicionar pré-requisito:', error);
      throw error;
    }
  },

  // Lista os pré-requisitos de uma habilidade
  async findPrerequisites(habilidadeId) {
    try {
      const [rows] = await pool.query(`
        SELECT p.* FROM habilidades p
        INNER JOIN habilidades_prerequisitos pr ON p.id = pr.prerequisito_id
        WHERE pr.habilidade_id = ?
      `, [habilidadeId]);
      return rows;
    } catch (error) {
      console.error('Erro ao buscar pré-requisitos:', error);
      throw error;
    }
  }
};

module.exports = HabilidadeModel;
