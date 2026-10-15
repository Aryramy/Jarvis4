/**
 * Contract Tests for Structured Extraction Endpoint (Brick 38).
 *
 * Validates HTTP route contract for:
 * - POST /api/browser/extract
 *
 * Guarantees:
 * - Method constraints (405 on GET)
 * - JSON schema and body validation (400 on malformed JSON)
 * - Expected snapshot token requirement (409 on missing or stale token)
 * - Human handoff exclusion (409 on active handoff)
 * - Browser lifecycle errors (controlled status code and error sanitization)
 * - Successful response structure matching Brick 38 contract specifications
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../../src/web/server.js';
import { StructuredExtractionError } from '../../src/browser/structuredExtractor.js';

describe('Structured Extraction Endpoint Contract Tests (Brick 38)', () => {
  let server;
  let port;
  let baseUrl;
  let mockBrowserManager;

  before(async () => {
    mockBrowserManager = {
      extractStructuredData: async (req, options) => {
        if (!req || typeof req !== 'object') {
          throw new StructuredExtractionError('Request must be a JSON object.', 'INVALID_ARGUMENT');
        }

        const token = req.expectedSnapshotToken;
        if (!token || typeof token !== 'string' || !token.trim()) {
          throw new StructuredExtractionError('Extraction requires an expectedSnapshotToken.', 'TARGET_STALE');
        }

        if (token === 'stale-token') {
          throw new StructuredExtractionError('Snapshot token is stale or invalid.', 'TARGET_STALE');
        }

        if (token === 'handoff-token') {
          throw new StructuredExtractionError(
            'Cannot extract data while sensitive human handoff is active.',
            'HUMAN_HANDOFF_ACTIVE'
          );
        }

        if (token === 'closed-token') {
          throw new StructuredExtractionError('Target page was closed.', 'PAGE_CLOSED');
        }

        if (token === 'error-token') {
          throw new StructuredExtractionError('DOM extraction failed unexpectedly.', 'BROWSER_ERROR');
        }

        const requestedTypes = Array.isArray(req.types) && req.types.length > 0
          ? req.types.map(t => String(t).toLowerCase())
          : ['metadata', 'headings', 'links', 'tables', 'lists', 'definitions', 'records'];

        const data = {
          metadata: requestedTypes.includes('metadata') ? {
            title: 'Sample Test Page',
            url: 'http://127.0.0.1:8080/sample.html',
            language: 'en',
            canonicalUrl: 'http://127.0.0.1:8080/sample.html',
            description: 'A test page for structured extraction'
          } : null,
          headings: requestedTypes.includes('headings') ? [
            { level: 1, text: 'Main Title' },
            { level: 2, text: 'Subtitle' }
          ] : [],
          links: requestedTypes.includes('links') ? [
            { text: 'Home', href: 'http://127.0.0.1:8080/', accessibleName: 'Home Page', sameOrigin: true }
          ] : [],
          tables: requestedTypes.includes('tables') ? [
            {
              caption: 'Users Table',
              headers: ['ID', 'Name'],
              rows: [['1', 'Alice'], ['2', 'Bob']],
              irregular: false
            }
          ] : [],
          lists: requestedTypes.includes('lists') ? [
            { ordered: false, items: ['Alpha', 'Beta'] }
          ] : [],
          definitions: requestedTypes.includes('definitions') ? [
            { key: 'Term', value: 'Definition description' }
          ] : [],
          records: requestedTypes.includes('records') ? [
            {
              tag: 'article',
              heading: 'Article 1',
              text: 'Summary of article 1',
              links: [],
              fields: [{ key: 'Author', value: 'Editor' }]
            }
          ] : []
        };

        return {
          success: true,
          pageId: 'page_contract_test_01',
          currentUrl: 'http://127.0.0.1:8080/sample.html',
          title: 'Sample Test Page',
          documentVersion: 1,
          semanticRevision: 2,
          snapshotToken: token,
          data,
          counts: {
            headings: data.headings.length,
            links: data.links.length,
            tables: data.tables.length,
            lists: data.lists.length,
            definitions: data.definitions.length,
            records: data.records.length
          },
          limits: {
            maxRecords: 500,
            maxTextChars: 200000,
            maxFieldChars: 4000,
            maxNestingDepth: 5
          },
          truncated: false,
          truncationReason: null,
          durationMs: 12.4
        };
      }
    };

    server = createServer({ browserManager: mockBrowserManager });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  function makeRequest(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const reqHeaders = { ...headers };
      let payload = null;

      if (body !== null) {
        if (typeof body === 'string') {
          payload = body;
        } else {
          payload = JSON.stringify(body);
          if (!reqHeaders['content-type']) {
            reqHeaders['content-type'] = 'application/json';
          }
        }
        reqHeaders['content-length'] = Buffer.byteLength(payload);
      }

      const req = http.request(url, { method, headers: reqHeaders }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      });

      req.on('error', reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  it('rejects GET /api/browser/extract with 405 Method Not Allowed', async () => {
    const res = await makeRequest('GET', '/api/browser/extract');
    assert.equal(res.status, 405);
    assert.equal(res.body.error, 'Method Not Allowed');
  });

  it('rejects malformed JSON body with 400 Bad Request', async () => {
    const res = await makeRequest(
      'POST',
      '/api/browser/extract',
      'not-valid-json{',
      { 'content-type': 'application/json' }
    );
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('rejects missing expectedSnapshotToken with 409 TARGET_STALE', async () => {
    const res = await makeRequest('POST', '/api/browser/extract', {});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'TARGET_STALE');
  });

  it('rejects stale snapshot token with 409 TARGET_STALE', async () => {
    const res = await makeRequest('POST', '/api/browser/extract', {
      expectedSnapshotToken: 'stale-token'
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'TARGET_STALE');
  });

  it('rejects extraction during active human handoff with 409 HUMAN_HANDOFF_ACTIVE', async () => {
    const res = await makeRequest('POST', '/api/browser/extract', {
      expectedSnapshotToken: 'handoff-token'
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'HUMAN_HANDOFF_ACTIVE');
  });

  it('handles page closed with 404 PAGE_CLOSED', async () => {
    const res = await makeRequest('POST', '/api/browser/extract', {
      expectedSnapshotToken: 'closed-token'
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'PAGE_CLOSED');
  });

  it('handles unexpected browser error with 500 BROWSER_ERROR', async () => {
    const res = await makeRequest('POST', '/api/browser/extract', {
      expectedSnapshotToken: 'error-token'
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'BROWSER_ERROR');
  });

  it('successfully extracts full structured data with 200 OK', async () => {
    const res = await makeRequest('POST', '/api/browser/extract', {
      expectedSnapshotToken: 'valid-snap-token-123'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.pageId, 'page_contract_test_01');
    assert.equal(res.body.currentUrl, 'http://127.0.0.1:8080/sample.html');
    assert.equal(res.body.title, 'Sample Test Page');
    assert.equal(res.body.documentVersion, 1);
    assert.equal(res.body.semanticRevision, 2);
    assert.equal(res.body.snapshotToken, 'valid-snap-token-123');

    // Verify all 7 data categories are present
    const data = res.body.data;
    assert.ok(data);
    assert.ok(data.metadata);
    assert.equal(data.metadata.title, 'Sample Test Page');
    assert.equal(Array.isArray(data.headings), true);
    assert.equal(data.headings.length, 2);
    assert.equal(Array.isArray(data.links), true);
    assert.equal(data.links.length, 1);
    assert.equal(Array.isArray(data.tables), true);
    assert.equal(data.tables.length, 1);
    assert.equal(Array.isArray(data.lists), true);
    assert.equal(data.lists.length, 1);
    assert.equal(Array.isArray(data.definitions), true);
    assert.equal(data.definitions.length, 1);
    assert.equal(Array.isArray(data.records), true);
    assert.equal(data.records.length, 1);

    // Verify counts and limits
    assert.deepEqual(res.body.counts, {
      headings: 2,
      links: 1,
      tables: 1,
      lists: 1,
      definitions: 1,
      records: 1
    });
    assert.equal(res.body.truncated, false);
    assert.equal(res.body.truncationReason, null);
    assert.ok(typeof res.body.durationMs === 'number');
  });

  it('filters data by requested types when types array is provided', async () => {
    const res = await makeRequest('POST', '/api/browser/extract', {
      expectedSnapshotToken: 'valid-snap-token-123',
      types: ['headings', 'links']
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.metadata, null);
    assert.equal(res.body.data.headings.length, 2);
    assert.equal(res.body.data.links.length, 1);
    assert.equal(res.body.data.tables.length, 0);
    assert.equal(res.body.data.lists.length, 0);
  });
});
