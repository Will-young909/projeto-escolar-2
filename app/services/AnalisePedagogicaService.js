const tf = require('@tensorflow/tfjs-node');
const fs = require('fs');
const path = require('path');
const pool = require('../../config/pool');
const HistoricoQuestoesModel = require('../models/HistoricoQuestoesModel');
const UsuarioHabilidadesModel = require('../models/UsuarioHabilidadesModel');

const MODEL_DIR = './ml_model';
const MODEL_PATH = `file://${path.join(__dirname, '../../', MODEL_DIR, 'model.json')}`;

let modeloCarregado = null;

// Constantes para os gatilhos de intervenção
const PROFICIENCIA_MINIMA_PARA_INTERVENCAO = 0.40; // Se a proficiência cair abaixo de 40%
const ERROS_CONSECUTIVOS_PARA_INTERVENCAO = 3;    // Ou se o aluno errar 3x seguidas

const AnalisePedagogicaService = {

    async verificarIntervencaoNecessaria(alunoId) {
        try {
            const [proficiencias] = await pool.query(
                `SELECT prerequisito_id, proficiencia, erros_consecutivos
                 FROM aluno_prerequisito_proficiencia
                 WHERE aluno_id = ? AND (proficiencia < ? OR erros_consecutivos >= ?)
                 ORDER BY proficiencia ASC, erros_consecutivos DESC
                 LIMIT 1`,
                [alunoId, PROFICIENCIA_MINIMA_PARA_INTERVENCAO, ERROS_CONSECUTIVOS_PARA_INTERVENCAO]
            );

            if (proficiencias.length > 0) {
                console.log(`[Intervenção] Gatilho detectado para o Aluno ${alunoId}. Pré-requisito problemático: ${proficiencias[0].prerequisito_id}`);
                return { necessitaIntervencao: true, prerequisitoId: proficiencias[0].prerequisito_id };
            }

            return { necessitaIntervencao: false };
        } catch (error) {
            console.error('[Intervenção] Erro ao verificar necessidade de intervenção:', error);
            return { necessitaIntervencao: false };
        }
    },

    // ... (resto do código do serviço permanece o mesmo)
    async preverChanceDeErro(alunoId, habilidadeId) {
        try {
            if (!modeloCarregado) {
                if (fs.existsSync(MODEL_DIR)) {
                    modeloCarregado = await tf.loadLayersModel(MODEL_PATH);
                } else {
                    return { chanceDeErro: 50, motivos: ['Modelo de ML não treinado'] };
                }
            }
            const proficiencia = await UsuarioHabilidadesModel.findOrCreate(alunoId, habilidadeId);
            const features = [proficiencia.percentual_dominio || 0, proficiencia.n_erros_consecutivos || 0, proficiencia.n_acertos_consecutivos || 0, proficiencia.n_tentativas || 0];
            const tensorFeatures = tf.tensor2d([features]);
            const predicaoTensor = modeloCarregado.predict(tensorFeatures);
            const chanceDeAcerto = predicaoTensor.dataSync()[0];
            tf.dispose([tensorFeatures, predicaoTensor]);
            return { chanceDeErro: Math.round((1 - chanceDeAcerto) * 100), motivos: ['Previsão baseada em ML'] };
        } catch (error) {
            console.error('[ML] Erro ao tentar fazer a previsão:', error);
            return { chanceDeErro: 50, motivos: ['Erro no modelo de ML'] };
        }
    },

    async analisarAposResposta(alunoId, habilidadeId, questaoId, historicoRecente) {
        try {
            this.atualizarProficienciaPrerequisitos(alunoId, questaoId, historicoRecente.acertou).catch(console.error);
            const flagsComportamentais = this.analisarComportamentoDeResposta(historicoRecente);
            const score = await this.calcularScorePedagogico(alunoId);
            return { flagsComportamentais, score };
        } catch (error) {
            console.error('Erro na análise pedagógica:', error);
        }
    },

    async atualizarProficienciaPrerequisitos(alunoId, questaoId, acertou) {
        const [prereqs] = await pool.query('SELECT prerequisito_id FROM questoes_prerequisitos WHERE questao_id = ?', [questaoId]);
        if (prereqs.length === 0) return;
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            for (const prereq of prereqs) {
                const prerequisitoId = prereq.prerequisito_id;
                const [rows] = await connection.query('SELECT * FROM aluno_prerequisito_proficiencia WHERE aluno_id = ? AND prerequisito_id = ? FOR UPDATE', [alunoId, prerequisitoId]);
                let prof = rows[0] || { proficiencia: 0.5, erros_consecutivos: 0, acertos_consecutivos: 0, id: null };
                const FATOR_APRENDIZAGEM = 0.20;
                let novaProficiencia = acertou ? prof.proficiencia + (1 - prof.proficiencia) * FATOR_APRENDIZAGEM : prof.proficiencia - prof.proficiencia * FATOR_APRENDIZAGEM;
                prof.acertos_consecutivos = acertou ? prof.acertos_consecutivos + 1 : 0;
                prof.erros_consecutivos = acertou ? 0 : prof.erros_consecutivos + 1;
                prof.proficiencia = Math.max(0.0001, Math.min(0.9999, novaProficiencia));
                if (prof.id) {
                    await connection.query('UPDATE aluno_prerequisito_proficiencia SET proficiencia = ?, acertos_consecutivos = ?, erros_consecutivos = ? WHERE id = ?', [prof.proficiencia, prof.acertos_consecutivos, prof.erros_consecutivos, prof.id]);
                } else {
                    await connection.query('INSERT INTO aluno_prerequisito_proficiencia (aluno_id, prerequisito_id, proficiencia, acertos_consecutivos, erros_consecutivos) VALUES (?, ?, ?, ?, ?)', [alunoId, prerequisitoId, prof.proficiencia, prof.acertos_consecutivos, prof.erros_consecutivos]);
                }
            }
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            console.error('[Análise de Pré-requisitos] Erro ao atualizar proficiência:', error);
        } finally {
            connection.release();
        }
    },

    analisarComportamentoDeResposta(historico) {
        const flags = [];
        const tempo = historico.tempo_resposta_seg;
        if (tempo > 90) flags.push('possivel_fadiga');
        if (!historico.acertou && tempo < 3) flags.push('possivel_chute');
        return flags;
    },

    async calcularScorePedagogico(alunoId) {
        const todasProficiencias = await UsuarioHabilidadesModel.findAllByAluno(alunoId);
        if (todasProficiencias.length === 0) return 0;
        let scoreTotal = 0;
        let pesoTotal = 0;
        for (const prof of todasProficiencias) {
            let peso = 1.0;
            if (prof.status_dominio === 'reforco') peso = 2.0;
            if (prof.status_dominio === 'dominado') peso = 0.5;
            scoreTotal += (prof.percentual_dominio || 0) * peso;
            pesoTotal += peso;
        }
        return pesoTotal > 0 ? scoreTotal / pesoTotal : 0;
    },
};

module.exports = AnalisePedagogicaService;
