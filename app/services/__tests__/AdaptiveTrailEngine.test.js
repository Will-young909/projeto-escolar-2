const Engine = require('../AdaptiveTrailEngine');

describe('AdaptiveTrailEngine', () => {
  test('weights difficult correct answers more heavily when calculating mastery', () => {
    const result = Engine.masteryState({
      history: [
        { acertou: true, dificuldade: 'dificil' },
        { acertou: false, dificuldade: 'facil' }
      ]
    });

    expect(result.percentual).toBeCloseTo(60, 1);
    expect(result.status).toBe('em_desenvolvimento');
  });

  test('changes difficulty by at most one level after consistent results', () => {
    const difficultHistory = [
      { acertou: true, dificuldade: 'facil' },
      { acertou: true, dificuldade: 'facil' }
    ];
    const strugglingHistory = [
      { acertou: false, dificuldade: 'dificil' },
      { acertou: false, dificuldade: 'dificil' }
    ];

    expect(Engine.selectDifficulty({ history: difficultHistory, currentDifficulty: 'facil' })).toBe('medio');
    expect(Engine.selectDifficulty({ history: strugglingHistory, currentDifficulty: 'dificil', status: 'precisa_reforco' })).toBe('medio');
  });

  test('searches the requested difficulty before nearby levels', () => {
    expect(Engine.difficultyPool('facil')).toEqual(['facil', 'medio', 'dificil']);
    expect(Engine.difficultyPool('medio')).toEqual(['medio', 'facil', 'dificil']);
    expect(Engine.difficultyPool('dificil')).toEqual(['dificil', 'medio', 'facil']);
  });

  test('does not redirect to prerequisites marked with the legacy mastered status', () => {
    const decision = Engine.determineNextStep({
      skill: { habilidade_id: 10, percentual_dominio: 60 },
      prerequisites: [{ habilidade_id: 9, status_dominio: 'dominado' }],
      history: [{ acertou: true, dificuldade: 'medio' }]
    });

    expect(decision.action).not.toBe('prerequisito');
    expect(Engine.isMastered('dominado')).toBe(true);
    expect(Engine.isMastered('dominada')).toBe(true);
  });

  test('sends recurring recent errors to reinforcement', () => {
    const decision = Engine.determineNextStep({
      skill: { habilidade_id: 3, percentual_dominio: 40 },
      history: [
        { acertou: false, dificuldade: 'medio' },
        { acertou: false, dificuldade: 'medio' }
      ],
      currentDifficulty: 'medio'
    });

    expect(decision).toMatchObject({ action: 'reforco', etapa: 'reforco', difficulty: 'facil' });
  });

  test('ends a dynamic activity only after enough consistent evidence', () => {
    const evidence = [
      { acertou: true, dificuldade: 'facil' },
      { acertou: true, dificuldade: 'medio' },
      { acertou: true, dificuldade: 'medio' }
    ];

    expect(Engine.shouldEndActivity({ history: evidence.slice(0, 2), consecutiveCorrect: 2, recentAccuracy: 100 })).toBe(false);
    expect(Engine.shouldEndActivity({ history: evidence, consecutiveCorrect: 3, recentAccuracy: 100 })).toBe(true);
  });
});
