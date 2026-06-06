'use strict';

const request = require('supertest');
const app = require('../src/app');
const { pool } = require('./helpers/db');
const { closeQueue } = require('./helpers/queue');

afterAll(async () => {
  await closeQueue();
  await pool.end();
});

describe('GET /health (shallow liveness)', () => {
  it('returns 200 with status ok and process uptime', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /health/ready (deep readiness)', () => {
  it('returns 200 and both checks pass when Postgres and Redis are reachable', async () => {
    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks).toEqual({ postgres: true, redis: true });
  });
});
