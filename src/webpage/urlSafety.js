/**
 * URL and SSRF Safety Module for JARVIS4 (Brick 21).
 * Validates protocols, ports, credentials, hostnames, and IP ranges.
 */

import net from 'node:net';
import dnsPromises from 'node:dns/promises';

/**
 * Controlled Page Reader Error.
 */
export class PageReaderError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Object} [details={}]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PageReaderError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Checks if an IPv4 address is in a public, globally routable range.
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 * @returns {boolean}
 */
export function isPublicIPv4(a, b, c, d) {
  if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) return false;
  if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255) return false;

  // 0.0.0.0/8 (Current network / "this" host)
  if (a === 0) return false;

  // 10.0.0.0/8 (Private IPv4)
  if (a === 10) return false;

  // 100.64.0.0/10 (Carrier-Grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return false;

  // 127.0.0.0/8 (Loopback)
  if (a === 127) return false;

  // 169.254.0.0/16 (Link-local)
  if (a === 169 && b === 254) return false;

  // 172.16.0.0/12 (Private IPv4: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return false;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 0) return false;

  // 192.0.2.0/24 (Documentation TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return false;

  // 192.168.0.0/16 (Private IPv4)
  if (a === 192 && b === 168) return false;

  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return false;

  // 198.51.100.0/24 (Documentation TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return false;

  // 203.0.113.0/24 (Documentation TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return false;

  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (a >= 224 && a <= 239) return false;

  // 240.0.0.0/4 (Reserved / Future use, including 255.255.255.255 Broadcast)
  if (a >= 240) return false;

  return true;
}

/**
 * Parses an IPv6 address string into an array of 8 16-bit numbers, or null if invalid.
 * @param {string} ip
 * @returns {number[] | null}
 */
export function parseIPv6(ip) {
  if (typeof ip !== 'string') return null;
  let cleanIp = ip.trim().toLowerCase();
  if (cleanIp.startsWith('[') && cleanIp.endsWith(']')) {
    cleanIp = cleanIp.slice(1, -1);
  }

  // Handle embedded IPv4 notation at the end, e.g. ::ffff:192.168.1.1
  const lastColon = cleanIp.lastIndexOf(':');
  if (lastColon !== -1) {
    const possibleIpv4 = cleanIp.slice(lastColon + 1);
    if (possibleIpv4.includes('.')) {
      const parts = possibleIpv4.split('.').map(p => Number(p));
      if (parts.length === 4 && parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
        const high = ((parts[0] << 8) | parts[1]).toString(16);
        const low = ((parts[2] << 8) | parts[3]).toString(16);
        cleanIp = cleanIp.slice(0, lastColon + 1) + high + ':' + low;
      } else {
        return null;
      }
    }
  }

  const doubleColonIndex = cleanIp.indexOf('::');
  let segments = [];
  if (doubleColonIndex !== -1) {
    if (cleanIp.indexOf('::', doubleColonIndex + 1) !== -1) {
      return null; // More than one '::' is invalid
    }
    const left = cleanIp.slice(0, doubleColonIndex).split(':').filter(Boolean);
    const right = cleanIp.slice(doubleColonIndex + 2).split(':').filter(Boolean);
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    const middle = new Array(missing).fill('0');
    segments = [...left, ...middle, ...right];
  } else {
    segments = cleanIp.split(':');
  }

  if (segments.length !== 8) return null;

  const words = [];
  for (const seg of segments) {
    if (seg.length === 0 || seg.length > 4) return null;
    const val = parseInt(seg, 16);
    if (isNaN(val) || val < 0 || val > 0xffff) return null;
    words.push(val);
  }

  return words;
}

/**
 * Checks if an IPv6 address is in a public, globally routable range.
 * @param {string} ip
 * @returns {boolean}
 */
export function isPublicIPv6(ip) {
  const words = parseIPv6(ip);
  if (!words) return false;

  // Unspecified address: ::
  if (words.every(w => w === 0)) return false;

  // Loopback address: ::1
  if (words.slice(0, 7).every(w => w === 0) && words[7] === 1) return false;

  // IPv4-mapped IPv6 address: ::ffff:a.b.c.d
  if (words.slice(0, 5).every(w => w === 0) && words[5] === 0xffff) {
    const a = words[6] >> 8;
    const b = words[6] & 0xff;
    const c = words[7] >> 8;
    const d = words[7] & 0xff;
    return isPublicIPv4(a, b, c, d);
  }

  // IPv4-compatible IPv6 (deprecated): ::a.b.c.d
  if (words.slice(0, 6).every(w => w === 0)) {
    const a = words[6] >> 8;
    const b = words[6] & 0xff;
    const c = words[7] >> 8;
    const d = words[7] & 0xff;
    return isPublicIPv4(a, b, c, d);
  }

  // Unique local addresses (ULA): fc00::/7 (0xfc00 to 0xfdff)
  if ((words[0] & 0xfe00) === 0xfc00) return false;

  // Link-local unicast: fe80::/10 (0xfe80 to 0xfebf)
  if ((words[0] & 0xffc0) === 0xfe80) return false;

  // Multicast: ff00::/8 (0xff00 to 0xffff)
  if ((words[0] & 0xff00) === 0xff00) return false;

  // Documentation: 2001:db8::/32
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;

  // Discard prefix: 100::/64
  if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return false;

  return true;
}

