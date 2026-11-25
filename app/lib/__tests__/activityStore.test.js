const fs = require('fs');
const activityStore = require('../activityStore');

describe('activityStore', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('returns an empty activity list when the data file is blank', () => {
        jest.spyOn(fs, 'readFileSync').mockReturnValue('   ');

        expect(activityStore.getActivities()).toEqual({ activities: [] });
    });

    test('still rejects malformed non-empty JSON', () => {
        jest.spyOn(fs, 'readFileSync').mockReturnValue('{"activities":');

        expect(() => activityStore.getActivities()).toThrow(SyntaxError);
    });
});
