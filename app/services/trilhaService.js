const pool = require('../../config/pool');

const RULES = {
  reforco: { min: 0, max: 39.99 },
  pratica: { min: 40, max: 70 },
  avanco: { min: 70.01, max: 100 }
};

function nivelPorPercentual(percentual) {
  if (percentual <= RULES.reforco.max) return 'reforco';
  if (percentual <= RULES.pratica.max) return 'pratica';
  return 'avanco';
}

function planoPorNivel(nivel) {
  if (nivel === 'reforco') return { facil: 3, medio: 2, dificil: 1 };
  if (nivel === 'pratica') return { facil: 2, medio: 3, dificil: 1 };
  return { facil: 1, medio: 3, dificil: 2 };
}

async function salvarResumoPorHabilidade({ tentativaId, alunoId }) {
  const [rows] = await pool.query(
    `SELECT habilidade,
            SUM(CASE WHEN acertou = 1 THEN 1 ELSE 0 END) AS acertos,
            SUM(CASE WHEN acertou = 0 THEN 1 ELSE 0 END) AS erros,
            COUNT(*) AS total
       FROM respostas_teste
      WHERE tentativa_id = ?
        AND habilidade IS NOT NULL
      GROUP BY habilidade`,
    [tentativaId]
  );

  for (const row of rows) {
    const total = Number(row.total || 0);
    const acertos = Number(row.acertos || 0);
    const erros = Number(row.erros || 0);
    const percentual = total ? Number(((acertos / total) * 100).toFixed(2)) : 0;
    const nivel = nivelPorPercentual(percentual);

    await pool.query(
      `INSERT INTO resultado_habilidade
         (tentativa_id, aluno_id, habilidade, acertos, erros, percentual, nivel)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tentativaId, alunoId, row.habilidade, acertos, erros, percentual, nivel]
    );
  }

  return rows.length;
}

async function gerarTrilhaDaTentativa({ alunoId, tentativaId }) {
  await pool.query('START TRANSACTION');
  try {
    const [trilhaInsert] = await pool.query(
      'INSERT INTO trilhas (aluno_id, tentativa_origem_id) VALUES (?, ?)',
      [alunoId, tentativaId]
    );
    const trilhaId = trilhaInsert.insertId;

    const [habilidades] = await pool.query(
      `SELECT habilidade, nivel, percentual
         FROM resultado_habilidade
        WHERE tentativa_id = ?
          AND aluno_id = ?
        ORDER BY percentual ASC`,
      [tentativaId, alunoId]
    );

    let ordem = 1;

    for (const hab of habilidades) {
      const plano = planoPorNivel(hab.nivel);

      for (const [dificuldade, quantidade] of Object.entries(plano)) {
        if (quantidade <= 0) continue;

        const [questoes] = await pool.query(
          `SELECT id
             FROM questoes
            WHERE habilidade = ?
              AND dificuldade = ?
            ORDER BY RAND()
            LIMIT ?`,
          [hab.habilidade, dificuldade, quantidade]
        );

        for (const q of questoes) {
          await pool.query(
            `INSERT INTO trilha_itens
               (trilha_id, ordem, questao_id, habilidade, dificuldade, bloco)
             VALUES (?, ?, ?, ?, ?, 'pratica')`,
            [trilhaId, ordem, q.id, hab.habilidade, dificuldade]
          );
          ordem += 1;
        }
      }
    }

    await pool.query('COMMIT');
    return { trilhaId, itens: ordem - 1 };
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

async function proximoItemPendente(trilhaId) {
  const [rows] = await pool.query(
    `SELECT ti.*, q.enunciado, q.alternativa_a, q.alternativa_b, q.alternativa_c, q.alternativa_d
       FROM trilha_itens ti
       JOIN questoes q ON q.id = ti.questao_id
      WHERE ti.trilha_id = ?
        AND ti.status = 'pendente'
      ORDER BY ti.ordem ASC
      LIMIT 1`,
    [trilhaId]
  );

  return rows[0] || null;
}

async function responderItemTrilha(itemId, respostaDoAluno) {
  await pool.query('START TRANSACTION');
  try {
    const [itemRows] = await pool.query(
      `SELECT ti.questao_id, q.alternativa_correta
         FROM trilha_itens ti
         JOIN questoes q ON q.id = ti.questao_id
        WHERE ti.id = ? AND ti.status = 'pendente'`,
      [itemId]
    );

    if (itemRows.length === 0) {
      throw new Error('Item da trilha não encontrado ou já foi concluído.');
    }

    const item = itemRows[0];
    const respostaCorreta = item.alternativa_correta.trim().toUpperCase();
    const respostaAlunoFormatada = (respostaDoAluno || '').trim().toUpperCase();

    const acertou = respostaCorreta === respostaAlunoFormatada;
    const acertouBit = acertou ? 1 : 0;

    await pool.query(
      `UPDATE trilha_itens
          SET status = 'concluido',
              concluido_em = NOW(),
              resposta_aluno = ?,
              acertou = ?
        WHERE id = ?`,
      [respostaDoAluno, acertouBit, itemId]
    );

    await pool.query('COMMIT');

    return { acertou };
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Erro ao responder item da trilha:', error);
    throw error;
  }
}

module.exports = {
  nivelPorPercentual,
  salvarResumoPorHabilidade,
  gerarTrilhaDaTentativa,
  proximoItemPendente,
  responderItemTrilha
};