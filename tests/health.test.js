'use strict';

const request = require('supertest');
const app = require('../src/app');
const { pool } = require('./helpers/db');

afterAll(async () => {
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