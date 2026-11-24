const pool = require('../../config/pool');
const { getSaoPauloDateTime } = require('../utils/brasiliaTime');

const STOP_WORDS = new Set([
    'a', 'ao', 'aos', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos',
    'o', 'os', 'para', 'por', 'um', 'uma', 'sobre', 'habilidade', 'questao', 'questão'
]);

function normalizarTexto(texto = '') {
    return String(texto)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function extrairTermos(texto = '') {
    return normalizarTexto(texto)
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(termo => termo.length > 2 && !STOP_WORDS.has(termo));
}

function calcularNivel(percentual, erros) {
    if (percentual < 50 || erros >= 3) return 'reforço urgente';
    if (percentual < 70 || erros > 0) return 'reforço recomendado';
    return 'aprofundamento';
}

async function buscarFocosPorTentativa(alunoId, tentativaId) {
    const [resultadoHabilidade] = await pool.query(
        `SELECT rh.habilidade_id, h.codigo, h.descricao, rh.acertos, rh.erros, rh.percentual, rh.nivel
         FROM resultado_habilidade rh
         JOIN habilidades h ON h.id = rh.habilidade_id
         WHERE rh.aluno_id = ? AND rh.tentativa_id = ?
         ORDER BY rh.percentual ASC, rh.erros DESC`,
        [alunoId, tentativaId]
    );

    if (resultadoHabilidade.length > 0) {
        return resultadoHabilidade.map(item => ({
            habilidadeId: item.habilidade_id,
            codigo: item.codigo,
            descricao: item.descricao,
            acertos: Number(item.acertos || 0),
            erros: Number(item.erros || 0),
            percentual: Number(item.percentual || 0),
            nivel: item.nivel || calcularNivel(Number(item.percentual || 0), Number(item.erros || 0))
        }));
    }

    const [resumoRespostas] = await pool.query(
        `SELECT h.id AS habilidade_id, h.codigo, h.descricao,
                SUM(CASE WHEN rt.acertou = 1 THEN 1 ELSE 0 END) AS acertos,
                SUM(CASE WHEN rt.acertou = 0 THEN 1 ELSE 0 END) AS erros,
                COUNT(*) AS total
         FROM respostas_teste rt
         JOIN tentativas_teste tt ON tt.id = rt.tentativa_id
         JOIN questoes q ON q.id = rt.questao_id
         LEFT JOIN habilidades h ON h.id = q.habilidade_id
         WHERE tt.aluno_id = ? AND rt.tentativa_id = ?
         GROUP BY h.id, h.codigo, h.descricao
         ORDER BY erros DESC, acertos ASC`,
        [alunoId, tentativaId]
    );

    return resumoRespostas.map(item => {
        const total = Number(item.total || 0);
        const acertos = Number(item.acertos || 0);
        const erros = Number(item.erros || 0);
        const percentual = total > 0 ? (acertos / total) * 100 : 0;

        return {
            habilidadeId: item.habilidade_id,
            codigo: item.codigo || 'diagnostico-geral',
            descricao: item.descricao || 'Conteúdos do diagnóstico',
            acertos,
            erros,
            percentual,
            nivel: calcularNivel(percentual, erros)
        };
    });
}

async function buscarUltimaTentativa(alunoId) {
    const [rows] = await pool.query(
        `SELECT id
         FROM tentativas_teste
         WHERE aluno_id = ?
         ORDER BY COALESCE(data_conclusao, criado_em) DESC, id DESC
         LIMIT 1`,
        [alunoId]
    );

    return rows[0]?.id || null;
}

function montarFocosPrioritarios(focos) {
    const comNecessidade = focos.filter(foco => foco.erros > 0 || foco.percentual < 70);
    const base = comNecessidade.length > 0 ? comNecessidade : focos;

    return base
        .sort((a, b) => (a.percentual - b.percentual) || (b.erros - a.erros))
        .slice(0, 4);
}

async function buscarProfessores() {
    const hojeEmSaoPaulo = getSaoPauloDateTime().slice(0, 10);
    const [professores] = await pool.query(
        `SELECT p.id, p.nome, p.foto, p.descricao, p.status,
                COALESCE(AVG(c.nota), 0) AS avaliacao_media,
                COUNT(DISTINCT c.id) AS num_avaliacoes,
                COUNT(DISTINCT hd.id) AS horarios_disponiveis,
                SUM(CASE WHEN hd.status = 'disponivel' AND hd.data BETWEEN ? AND DATE_ADD(?, INTERVAL 3 DAY) THEN 1 ELSE 0 END) AS horarios_proximos,
                GROUP_CONCAT(DISTINCT d.nome SEPARATOR ', ') AS disciplinas
         FROM professores p
         LEFT JOIN disciplinas d ON d.professor_id = p.id
         LEFT JOIN comentarios c ON c.professor_id = p.id
         LEFT JOIN horarios_disponiveis hd ON hd.professor_id = p.id
              AND hd.status = 'disponivel'
              AND hd.data >= ?
         WHERE p.status = 'disponivel'
           AND p.aprovacao_status = 'approved'
         GROUP BY p.id, p.nome, p.foto, p.descricao, p.status
         ORDER BY p.nome ASC`,
        [hojeEmSaoPaulo, hojeEmSaoPaulo, hojeEmSaoPaulo]
    );

    return professores.map(professor => ({
        ...professor,
        avaliacao_media: Number(professor.avaliacao_media || 0),
        num_avaliacoes: Number(professor.num_avaliacoes || 0),
        horarios_disponiveis: Number(professor.horarios_disponiveis || 0),
        horarios_proximos: Number(professor.horarios_proximos || 0),
        disciplinas: professor.disciplinas ? professor.disciplinas.split(', ') : []
    }));
}

function pontuarProfessor(professor, focosPrioritarios) {
    const textoProfessor = [professor.nome, professor.descricao, ...(professor.disciplinas || [])].join(' ');
    const termosProfessor = new Set(extrairTermos(textoProfessor));
    let pontuacaoFocos = 0;
    const focosComMatch = [];

    let bonusDisciplina = 0;
    const disciplinasNorm = (professor.disciplinas || [])
        .map(d => normalizarTexto(d))
        .filter(d => d.length > 0);

    focosPrioritarios.forEach((foco, index) => {
        const pesoPrioridade = Math.max(1, focosPrioritarios.length - index);
        const descNorm = normalizarTexto(foco.descricao || '');
        const codigoNorm = normalizarTexto(foco.codigo || '');

        if (disciplinasNorm.length > 0) {
            const matchDisciplina = disciplinasNorm.some(disciplina => {
                if (!disciplina) return false;
                if (descNorm.includes(disciplina)) return true;
                const primeiraPalavra = descNorm.split(' ')[0];
                if (primeiraPalavra && disciplina.includes(primeiraPalavra)) return true;
                if (codigoNorm && disciplina.includes(codigoNorm)) return true;
                return false;
            });

            if (matchDisciplina) {
                bonusDisciplina += 8 * pesoPrioridade;
            }
        }

        const termosFoco = extrairTermos(`${foco.codigo || ''} ${foco.descricao || ''}`);
        const matches = termosFoco.filter(termo => termosProfessor.has(termo));

        if (matches.length > 0) {
            pontuacaoFocos += Math.min(32, matches.length * 8) * pesoPrioridade;
            focosComMatch.push(foco);
        }
    });

    const notaNormalizada = professor.avaliacao_media > 0 ? professor.avaliacao_media : 4;
    const pontuacaoAvaliacao = Math.min(25, notaNormalizada * 5);
    const pontuacaoDisponibilidade = Math.min(15, (professor.horarios_disponiveis || 0) * 3);
    const bonusProximos = Math.min(12, (professor.horarios_proximos || 0) * 4);
    const pontuacaoStatus = professor.status === 'disponivel' ? 10 : 0;
    const pontuacaoConteudo = focosPrioritarios.length > 0 ? (pontuacaoFocos || 12) : 12;

    let bonusPerfil = 0;
    if (professor.foto) bonusPerfil += 2;
    if (professor.descricao && professor.descricao.trim().length > 20) bonusPerfil += 3;
    if ((professor.disciplinas || []).length > 0) bonusPerfil += 3;

    return {
        score: Math.round(pontuacaoConteudo + pontuacaoAvaliacao + pontuacaoDisponibilidade + pontuacaoStatus + bonusDisciplina + bonusPerfil + bonusProximos),
        focosComMatch
    };
}

function montarMotivos(professor, focosComMatch, focosPrioritarios, professorChatsCount = 0, agendamentoInfo = null) {
    const motivos = [];

    if (agendamentoInfo && (agendamentoInfo.concluidos || 0) > 0) {
        motivos.push('Já teve aula com este professor.');
    }

    if (focosComMatch.length > 0) {
        motivos.push(`Foco em ${focosComMatch.slice(0, 2).map(foco => foco.descricao).join(' e ')}.`);
    } else if (focosPrioritarios.length > 0) {
        motivos.push(`Pode ajudar no reforço de ${focosPrioritarios[0].descricao}.`);
    } else {
        motivos.push('Boa opção para acompanhamento geral em matemática.');
    }

    if ((professor.horarios_proximos || 0) > 0) {
        motivos.push(`${professor.horarios_proximos} horário(s) nos próximos 3 dias.`);
    } else if ((professor.horarios_disponiveis || 0) > 0) {
        motivos.push(`${professor.horarios_disponiveis} horário(s) disponível(is) para agendamento.`);
    }

    if (professor.avaliacao_media > 0) {
        motivos.push(`Avaliação média ${professor.avaliacao_media.toFixed(1)} de 5.`);
    }

    if (professorChatsCount > 0 && !(agendamentoInfo && (agendamentoInfo.concluidos || 0) > 0)) {
        motivos.push(`Você já trocou ${professorChatsCount} mensagem(s) com este professor.`);
    }

    return motivos;
}

async function recomendarProfessoresParaAluno(alunoId, opcoes = {}) {
    const tentativaId = opcoes.tentativaId || await buscarUltimaTentativa(alunoId);
    const limite = Number(opcoes.limite || 3);
    const focos = tentativaId ? await buscarFocosPorTentativa(alunoId, tentativaId) : [];
    const focosPrioritarios = montarFocosPrioritarios(focos);
    const professores = await buscarProfessores();

    // Buscar histórico de chats do aluno para enriquecer recomendação
    let historicoChats = [];
    try {
        const chatStore = require('../lib/chatStore');
        if (typeof chatStore.loadMessages === 'function') {
            const allMessages = await chatStore.loadMessages();
            historicoChats = [];
            for (const room in allMessages) {
                if (room.startsWith('global')) continue;
                const roomParts = room.replace('chat_', '').split('-');
                if (roomParts.includes(String(alunoId))) {
                    const msgs = allMessages[room] || [];
                    if (msgs.length > 0) {
                        const partnerId = roomParts.find(id => id !== String(alunoId));
                        historicoChats.push({ professor_id: partnerId ? Number(partnerId) : null, count: msgs.length });
                    }
                }
            }
            // Agrupar por professor
            const grouped = {};
            historicoChats.forEach(h => {
                if (!h.professor_id) return;
                grouped[h.professor_id] = (grouped[h.professor_id] || 0) + 1;
            });
            historicoChats = Object.keys(grouped).map(pid => ({ professor_id: Number(pid), count: grouped[pid] }));
        }
    } catch (err) {
        historicoChats = [];
    }

    // Buscar histórico de agendamentos do aluno
    let agendamentosPorProfessor = {};
    try {
        const [agendamentos] = await pool.query(
            `SELECT professor_id,
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'concluido' THEN 1 ELSE 0 END) AS concluidos,
                    SUM(CASE WHEN status IN ('agendado','pendente','aguardando_confirmacao') THEN 1 ELSE 0 END) AS ativos
             FROM agendamentos
             WHERE aluno_id = ?
             GROUP BY professor_id`,
            [alunoId]
        );

        agendamentos.forEach(item => {
            agendamentosPorProfessor[item.professor_id] = {
                total: Number(item.total || 0),
                concluidos: Number(item.concluidos || 0),
                ativos: Number(item.ativos || 0)
            };
        });
    } catch (err) {
        agendamentosPorProfessor = {};
    }

    const recomendacoesOrdenadas = professores
        .map(professor => {
            const pontuacao = pontuarProfessor(professor, focosPrioritarios);

            let bonusChats = 0;
            const professorChats = historicoChats.filter(chat =>
                chat.professor_id && chat.professor_id === professor.id
            );
            if (professorChats.length > 0) {
                bonusChats = Math.min(20, Math.round(professorChats.length * 3));
            }

            let bonusAgendamentos = 0;
            const agendamentoInfo = agendamentosPorProfessor[professor.id];
            if (agendamentoInfo) {
                if (agendamentoInfo.concluidos > 0) {
                    bonusAgendamentos += 25;
                    if (agendamentoInfo.concluidos >= 2) {
                        bonusAgendamentos += 10;
                    }
                } else if (agendamentoInfo.ativos > 0) {
                    bonusAgendamentos += 8;
                } else if (agendamentoInfo.total > 0) {
                    bonusAgendamentos += 4;
                }
            }

            const scoreFinal = pontuacao.score + bonusChats + bonusAgendamentos;

            return {
                ...professor,
                score: scoreFinal,
                motivos: montarMotivos(professor, pontuacao.focosComMatch, focosPrioritarios, professorChats.length, agendamentoInfo)
            };
        })
        .sort((a, b) => {
            const scoreDiff = b.score - a.score;
            if (scoreDiff !== 0) return scoreDiff;
            const mediaDiff = b.avaliacao_media - a.avaliacao_media;
            if (mediaDiff !== 0) return mediaDiff;
            return (b.horarios_proximos || 0) - (a.horarios_proximos || 0) || (b.horarios_disponiveis || 0) - (a.horarios_disponiveis || 0);
        });

    const recomendacoes = [];
    const disciplinasUsadas = new Set();

    for (let i = 0; i < recomendacoesOrdenadas.length && recomendacoes.length < limite; i++) {
        const prof = recomendacoesOrdenadas[i];
        const discPrincipal = (prof.disciplinas && prof.disciplinas[0])
            ? normalizarTexto(prof.disciplinas[0])
            : 'geral';

        if (recomendacoes.length >= 2 && disciplinasUsadas.has(discPrincipal) && discPrincipal !== 'geral') {
            continue;
        }

        recomendacoes.push(prof);
        disciplinasUsadas.add(discPrincipal);
    }

    if (recomendacoes.length < limite) {
        for (let i = 0; i < recomendacoesOrdenadas.length && recomendacoes.length < limite; i++) {
            const prof = recomendacoesOrdenadas[i];
            if (recomendacoes.find(r => r.id === prof.id)) continue;
            recomendacoes.push(prof);
        }
    }

    return {
        tentativaId,
        focos: focosPrioritarios,
        recomendacoes
    };
}

module.exports = {
    recomendarProfessoresParaAluno
};