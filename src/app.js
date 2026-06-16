'use strict';

const path = require('path');
const express = require('express');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');
const openapiSpec = require('./openapi');
const logger = require('./logger');
const healthRouter = require('./routes/health');
const subscriptionsRouter = require('./routes/subscriptions');
const eventsRouter = require('./routes/events');
const deadLettersRouter = require('./routes/dead-letters');
const metricsRouter = require('./routes/metrics');
const demoRouter = require('./routes/demo');
const demoReceiverRouter = require('./routes/demo-receiver');
const { notFoundHandler, errorHandler } = require('./errors');

// Build the Express app WITHOUT calling listen(). Exporting the app instance
// lets Supertest drive it in-process, while src/index.js owns the actual
// server lifecycle.
const app = express();

app.use(pinoHttp({ logger }));

// Body parsers are mounted per-route, not globally: the events ingress needs
// the EXACT raw bytes (express.raw -> Buffer) so they can be persisted and
// signed verbatim, while the JSON APIs want a parsed object. A global
// express.json() would consume the events stream before raw could see it.
app.use('/health', healthRouter);
app.use('/api/subscriptions', express.json(), subscriptionsRouter);
app.use(
  '/api/events',
  express.raw({ type: '*/*', limit: '1mb' }),
  eventsRouter
);
app.use('/api/dead-letters', deadLettersRouter);
app.use('/metrics', metricsRouter);

// Demo aids (gated behind DEMO_MODE inside the routers via requireDemo): the
// operator controls (/api/demo: settings toggle, seed, reset, reconcile) and
// the in-process controllable receiver (/demo/receiver/*). The receiver needs
// the EXACT raw bytes to verify the HMAC, so it gets express.raw like the
// events ingress — not the global JSON parser.
app.use('/api/demo', express.json(), demoRouter);
app.use(
  '/demo/receiver',
  express.raw({ type: '*/*', limit: '1mb' }),
  demoReceiverRouter
);

// Live API docs: Swagger UI driven by the hand-written OpenAPI spec.
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

// Operator dashboard: a single self-contained HTML file (no framework, no
// build step) that drives the JSON API above. Served as a static asset.
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
