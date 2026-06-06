'use strict';

const express = require('express');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const subscriptionsRouter = require('./routes/subscriptions');
const eventsRouter = require('./routes/events');
const { notFoundHandler, errorHandler } = require('./errors');

const app = express();

app.use(pinoHttp({ logger }));

// Body parsers are mounted per-route: the events ingress needs the EXACT raw
// bytes (express.raw -> Buffer) to persist and sign verbatim, while the JSON
// APIs want a parsed object.
app.use('/health', healthRouter);
app.use('/api/subscriptions', express.json(), subscriptionsRouter);
app.use('/api/events', express.raw({ type: '*/*', limit: '1mb' }), eventsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;