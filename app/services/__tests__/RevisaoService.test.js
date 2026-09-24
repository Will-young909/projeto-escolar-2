jest.mock('../../../config/pool', () => ({ query: jest.fn() }));

const pool = require('../../../config/pool');
const RevisaoService = require('../RevisaoService');

describe('RevisaoService', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    [null, true, 1],
    [{ fator_facilidade: 2.5, intervalo_dias: 1 }, true, 3],
    [{ fator_facilidade: 2.5, intervalo_dias: 3 }, true, 7],
    [{ fator_facilidade: 2.5, intervalo_dias: 7 }, true, 14],
    [{ fator_facilidade: 2.5, intervalo_dias: 14 }, true, 30],
    [{ fator_facilidade: 2.5, intervalo_dias: 14 }, false, 1]
  ])('uses interval %s and success %s to schedule %i days', async (current, acertou, expectedInterval) => {
    pool.query.mockResolvedValueOnce([[current].filter(Boolean)]).mockResolvedValueOnce([{}]);

    await RevisaoService.agendarProximaRevisao('aluno-1', 12, acertou);

    const [, values] = pool.query.mock.calls[1];
    expect(values[4]).toBe(expectedInterval);
  });
});
