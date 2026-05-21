const pool = require('../../config/pool');

const RevisaoService = {

    /**
     * Busca um agendamento de revisão existente para um aluno e uma questão.
     * @param {string} alunoId
     * @param {number} questaoId
     * @returns {Promise<object|null>}
     */
    async findAgendamento(alunoId, questaoId) {
        const [rows] = await pool.query(
            'SELECT * FROM revisao_agendada WHERE aluno_id = ? AND questao_id = ?',
            [alunoId, questaoId]
        );
        return rows[0] || null;
    },

    /**
     * Atualiza ou cria um agendamento de revisão com base na resposta do aluno.
     * Utiliza uma versão simplificada do algoritmo SM-2.
     * @param {string} alunoId - ID do aluno.
     * @param {number} questaoId - ID da questão respondida.
     * @param {boolean} acertou - Se o aluno acertou a questão.
     */
    async agendarProximaRevisao(alunoId, questaoId, acertou) {
        try {
            const agendamento = await this.findAgendamento(alunoId, questaoId);

            let novoFatorFacilidade = 2.5;
            let novoIntervalo = 1;

            if (agendamento) { // Se já existe um agendamento, ajusta com base nele
                if (acertou) {
                    novoIntervalo = Math.ceil(agendamento.intervalo_dias * agendamento.fator_facilidade);
                    novoFatorFacilidade = agendamento.fator_facilidade + 0.1; 
                } else {
                    novoIntervalo = 1; // Reseta o intervalo
                    novoFatorFacilidade = Math.max(1.3, agendamento.fator_facilidade - 0.2); // Reduz o fator, com um mínimo
                }
            } else { // Se for a primeira vez, usa os valores iniciais
                if (!acertou) {
                    novoIntervalo = 1; // Se errar na primeira, revisa amanhã
                } else {
                    novoIntervalo = 2; // Se acertar na primeira, revisa em 2 dias
                }
            }
            
            // Calcula a próxima data de revisão
            const dataRevisao = new Date();
            dataRevisao.setDate(dataRevisao.getDate() + novoIntervalo);
            const dataRevisaoSQL = dataRevisao.toISOString().slice(0, 10); // Formato YYYY-MM-DD

            // Prepara a query para INSERT... ON DUPLICATE KEY UPDATE
            const query = `
                INSERT INTO revisao_agendada (aluno_id, questao_id, data_revisao, fator_facilidade, intervalo_dias, criado_em, atualizado_em)
                VALUES (?, ?, ?, ?, ?, NOW(), NOW())
                ON DUPLICATE KEY UPDATE
                    data_revisao = VALUES(data_revisao),
                    fator_facilidade = VALUES(fator_facilidade),
                    intervalo_dias = VALUES(intervalo_dias),
                    atualizado_em = NOW();
            `;

            await pool.query(query, [alunoId, questaoId, dataRevisaoSQL, novoFatorFacilidade, novoIntervalo]);
            
            console.log(`[RevisaoService] Questão ${questaoId} agendada para ${alunoId} em ${dataRevisaoSQL}`);

        } catch (error) {
            console.error(`[RevisaoService] Erro ao agendar revisão para aluno ${alunoId}, questão ${questaoId}:`, error);
            // Não relança o erro para não quebrar o fluxo principal de resposta da questão
        }
    },
    
    /**
     * Busca a próxima questão de revisão pendente para um aluno.
     * @param {string} alunoId - O ID do aluno.
     * @returns {Promise<number|null>} O ID da questão a ser revisada, ou nulo.
     */
    async getQuestaoParaRevisar(alunoId) {
        try {
            const hoje = new Date().toISOString().slice(0, 10);
            const [rows] = await pool.query(
                `SELECT questao_id
                 FROM revisao_agendada
                 WHERE aluno_id = ? AND data_revisao <= ?
                 ORDER BY data_revisao ASC -- Pega a mais antiga primeiro
                 LIMIT 1`,
                [alunoId, hoje]
            );
            
            return rows[0] ? rows[0].questao_id : null;
        } catch (error) {
            console.error('[RevisaoService] Erro ao buscar questão para revisar:', error);
            return null;
        }
    }
};

module.exports = RevisaoService;
