
const pool = require('../../config/pool');

const UsuarioHabilidadesModel = {
  // ... (métodos existentes)

  // Encontra todas as proficiências de um aluno
  async findAllByAluno(alunoId) {
    try {
      const [rows] = await pool.query(
        `SELECT uh.*, h.nome as habilidade_nome 
         FROM usuario_habilidades uh
         JOIN habilidades h ON uh.habilidade_id = h.id
         WHERE uh.aluno_id = ?
         ORDER BY uh.ultima_vez_praticado DESC`,
        [alunoId]
      );
      return rows;
    } catch (error) {
      console.error('Erro ao buscar todas as habilidades do aluno:', error);
      throw error;
    }
  },

  // Encontra proficiências de um aluno por status
  async findByStatus(alunoId, status) {
    try {
      const [rows] = await pool.query(
        `SELECT * FROM usuario_habilidades 
         WHERE aluno_id = ? AND status_dominio = ? 
         ORDER BY ultima_vez_praticado ASC`,
        [alunoId, status]
      );
      return rows;
    } catch (error) {
      console.error(`Erro ao buscar habilidades com status ${status}:`, error);
      throw error;
    }
  },

  // Encontra habilidades que o aluno ainda não praticou
  async findHabilidadesNaoIniciadas(alunoId) {
    try {
        // Esta query encontra habilidades que NÃO têm uma entrada correspondente em usuario_habilidades para este aluno.
        const [rows] = await pool.query(`
            SELECT h.* FROM habilidades h
            LEFT JOIN usuario_habilidades uh ON h.id = uh.habilidade_id AND uh.aluno_id = ?
            WHERE uh.id IS NULL
            ORDER BY h.ano_escolar, h.id ASC
        `, [alunoId]);
        return rows;
    } catch (error) {
        console.error('Erro ao buscar habilidades não iniciadas:', error);
        throw error;
    }
  },

  // Busca ou cria a proficiência de um usuário para uma habilidade
  async findOrCreate(alunoId, habilidadeId) {
    try {
      let [rows] = await pool.query('SELECT * FROM usuario_habilidades WHERE aluno_id = ? AND habilidade_id = ?', [alunoId, habilidadeId]);
      if (rows.length > 0) {
        return rows[0];
      }

      const [result] = await pool.query('INSERT INTO usuario_habilidades (aluno_id, habilidade_id, status_dominio) VALUES (?, ?, ?)', [alunoId, habilidadeId, 'nao_iniciado']);
      [rows] = await pool.query('SELECT * FROM usuario_habilidades WHERE id = ?', [result.insertId]);
      return rows[0];
    } catch (error) {
      console.error('Erro em findOrCreate na proficiência:', error);
      throw error;
    }
  },

  // Atualiza o domínio de uma habilidade
  async updateDominio(proficienciaId, { percentual, status, acertoConsistente }) {
    try {
      await pool.query(
        `UPDATE usuario_habilidades 
         SET percentual_dominio = ?, status_dominio = ?, respostas_consistentes_acerto = ?, ultima_vez_praticado = NOW() 
         WHERE id = ?`,
        [percentual, status, acertoConsistente, proficienciaId]
      );
      return true;
    } catch (error) {
      console.error('Erro ao atualizar domínio:', error);
      throw error;
    }
  },

  // Encontra habilidades que precisam de reforço
  async findHabilidadesParaReforco(alunoId) {
    try {
      const [rows] = await pool.query(
        `SELECT * FROM usuario_habilidades 
         WHERE aluno_id = ? AND status_dominio = 'reforco'
         ORDER BY ultima_vez_praticado ASC`,
        [alunoId]
      );
      return rows;
    } catch (error) {
      console.error('Erro ao buscar habilidades para reforço:', error);
      throw error;
    }
  },

  // Verifica se todos os pré-requisitos de uma habilidade foram dominados
  async checkPrerequisitosDominados(alunoId, habilidadeId) {
    try {
      const [prerequisitos] = await pool.query('SELECT prerequisito_id FROM habilidade_prerequisitos WHERE habilidade_id = ?', [habilidadeId]);
      if (prerequisitos.length === 0) {
        return true; // Não tem pré-requisitos
      }

      const prereqIds = prerequisitos.map(p => p.prerequisito_id);
      
      const [dominados] = await pool.query(
        `SELECT COUNT(*) as count FROM usuario_habilidades 
         WHERE aluno_id = ? AND habilidade_id IN (?) AND status_dominio = 'dominado'`,
        [alunoId, prereqIds]
      );

      return dominados[0].count === prereqIds.length;
    } catch (error) {
      console.error('Erro ao verificar pré-requisitos dominados:', error);
      throw error;
    }
  }
};

module.exports = UsuarioHabilidadesModel;
