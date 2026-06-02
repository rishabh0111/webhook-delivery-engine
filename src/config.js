'use strict';

// Central configuration, read once from the environment. Keeping this in one
// place means routes/db/logger never reach into process.env directly.
const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL,
  // Default to silent during tests so the suite output stays readable.
  logLevel:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
};

module.exports = config;