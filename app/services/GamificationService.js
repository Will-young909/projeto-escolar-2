const { isYesterday, isToday } = require('date-fns');
const AlunoModel = require('../models/AlunoModel');
const C = require('../constants/trilha');

const GamificationService = {

    xpParaNivel(nivel) {
        if (nivel <= 1) return 0;
        return Math.floor(Math.pow(nivel - 1, 1.5) * C.GAMIFICATION.NIVEL_BASE_XP);
    },

    async registrarAtividade(alunoId) {
        try {
            const aluno = await AlunoModel.findById(alunoId);
            if (!aluno) return;

            const hoje = new Date();
            const ultimaAtividade = aluno.ultima_atividade_em ? new Date(aluno.ultima_atividade_em) : null;

            if (ultimaAtividade && isToday(ultimaAtividade)) return;

            let novoStreak = (ultimaAtividade && isYesterday(ultimaAtividade)) ? (aluno.streak_atual || 0) + 1 : 1;

            await AlunoModel.update(alunoId, {
                streak_atual: novoStreak,
                ultima_atividade_em: hoje
            });
            console.log(`[Gamification] Streak diário atualizado para aluno ${alunoId}. Novo streak: ${novoStreak}.`);

        } catch (error) {
            console.error(`[Gamification] Erro ao registrar atividade para ${alunoId}:`, error);
        }
    },

    async registrarResultado(alunoId, acertou) {
        try {
            const aluno = await AlunoModel.findById(alunoId);
            if (!aluno) {
                console.warn(`[Gamification] Aluno ${alunoId} não encontrado para registrar resultado.`);
                return { xpGanho: 0, novoStreak: 0 };
            }

            if (acertou) {
                const xpGanho = C.GAMIFICATION.XP_POR_ACERTO;
                const novoXp = (aluno.xp_total || 0) + xpGanho;
                let novoNivel = aluno.nivel || 1;

                const xpNecessarioParaProximoNivel = this.xpParaNivel(novoNivel + 1);
                if (novoXp >= xpNecessarioParaProximoNivel) {
                    novoNivel++;
                    console.log(`[Gamification] UAU! Aluno ${alunoId} subiu para o nível ${novoNivel}!`);
                }

                const novoStreak = (aluno.streak_acertos || 0) + 1;

                this.registrarAtividade(alunoId).catch(console.error);

                await AlunoModel.update(alunoId, {
                    xp_total: novoXp,
                    nivel: novoNivel,
                    streak_acertos: novoStreak
                });

                console.log(`[Gamification] Resultado (ACERTO) para ${alunoId}. XP: +${xpGanho}, Streak de Acertos: ${novoStreak}.`);
                return { xpGanho, novoStreak };

            } else {
                const streakAntes = aluno.streak_acertos || 0;
                await AlunoModel.update(alunoId, { streak_acertos: 0 });

                console.log(`[Gamification] Resultado (ERROU A QUESTÃO) para ${alunoId}. Streak de acertos zerado (era ${streakAntes}).`);
                return { xpGanho: 0, novoStreak: 0 };
            }
        } catch (error) {
            console.error(`[Gamification] Erro ao registrar resultado para ${alunoId}:`, error);
            return { xpGanho: 0, novoStreak: 0 };
        }
    }
};

module.exports = GamificationService;
