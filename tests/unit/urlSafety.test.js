import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateUrlSafety,
  isPublicIP,
  isPublicIPv4,
  isPublicIPv6,
  PageReaderError
} from '../../src/webpage/urlSafety.js';

test('URL & SSRF Safety - Unit Tests (Brick 21 Section 37)', async (t) => {
  const publicDnsMock = async () => [{ address: '93.184.216.34', family: 4 }];

  await t.test('1. https://example.com -> allowed', async () => {
    const res = await validateUrlSafety('https://example.com', { dnsLookup: publicDnsMock });
    assert.equal(res.valid, true);
    assert.equal(res.url.hostname, 'example.com');
  });

  await t.test('2. http://example.com -> allowed', async () => {
    const res = await validateUrlSafety('http://example.com', { dnsLookup: publicDnsMock });
    assert.equal(res.valid, true);
    assert.equal(res.url.hostname, 'example.com');
  });

  await t.test('3. ftp://example.com -> rejected (UNSUPPORTED_PROTOCOL)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('ftp://example.com', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'UNSUPPORTED_PROTOCOL'
    );
  });

  await t.test('4. file:///etc/passwd -> rejected (UNSUPPORTED_PROTOCOL)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('file:///etc/passwd', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'UNSUPPORTED_PROTOCOL'
    );
  });

  await t.test('5. javascript:alert(1) -> rejected (UNSUPPORTED_PROTOCOL)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('javascript:alert(1)', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && (err.code === 'UNSUPPORTED_PROTOCOL' || err.code === 'INVALID_URL')
    );
  });

  await t.test('6. https://user:pass@example.com -> rejected (URL_CREDENTIALS_NOT_ALLOWED)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('https://user:pass@example.com', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'URL_CREDENTIALS_NOT_ALLOWED'
    );
  });

  await t.test('7. http://localhost -> rejected (LOCAL_OR_PRIVATE_HOST_BLOCKED)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('http://localhost', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );
  });

  await t.test('8. http://127.0.0.1 -> rejected (LOCAL_OR_PRIVATE_HOST_BLOCKED)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('http://127.0.0.1', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );
  });

  await t.test('9. http://127.0.0.1:80 -> rejected (LOCAL_OR_PRIVATE_HOST_BLOCKED)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('http://127.0.0.1:80', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );
  });

  await t.test('10. http://10.0.0.1 -> rejected (LOCAL_OR_PRIVATE_HOST_BLOCKED)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('http://10.0.0.1', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );
  });

  await t.test('11. http://172.16.0.1 -> rejected (LOCAL_OR_PRIVATE_HOST_BLOCKED)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('http://172.16.0.1', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );
  });

  await t.test('12. http://192.168.1.1 -> rejected (LOCAL_OR_PRIVATE_HOST_BLOCKED)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('http://192.168.1.1', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );
  });

  await t.test('13. http://169.254.169.254 -> rejected (LOCAL_OR_PRIVATE_HOST_BLOCKED)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('http://169.254.169.254', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );
  });

  await t.test('14. http://[::1] -> rejected (LOCAL_OR_PRIVATE_HOST_BLOCKED)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('http://[::1]', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );
  });

  await t.test('15. private IPv6 result -> rejected (LOCAL_OR_PRIVATE_HOST_BLOCKED)', async () => {
    const privateIpv6DnsMock = async () => [{ address: 'fc00::1', family: 6 }];
    await assert.rejects(
      async () => validateUrlSafety('https://example.com', { dnsLookup: privateIpv6DnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );

    const linkLocalIpv6DnsMock = async () => [{ address: 'fe80::1', family: 6 }];
    await assert.rejects(
      async () => validateUrlSafety('https://example.com', { dnsLookup: linkLocalIpv6DnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );
  });

  await t.test('16. public hostname resolving only to public IP -> allowed', async () => {
    const dualPublicDnsMock = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
    ];
    const res = await validateUrlSafety('https://example.com', { dnsLookup: dualPublicDnsMock });
    assert.equal(res.valid, true);
    assert.equal(res.resolvedAddresses.length, 2);
  });

  await t.test('17. hostname resolving to one public and one private address -> rejected', async () => {
    const mixedDnsMock = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 }
    ];
    await assert.rejects(
      async () => validateUrlSafety('https://example.com', { dnsLookup: mixedDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
    );
  });

  await t.test('18. DNS failure -> controlled failure (DNS_RESOLUTION_FAILED)', async () => {
    const failingDnsMock = async () => {
      throw new Error('getaddrinfo ENOTFOUND fake-host-xyz.com');
    };
    await assert.rejects(
      async () => validateUrlSafety('https://fake-host-xyz.com', { dnsLookup: failingDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'DNS_RESOLUTION_FAILED'
    );
  });

  await t.test('19. explicit port 8080 -> rejected (PORT_NOT_ALLOWED)', async () => {
    await assert.rejects(
      async () => validateUrlSafety('http://example.com:8080', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'PORT_NOT_ALLOWED'
    );

    await assert.rejects(
      async () => validateUrlSafety('https://example.com:8080', { dnsLookup: publicDnsMock }),
      (err) => err instanceof PageReaderError && err.code === 'PORT_NOT_ALLOWED'
    );
  });

  await t.test('20. default HTTPS 443 -> allowed', async () => {
    const res1 = await validateUrlSafety('https://example.com:443', { dnsLookup: publicDnsMock });
    assert.equal(res1.valid, true);
    const res2 = await validateUrlSafety('https://example.com', { dnsLookup: publicDnsMock });
    assert.equal(res2.valid, true);
  });

  await t.test('21. default HTTP 80 -> allowed', async () => {
    const res1 = await validateUrlSafety('http://example.com:80', { dnsLookup: publicDnsMock });
    assert.equal(res1.valid, true);
    const res2 = await validateUrlSafety('http://example.com', { dnsLookup: publicDnsMock });
    assert.equal(res2.valid, true);
  });

  await t.test('additional: local domain suffixes blocked', async () => {
    for (const host of ['test.local', 'api.internal', 'gateway.lan', 'router.home.arpa', 'dev.localhost']) {
      await assert.rejects(
        async () => validateUrlSafety(`http://${host}`, { dnsLookup: publicDnsMock }),
        (err) => err instanceof PageReaderError && err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    }
  });

  await t.test('additional: carrier-grade NAT, test-net and multicast IP ranges blocked', async () => {
    assert.equal(isPublicIP('100.64.0.1'), false);
    assert.equal(isPublicIP('100.127.255.254'), false);
    assert.equal(isPublicIP('192.0.2.1'), false);
    assert.equal(isPublicIP('198.51.100.1'), false);
    assert.equal(isPublicIP('203.0.113.1'), false);
    assert.equal(isPublicIP('224.0.0.1'), false);
    assert.equal(isPublicIP('240.0.0.1'), false);
    assert.equal(isPublicIP('255.255.255.255'), false);
    assert.equal(isPublicIP('::ffff:127.0.0.1'), false);
    assert.equal(isPublicIP('::ffff:192.168.1.1'), false);
    assert.equal(isPublicIP('2001:db8::1'), false);
    assert.equal(isPublicIP('8.8.8.8'), true);
    assert.equal(isPublicIP('1.1.1.1'), true);
  });
});
