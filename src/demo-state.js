'use strict';

const config = require('./config');

// Runtime, process-local demo settings. A single free instance runs one
// process, so an in-memory toggle is sufficient — it is NOT shared across
// instances and resets on restart (documented as a demo aid). This is what lets
// the dashboard compress delivery timing live, with no env change and no
// redeploy.
//
// fastMode defaults OFF so the engine behaves with true production timings
// unless a presenter explicitly speeds things up (the dashboard "Seed demo
// data" action flips it on for convenience). Keeping it off by default also
// means the test suite sees production timing unless it opts in.

// The compressed values used while fastMode is on: a ~2s backoff base means a
// 5-attempt exhaustion dead-letters in ~30s, and a short delivery timeout makes
// the "slow receiver -> timeout" path quick to watch.
const FAST = { backoffDelayMs: 2000, deliveryTimeoutMs: 3000 };

const state = { fastMode: false };

function isFast() {
  return state.fastMode;
}

function setFastMode(on) {
  state.fastMode = Boolean(on);
  return state.fastMode;
}

// Effective values read at call time by the queue (enqueue) and worker
// (delivery). When fastMode is off these fall through to the live config values
// — read fresh, so tests that mutate config.deliveryTimeoutMs still take effect.
function backoffDelayMs() {
  return state.fastMode ? FAST.backoffDelayMs : config.backoffDelayMs;
}

function deliveryTimeoutMs() {
  return state.fastMode ? FAST.deliveryTimeoutMs : config.deliveryTimeoutMs;
}

function snapshot() {
  return {
    fastMode: state.fastMode,
    backoffDelayMs: backoffDelayMs(),
    deliveryTimeoutMs: deliveryTimeoutMs(),
  };
}

module.exports = {
  isFast,
  setFastMode,
  backoffDelayMs,
  deliveryTimeoutMs,
  snapshot,
};
