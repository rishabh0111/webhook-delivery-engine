'use strict';

module.exports = {
  testEnvironment: 'node',
  // Tests share a single test Postgres; run serially so they don't race on
  // truncation/inserts. (Also set via the `test` npm script's --runInBand.)
  maxWorkers: 1,
  testMatch: ['**/tests/**/*.test.js'],
  // Each suite closes everything it owns (verified clean individually with
  // --detectOpenHandles). The only thing left at the end of a combined run is
  // a process-global handle — Node's fetch/undici keep-alive agent plus Redis
  // socket residue — that closes just after Jest's 1s exit probe. forceExit
  // ends the run promptly without masking any real per-suite leak.
  forceExit: true,
};