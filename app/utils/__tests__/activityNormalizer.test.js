'use strict';

const { normalizeActivityQuestions } = require('../activityNormalizer');

describe('normalizeActivityQuestions', () => {
  test('uses multiple choice when alternatives are present, even if the source says short text', () => {
    const [question] = normalizeActivityQuestions({
      questions: [{
        title: 'Quanto é 2 + 2?',
        type: 'short_text',
        options: ['3', '4', '5', '6'],
        correct: '2'
      }]
    });

    expect(question.type).toBe('multiple_choice');
    expect(question.options).toEqual({ A: '3', B: '4', C: '5', D: '6' });
  });

  test('preserves written question types when there are no alternatives', () => {
    const [question] = normalizeActivityQuestions({
      questions: [{ title: 'Explique sua resposta.', type: 'long_text' }]
    });

    expect(question.type).toBe('long_text');
    expect(question.options).toBeNull();
  });
});