/**
 * Checks if an IP string (v4 or v6) is public and globally routable.
 * @param {string} ip
 * @returns {boolean}
 */
export function isPublicIP(ip) {
  if (typeof ip !== 'string') return false;
  let trimmed = ip.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    trimmed = trimmed.slice(1, -1);
  }
  const v = net.isIP(trimmed);
  if (v === 4) {
    const parts = trimmed.split('.').map(p => Number(p));
    return isPublicIPv4(parts[0], parts[1], parts[2], parts[3]);
  }
  if (v === 6) {
    return isPublicIPv6(trimmed);
  }
  return false;
}

const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home.arpa'
];

/**
 * Validates a URL for safety against SSRF and unsupported protocols/ports.
 * @param {string} urlStr
 * @param {Object} [options]
 * @param {Function} [options.dnsLookup] - Optional injectable DNS resolver
 * @returns {Promise<{ valid: boolean, url: URL, resolvedAddresses: Array<{ address: string, family: number }> }>}
 */
export async function validateUrlSafety(urlStr, options = {}) {
  if (typeof urlStr !== 'string' || urlStr.trim().length === 0) {
    throw new PageReaderError('INVALID_URL', 'URL must be a non-empty string');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlStr.trim());
  } catch {
    throw new PageReaderError('INVALID_URL', 'Malformed or unparseable URL');
  }

  // Protocol check
  const protocol = parsedUrl.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new PageReaderError('UNSUPPORTED_PROTOCOL', `Unsupported protocol: "${protocol}". Only http: and https: are allowed.`);
  }

  // Credentials check
  if (parsedUrl.username || parsedUrl.password) {
    throw new PageReaderError('URL_CREDENTIALS_NOT_ALLOWED', 'URL must not contain embedded username or password credentials.');
  }

  // Hostname check
  const hostname = parsedUrl.hostname;
  if (!hostname || hostname.trim().length === 0) {
    throw new PageReaderError('INVALID_URL', 'URL missing hostname');
  }

  const lowerHost = hostname.toLowerCase();

  // Local hostname checks
  if (lowerHost === 'localhost' || BLOCKED_HOST_SUFFIXES.some(suffix => lowerHost === suffix.replace(/^\./, '') || lowerHost.endsWith(suffix))) {
    throw new PageReaderError('LOCAL_OR_PRIVATE_HOST_BLOCKED', `Local or private hostname blocked: "${hostname}"`);
  }

  // Port check
  const port = parsedUrl.port;
  if (protocol === 'http:') {
    if (port !== '' && port !== '80') {
      throw new PageReaderError('PORT_NOT_ALLOWED', `Port ${port} is not allowed for HTTP. Only standard port 80 is permitted.`);
    }
  } else if (protocol === 'https:') {
    if (port !== '' && port !== '443') {
      throw new PageReaderError('PORT_NOT_ALLOWED', `Port ${port} is not allowed for HTTPS. Only standard port 443 is permitted.`);
    }
  }

  // Check if hostname is an IP literal
  const rawIpCandidate = lowerHost.startsWith('[') && lowerHost.endsWith(']')
    ? lowerHost.slice(1, -1)
    : lowerHost;

  const ipVersion = net.isIP(rawIpCandidate);
  if (ipVersion !== 0) {
    if (!isPublicIP(rawIpCandidate)) {
      throw new PageReaderError('LOCAL_OR_PRIVATE_HOST_BLOCKED', `Access to private or non-routable IP address blocked: "${rawIpCandidate}"`);
    }
    return {
      valid: true,
      url: parsedUrl,
      resolvedAddresses: [{ address: rawIpCandidate, family: ipVersion }]
    };
  }

  // Hostname is a domain name -> DNS resolution
  const dnsLookup = options.dnsLookup || (async (h) => {
    return await dnsPromises.lookup(h, { all: true, verbatim: true });
  });

  let resolved;
  try {
    resolved = await dnsLookup(hostname);
  } catch (err) {
    throw new PageReaderError('DNS_RESOLUTION_FAILED', `DNS resolution failed for hostname "${hostname}": ${err.message || 'Lookup error'}`);
  }

  if (!Array.isArray(resolved) || resolved.length === 0) {
    throw new PageReaderError('DNS_RESOLUTION_FAILED', `No DNS records found for hostname "${hostname}"`);
  }

  for (const record of resolved) {
    const ip = record.address;
    if (!isPublicIP(ip)) {
      throw new PageReaderError('LOCAL_OR_PRIVATE_HOST_BLOCKED', `Hostname "${hostname}" resolved to blocked non-public IP: "${ip}"`);
    }
  }

  return {
    valid: true,
    url: parsedUrl,
    resolvedAddresses: resolved
  };
}
