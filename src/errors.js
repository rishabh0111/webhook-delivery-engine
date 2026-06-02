'use strict';

const logger = require('./logger');

// A typed error carrying an HTTP status. Routes throw these (or pass them to
// next()) and the error handler renders them in a consistent envelope.
class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

// Terminal 404 for unmatched routes.
function notFoundHandler(req, res, next) {
  next(new ApiError(404, 'Not found'));
}

// Single error-rendering middleware. Everything that reaches here is rendered
// as { error: { message, details? } } so clients see one shape.
function errorHandler(err, req, res, next) {
  // eslint-disable-line no-unused-vars
  // err.statusCode is set by our ApiError; err.status is set by Express's
  // body-parser (e.g. malformed JSON -> 400).
  const statusCode = err.statusCode || err.status || 500;
  if (statusCode >= 500) {
    logger.error({ err }, 'unhandled error');
  }
  const body = { error: { message: err.message || 'Internal server error' } };
  if (err.details !== undefined) {
    body.error.details = err.details;
  }
  res.status(statusCode).json(body);
}

module.exports = { ApiError, notFoundHandler, errorHandler };