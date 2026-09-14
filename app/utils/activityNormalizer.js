function normalizeActivityQuestions(activity) {
    const rawQuestions = Array.isArray(activity.questions) ? activity.questions : Object.values(activity.questions || {});

    return rawQuestions.map((question) => {
        let options = null;
        let correctKey = question.correct;

        if (Array.isArray(question.options) && question.options.length > 0) {
            options = question.options.reduce((acc, value, index) => {
                const letter = String.fromCharCode(65 + index);
                acc[letter] = value;
                return acc;
            }, {});
            const correctIndex = parseInt(question.correct, 10);
            if (!isNaN(correctIndex) && correctIndex >= 1 && correctIndex <= question.options.length) {
                correctKey = String.fromCharCode(65 + correctIndex - 1);
            }
        } else if (question.options && Object.keys(question.options).length > 0) {
            options = Object.fromEntries(Object.entries(question.options).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== ''));
            const correctIndex = parseInt(question.correct, 10);
            if (!isNaN(correctIndex) && correctIndex >= 1 && Object.keys(options).length >= correctIndex) {
                correctKey = String.fromCharCode(65 + correctIndex - 1);
            }
        }

        // Se o objeto de opções ficar vazio (ex.: "options": []), trata a questão como escrita
        if (options && Object.keys(options).length === 0) {
            options = null;
        }

        const correctAnswer = question.correctAnswer || (options ? (options[correctKey] || correctKey) : '');

        return {
            ...question,
            title: question.title || question.text || question.enunciado || 'Questão',
            text: question.text || question.title || question.enunciado || 'Questão',
            type: question.type || (options ? 'multiple_choice' : 'short_text'),
            options,
            correct: correctKey,
            correctAnswer
        };
    });
}

function isAnswerCorrect(question, answer) {
    if (answer === undefined || answer === null || String(answer).trim() === '') return false;
    const marked = String(answer).trim().toLowerCase();
    if (question.options) {
        const correct = String(question.correct || '').trim().toLowerCase();
        const correctNumeric = Number(correct);
        if (!Number.isNaN(correctNumeric) && String(correctNumeric) === correct) {
            const correctLetter = String.fromCharCode(96 + correctNumeric);
            return marked === correctLetter;
        }
        return marked === correct;
    }
    return marked === String(question.correctAnswer || '').trim().toLowerCase();
}

module.exports = {
    normalizeActivityQuestions,
    isAnswerCorrect
};
