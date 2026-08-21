const pool = require('../../config/pool');

const PasseEstudoService = {

    /**
     * Adiciona um novo passe de estudos para um aluno após a confirmação de compra.
     * @param {string} alunoId - O ID do aluno.
     * @param {string} tipoPasse - O tipo do passe comprado ('quantidade_10', 'diario', 'semanal').
     * @returns {Promise<object>} O resultado da inserção no banco de dados.
     */
    async adicionarPasse(alunoId, tipoPasse) {
        if (!alunoId || !tipoPasse) {
            throw new Error('ID do aluno e tipo do passe são obrigatórios.');
        }

        let query, params;
        const agora = new Date();

        switch (tipoPasse) {
            case 'quantidade_10':
                // Adiciona um passe com 10 atividades. Não tem data de validade.
                query = 'INSERT INTO passes_estudo (aluno_id, tipo, atividades_restantes, data_compra) VALUES (?, ?, ?, ?)';
                params = [alunoId, 'quantidade', 10, agora];
                break;
            
            case 'diario':
                // Adiciona um passe com validade de 24 horas a partir de agora.
                const validadeDiaria = new Date(agora.getTime() + 24 * 60 * 60 * 1000);
                query = 'INSERT INTO passes_estudo (aluno_id, tipo, data_compra, data_validade) VALUES (?, ?, ?, ?)';
                params = [alunoId, 'diario', agora, validadeDiaria];
                break;

            case 'semanal':
                // Adiciona um passe com validade de 7 dias a partir de agora.
                const validadeSemanal = new Date(agora.getTime() + 7 * 24 * 60 * 60 * 1000);
                query = 'INSERT INTO passes_estudo (aluno_id, tipo, data_compra, data_validade) VALUES (?, ?, ?, ?)';
                params = [alunoId, 'semanal', agora, validadeSemanal];
                break;

            default:
                throw new Error('Tipo de passe inválido.');
        }

        try {
            const [result] = await pool.query(query, params);
            console.log(`Passe do tipo '${tipoPasse}' adicionado com sucesso para o aluno ${alunoId}.`);
            return result;
        } catch (error) {
            console.error('Erro ao adicionar passe de estudo no banco de dados:', error);
            throw error;
        }
    },

    /**
     * Verifica se um aluno possui algum passe de estudos ativo.
     * A função prioriza passes de tempo (semanal/diário) sobre os de quantidade.
     * @param {string} alunoId - O ID do aluno.
     * @returns {Promise<{passeAtivo: boolean, tipo: string|null, atividadesRestantes?: number}>} Um objeto indicando se há um passe ativo, seu tipo e atividades restantes (se aplicável).
     */
    async verificarPasseAtivo(alunoId) {
        if (!alunoId) return { passeAtivo: false, tipo: null };

        try {
            const [passes] = await pool.query(
                'SELECT * FROM passes_estudo WHERE aluno_id = ? ORDER BY data_compra DESC',
                [alunoId]
            );

            if (passes.length === 0) return { passeAtivo: false, tipo: null };

            const agora = new Date();

            const passeDeTempoAtivo = passes.find(p => 
                (p.tipo === 'diario' || p.tipo === 'semanal') && p.data_validade > agora
            );

            if (passeDeTempoAtivo) {
                return { passeAtivo: true, tipo: passeDeTempoAtivo.tipo };
            }

            const passeDeQuantidadeAtivo = passes.find(p => 
                p.tipo === 'quantidade' && p.atividades_restantes > 0
            );

            if (passeDeQuantidadeAtivo) {
                return {
                    passeAtivo: true,
                    tipo: 'quantidade',
                    atividadesRestantes: passeDeQuantidadeAtivo.atividades_restantes
                };
            }

            return { passeAtivo: false, tipo: null };
        } catch (error) {
            console.error('Erro ao verificar passes de estudo:', error);
            return { passeAtivo: false, tipo: null };
        }
    },

    /**
     * Consome uma atividade de um passe do tipo 'quantidade'.
     * @param {string} alunoId - O ID do aluno.
     */
    async consumirAtividadePasse(alunoId) {
        try {
            const [passes] = await pool.query(
                `SELECT id FROM passes_estudo 
                 WHERE aluno_id = ? AND tipo = 'quantidade' AND atividades_restantes > 0 
                 ORDER BY data_compra ASC LIMIT 1`,
                [alunoId]
            );

            if (passes.length > 0) {
                const passeId = passes[0].id;
                await pool.query(
                    'UPDATE passes_estudo SET atividades_restantes = atividades_restantes - 1 WHERE id = ?',
                    [passeId]
                );
                console.log(`Uma atividade do passe ${passeId} foi consumida pelo aluno ${alunoId}.`);
            }
        } catch (error) {
            console.error('Erro ao consumir atividade do passe de quantidade:', error);
            throw error;
        }
    }
};

module.exports = PasseEstudoService;
