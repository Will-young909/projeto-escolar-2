const pool = require('../../config/pool');

const PlatformConfigService = {
    /**
     * Obtém o valor de uma configuração por chave
     */
    async getConfig(chave, valorPadrao = null) {
        const [rows] = await pool.query(
            'SELECT valor FROM platform_config WHERE chave = ?',
            [chave]
        );
        if (rows.length > 0) {
            return rows[0].valor;
        }
        return valorPadrao;
    },

    /**
     * Salva ou atualiza uma configuração
     */
    async setConfig(chave, valor) {
        // Tentar atualizar primeiro
        const [result] = await pool.query(
            'UPDATE platform_config SET valor = ? WHERE chave = ?',
            [valor, chave]
        );
        if (result.affectedRows === 0) {
            // Se não atualizou, inserir
            await pool.query(
                'INSERT INTO platform_config (chave, valor) VALUES (?, ?)',
                [chave, valor]
            );
        }
        return true;
    },

    /**
     * Obtém a taxa da plataforma em percentual (ex: 20 para 20%)
     */
    async getPlatformFeePercent() {
        const valor = await this.getConfig('platform_fee_percent', '20');
        return parseFloat(valor);
    },

    /**
     * Calcula a taxa da plataforma com base no valor total
     */
    async calcularTaxaPlataforma(valorTotal) {
        const percentual = await this.getPlatformFeePercent();
        const total = Number(valorTotal);
        if (!Number.isFinite(total) || total < 0 || !Number.isFinite(percentual) || percentual < 0 || percentual > 100) {
            throw new Error('Valor ou percentual da taxa da plataforma inválido.');
        }
        const taxa = Number((total * percentual / 100).toFixed(2));
        const valorLiquido = Number((total - taxa).toFixed(2));
        return {
            percentual,
            taxa_plataforma: taxa,
            valor_liquido: valorLiquido
        };
    }
};

module.exports = PlatformConfigService;