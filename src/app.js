'use strict';

const path = require('path');
const express = require('express');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const subscriptionsRouter = require('./routes/subscriptions');
const eventsRouter = require('./routes/events');
const deadLettersRouter = require('./routes/dead-letters');
const metricsRouter = require('./routes/metrics');
const { notFoundHandler, errorHandler } = require('./errors');
const swaggerUi = require('swagger-ui-express');
const openapiSpec = require('./openapi');

const app = express();

app.use(pinoHttp({ logger }));

app.use('/health', healthRouter);
app.use('/api/subscriptions', express.json(), subscriptionsRouter);
app.use('/api/events', express.raw({ type: '*/*', limit: '1mb' }), eventsRouter);
app.use('/api/dead-letters', deadLettersRouter);
app.use('/metrics', metricsRouter);
// Live API docs: Swagger UI driven by the hand-written OpenAPI spec.
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));
// Operator dashboard: a single self-contained HTML file (no framework, no
// build step) that drives the JSON API above.
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;