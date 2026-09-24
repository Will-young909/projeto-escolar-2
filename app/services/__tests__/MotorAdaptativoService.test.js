jest.mock('../../../config/pool', () => ({ query: jest.fn() }));
jest.mock('../../models/CurriculoAlunoModel', () => ({}));

const pool = require('../../../config/pool');
const MotorAdaptativoService = require('../MotorAdaptativoService');

describe('MotorAdaptativoService question pool', () => {
  beforeEach(() => jest.clearAllMocks());

  test('selects only questions never answered in diagnostic or trail history', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 22, dificuldade: 'medio' }]]);

    const question = await MotorAdaptativoService.selecionarQuestaoInedita('aluno-1', 7, 'medio');

    const [sql, params] = pool.query.mock.calls[0];
    expect(question).toEqual({ id: 22, dificuldade: 'medio' });
    expect(sql).toContain('historico_questoes');
    expect(sql).toContain('respostas_teste');
    expect(sql).toContain('tentativas_teste');
    expect(params).toEqual([7, ['medio', 'facil', 'dificil'], 'aluno-1', 'aluno-1', 'medio', 'facil', 'dificil']);
  });
});
