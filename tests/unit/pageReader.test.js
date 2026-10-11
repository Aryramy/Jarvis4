import test from 'node:test';
import assert from 'node:assert/strict';
import { readWebPage } from '../../src/webpage/pageReader.js';
import { PageReaderError } from '../../src/webpage/urlSafety.js';

test('Page Reader - Redirect & Fetch Safety - Unit Tests (Brick 21 Sections 38 & 39)', async (t) => {
  const publicDnsMock = async () => [{ address: '93.184.216.34', family: 4 }];

  function createMockResponse({
    status = 200,
    headers = {},
    body = '<html><head><title>Test</title></head><body><main><p>Valid content</p></main></body></html>'
  }) {
    const headerMap = new Map();
    for (const [k, v] of Object.entries(headers)) {
      headerMap.set(k.toLowerCase(), v);
    }
    if (!headerMap.has('content-type')) {
      headerMap.set('content-type', 'text/html; charset=utf-8');
    }

    return {
      status,
      headers: {
        get: (h) => headerMap.get(h.toLowerCase()) ?? null
      },
      text: async () => body,
      arrayBuffer: async () => Buffer.from(body, 'utf8')
    };
  }

  // --- Section 38: Redirect Safety ---

  await t.test('22. public HTTPS -> public HTTPS redirect -> allowed', async () => {
    let callCount = 0;
    const mockFetch = async (url) => {
      callCount++;
      if (url === 'https://example.com/start') {
        return createMockResponse({
          status: 301,
          headers: { location: 'https://example.com/dest' }
        });
      }
      return createMockResponse({
        status: 200,
        body: '<html><head><title>Redirected</title></head><body><main><p>Reached final destination.</p></main></body></html>'
      });
    };

    const result = await readWebPage('https://example.com/start', {
      fetchFn: mockFetch,
      dnsLookup: publicDnsMock
    });

    assert.equal(result.success, true);
    assert.equal(result.redirectCount, 1);
    assert.equal(result.requestedUrl, 'https://example.com/start');
    assert.equal(result.finalUrl, 'https://example.com/dest');
    assert.equal(result.title, 'Redirected');
    assert.match(result.text, /Reached final destination\./);
  });

  await t.test('23. redirect destination is revalidated with URL safety & DNS', async () => {
    const urlsValidated = [];
    const trackingDns = async (h) => {
      urlsValidated.push(h);
      return [{ address: '93.184.216.34', family: 4 }];
    };

    const mockFetch = async (url) => {
      if (url === 'https://example.com/one') {
        return createMockResponse({
          status: 302,
          headers: { location: 'https://safe-domain.com/two' }
        });
      }
      return createMockResponse({
        status: 200,
        body: '<html><head><title>Two</title></head><body><main><p>Content</p></main></body></html>'
      });
    };

    const result = await readWebPage('https://example.com/one', {
      fetchFn: mockFetch,
      dnsLookup: trackingDns
    });

    assert.equal(result.success, true);
    assert.ok(urlsValidated.includes('example.com'));
    assert.ok(urlsValidated.includes('safe-domain.com'));
  });

  await t.test('24. public page -> localhost redirect -> blocked', async () => {
    const mockFetch = async (url) => {
      return createMockResponse({
        status: 302,
        headers: { location: 'http://localhost/admin' }
      });
    };

    await assert.rejects(
      async () => readWebPage('https://example.com/page', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock
      }),
      (err) => err instanceof PageReaderError && (err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED' || err.code === 'INSECURE_REDIRECT_DOWNGRADE')
    );
  });

  await t.test('25. public page -> private-IP redirect -> blocked', async () => {
    const mockFetch = async (url) => {
      return createMockResponse({
        status: 302,
        headers: { location: 'https://192.168.1.1/router' }
      });
    };

    await assert.rejects(
      async () => readWebPage('https://example.com/page', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock
      }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );
  });

  await t.test('26. HTTPS -> HTTP downgrade -> blocked (INSECURE_REDIRECT_DOWNGRADE)', async () => {
    const mockFetch = async (url) => {
      return createMockResponse({
        status: 301,
        headers: { location: 'http://example.com/insecure' }
      });
    };

    await assert.rejects(
      async () => readWebPage('https://example.com/secure', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock
      }),
      (err) => err instanceof PageReaderError && err.code === 'INSECURE_REDIRECT_DOWNGRADE'
    );
  });

  await t.test('27. more than 3 redirects -> TOO_MANY_REDIRECTS', async () => {
    let hops = 0;
    const mockFetch = async (url) => {
      hops++;
      return createMockResponse({
        status: 302,
        headers: { location: `https://example.com/hop-${hops}` }
      });
    };

    await assert.rejects(
      async () => readWebPage('https://example.com/start', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock,
        maxRedirects: 3
      }),
      (err) => err instanceof PageReaderError && err.code === 'TOO_MANY_REDIRECTS'
    );
  });

  // --- Section 39: Fetch Safety ---

  await t.test('28. timeout -> FETCH_TIMEOUT', async () => {
    const mockFetch = async (_url, opts) => {
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => resolvePromise(createMockResponse({})), 150);
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            rejectPromise(abortErr);
          });
        }
      });
    };

    await assert.rejects(
      async () => readWebPage('https://example.com/slow', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock,
        timeoutMs: 20
      }),
      (err) => err instanceof PageReaderError && err.code === 'FETCH_TIMEOUT'
    );
  });

  await t.test('29. body above max bytes -> PAGE_TOO_LARGE', async () => {
    const hugeBody = 'x'.repeat(5000);
    const mockFetch = async () => createMockResponse({ body: hugeBody });

    await assert.rejects(
      async () => readWebPage('https://example.com/huge', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock,
        maxBytes: 1000
      }),
      (err) => err instanceof PageReaderError && err.code === 'PAGE_TOO_LARGE'
    );
  });

  await t.test('30. text/html -> accepted', async () => {
    const mockFetch = async () => createMockResponse({
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><head><title>HTML Page</title></head><body><main><p>Valid HTML</p></main></body></html>'
    });

    const res = await readWebPage('https://example.com/html', {
      fetchFn: mockFetch,
      dnsLookup: publicDnsMock
    });
    assert.equal(res.success, true);
    assert.equal(res.contentType, 'text/html');
  });

  await t.test('31. application/xhtml+xml -> accepted', async () => {
    const mockFetch = async () => createMockResponse({
      headers: { 'content-type': 'application/xhtml+xml; charset=utf-8' },
      body: '<html><head><title>XHTML Page</title></head><body><main><p>Valid XHTML</p></main></body></html>'
    });

    const res = await readWebPage('https://example.com/xhtml', {
      fetchFn: mockFetch,
      dnsLookup: publicDnsMock
    });
    assert.equal(res.success, true);
    assert.equal(res.contentType, 'application/xhtml+xml');
  });

  await t.test('32. application/pdf -> rejected (UNSUPPORTED_CONTENT_TYPE)', async () => {
    const mockFetch = async () => createMockResponse({
      headers: { 'content-type': 'application/pdf' },
      body: '%PDF-1.4 binary data'
    });

    await assert.rejects(
      async () => readWebPage('https://example.com/doc.pdf', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock
      }),
      (err) => err instanceof PageReaderError && err.code === 'UNSUPPORTED_CONTENT_TYPE'
    );
  });

  await t.test('33. application/json -> rejected (UNSUPPORTED_CONTENT_TYPE)', async () => {
    const mockFetch = async () => createMockResponse({
      headers: { 'content-type': 'application/json' },
      body: '{"foo": "bar"}'
    });

    await assert.rejects(
      async () => readWebPage('https://example.com/api', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock
      }),
      (err) => err instanceof PageReaderError && err.code === 'UNSUPPORTED_CONTENT_TYPE'
    );
  });

  await t.test('34. image/png -> rejected (UNSUPPORTED_CONTENT_TYPE)', async () => {
    const mockFetch = async () => createMockResponse({
      headers: { 'content-type': 'image/png' },
      body: 'binary png'
    });

    await assert.rejects(
      async () => readWebPage('https://example.com/image.png', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock
      }),
      (err) => err instanceof PageReaderError && err.code === 'UNSUPPORTED_CONTENT_TYPE'
    );
  });

  await t.test('35. 404 -> HTTP_ERROR with status and finalUrl', async () => {
    const mockFetch = async () => createMockResponse({
      status: 404,
      body: '<html><body>Not Found</body></html>'
    });

    await assert.rejects(
      async () => readWebPage('https://example.com/missing', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock
      }),
      (err) => err instanceof PageReaderError && err.code === 'HTTP_ERROR' && err.details?.httpStatus === 404
    );
  });

  await t.test('36. 500 -> HTTP_ERROR with status and finalUrl', async () => {
    const mockFetch = async () => createMockResponse({
      status: 500,
      body: '<html><body>Server Error</body></html>'
    });

    await assert.rejects(
      async () => readWebPage('https://example.com/crash', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock
      }),
      (err) => err instanceof PageReaderError && err.code === 'HTTP_ERROR' && err.details?.httpStatus === 500
    );
  });

  await t.test('37. network failure -> FETCH_FAILED', async () => {
    const mockFetch = async () => {
      throw new Error('connect ECONNREFUSED 93.184.216.34:443');
    };

    await assert.rejects(
      async () => readWebPage('https://example.com/dead', {
        fetchFn: mockFetch,
        dnsLookup: publicDnsMock
      }),
      (err) => err instanceof PageReaderError && err.code === 'FETCH_FAILED'
    );
  });
});
