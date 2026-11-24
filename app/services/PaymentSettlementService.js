const pool = require('../../config/pool');
const PlatformConfigService = require('./PlatformConfigService');

const PaymentSettlementService = {
  async settleApprovedPayment({ checkoutId, preferenceId, paymentId, professorId, salaId }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const conditions = [];
      const params = [];
      if (checkoutId) {
        conditions.push('checkout_id = ?');
        params.push(checkoutId);
      }
      if (preferenceId) {
        conditions.push('preference_id = ?');
        params.push(preferenceId);
      }
      if (paymentId) {
        conditions.push('payment_id = ?');
        params.push(paymentId);
      }
      if (conditions.length === 0) {
        throw new Error('Identificador do pagamento ausente.');
      }

      const [payments] = await connection.query(
        `SELECT * FROM pagamentos WHERE ${conditions.join(' OR ')} LIMIT 1 FOR UPDATE`,
        params
      );
      if (payments.length === 0) {
        await connection.rollback();
        return null;
      }

      const payment = payments[0];
      const resolvedPaymentId = paymentId || payment.payment_id || null;
      const resolvedPreferenceId = preferenceId || payment.preference_id || null;

      // IDEMPOTENCY CHECK: Se o pagamento jÃ¡ foi processado, nÃ£o faz nada.
      if (payment.status === 'pago') {
        let existingPayout = null;
        if (payment.professor_id) {
          const transactionReference = resolvedPaymentId || `preference:${resolvedPreferenceId}`;
          const [existingPayouts] = await connection.query(
            'SELECT id FROM repasses WHERE referencia_transacao = ? LIMIT 1 FOR UPDATE',
            [transactionReference]
          );
          existingPayout = existingPayouts[0] || null;
        }
        await connection.commit();
        console.log(`[PaymentSettlement] Ignorando pagamento já liquidado: ${payment.id}`);
        return {
          pagamentoId: payment.id,
          repasseId: existingPayout?.id || null,
          professorId: payment.professor_id || null,
          valor_bruto: Number(payment.valor),
          alreadySettled: true
        };
      }

      const professor = payment.professor_id || professorId || null;

      // Pagamento sem professor (ex.: Passe de Estudos) = receita integral da plataforma, sem repasse.
      if (!professor) {
        const valor = Number(payment.valor || 0);
        await connection.query(
          `UPDATE pagamentos
           SET payment_id = COALESCE(?, payment_id),
               pago_em = COALESCE(pago_em, CURRENT_TIMESTAMP),
               status = 'pago',
               taxa_plataforma = CASE WHEN taxa_plataforma = 0 THEN ? ELSE taxa_plataforma END,
               valor_liquido = CASE WHEN liberado_em IS NULL THEN 0 ELSE valor_liquido END,
               liberado_em = COALESCE(liberado_em, CURRENT_TIMESTAMP)
           WHERE id = ?`,
          [resolvedPaymentId, valor, payment.id]
        );
        await connection.commit();
        return {
          pagamentoId: payment.id,
          repasseId: null,
          professorId: null,
          valor_bruto: valor,
          platformRevenue: true,
          alreadySettled: false
        };
      }

      await connection.query(
        `UPDATE pagamentos
         SET payment_id = COALESCE(?, payment_id),
             sala = COALESCE(?, sala),
             professor_id = ?,
             pago_em = COALESCE(pago_em, CURRENT_TIMESTAMP),
             status = 'pago'
         WHERE id = ?`,
        [resolvedPaymentId, salaId || null, professor, payment.id]
      );

      const transactionReference = resolvedPaymentId || `preference:${resolvedPreferenceId}`;
      const [existingPayouts] = await connection.query(
        'SELECT id FROM repasses WHERE referencia_transacao = ? LIMIT 1 FOR UPDATE',
        [transactionReference]
      );
      let payoutId = existingPayouts[0]?.id || null;
      if (!payoutId) {
        const [result] = await connection.query(
          `INSERT INTO repasses (professor_id, valor, status, referencia_transacao, metodo_pagamento)
           VALUES (?, ?, 'retido', ?, 'mercadopago')`,
          [professor, payment.valor, transactionReference]
        );
        payoutId = result.insertId;
      }

      await connection.commit();
      return {
        pagamentoId: payment.id,
        repasseId: payoutId,
        professorId: professor,
        valor_bruto: Number(payment.valor),
        alreadySettled: false
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async releaseCompletedAppointment(agendamentoId) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [appointments] = await connection.query(
        `SELECT id, sala_id, professor_id FROM agendamentos
         WHERE id = ? AND status = 'concluido'
         FOR UPDATE`,
        [agendamentoId]
      );
      if (appointments.length === 0) {
        await connection.rollback();
        return [];
      }

      const appointment = appointments[0];
      const [payments] = await connection.query(
        `SELECT p.* FROM pagamentos p
         WHERE p.sala = ? AND p.status = 'pago'
         FOR UPDATE`,
        [appointment.sala_id]
      );
      const released = [];

      for (const payment of payments) {
        if (payment.liberado_em) continue;

        const calculation = await PlatformConfigService.calcularTaxaPlataforma(payment.valor);
        const transactionReference = payment.payment_id || `preference:${payment.preference_id}`;
        const [payouts] = await connection.query(
          'SELECT id, status FROM repasses WHERE referencia_transacao = ? LIMIT 1 FOR UPDATE',
          [transactionReference]
        );
        let payoutId;

        if (payouts.length > 0) {
          payoutId = payouts[0].id;
          if (payouts[0].status === 'retido') {
            await connection.query(
              `UPDATE repasses SET valor = ?, status = 'pendente'
               WHERE id = ? AND status = 'retido'`,
              [calculation.valor_liquido, payoutId]
            );
          }
        } else {
          const [result] = await connection.query(
            `INSERT INTO repasses (professor_id, valor, status, referencia_transacao, metodo_pagamento)
             VALUES (?, ?, 'pendente', ?, 'mercadopago')`,
            [appointment.professor_id, calculation.valor_liquido, transactionReference]
          );
          payoutId = result.insertId;
        }

        await connection.query(
          `UPDATE pagamentos
           SET taxa_plataforma = ?, valor_liquido = ?, liberado_em = CURRENT_TIMESTAMP
           WHERE id = ? AND liberado_em IS NULL`,
          [calculation.taxa_plataforma, calculation.valor_liquido, payment.id]
        );
        released.push({
          pagamentoId: payment.id,
          repasseId: payoutId,
          taxa_plataforma: calculation.taxa_plataforma,
          valor_liquido: calculation.valor_liquido
        });
      }

      await connection.commit();
      return released;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async releaseCompletedAppointments() {
    const [appointments] = await pool.query(
      `SELECT DISTINCT ag.id
       FROM agendamentos ag
       JOIN pagamentos p ON p.sala = ag.sala_id
       WHERE ag.status = 'concluido'
         AND p.status = 'pago'
         AND p.liberado_em IS NULL`
    );
    for (const appointment of appointments) {
      try {
        await this.releaseCompletedAppointment(appointment.id);
      } catch (error) {
        console.error(`Erro ao liberar pagamento da aula concluída ${appointment.id}:`, error);
      }
    }
  },

  async autoPagarRepassesDisponiveis() {
    const [result] = await pool.query(
      `UPDATE repasses r
       JOIN pagamentos p ON p.payment_id = r.referencia_transacao
       JOIN agendamentos ag ON ag.sala_id = p.sala
       SET r.status = 'pago', r.data_pagamento = NOW()
       WHERE r.status = 'pendente'
         AND ag.status = 'concluido'
         AND p.status = 'pago'
         AND p.liberado_em IS NOT NULL
         AND p.liberado_em <= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
         AND r.professor_id = ag.professor_id
         AND r.valor = p.valor_liquido`
    );
    return result.affectedRows || 0;
  }
};

module.exports = PaymentSettlementService;
