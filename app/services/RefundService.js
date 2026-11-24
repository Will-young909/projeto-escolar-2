const pool = require('../../config/pool');
const { getSaoPauloDateTime } = require('../utils/brasiliaTime');

const ACCEPTED_REFUND_STATUSES = new Set(['approved', 'in_process']);

function toCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Valor de pagamento inválido.');
  }
  return Math.round(amount * 100);
}

function toAmount(cents) {
  return Number((cents / 100).toFixed(2));
}

function getRefundErrorDetails(error) {
  const details = { message: error.message };
  if (error.status !== undefined) details.httpStatus = error.status;
  if (error.error) details.providerCode = error.error;
  if (Array.isArray(error.causes)) {
    details.causes = error.causes.map(cause => ({
      code: cause.code,
      description: cause.description
    }));
  }
  return details;
}

const RefundService = {
  async listarAulasNaoRealizadas({ userType, userId }) {
    if (!['professor', 'aluno', 'system'].includes(userType) || (userType !== 'system' && !userId)) {
      throw new Error('Usuário inválido para processar aulas não realizadas.');
    }
    const userColumn = userType === 'professor' ? 'ag.professor_id' : 'ag.aluno_id';
    const filter = userType === 'system' ? '' : `AND ${userColumn} = ?`;
    const params = [getSaoPauloDateTime()];
    if (userType !== 'system') params.push(userId);
    const [appointments] = await pool.query(
      `SELECT ag.id, ag.sala_id, ag.aluno_id, ag.professor_id, ag.data, ag.hora,
              h.hora_fim, al.nome as aluno_nome, prof.nome as professor_nome,
              COUNT(p.payment_id) as pagamentos_aprovados,
              COALESCE(SUM(p.valor), 0) as valor_bruto
       FROM agendamentos ag
       JOIN horarios_disponiveis h ON h.id = ag.horario_id
       JOIN alunos al ON al.id = ag.aluno_id
       JOIN professores prof ON prof.id = ag.professor_id
       LEFT JOIN (
         SELECT sala, payment_id, MAX(valor) as valor
         FROM pagamentos
         WHERE status = 'pago'
         GROUP BY sala, payment_id
       ) p ON p.sala = ag.sala_id
       WHERE ag.status = 'ativo'
         AND TIMESTAMP(ag.data, h.hora_fim) < ?
         AND NOT (ag.aluno_entrou_em IS NOT NULL AND ag.professor_entrou_em IS NOT NULL)
         ${filter}
       GROUP BY ag.id, ag.sala_id, ag.aluno_id, ag.professor_id, ag.data, ag.hora,
                h.hora_fim, al.nome, prof.nome
       ORDER BY ag.data, ag.hora`,
      params
    );
    return appointments;
  },

  async processarAulasNaoRealizadas({ userType, userId, refundClient, paymentClient }) {
    if (!refundClient || !paymentClient) {
      throw new Error('Clientes de pagamento e reembolso do Mercado Pago não estão configurados.');
    }
    const appointments = await this.listarAulasNaoRealizadas({ userType, userId });
    const results = [];
    for (const appointment of appointments) {
      try {
        results.push(await this.processarAgendamento(appointment.id, refundClient, paymentClient));
      } catch (error) {
        console.error(`Erro ao reembolsar o agendamento ${appointment.id}:`, error);
        results.push({ agendamentoId: appointment.id, error: error.message });
      }
    }
    return results;
  },

  async processarAgendamento(agendamentoId, refundClient, paymentClient) {
    const connection = await pool.getConnection();
    let refund;
    let payments;
    let appointment;

    try {
      await connection.beginTransaction();

      const [appointments] = await connection.query(
        `SELECT ag.*
         FROM agendamentos ag
         JOIN horarios_disponiveis h ON h.id = ag.horario_id
         WHERE ag.id = ? AND ag.status = 'ativo'
           AND TIMESTAMP(ag.data, h.hora_fim) < ?
           AND NOT (ag.aluno_entrou_em IS NOT NULL AND ag.professor_entrou_em IS NOT NULL)
         FOR UPDATE`,
        [agendamentoId, getSaoPauloDateTime()]
      );
      if (appointments.length === 0) {
        await connection.rollback();
        return { agendamentoId, cancelada: false, message: 'Aula não está mais elegível para processamento.' };
      }
      appointment = appointments[0];

      const [paymentRows] = await connection.query(
        `SELECT MIN(id) as id, payment_id, MAX(valor) as valor
         FROM pagamentos
         WHERE sala = ? AND status = 'pago'
         GROUP BY payment_id
         ORDER BY MIN(id)`,
        [appointment.sala_id]
      );
      if (paymentRows.length === 0) {
        await connection.rollback();
        return { agendamentoId, error: 'Não há pagamento aprovado vinculado; aula mantida para conferência.' };
      }
      if (paymentRows.some(payment => !payment.payment_id)) {
        await connection.rollback();
        return { agendamentoId, error: 'Existe pagamento sem ID do Mercado Pago; aula mantida para conferência.' };
      }
      if (paymentRows.some(payment => !Number.isFinite(Number(payment.valor)) || Number(payment.valor) <= 0)) {
        await connection.rollback();
        return { agendamentoId, error: 'Existe pagamento com valor inválido; aula mantida para conferência.' };
      }

      const totalGrossCents = paymentRows.reduce((total, payment) => total + toCents(payment.valor), 0);
      const [refundRows] = await connection.query(
        'SELECT id FROM reembolsos WHERE agendamento_id = ? FOR UPDATE',
        [agendamentoId]
      );
      if (refundRows.length > 0) {
        refund = refundRows[0];
      } else {
        const [result] = await connection.query(
          `INSERT INTO reembolsos
            (agendamento_id, aluno_id, professor_id, valor_reembolso, status, tipo, motivo)
           VALUES (?, ?, ?, ?, 'pendente', 'inteiro', ?)`,
          [
            agendamentoId,
            appointment.aluno_id,
            appointment.professor_id,
            toAmount(totalGrossCents),
            'Aula marcada não realizada'
          ]
        );
        refund = { id: result.insertId };
      }

      payments = paymentRows;
      for (const payment of payments) {
        const [refundPayments] = await connection.query(
          'SELECT id FROM reembolso_pagamentos WHERE payment_id = ?',
          [payment.payment_id]
        );
        if (refundPayments.length === 0) {
          await connection.query(
            `INSERT INTO reembolso_pagamentos
              (reembolso_id, payment_id, valor_reembolso, status)
             VALUES (?, ?, ?, 'pendente')`,
            [refund.id, payment.payment_id, Number(payment.valor)]
          );
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const paymentRefunds = [];
    for (const payment of payments) {
      try {
        const [refundRecord] = await pool.query(
          'SELECT * FROM reembolso_pagamentos WHERE payment_id = ?',
          [payment.payment_id]
        );
        if (refundRecord.length === 0) {
          throw new Error(`Registro de estorno ausente para o pagamento ${payment.payment_id}.`);
        }

        const paymentGrossCents = toCents(payment.valor);
        const paymentDetails = await paymentClient.get({ id: payment.payment_id });
        const providerRefunds = Array.isArray(paymentDetails.refunds) ? paymentDetails.refunds : [];
        const acceptedRefunds = providerRefunds.filter(item =>
          ACCEPTED_REFUND_STATUSES.has(item.status)
        );
        const refundedCents = acceptedRefunds.reduce(
          (sum, item) => sum + toCents(item.amount),
          0
        );
        const remainingCents = Math.max(0, paymentGrossCents - refundedCents);
        let providerRefund = acceptedRefunds[acceptedRefunds.length - 1] || null;

        if (remainingCents > 0) {
          const idempotencyKey = `refund-${agendamentoId}-${payment.payment_id}-${remainingCents}`;
          providerRefund = remainingCents === paymentGrossCents
            ? await refundClient.total({
                payment_id: payment.payment_id,
                requestOptions: { idempotencyKey }
              })
            : await refundClient.create({
                payment_id: payment.payment_id,
                body: { amount: toAmount(remainingCents) },
                requestOptions: { idempotencyKey }
              });
        }

        if (remainingCents > 0 && !ACCEPTED_REFUND_STATUSES.has(providerRefund.status)) {
          throw new Error(
            `Mercado Pago retornou status "${providerRefund.status || 'desconhecido'}" para o estorno do pagamento ${payment.payment_id}.`
          );
        }

        const allRefunds = remainingCents > 0
          ? [...acceptedRefunds, providerRefund]
          : acceptedRefunds;
        const paymentRefundStatus = allRefunds.length > 0 &&
          allRefunds.every(item => item.status === 'approved')
          ? 'concluido'
          : 'processando';
        await pool.query(
          `UPDATE reembolso_pagamentos
           SET mercadopago_refund_id = ?, status = ?, data_processamento = NOW()
           WHERE payment_id = ?`,
          [
            providerRefund?.id
              ? String(providerRefund.id)
              : refundRecord[0].mercadopago_refund_id,
            paymentRefundStatus,
            payment.payment_id
          ]
        );
        await pool.query(
          `UPDATE repasses
           SET status = 'estornado'
           WHERE status = 'pendente' AND referencia_transacao = ?`,
          [payment.payment_id]
        );
        paymentRefunds.push({ paymentId: payment.payment_id, status: paymentRefundStatus });
      } catch (error) {
        const errorDetails = getRefundErrorDetails(error);
        await pool.query(
          `UPDATE reembolso_pagamentos
           SET status = CASE WHEN status = 'processando' THEN status ELSE 'recusado' END,
               data_processamento = NOW()
           WHERE payment_id = ? AND status <> 'concluido'`,
          [payment.payment_id]
        );
        paymentRefunds.push({
          paymentId: payment.payment_id,
          error: errorDetails.message,
          httpStatus: errorDetails.httpStatus,
          providerCode: errorDetails.providerCode,
          causes: errorDetails.causes
        });
      }
    }

    const acceptedAll = paymentRefunds.length === payments.length &&
      paymentRefunds.every(item => !item.error);
    if (!acceptedAll) {
      await pool.query(
        `UPDATE reembolsos SET status = 'recusado'
         WHERE id = ? AND status NOT IN ('concluido', 'processando')`,
        [refund.id]
      );
      return {
        agendamentoId,
        cancelada: false,
        valorReembolso: toAmount(payments.reduce((sum, payment) => sum + toCents(payment.valor), 0)),
        paymentRefunds,
        error: 'Nem todos os reembolsos foram aceitos; a aula foi mantida para nova tentativa.'
      };
    }

    const statusReembolso = paymentRefunds.every(item => item.status === 'concluido')
      ? 'concluido'
      : 'processando';
    const finalConnection = await pool.getConnection();
    try {
      await finalConnection.beginTransaction();
      await finalConnection.query(
        `UPDATE reembolsos
         SET status = ?,
             data_processamento = CASE
               WHEN ? = 'concluido' THEN COALESCE(data_processamento, NOW())
               ELSE data_processamento
             END
         WHERE id = ? AND status <> 'concluido'`,
        [statusReembolso, statusReembolso, refund.id]
      );
      await finalConnection.query(
        `UPDATE agendamentos
         SET status = 'cancelado',
             data_cancelamento = NOW(),
             motivo_cancelamento = 'Aula marcada não realizada - reembolso integral solicitado'
         WHERE id = ? AND status = 'ativo'`,
        [agendamentoId]
      );

      await finalConnection.query(
        `UPDATE horarios_disponiveis
         SET status = 'disponivel', aluno_id = NULL
         WHERE id = ? AND status = 'agendado'`,
        [appointment.horario_id]
      );

      const paymentIds = payments.map(payment => payment.payment_id);
      const placeholders = paymentIds.map(() => '?').join(', ');
      await finalConnection.query(
        `UPDATE pagamentos
         SET status = 'reembolsado', taxa_plataforma = 0, valor_liquido = 0
         WHERE payment_id IN (${placeholders})`,
        paymentIds
      );
      await finalConnection.query(
        `UPDATE repasses
         SET status = 'estornado'
         WHERE status IN ('pendente', 'retido') AND referencia_transacao IN (${placeholders})`,
        paymentIds
      );
      await finalConnection.commit();
    } catch (error) {
      await finalConnection.rollback();
      throw error;
    } finally {
      finalConnection.release();
    }

    return {
      agendamentoId,
      cancelada: true,
      alunoId: appointment.aluno_id,
      professorId: appointment.professor_id,
      valorReembolso: toAmount(payments.reduce((sum, payment) => sum + toCents(payment.valor), 0)),
      status: statusReembolso,
      paymentRefunds
    };
  }
};

module.exports = RefundService;
