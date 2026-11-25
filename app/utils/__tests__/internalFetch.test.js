'use strict';

const { getBaseUrl } = require('../internalFetch');

describe('internalFetch base URL', () => {
  const originalAppPort = process.env.APP_PORT;
  const originalAppScheme = process.env.APP_SCHEME;

  afterEach(() => {
    if (originalAppPort === undefined) delete process.env.APP_PORT;
    else process.env.APP_PORT = originalAppPort;

    if (originalAppScheme === undefined) delete process.env.APP_SCHEME;
    else process.env.APP_SCHEME = originalAppScheme;
  });

  test('defaults to HTTP for the local application server', () => {
    process.env.APP_PORT = '4321';
    delete process.env.APP_SCHEME;

    expect(getBaseUrl()).toBe('http://localhost:4321');
  });
});
