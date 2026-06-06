'use strict';

const { queue, connection } = require('../../src/queue');

// Wipe all jobs between tests so queue assertions start clean.
async function resetQueue() {
  await queue.obliterate({ force: true });
}

// Close the producer queue + Redis connection so Jest can exit. Safe to call
// even if the connection never actually opened (lazyConnect).
async function closeQueue() {
  try {
    await queue.close();
  } catch (err) {
    /* ignore */
  }
  try {
    connection.disconnect();
  } catch (err) {
    /* ignore */
  }
}

module.exports = { queue, connection, resetQueue, closeQueue };
