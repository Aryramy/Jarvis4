/**
 * Minimal local HTTP web server for JARVIS4 (Brick 2).
 * Serves the web interface and routes /api/text requests to handleText().
 */

import { createServer as createHttpServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleText } from '../core/textCore.js';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const HTML_FILE_PATH = join(__dirname, 'index.html');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;

/**
 * Creates the HTTP request listener.
 * @returns {import('node:http').RequestListener}
 */
export function createRequestListener() {
  let htmlContent = '';
  if (existsSync(HTML_FILE_PATH)) {
    htmlContent = readFileSync(HTML_FILE_PATH, 'utf8');
  }

  return (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Route: GET /
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(htmlContent);
      return;
    }

    // Route: /api/text
    if (url.pathname === '/api/text') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      let body = '';
      let isTooLarge = false;

      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1e6) {
          // 1MB limit for safety
          isTooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          req.destroy();
        }
      });

      req.on('end', () => {
        if (isTooLarge) return;

        let parsedBody;
        try {
          parsedBody = body ? JSON.parse(body) : {};
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
          return;
        }

        const input = parsedBody.input;
        const result = handleText(input);

        const statusCode = result.success ? 200 : 400;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });

      return;
    }

    // Route: 404 Not Found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Not Found' }));
  };
}

/**
 * Creates the HTTP server instance.
 * @returns {import('node:http').Server}
 */
export function createServer() {
  return createHttpServer(createRequestListener());
}

/**
 * Starts the server on the specified port and host.
 * @param {number} [port]
 * @param {string} [host]
 * @returns {Promise<import('node:http').Server>}
 */
export function startServer(port = Number(process.env.PORT) || DEFAULT_PORT, host = DEFAULT_HOST) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();

    server.once('error', (err) => {
      rejectPromise(err);
    });

    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      console.log(`JARVIS4 web interface running at http://${host}:${actualPort}`);
      resolvePromise(server);
    });
  });
}

// Start server if executed directly
const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  startServer().catch((err) => {
    console.error('Failed to start web server:', err.message);
    process.exit(1);
  });
}

export default {
  createServer,
  startServer,
  createRequestListener
};
