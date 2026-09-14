const path = require('path');

if (process.platform === 'win32') {
    const packageDirectory = path.dirname(require.resolve('@tensorflow/tfjs-node/package.json'));
    const nativeLibraryDirectory = path.join(packageDirectory, 'deps', 'lib');
    const pathEntries = (process.env.PATH || '').split(path.delimiter);

    if (!pathEntries.includes(nativeLibraryDirectory)) {
        process.env.PATH = `${nativeLibraryDirectory}${path.delimiter}${process.env.PATH || ''}`;
    }
}

module.exports = require('@tensorflow/tfjs-node');