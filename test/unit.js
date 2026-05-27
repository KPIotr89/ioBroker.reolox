'use strict';

// Legacy entry — kept so older CI configurations still pass.
// Real tests live in test/unit/*.test.js. This shim re-runs the package
// manifest validation so that simply executing `mocha test/unit.js`
// still produces a useful result.

const path = require('path');
const { tests } = require('@iobroker/testing');
tests.packageFiles(path.join(__dirname, '..'));
