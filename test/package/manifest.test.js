'use strict';

const path = require('path');
const { tests } = require('@iobroker/testing');

// Validates io-package.json + package.json structure against ioBroker rules.
tests.packageFiles(path.join(__dirname, '..', '..'));
