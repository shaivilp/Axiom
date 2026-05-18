import './test-env.js';
import { describe, expect, it, vi } from 'vitest';

// Mock the AccountManager so we don't need a live mineflayer / DB.
vi.mock('../src/minecraft/account-manager.js', () => ({
  accountManager: {
    listSummaries: () => [],
    getSummary: () => null,
    createAccount: vi.fn(),
    updateAccount: vi.fn(),
    startAccount: vi.fn(),
    stopAccount: vi.fn(),
    deleteAccount: vi.fn(),
    sendChat: vi.fn(),
  },
}));

async function buildApp() {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const { accountsRouter } = await import('../src/routes/accounts.js');
  const { errorHandler } = await import('../src/middleware/error.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/accounts', accountsRouter);
  app.use(errorHandler);
  return app;
}

describe('POST /accounts validation', () => {
  it('returns 400 + VALIDATION_ERROR for missing fields', async () => {
    const app = await buildApp();
    const request = (await import('supertest')).default;
    const res = await request(app).post('/api/v1/accounts').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid authType', async () => {
    const app = await buildApp();
    const request = (await import('supertest')).default;
    const res = await request(app).post('/api/v1/accounts').send({
      label: 'x',
      username: 'y',
      authType: 'whatever',
      serverHost: 'h',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for out-of-range port', async () => {
    const app = await buildApp();
    const request = (await import('supertest')).default;
    const res = await request(app).post('/api/v1/accounts').send({
      label: 'x',
      username: 'y',
      authType: 'offline',
      serverHost: 'h',
      serverPort: 99999,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-UUID :id', async () => {
    const app = await buildApp();
    const request = (await import('supertest')).default;
    const res = await request(app).get('/api/v1/accounts/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not leak the user-supplied input in the error response', async () => {
    const app = await buildApp();
    const request = (await import('supertest')).default;
    const probe = 'attacker-probe-token-12345';
    const res = await request(app).post('/api/v1/accounts').send({
      label: probe,
      username: '',
      authType: 'offline',
      serverHost: '',
    });
    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(probe);
  });
});

describe('POST /accounts/:id/chat sanitization', () => {
  it('rejects CR/LF-only messages with 400 after sanitization', async () => {
    const app = await buildApp();
    const request = (await import('supertest')).default;
    const res = await request(app)
      .post('/api/v1/accounts/11111111-1111-1111-1111-111111111111/chat')
      .send({ message: '\r\n\r\n' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty message with 400', async () => {
    const app = await buildApp();
    const request = (await import('supertest')).default;
    const res = await request(app)
      .post('/api/v1/accounts/11111111-1111-1111-1111-111111111111/chat')
      .send({ message: '' });
    expect(res.status).toBe(400);
  });
});
