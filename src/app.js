'use strict';

const express = require('express');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const { notFoundHandler, errorHandler } = require('./errors');

// Build the Express app WITHOUT calling listen(). Exporting the app instance
// lets Supertest drive it in-process, while src/index.js owns the actual
// server lifecycle.
const app = express();

app.use(pinoHttp({ logger }));

app.use('/health', healthRouter);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;