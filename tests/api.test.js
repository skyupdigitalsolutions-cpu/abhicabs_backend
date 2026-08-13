'use strict';

/**
 * tests/api.test.js
 *
 * Smoke tests covering the auth flow and the access-control rules that matter.
 *
 * Run:  npm test
 * Needs: npm i -D vitest supertest
 *
 * These hit a REAL database, so point DATABASE_URL at a test database before
 * running — the suite creates and deletes users.
 */

const request = require('supertest');
const { describe, it, expect, beforeAll, afterAll } = require('vitest');

const app = require('../src/app');
const { prisma } = require('../src/config/prisma');

const ADMIN = { email: 'admin@example.com', password: 'Admin@12345' };
const TEST_EMAIL = `test_${Date.now()}@example.com`;

let adminToken;
let userToken;
let createdUserId;

beforeAll(async () => {
  const res = await request(app).post('/api/v1/auth/login').send(ADMIN);
  adminToken = res.body?.data?.accessToken;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: 'test_' } } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe('health', () => {
  it('reports ready when the database is reachable', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
  });
});

describe('register', () => {
  it('creates a user and returns tokens', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: TEST_EMAIL,
      password: 'Test@12345',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeTruthy();
    // The password hash must never leave the server.
    expect(res.body.data.user.password).toBeUndefined();

    userToken = res.body.data.accessToken;
  });

  it('rejects a duplicate email with 409', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: TEST_EMAIL,
      password: 'Test@12345',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE');
  });

  it('rejects a weak password with field-level detail', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Weak',
      email: `weak_${Date.now()}@example.com`,
      password: 'weak',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fields.length).toBeGreaterThan(0);
  });

  it('IGNORES a role field — nobody can self-register as admin', async () => {
    const email = `esc_${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Escalate', email, password: 'Test@12345', role: 'ADMIN' });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('USER');
  });
});

describe('login', () => {
  it('rejects a wrong password without revealing which field was wrong', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: 'WrongPass@123' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns the same error for an unknown email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'Whatever@123' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('protected routes', () => {
  it('rejects a request with no token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NO_TOKEN');
  });

  it('rejects a malformed token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('accepts a valid token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('ADMIN');
  });
});

describe('role enforcement', () => {
  it('blocks a USER from admin routes', async () => {
    const res = await request(app)
      .get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows an ADMIN to list users', async () => {
    const res = await request(app)
      .get('/api/v1/admin/users?page=1&limit=5')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.pagination.limit).toBe(5);
  });
});

describe('admin CRUD', () => {
  it('creates a user', async () => {
    const res = await request(app)
      .post('/api/v1/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Created By Admin',
        email: `test_crud_${Date.now()}@example.com`,
        password: 'Crud@12345',
        role: 'USER',
      });

    expect(res.status).toBe(201);
    createdUserId = res.body.data.user.id;
  });

  it('reads it back', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/users/${createdUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('updates it', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/users/${createdUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe('Renamed');
  });

  it('deactivates it', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/users/${createdUserId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.isActive).toBe(false);
  });

  it('deletes it', async () => {
    const res = await request(app)
      .delete(`/api/v1/admin/users/${createdUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('returns 404 for an id that no longer exists', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/users/${createdUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('admin lockout guard rails', () => {
  it('refuses to let an admin deactivate themselves', async () => {
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);

    const res = await request(app)
      .patch(`/api/v1/admin/users/${me.body.data.user.id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(['SELF_DEACTIVATION', 'LAST_ADMIN']).toContain(res.body.error.code);
  });
});

describe('refresh rotation', () => {
  it('issues a new token, and refuses the old one on reuse', async () => {
    const login = await request(app).post('/api/v1/auth/login').send(ADMIN);
    const refreshToken = login.body.data.refreshToken;

    const first = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.data.accessToken).toBeTruthy();

    // Same token again — single use, so this must fail.
    const second = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('REFRESH_REVOKED');
  });
});