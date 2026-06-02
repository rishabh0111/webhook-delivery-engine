'use strict';

const pino = require('pino');
const config = require('./config');

// One shared logger for the process. pino-http (wired in app.js) derives a
// child logger per request from this instance.
const logger = pino({ level: config.logLevel });

module.exports = logger;