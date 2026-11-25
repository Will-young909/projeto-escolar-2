'use strict';

const path = require('path');
const ejs = require('ejs');

describe('ver_atividade view', () => {
  test('wires both cancel buttons to close their modals', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../ver_atividade.ejs'), {
      activity: {
        id: 'test-activity',
        title: 'Teste',
        description: 'Teste',
        questions: []
      },
      user: { tipo: 'aluno' },
      session: {},
      usouPasseNaAtividade: false,
      passeDisponivel: { passeAtivo: true },
      hintsUnlocked: false
    });

    expect(html).toContain('>Agora não</button>');
    expect(html).toContain('>Continuar sem dica</button>');
    expect(html).toContain(
      "backdrop.querySelectorAll('.close-button, .btn-cancel').forEach(button => {"
    );
  });

  test('renders alternatives whenever they exist, regardless of the question type', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../ver_atividade.ejs'), {
      activity: {
        id: 'test-activity',
        title: 'Teste',
        description: 'Teste',
        isTest: true,
        questions: [{
          title: 'Quanto é $2^3 + 5 \\cdot (4 - 2)$?',
          type: 'short_text',
          options: { A: '3', B: '4', C: '5', D: '6' },
          correct: 'B'
        }]
      },
      user: null,
      session: {},
      usouPasseNaAtividade: false,
      passeDisponivel: { passeAtivo: false },
      hintsUnlocked: false
    });

    expect(html.match(/type="radio" name="answers\[0\]"/g)).toHaveLength(4);
    expect(html).toMatch(/>\s*3\s*<\/span>/);
    expect(html).toMatch(/>\s*4\s*<\/span>/);
    expect(html).not.toContain('Digite sua resposta curta');
    expect(html).toContain('class="math-content"');
    expect(html).toContain('mathjax@3');
    expect(html).toContain('$2^3 + 5 \\cdot (4 - 2)$');
  });
});
