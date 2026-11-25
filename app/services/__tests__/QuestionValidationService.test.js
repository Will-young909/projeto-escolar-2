'use strict';

const QuestionValidationService = require('../QuestionValidationService');

describe('QuestionValidationService generated questions', () => {
  test('validates a numeric fraction applied to a quantity', () => {
    const report = QuestionValidationService.validar({
      title: 'Quanto é 3/4 de 80?',
      habilidade: 'Frações',
      dificuldade: 'facil',
      options: ['40', '80', '60', '45'],
      correct: '3'
    });

    expect(report.valid).toBe(true);
    expect(report.calculatedAnswer).toBe('60');
  });

  test('calculates the side from a square perimeter when the question asks for the side', () => {
    const report = QuestionValidationService.validar({
      title: 'O perímetro de um quadrado mede 48 cm. Qual é a medida do lado desse quadrado?',
      habilidade: 'Geometria: Perímetro',
      dificuldade: 'facil',
      options: ['10 cm', '16 cm', '14 cm', '12 cm'],
      correct: '4'
    });

    expect(report.valid).toBe(true);
    expect(report.calculatedAnswer).toBe('12');
  });

  test('still calculates the perimeter when the side length is given', () => {
    const answer = QuestionValidationService.determinarResposta(
      'Qual é o perímetro de um quadrado com lado de 12 cm?',
      'Geometria: Perímetro'
    );

    expect(answer.ok).toBe(true);
    expect(answer.valor).toBe('48');
  });
});
