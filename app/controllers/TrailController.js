const AtividadeModel = require('../models/AtividadeModel');
const fs = require('fs');
const path = require('path');

class TrailController {
    constructor(aluno) {
        this.aluno = aluno;
        this.trail = [];
        this.questionTopics = this.loadQuestionTopics();
    }

    loadQuestionTopics() {
        const filePath = path.resolve(__dirname, '../data/question_topics.json');
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(fileContent);
    }

    async generateTrail(testResults) {
        const incorrectQuestions = this.parseTestResults(testResults);

        for (const questionNumber of incorrectQuestions) {
            const topic = this.questionTopics[questionNumber];
            if (topic) {
                const newActivity = await AtividadeModel.create({
                    professor_id: null, 
                    titulo: `Exercícios de ${topic}`,
                    descricao: `Atividades de reforço sobre ${topic}.`
                });
                this.trail.push(newActivity);
            }
        }
        return this.trail;
    }

    parseTestResults(testResults) {
        const incorrectQuestions = [];
        const lines = testResults.split('\n');

        for (const line of lines) {
            if (line.includes('Incorreto!')) {
                const match = line.match(/Questão (\d+):/);
                if (match) {
                    incorrectQuestions.push(parseInt(match[1], 10));
                }
            }
        }
        return incorrectQuestions;
    }
}

module.exports = TrailController;