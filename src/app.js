'use strict';

const express = require('express');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const subscriptionsRouter = require('./routes/subscriptions');
const { notFoundHandler, errorHandler } = require('./errors');

const app = express();

app.use(pinoHttp({ logger }));

app.use('/health', healthRouter);
app.use('/api/subscriptions', express.json(), subscriptionsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;