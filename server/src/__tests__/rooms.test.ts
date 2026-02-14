import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { createServer, Server } from 'http';
import { roomRouter, getRoom } from '../rooms.js';

function setupApp() {
  const app = express();
  app.use(express.json());
  app.use('/rooms', roomRouter);
  const server = createServer(app);
  return { app, server };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

async function req(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

describe('rooms API', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    // Each test gets a fresh server but shares the in-memory room store
    const { server: s } = setupApp();
    server = s;
    port = await listen(server);
    return () => server.close();
  });

  it('creates a room', async () => {
    const { status, data } = await req(port, 'POST', '/rooms', { name: 'test' });
    expect(status).toBe(201);
    expect(data.id).toBeTypeOf('string');
    expect(data.token).toBeTypeOf('string');
    expect(data.name).toBe('test');
    expect((data.id as string).length).toBeGreaterThan(0);
    expect((data.token as string).length).toBeGreaterThan(0);
  });

  it('rejects room creation without name', async () => {
    const { status, data } = await req(port, 'POST', '/rooms', {});
    expect(status).toBe(400);
    expect(data.error).toBe('name is required');
  });

  it('gets room info', async () => {
    const create = await req(port, 'POST', '/rooms', { name: 'info-test' });
    const { status, data } = await req(port, 'GET', `/rooms/${create.data.id}`);
    expect(status).toBe(200);
    expect(data.name).toBe('info-test');
    expect(data.createdAt).toBeTypeOf('number');
  });

  it('returns 404 for unknown room', async () => {
    const { status } = await req(port, 'GET', '/rooms/nonexistent');
    expect(status).toBe(404);
  });

  it('joins a room with valid token', async () => {
    const create = await req(port, 'POST', '/rooms', { name: 'join-test' });
    const { status, data } = await req(port, 'POST', `/rooms/${create.data.id}/join`, {
      token: create.data.token,
    });
    expect(status).toBe(200);
    expect(data.id).toBe(create.data.id);
    expect(data.wsUrl).toBe(`/ws/${create.data.id}`);
  });

  it('rejects join with wrong token', async () => {
    const create = await req(port, 'POST', '/rooms', { name: 'bad-token' });
    const { status, data } = await req(port, 'POST', `/rooms/${create.data.id}/join`, {
      token: 'wrong',
    });
    expect(status).toBe(403);
    expect(data.error).toBe('invalid token');
  });

  it('rejects join for unknown room', async () => {
    const { status } = await req(port, 'POST', '/rooms/nonexistent/join', {
      token: 'x',
    });
    expect(status).toBe(404);
  });

  it('getRoom returns the room object', async () => {
    const create = await req(port, 'POST', '/rooms', { name: 'get-room' });
    const room = getRoom(create.data.id as string);
    expect(room).toBeDefined();
    expect(room!.name).toBe('get-room');
    expect(room!.token).toBe(create.data.token);
  });

  it('getRoom returns undefined for unknown id', () => {
    expect(getRoom('nope')).toBeUndefined();
  });
});
