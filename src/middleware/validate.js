'use strict';

const { ApiError } = require('../errors');

// Build a middleware that validates a request part against a Zod schema and
// replaces it with the parsed (coerced, defaulted) value. On failure it raises
// a 400 ApiError whose details list each offending field.
function validate(schema, part = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return next(new ApiError(400, 'Validation failed', details));
    }
    req[part] = result.data;
    return next();
  };
}

module.exports = { validate };