import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../src/web/server.js';

describe('Web Server - Brick 2', () => {
  let server;
  let baseUrl;

  before(async () => {
    // Start on ephemeral port 0 to prevent port collisions
    server = await startServer(0, '127.0.0.1');
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after((done) => {
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  test('server starts successfully and binds to local host', () => {
    assert.ok(server);
    const addr = server.address();
    assert.equal(addr.address, '127.0.0.1');
    assert.ok(addr.port > 0);
  });

  test('GET / serves the minimal web page HTML', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);

    const body = await res.text();
    assert.match(body, /JARVIS4/);
    assert.match(body, /id="text-input"/);
    assert.match(body, /id="send-btn"/);
    assert.match(body, /id="response-area"/);
    assert.match(body, /id="status-indicator"/);
  });

  test('POST /api/text accepts valid text and returns deterministic response from text core', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello Jarvis' })
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);

    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.input, 'Hello Jarvis');
    assert.equal(data.response, 'JARVIS received: Hello Jarvis');
  });

  test('POST /api/text normalizes surrounding whitespace via text core', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '   Hello Jarvis   ' })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.input, 'Hello Jarvis');
    assert.equal(data.response, 'JARVIS received: Hello Jarvis');
  });

  test('POST /api/text handles empty input safely with controlled error', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Input cannot be empty');
  });

  test('POST /api/text handles whitespace-only input safely', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '     ' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Input cannot be empty');
  });

  test('POST /api/text handles non-string input safely', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 12345 })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Input must be a string');
  });

  test('POST /api/text handles invalid JSON body without crashing server', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid-non-json-string'
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Invalid JSON body');
  });

  test('GET /api/text rejects wrong method with 405 Method Not Allowed', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'GET'
    });

    assert.equal(res.status, 405);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Method Not Allowed');
  });

  test('GET /nonexistent returns 404 Not Found', async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Not Found');
  });
});
