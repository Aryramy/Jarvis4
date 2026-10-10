/**
 * Minimal local HTTP web server for JARVIS4 (Brick 2).
 * Serves the web interface and routes /api/text requests to handleText().
 */

import { createServer as createHttpServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { handleText } from '../core/textCore.js';
import { CheaperInferenceProvider } from '../providers/cheaperInference.js';
import { OpenRouterTextProvider } from '../providers/openRouterText.js';
import { OpenRouterSpeechToTextProvider } from '../providers/openRouterSTT.js';
import { OpenRouterTextToSpeechProvider } from '../providers/openRouterTTS.js';
import { OpenRouterSearchProvider, isFreshnessSensitiveQuery } from '../providers/openRouterSearch.js';
import { ConversationSession } from '../core/conversationSession.js';
import { ConversationStore } from '../core/conversationStore.js';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const HTML_FILE_PATH = join(__dirname, 'index.html');
const MICROPHONE_JS_PATH = join(__dirname, 'microphone.js');
const VOICE_TURN_JS_PATH = join(__dirname, 'voiceTurn.js');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;

/**
 * Creates the HTTP request listener.
 * @param {Object} [options]
 * @param {import('../providers/base.js').AIProvider} [options.provider]
 * @param {import('../providers/openRouterSTT.js').OpenRouterSpeechToTextProvider} [options.sttProvider]
 * @param {import('../providers/openRouterTTS.js').OpenRouterTextToSpeechProvider} [options.ttsProvider]
 * @param {import('../providers/openRouterSearch.js').OpenRouterSearchProvider} [options.searchProvider]
 * @param {import('../core/conversationSession.js').ConversationSession} [options.session]
 * @param {import('../core/conversationStore.js').ConversationStore} [options.store]
 * @returns {import('node:http').RequestListener}
 */
export function createRequestListener(options = {}) {
  let htmlContent = '';
  if (existsSync(HTML_FILE_PATH)) {
    htmlContent = readFileSync(HTML_FILE_PATH, 'utf8');
  }

  let microphoneJsContent = '';
  if (existsSync(MICROPHONE_JS_PATH)) {
    microphoneJsContent = readFileSync(MICROPHONE_JS_PATH, 'utf8');
  }

  let voiceTurnJsContent = '';
  if (existsSync(VOICE_TURN_JS_PATH)) {
    voiceTurnJsContent = readFileSync(VOICE_TURN_JS_PATH, 'utf8');
  }

  const store = options.store !== undefined
    ? options.store
    : (options.session ? null : new ConversationStore());
  const session = options.session || new ConversationSession();

  // Restore persisted messages on startup if session is not already populated
  if (store && session.size === 0) {
    try {
      const persisted = store.load();
      if (Array.isArray(persisted) && persisted.length > 0) {
        session.load(persisted);
      }
    } catch {
      // Safe fallback
    }
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

    // Route: GET /microphone.js (Brick 9 microphone module)
    if (url.pathname === '/microphone.js') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(microphoneJsContent);
      return;
    }

    // Route: GET /voiceTurn.js (Brick 13 voice turn runner module)
    if (url.pathname === '/voiceTurn.js') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(voiceTurnJsContent);
      return;
    }

    // Route: /api/text (Brick 2 deterministic endpoint)
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

    // Route: /api/ai/stream (Brick 5 streaming AI endpoint & Brick 7 streaming conversation context)
    if (url.pathname === '/api/ai/stream') {
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
          isTooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          req.destroy();
        }
      });

      req.on('end', async () => {
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
        if (typeof input !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Input must be a string' }));
          return;
        }

        const trimmedInput = input.trim();
        if (trimmedInput.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Input cannot be empty' }));
          return;
        }

        const provider = options.provider || new OpenRouterTextProvider();

        const configCheck = provider.validateConfig ? provider.validateConfig() : { valid: true };
        if (!configCheck.valid) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `Configuration error: ${configCheck.error}`
          }));
          return;
        }

        let userTurnAdded = false;
        let streamCompletedCleanly = false;
        let accumulatedText = '';
        let clientDisconnected = false;

        const rollbackUserTurn = () => {
          if (userTurnAdded && !streamCompletedCleanly) {
            session.pop();
            userTurnAdded = false;
          }
        };

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Transfer-Encoding': 'chunked'
        });

        res.on('close', () => {
          if (!res.writableEnded) {
            clientDisconnected = true;
            rollbackUserTurn();
          }
        });

        try {
          // Add user message to session context
          session.addUserMessage(trimmedInput);
          userTurnAdded = true;

          const messages = session.getMessages();

          const streamSource = typeof provider.streamMessages === 'function'
            ? provider.streamMessages(messages)
            : provider.stream(trimmedInput);

          for await (const delta of streamSource) {
            if (clientDisconnected || res.destroyed || res.writableEnded) {
              break;
            }
            accumulatedText += delta;
            res.write(JSON.stringify({ type: 'delta', text: delta }) + '\n');
          }

          if (!res.writableEnded && !clientDisconnected) {
            streamCompletedCleanly = true;
            // Store accumulated assistant response only after clean completion
            session.addAssistantMessage(accumulatedText);

            if (store) {
              try {
                store.save(session.getMessages());
              } catch {
                // Safe fallback
              }
            }

            res.write(JSON.stringify({ type: 'done' }) + '\n');
            res.end();
          } else {
            rollbackUserTurn();
            if (!res.writableEnded) {
              res.end();
            }
          }
        } catch (err) {
          // Stream error occurred: roll back user turn to keep conversation state uncorrupted
          rollbackUserTurn();

          if (!res.writableEnded && !clientDisconnected) {
            let safeError = err.message || 'Stream request failed';
            const apiKeyToRedact = provider.apiKey || process.env.OPENROUTER_API_KEY || process.env.CHEAPER_INFERENCE_API_KEY;
            if (apiKeyToRedact) {
              safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
            }
            res.write(JSON.stringify({ type: 'error', message: safeError }) + '\n');
            res.end();
          }
        }
      });

      return;
    }

    // Route: /api/conversation/clear (Brick 6 clear conversation endpoint)
    if (url.pathname === '/api/conversation/clear') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      req.on('data', () => {});
      req.on('end', () => {
        session.clear();
        if (store) {
          try {
            store.clear();
          } catch {
            // Safe fallback
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });

      return;
    }

    // Route: /api/ai (Brick 4 real AI endpoint & Brick 6 conversation context)
    if (url.pathname === '/api/ai') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      const requestStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

      const getServerAiDurationMs = () => {
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();
        return Math.max(0, Math.round(now - requestStartTime));
      };

      let body = '';
      let isTooLarge = false;

      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1e6) {
          isTooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          req.destroy();
        }
      });

      req.on('end', async () => {
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
        if (typeof input !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Input must be a string' }));
          return;
        }

        const trimmedInput = input.trim();
        if (trimmedInput.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Input cannot be empty' }));
          return;
        }

        let userTurnAdded = false;

        try {
          const provider = options.provider || new OpenRouterTextProvider();

          const configCheck = provider.validateConfig ? provider.validateConfig() : { valid: true };
          if (!configCheck.valid) {
            const serverAiDurationMs = getServerAiDurationMs();
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: `Configuration error: ${configCheck.error}`,
              timing: { serverAiDurationMs },
              serverAiDurationMs
            }));
            return;
          }

          // Add user message to session context
          session.addUserMessage(trimmedInput);
          userTurnAdded = true;

          const messages = session.getMessages();

          const result = typeof provider.generateMessages === 'function'
            ? await provider.generateMessages(messages)
            : await provider.generate(trimmedInput);

          const serverAiDurationMs = getServerAiDurationMs();
          const providerDurationMs = typeof result.providerDurationMs === 'number'
            ? result.providerDurationMs
            : (typeof result.durationMs === 'number' ? result.durationMs : 0);

          if (result.success) {
            // Store assistant response in session context
            session.addAssistantMessage(result.text);

            if (store) {
              try {
                store.save(session.getMessages());
              } catch {
                // Safe fallback
              }
            }

            const timing = {
              providerDurationMs,
              serverAiDurationMs
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              response: result.text,
              provider: result.provider || (provider instanceof OpenRouterTextProvider ? 'openrouter' : (provider.name || 'custom')),
              model: result.model || provider.model,
              timing,
              providerDurationMs,
              serverAiDurationMs
            }));
          } else {
            // Provider failed: roll back user turn so context remains clean and uncorrupted
            if (userTurnAdded) {
              session.pop();
            }

            let safeError = result.error || 'Provider request failed';
            const apiKeyToRedact = provider.apiKey || process.env.OPENROUTER_API_KEY || process.env.CHEAPER_INFERENCE_API_KEY;
            if (apiKeyToRedact) {
              safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
            }

            const timing = {
              serverAiDurationMs
            };
            if (typeof result.providerDurationMs === 'number') {
              timing.providerDurationMs = result.providerDurationMs;
            }

            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: safeError,
              timing,
              providerDurationMs: timing.providerDurationMs,
              serverAiDurationMs
            }));
          }
        } catch (err) {
          // Exception occurred: roll back user turn so context remains clean and uncorrupted
          if (userTurnAdded) {
            session.pop();
          }

          const serverAiDurationMs = getServerAiDurationMs();
          let safeError = err.message || 'Internal server error';
          const apiKeyToRedact = (options.provider && options.provider.apiKey) || process.env.OPENROUTER_API_KEY || process.env.CHEAPER_INFERENCE_API_KEY;
          if (apiKeyToRedact) {
            safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: safeError,
            timing: { serverAiDurationMs },
            serverAiDurationMs
          }));
        }
      });

      return;
    }

    // Route: /api/search (Brick 19 explicit web search endpoint)
    if (url.pathname === '/api/search') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      const requestStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

      const getServerSearchDurationMs = () => {
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();
        return Math.max(0, Math.round(now - requestStartTime));
      };

      let body = '';
      let isTooLarge = false;

      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1e6) {
          isTooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          req.destroy();
        }
      });

      req.on('end', async () => {
        if (isTooLarge) return;

        let parsedBody;
        try {
          parsedBody = body ? JSON.parse(body) : {};
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
          return;
        }

        const prompt = parsedBody.prompt ?? parsedBody.input;
        if (typeof prompt !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Prompt must be a string' }));
          return;
        }

        const trimmedPrompt = prompt.trim();
        if (trimmedPrompt.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Prompt cannot be empty' }));
          return;
        }

        try {
          const provider = options.searchProvider || new OpenRouterSearchProvider();

          const configCheck = provider.validateConfig ? provider.validateConfig() : { valid: true };
          if (!configCheck.valid) {
            const serverSearchDurationMs = getServerSearchDurationMs();
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: `Configuration error: ${configCheck.error}`,
              searchUsed: false,
              searchRequests: null,
              searchEvidence: 'none',
              sources: [],
              currentDate: new Date().toISOString().slice(0, 10),
              freshnessSensitive: isFreshnessSensitiveQuery(trimmedPrompt),
              newestSourceDate: null,
              freshnessStatus: 'unknown',
              timing: {
                serverSearchDurationMs,
                providerSearchDurationMs: 0,
                providerDurationMs: 0
              },
              serverSearchDurationMs,
              providerSearchDurationMs: 0
            }));
            return;
          }

          const result = await provider.search(trimmedPrompt);

          const serverSearchDurationMs = getServerSearchDurationMs();
          const providerSearchDurationMs = typeof result.providerSearchDurationMs === 'number'
            ? result.providerSearchDurationMs
            : (typeof result.providerDurationMs === 'number' ? result.providerDurationMs : 0);

          const timing = {
            providerSearchDurationMs,
            serverSearchDurationMs,
            providerDurationMs: providerSearchDurationMs
          };

          if (result.success) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              response: result.response || result.text,
              provider: result.provider || 'openrouter',
              model: result.model || 'deepseek/deepseek-v4-flash-0731',
              searchUsed: Boolean(result.searchUsed),
              searchRequests: (typeof result.searchRequests === 'number' && Number.isFinite(result.searchRequests)) ? result.searchRequests : null,
              searchEvidence: result.searchEvidence || 'none',
              sources: Array.isArray(result.sources) ? result.sources : [],
              currentDate: result.currentDate || new Date().toISOString().slice(0, 10),
              freshnessSensitive: Boolean(result.freshnessSensitive),
              newestSourceDate: result.newestSourceDate ?? null,
              freshnessStatus: result.freshnessStatus || 'unknown',
              providerFinishReason: result.providerFinishReason ?? null,
              hasMessage: Boolean(result.hasMessage),
              hasMessageContent: Boolean(result.hasMessageContent),
              contentType: result.contentType || 'string',
              hasToolCalls: Boolean(result.hasToolCalls),
              hasReasoning: Boolean(result.hasReasoning),
              annotationCount: typeof result.annotationCount === 'number' ? result.annotationCount : 0,
              timing,
              providerSearchDurationMs,
              serverSearchDurationMs
            }));
          } else {
            let safeError = result.error || 'Search request failed';
            const apiKeyToRedact = provider.apiKey || process.env.OPENROUTER_API_KEY;
            if (apiKeyToRedact) {
              safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
            }

            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: safeError,
              searchUsed: Boolean(result.searchUsed),
              searchRequests: (typeof result.searchRequests === 'number' && Number.isFinite(result.searchRequests)) ? result.searchRequests : null,
              searchEvidence: result.searchEvidence || 'none',
              sources: Array.isArray(result.sources) ? result.sources : [],
              currentDate: result.currentDate || new Date().toISOString().slice(0, 10),
              freshnessSensitive: typeof result.freshnessSensitive === 'boolean' ? result.freshnessSensitive : isFreshnessSensitiveQuery(trimmedPrompt),
              newestSourceDate: result.newestSourceDate ?? null,
              freshnessStatus: result.freshnessStatus || 'unknown',
              providerFinishReason: result.providerFinishReason ?? null,
              hasMessage: Boolean(result.hasMessage),
              hasMessageContent: Boolean(result.hasMessageContent),
              contentType: result.contentType || 'none',
              hasToolCalls: Boolean(result.hasToolCalls),
              hasReasoning: Boolean(result.hasReasoning),
              annotationCount: typeof result.annotationCount === 'number' ? result.annotationCount : 0,
              timing,
              serverSearchDurationMs,
              providerSearchDurationMs
            }));
          }
        } catch (err) {
          const serverSearchDurationMs = getServerSearchDurationMs();
          let safeError = err.message || 'Internal server error';
          const apiKeyToRedact = (options.searchProvider && options.searchProvider.apiKey) || process.env.OPENROUTER_API_KEY;
          if (apiKeyToRedact) {
            safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: safeError,
            searchUsed: false,
            searchRequests: null,
            searchEvidence: 'none',
            sources: [],
            currentDate: new Date().toISOString().slice(0, 10),
            freshnessSensitive: typeof prompt === 'string' ? isFreshnessSensitiveQuery(prompt) : false,
            newestSourceDate: null,
            freshnessStatus: 'unknown',
            timing: {
              serverSearchDurationMs,
              providerSearchDurationMs: 0,
              providerDurationMs: 0
            },
            serverSearchDurationMs,
            providerSearchDurationMs: 0
          }));
        }
      });

      return;
    }

    // Route: /api/stt (Brick 10 multilingual STT endpoint & Brick 18 STT Latency Instrumentation)
    if (url.pathname === '/api/stt') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      const requestStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

      const getServerSttDurationMs = () => {
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();
        return Math.max(0, Math.round(now - requestStartTime));
      };

      const contentType = req.headers['content-type'] || '';
      const chunks = [];
      let totalLength = 0;
      let isTooLarge = false;
      const MAX_STT_BYTES = 25 * 1024 * 1024; // 25 MB limit for speech transcription

      req.on('data', (chunk) => {
        totalLength += chunk.length;
        if (totalLength > MAX_STT_BYTES) {
          isTooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', async () => {
        if (isTooLarge) return;

        try {
          const bodyBuffer = Buffer.concat(chunks);
          let audioBuffer = null;
          let mimeType = 'audio/webm';
          let filename = 'recording.webm';
          let clientAudioDurationMs = null;

          const durationHeader = req.headers['x-audio-duration-ms'];
          if (durationHeader) {
            const parsed = Number(durationHeader);
            if (!Number.isNaN(parsed) && parsed >= 0) {
              clientAudioDurationMs = parsed;
            }
          }

          if (contentType.toLowerCase().startsWith('multipart/form-data')) {
            const stream = Readable.toWeb(Readable.from([bodyBuffer]));
            const webRequest = new Request('http://localhost', {
              method: 'POST',
              headers: req.headers,
              body: stream,
              duplex: 'half'
            });

            let formData;
            try {
              formData = await webRequest.formData();
            } catch (err) {
              const serverSttDurationMs = getServerSttDurationMs();
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: `Malformed multipart form data: ${err.message}`,
                timing: { serverSttDurationMs },
                serverSttDurationMs
              }));
              return;
            }

            const durField = formData.get('audioDurationMs') || formData.get('durationMs');
            if (durField) {
              const parsed = Number(durField);
              if (!Number.isNaN(parsed) && parsed >= 0) {
                clientAudioDurationMs = parsed;
              }
            }

            const file = formData.get('audio') || formData.get('file');
            if (!file || typeof file.arrayBuffer !== 'function') {
              const serverSttDurationMs = getServerSttDurationMs();
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: 'Audio file is required in multipart upload',
                timing: { serverSttDurationMs },
                serverSttDurationMs
              }));
              return;
            }

            const arrayBuffer = await file.arrayBuffer();
            audioBuffer = Buffer.from(arrayBuffer);
            mimeType = file.type || 'audio/webm';
            filename = file.name || 'recording.webm';
          } else if (contentType.toLowerCase().startsWith('audio/')) {
            audioBuffer = bodyBuffer;
            mimeType = contentType.split(';')[0].trim();
            filename = 'recording.webm';
          } else {
            const serverSttDurationMs = getServerSttDurationMs();
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: 'Invalid Content-Type. Expected audio/* or multipart/form-data',
              timing: { serverSttDurationMs },
              serverSttDurationMs
            }));
            return;
          }

          if (!audioBuffer || audioBuffer.length === 0) {
            const serverSttDurationMs = getServerSttDurationMs();
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: 'Audio data cannot be empty (0 bytes)',
              timing: { serverSttDurationMs },
              serverSttDurationMs
            }));
            return;
          }

          if (mimeType && !mimeType.toLowerCase().startsWith('audio/')) {
            const serverSttDurationMs = getServerSttDurationMs();
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: `Invalid audio MIME type: ${mimeType}`,
              timing: { serverSttDurationMs },
              serverSttDurationMs
            }));
            return;
          }

          const sttProvider = options.sttProvider || new OpenRouterSpeechToTextProvider();
          const configCheck = sttProvider.validateConfig ? sttProvider.validateConfig() : { valid: true };
          if (!configCheck.valid) {
            const serverSttDurationMs = getServerSttDurationMs();
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: `Configuration error: ${configCheck.error}`,
              timing: { serverSttDurationMs },
              serverSttDurationMs,
              providerSttDurationMs: 0
            }));
            return;
          }

          const result = await sttProvider.transcribe(audioBuffer, { mimeType, filename });
          const serverSttDurationMs = getServerSttDurationMs();
          const providerSttDurationMs = typeof result.providerSttDurationMs === 'number'
            ? result.providerSttDurationMs
            : (typeof result.durationMs === 'number' ? result.durationMs : 0);

          const timing = {
            providerSttDurationMs,
            serverSttDurationMs
          };

          if (result.success) {
            const responsePayload = {
              success: true,
              transcript: result.text,
              text: result.text,
              provider: result.provider || 'openrouter',
              model: result.model || sttProvider.model,
              timing,
              providerSttDurationMs,
              serverSttDurationMs,
              durationMs: result.durationMs !== undefined ? result.durationMs : providerSttDurationMs,
              audioDurationMs: clientAudioDurationMs,
              audioSizeBytes: audioBuffer.length,
              audioMimeType: mimeType,
              audio: {
                audioDurationMs: clientAudioDurationMs,
                audioSizeBytes: audioBuffer.length,
                audioMimeType: mimeType
              }
            };
            if (result.language) {
              responsePayload.language = result.language;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));
          } else {
            let safeError = result.error || 'Transcription failed';
            const apiKeyToRedact = sttProvider.apiKey || process.env.OPENROUTER_API_KEY;
            if (apiKeyToRedact) {
              safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
            }

            const errorTiming = {
              serverSttDurationMs
            };
            if (typeof result.providerSttDurationMs === 'number') {
              errorTiming.providerSttDurationMs = result.providerSttDurationMs;
            }

            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: safeError,
              provider: result.provider || 'openrouter',
              model: result.model || sttProvider.model,
              timing: errorTiming,
              providerSttDurationMs: errorTiming.providerSttDurationMs ?? providerSttDurationMs,
              serverSttDurationMs,
              durationMs: result.durationMs !== undefined ? result.durationMs : providerSttDurationMs,
              audioDurationMs: clientAudioDurationMs,
              audioSizeBytes: audioBuffer?.length ?? 0,
              audioMimeType: mimeType,
              audio: {
                audioDurationMs: clientAudioDurationMs,
                audioSizeBytes: audioBuffer?.length ?? 0,
                audioMimeType: mimeType
              }
            }));
          }
        } catch (err) {
          const serverSttDurationMs = getServerSttDurationMs();
          let safeError = err.message || 'Internal server error';
          const apiKeyToRedact = (options.sttProvider && options.sttProvider.apiKey) || process.env.OPENROUTER_API_KEY;
          if (apiKeyToRedact) {
            safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: safeError,
            timing: { serverSttDurationMs },
            serverSttDurationMs
          }));
        }
      });

      return;
    }

    // Route: /api/tts (Brick 12 multilingual TTS endpoint)
    if (url.pathname === '/api/tts') {
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
          isTooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          req.destroy();
        }
      });

      req.on('end', async () => {
        if (isTooLarge) return;

        let parsedBody;
        try {
          parsedBody = body ? JSON.parse(body) : {};
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
          return;
        }

        const text = parsedBody.text !== undefined ? parsedBody.text : parsedBody.input;
        if (typeof text !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Text input must be a string' }));
          return;
        }

        const trimmedText = text.trim();
        if (trimmedText.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Text input cannot be empty or whitespace-only' }));
          return;
        }

        if (text.length > 5000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Text input exceeds maximum allowed length of 5000 characters' }));
          return;
        }

        const ttsProvider = options.ttsProvider || new OpenRouterTextToSpeechProvider();
        const configCheck = ttsProvider.validateConfig ? ttsProvider.validateConfig() : { valid: true };
        if (!configCheck.valid) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `Configuration error: ${configCheck.error}`
          }));
          return;
        }

        try {
          const result = await ttsProvider.synthesize(text);

          if (result.success) {
            res.writeHead(200, {
              'Content-Type': result.mimeType || 'audio/mpeg',
              'Content-Length': result.audioBytes.length,
              'X-TTS-Duration-Ms': String(result.durationMs ?? 0),
              'Cache-Control': 'no-store'
            });
            res.end(result.audioBytes);
          } else {
            let safeError = result.error || 'TTS synthesis failed';
            const apiKeyToRedact = ttsProvider.apiKey || process.env.OPENROUTER_API_KEY;
            if (apiKeyToRedact) {
              safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
            }
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: safeError,
              durationMs: result.durationMs
            }));
          }
        } catch (err) {
          let safeError = err.message || 'Internal server error';
          const apiKeyToRedact = (options.ttsProvider && options.ttsProvider.apiKey) || process.env.OPENROUTER_API_KEY;
          if (apiKeyToRedact) {
            safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: safeError
          }));
        }
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
 * @param {Object} [options]
 * @returns {import('node:http').Server}
 */
export function createServer(options = {}) {
  return createHttpServer(createRequestListener(options));
}

/**
 * Starts the server on the specified port and host.
 * @param {number} [port]
 * @param {string} [host]
 * @param {Object} [options]
 * @returns {Promise<import('node:http').Server>}
 */
export function startServer(port = Number(process.env.PORT) || DEFAULT_PORT, host = DEFAULT_HOST, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer(options);

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
