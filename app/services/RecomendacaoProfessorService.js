const pool = require('../../config/pool');

const STOP_WORDS = new Set([
    'a', 'ao', 'aos', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos',
    'o', 'os', 'para', 'por', 'um', 'uma', 'sobre', 'matematica', 'matemática', 'habilidade', 'questao', 'questão'
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
    const [professores] = await pool.query(
        `SELECT p.id, p.nome, p.foto, p.descricao, p.status,
                COALESCE(AVG(c.nota), 0) AS avaliacao_media,
                COUNT(DISTINCT c.id) AS num_avaliacoes,
                COUNT(DISTINCT hd.id) AS horarios_disponiveis,
                GROUP_CONCAT(DISTINCT d.nome SEPARATOR ', ') AS disciplinas
         FROM professores p
         LEFT JOIN disciplinas d ON d.professor_id = p.id
         LEFT JOIN comentarios c ON c.professor_id = p.id
         LEFT JOIN horarios_disponiveis hd ON hd.professor_id = p.id
              AND hd.status = 'disponivel'
              AND hd.data >= CURDATE()
         WHERE p.status = 'disponivel'
         GROUP BY p.id, p.nome, p.foto, p.descricao, p.status
         ORDER BY p.nome ASC`
    );

    return professores.map(professor => ({
        ...professor,
        avaliacao_media: Number(professor.avaliacao_media || 0),
        num_avaliacoes: Number(professor.num_avaliacoes || 0),
        horarios_disponiveis: Number(professor.horarios_disponiveis || 0),
        disciplinas: professor.disciplinas ? professor.disciplinas.split(', ') : []
    }));
}

function pontuarProfessor(professor, focosPrioritarios) {
    const textoProfessor = [professor.nome, professor.descricao, ...professor.disciplinas].join(' ');
    const termosProfessor = new Set(extrairTermos(textoProfessor));
    let pontuacaoFocos = 0;
    const focosComMatch = [];

    focosPrioritarios.forEach((foco, index) => {
        const pesoPrioridade = Math.max(1, focosPrioritarios.length - index);
        const termosFoco = extrairTermos(`${foco.codigo} ${foco.descricao}`);
        const matches = termosFoco.filter(termo => termosProfessor.has(termo));

        if (matches.length > 0) {
            pontuacaoFocos += Math.min(32, matches.length * 8) * pesoPrioridade;
            focosComMatch.push(foco);
        }
    });

    const notaNormalizada = professor.avaliacao_media > 0 ? professor.avaliacao_media : 4;
    const pontuacaoAvaliacao = Math.min(25, notaNormalizada * 5);
    const pontuacaoDisponibilidade = Math.min(15, professor.horarios_disponiveis * 3);
    const pontuacaoStatus = professor.status === 'disponivel' ? 10 : 0;
    const pontuacaoConteudo = focosPrioritarios.length > 0 ? pontuacaoFocos : 12;

    return {
        score: Math.round(pontuacaoConteudo + pontuacaoAvaliacao + pontuacaoDisponibilidade + pontuacaoStatus),
        focosComMatch
    };
}

function montarMotivos(professor, focosComMatch, focosPrioritarios) {
    const motivos = [];

    if (focosComMatch.length > 0) {
        motivos.push(`Combina com ${focosComMatch.slice(0, 2).map(foco => foco.descricao).join(' e ')}.`);
    } else if (focosPrioritarios.length > 0) {
        motivos.push(`Pode ajudar no reforço de ${focosPrioritarios[0].descricao}.`);
    } else {
        motivos.push('Boa opção para acompanhamento geral em matemática.');
    }

    if (professor.horarios_disponiveis > 0) {
        motivos.push(`${professor.horarios_disponiveis} horário(s) disponível(is) para agendamento.`);
    }

    if (professor.avaliacao_media > 0) {
        motivos.push(`Avaliação média ${professor.avaliacao_media.toFixed(1)} de 5.`);
    }

    return motivos;
}

async function recomendarProfessoresParaAluno(alunoId, opcoes = {}) {
    const tentativaId = opcoes.tentativaId || await buscarUltimaTentativa(alunoId);
    const limite = Number(opcoes.limite || 3);
    const focos = tentativaId ? await buscarFocosPorTentativa(alunoId, tentativaId) : [];
    const focosPrioritarios = montarFocosPrioritarios(focos);
    const professores = await buscarProfessores();

    const recomendacoes = professores
        .map(professor => {
            const pontuacao = pontuarProfessor(professor, focosPrioritarios);
            return {
                ...professor,
                score: pontuacao.score,
                motivos: montarMotivos(professor, pontuacao.focosComMatch, focosPrioritarios)
            };
        })
        .sort((a, b) => (b.score - a.score) || (b.avaliacao_media - a.avaliacao_media) || (b.horarios_disponiveis - a.horarios_disponiveis))
        .slice(0, limite);

    return {
        tentativaId,
        focos: focosPrioritarios,
        recomendacoes
    };
}

module.exports = {
    recomendarProfessoresParaAluno
};
