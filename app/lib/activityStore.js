const fs = require('fs');
const path = require('path');

const activityDataPath = path.join(__dirname, '../data/atividades.json');

const getActivities = () => {
    const data = fs.readFileSync(activityDataPath, 'utf8');
    return JSON.parse(data);
};

const saveActivities = (activities) => {
    fs.writeFileSync(activityDataPath, JSON.stringify(activities, null, 2));
};

module.exports = {
    getActivities,
    saveActivities
};