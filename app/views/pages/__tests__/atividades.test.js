'use strict';

const path = require('path');
const ejs = require('ejs');

describe('atividades view math preview', () => {
  test('provides a MathJax preview for inline dollar-delimited expressions', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../atividades.ejs'), {
      activity: {
        id: 'editor-test',
        title: 'Teste',
        description: 'Teste',
        questions: [{
          title: 'Quanto é $2^3 + 5 \\cdot (4 - 2)$?',
          type: 'multiple_choice',
          options: { '1': '3', '2': '4', '3': '5', '4': '6' },
          correct: 'B'
        }]
      }
    });

    expect(html).toContain('mathjax@3');
    expect(html).toContain('inlineMath:');
    expect(html).toContain('question-math-preview');
    expect(html).toContain('2^3 + 5');
    expect(html).toContain('cdot (4 - 2)');
  });
});
