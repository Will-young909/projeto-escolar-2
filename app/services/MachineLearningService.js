
const tf = require('@tensorflow/tfjs-node');
const HistoricoQuestoesModel = require('../models/HistoricoQuestoesModel');
const UsuarioHabilidadesModel = require('../models/UsuarioHabilidadesModel');

const MODEL_PATH = 'file://./ml_model';

const MachineLearningService = {

    async treinarModelo() {
        console.log('[ML] Iniciando processo de treinamento...');

        // 1. Coletar e preparar os dados
        const dadosDeTreinamento = await this.prepararDados();
        if (!dadosDeTreinamento || dadosDeTreinamento.features.length === 0) {
            console.log('[ML] Não há dados suficientes para treinar o modelo.');
            return;
        }

        // 2. Criar e treinar o modelo
        const modelo = await this.criarEtreinarModelo(dadosDeTreinamento);

        // 3. Salvar o modelo treinado
        await modelo.save(MODEL_PATH);

        console.log(`[ML] Modelo treinado e salvo com sucesso em ${MODEL_PATH}`);
    },

    async prepararDados() {
        console.log('[ML] Coletando e processando histórico de respostas...');
        const todoHistorico = await HistoricoQuestoesModel.findAll();

        const features = [];
        const labels = [];

        // Agrupar histórico por aluno e habilidade para processamento eficiente
        const agrupado = todoHistorico.reduce((acc, item) => {
            const key = `${item.aluno_id}-${item.habilidade_id}`;
            if (!acc[key]) acc[key] = [];
            acc[key].push(item);
            return acc;
        }, {});

        for (const key in agrupado) {
            const sessoes = agrupado[key].sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));

            let acertos = 0;
            let tentativas = 0;
            let errosConsecutivos = 0;
            let acertosConsecutivos = 0;

            for (const sessao of sessoes) {
                // --- Features (Estado ANTES da resposta atual) ---
                const dominioAnterior = tentativas > 0 ? (acertos / tentativas) * 100 : 0;
                
                features.push([
                    dominioAnterior,
                    errosConsecutivos,
                    acertosConsecutivos,
                    tentativas
                ]);

                // --- Label (O resultado da resposta atual) ---
                labels.push([sessao.acertou ? 1 : 0]);

                // --- Atualizar estado para a PRÓXIMA iteração ---
                tentativas++;
                if (sessao.acertou) {
                    acertos++;
                    acertosConsecutivos++;
                    errosConsecutivos = 0;
                } else {
                    errosConsecutivos++;
                    acertosConsecutivos = 0;
                }
            }
        }
        
        console.log(`[ML] Processamento finalizado. Total de ${features.length} registros para treinamento.`);
        return { features, labels };
    },

    async criarEtreinarModelo({ features, labels }) {
        const tensorFeatures = tf.tensor2d(features);
        const tensorLabels = tf.tensor2d(labels);

        // Define a arquitetura do modelo
        const modelo = tf.sequential();
        modelo.add(tf.layers.dense({ units: 10, activation: 'relu', inputShape: [features[0].length] }));
        modelo.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));

        // Compila o modelo
        modelo.compile({
            optimizer: 'adam',
            loss: 'binaryCrossentropy',
            metrics: ['accuracy']
        });

        // Treina o modelo
        await modelo.fit(tensorFeatures, tensorLabels, {
            epochs: 50,
            shuffle: true,
            callbacks: {
                onEpochEnd: (epoch, logs) => {
                    console.log(`Epoch ${epoch + 1}: Loss = ${logs.loss.toFixed(4)}, Accuracy = ${logs.acc.toFixed(4)}`);
                }
            }
        });

        return modelo;
    }
};

module.exports = MachineLearningService;
