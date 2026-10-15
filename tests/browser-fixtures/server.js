/**
 * Deterministic local loopback HTTP fixture server for automated real-browser verification.
 * 
 * Invariants:
 * - Binds ONLY to 127.0.0.1 (loopback).
 * - Ephemeral port (0) by default to prevent port collision.
 * - Serves files strictly from tests/browser-fixtures.
 * - No external network dependencies.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Starts a local HTTP server binding strictly to 127.0.0.1.
 * 
 * @param {Object} [options]
 * @param {number} [options.port=0] - 0 for ephemeral
 * @returns {Promise<{ server: http.Server, port: number, baseUrl: string, close: () => Promise<void> }>}
 */
export async function startFixtureServer(options = {}) {
  const sockets = new Set();
  let submitCount = 0;
  let lastSubmittedData = null;
  const submissions = [];

  const server = http.createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      let pathname = parsedUrl.pathname;

      // Handle test-only form POST endpoints (Brick 34)
      if (req.method === 'POST') {
        if (pathname === '/submit-form-target' || pathname === '/api/test/submit') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            submitCount++;
            lastSubmittedData = body;
            submissions.push({ pathname, body, time: Date.now() });

            if (pathname === '/submit-form-target') {
              res.writeHead(303, { 'Location': '/submitted.html' });
              res.end();
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ success: true, count: submitCount }));
            }
          });
          return;
        }
      }

      if (req.method === 'GET' && pathname === '/api/test/submit-count') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ count: submitCount }));
        return;
      }

      // File Download Fixture Routes (Brick 37)
      if (pathname.startsWith('/api/download/')) {
        const sub = pathname.replace('/api/download/', '');
        if (sub === 'sample.txt') {
          const content = Buffer.from('Hello JARVIS safe download fixture\n');
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': content.length,
            'Content-Disposition': 'attachment; filename="sample.txt"',
            'Cache-Control': 'no-store'
          });
          res.end(content);
          return;
        }

        if (sub === 'report.pdf') {
          const content = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\nxref\n0 1\ntrailer<</Size 1/Root 1 0 R>>\nstartxref\n9\n%%EOF');
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': content.length,
            'Content-Disposition': 'attachment; filename="report.pdf"',
            'Cache-Control': 'no-store'
          });
          res.end(content);
          return;
        }

        if (sub === 'large.bin') {
          const size = Number(parsedUrl.searchParams.get('size') || 100000); // 100 KB
          const content = Buffer.alloc(size, 0x41);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': content.length,
            'Content-Disposition': 'attachment; filename="large.bin"',
            'Cache-Control': 'no-store'
          });
          res.end(content);
          return;
        }

        if (sub === 'dangerous') {
          const name = parsedUrl.searchParams.get('name') || 'evil.txt';
          const content = Buffer.from('Dangerous name fixture test\n');
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': content.length,
            'Content-Disposition': `attachment; filename="${name}"`,
            'Cache-Control': 'no-store'
          });
          res.end(content);
          return;
        }

        if (sub === 'malicious.exe') {
          const content = Buffer.from('MZ fake executable header\n');
          res.writeHead(200, {
            'Content-Type': 'application/x-msdownload',
            'Content-Length': content.length,
            'Content-Disposition': 'attachment; filename="malicious.exe"',
            'Cache-Control': 'no-store'
          });
          res.end(content);
          return;
        }
      }

      // Auth Fixture Routes (Brick 35)
      if (pathname === '/auth/do-login') {
        const user = parsedUrl.searchParams.get('user') || 'UserA';
        const isExpired = parsedUrl.searchParams.get('expired') === 'true';

        let cookieHeader;
        if (isExpired) {
          cookieHeader = 'jarvis_session=synth_expired_token; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax';
        } else {
          cookieHeader = `jarvis_session=synth_token_${encodeURIComponent(user)}; Path=/; HttpOnly; SameSite=Lax`;
        }

        res.writeHead(302, {
          'Location': '/auth/protected',
          'Set-Cookie': cookieHeader,
          'Cache-Control': 'no-store, no-cache'
        });
        res.end();
        return;
      }

      if (pathname === '/auth/logout') {
        res.writeHead(302, {
          'Location': '/auth/login',
          'Set-Cookie': 'jarvis_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
          'Cache-Control': 'no-store, no-cache'
        });
        res.end();
        return;
      }

      if (pathname === '/auth/protected') {
        const rawCookies = req.headers.cookie || '';
        const match = rawCookies.match(/(?:^|;\s*)jarvis_session=([^;]+)/);
        const sessionToken = match ? decodeURIComponent(match[1]) : null;

        const isAuthenticated = sessionToken && sessionToken.startsWith('synth_token_') && !sessionToken.includes('expired');
        const user = isAuthenticated ? sessionToken.replace('synth_token_', '') : null;

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${isAuthenticated ? 'Authenticated Fixture' : 'Authentication Required'}</title>
</head>
<body>
  <h1 id="page-heading">${isAuthenticated ? 'Authenticated Fixture' : 'Authentication Required'}</h1>
  <div id="auth-status">${isAuthenticated ? 'Authenticated Fixture' : 'Authentication Required'}</div>
  <div id="user-display">User: ${isAuthenticated ? user : 'None'}</div>
  <div id="localstorage-marker">Marker: Checking...</div>
  <div style="margin-top: 12px;">
    ${isAuthenticated ? '<a id="logout-link" href="/auth/logout">Log Out</a>' : '<a id="login-link" href="/auth/login">Log In</a>'}
  </div>
  <script>
    const userVal = ${JSON.stringify(user)};
    if (userVal) {
      if (!localStorage.getItem('jarvis_marker')) {
        localStorage.setItem('jarvis_marker', 'synth_marker_' + userVal);
      }
    } else {
      localStorage.removeItem('jarvis_marker');
    }
    const marker = localStorage.getItem('jarvis_marker');
    document.getElementById('localstorage-marker').textContent = 'Marker: ' + (marker || 'None');
  </script>
</body>
</html>`;

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache'
        });
        res.end(html);
        return;
      }

      if (pathname === '/auth/login') {
        pathname = '/auth-login.html';
      }

      if (pathname === '/' || pathname === '') {
        pathname = '/static.html';
      }

      // SPA routing fallback: if requesting subpaths like /dashboard or /settings, serve spa-routing.html
      if (pathname.startsWith('/dashboard') || pathname.startsWith('/settings') || pathname.startsWith('/profile')) {
        pathname = '/spa-routing.html';
      }

      const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      let filePath = path.join(__dirname, safePath);

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        if (fs.existsSync(path.join(__dirname, 'spa-routing.html'))) {
          filePath = path.join(__dirname, 'spa-routing.html');
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Fixture Not Found');
          return;
        }
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(content),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Server Error: ${err.message}`);
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.listen(options.port || 0, '127.0.0.1', () => {
      resolve();
    });
    server.on('error', reject);
  });

  const address = server.address();
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const close = async () => {
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {}
    }
    sockets.clear();
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    server,
    port,
    baseUrl,
    close,
    getSubmitCount: () => submitCount,
    resetSubmitCount: () => {
      submitCount = 0;
      lastSubmittedData = null;
      submissions.length = 0;
    },
    getLastSubmittedData: () => lastSubmittedData,
    getSubmissions: () => [...submissions]
  };
}
