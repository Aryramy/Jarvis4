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

  const server = http.createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      let pathname = parsedUrl.pathname;

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
    close
  };
}
