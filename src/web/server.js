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
import { decideSearchRoute } from '../routing/searchDecision.js';
import { readWebPage } from '../webpage/pageReader.js';
import { PageReaderError } from '../webpage/urlSafety.js';
import { executePageQa, PageQaError } from '../webpage/pageQa.js';
import { executeResearchOne, ResearchOneError } from '../research/researchOne.js';

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

    /**
     * Executes internal AI request logic.
     * Reused by /api/ai and /api/auto.
     */
    async function executeAiRequest({ input, provider, session, store, requestStartTime }) {
      const getServerAiDurationMs = () => {
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();
        return Math.max(0, Math.round(now - requestStartTime));
      };

      const configCheck = provider.validateConfig ? provider.validateConfig() : { valid: true };
      if (!configCheck.valid) {
        const serverAiDurationMs = getServerAiDurationMs();
        return {
          statusCode: 500,
          body: {
            success: false,
            error: `Configuration error: ${configCheck.error}`,
            timing: { serverAiDurationMs },
            serverAiDurationMs
          }
        };
      }

      let userTurnAdded = false;
      try {
        session.addUserMessage(input);
        userTurnAdded = true;

        const messages = session.getMessages();
        const result = typeof provider.generateMessages === 'function'
          ? await provider.generateMessages(messages)
          : await provider.generate(input);

        const serverAiDurationMs = getServerAiDurationMs();
        const providerDurationMs = typeof result.providerDurationMs === 'number'
          ? result.providerDurationMs
          : (typeof result.durationMs === 'number' ? result.durationMs : 0);

        if (result.success) {
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
          return {
            statusCode: 200,
            body: {
              success: true,
              response: result.text,
              provider: result.provider || (provider instanceof OpenRouterTextProvider ? 'openrouter' : (provider.name || 'custom')),
              model: result.model || provider.model,
              timing,
              providerDurationMs,
              serverAiDurationMs
            }
          };
        } else {
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
          return {
            statusCode: 500,
            body: {
              success: false,
              error: safeError,
              timing,
              providerDurationMs: timing.providerDurationMs,
              serverAiDurationMs
            }
          };
        }
      } catch (err) {
        if (userTurnAdded) {
          session.pop();
        }
        const serverAiDurationMs = getServerAiDurationMs();
        let safeError = err.message || 'Internal server error';
        const apiKeyToRedact = provider.apiKey || process.env.OPENROUTER_API_KEY || process.env.CHEAPER_INFERENCE_API_KEY;
        if (apiKeyToRedact) {
          safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
        }
        return {
          statusCode: 500,
          body: {
            success: false,
            error: safeError,
            timing: { serverAiDurationMs },
            serverAiDurationMs
          }
        };
      }
    }

    /**
     * Executes internal search request logic.
     * Reused by /api/search and /api/auto.
     */
    async function executeSearchRequest({ prompt, searchProvider, requestStartTime }) {
      const getServerSearchDurationMs = () => {
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();
        return Math.max(0, Math.round(now - requestStartTime));
      };

      const configCheck = searchProvider.validateConfig ? searchProvider.validateConfig() : { valid: true };
      if (!configCheck.valid) {
        const serverSearchDurationMs = getServerSearchDurationMs();
        return {
          statusCode: 500,
          body: {
            success: false,
            error: `Configuration error: ${configCheck.error}`,
            searchUsed: false,
            searchRequests: null,
            searchEvidence: 'none',
            sources: [],
            currentDate: new Date().toISOString().slice(0, 10),
            freshnessSensitive: isFreshnessSensitiveQuery(prompt),
            newestSourceDate: null,
            freshnessStatus: 'unknown',
            timing: {
              serverSearchDurationMs,
              providerSearchDurationMs: 0,
              providerDurationMs: 0
            },
            serverSearchDurationMs,
            providerSearchDurationMs: 0
          }
        };
      }

      try {
        const result = await searchProvider.search(prompt);
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
          return {
            statusCode: 200,
            body: {
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
            }
          };
        } else {
          let safeError = result.error || 'Search request failed';
          const apiKeyToRedact = searchProvider.apiKey || process.env.OPENROUTER_API_KEY;
          if (apiKeyToRedact) {
            safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
          }
          return {
            statusCode: 500,
            body: {
              success: false,
              error: safeError,
              searchUsed: Boolean(result.searchUsed),
              searchRequests: (typeof result.searchRequests === 'number' && Number.isFinite(result.searchRequests)) ? result.searchRequests : null,
              searchEvidence: result.searchEvidence || 'none',
              sources: Array.isArray(result.sources) ? result.sources : [],
              currentDate: result.currentDate || new Date().toISOString().slice(0, 10),
              freshnessSensitive: typeof result.freshnessSensitive === 'boolean' ? result.freshnessSensitive : isFreshnessSensitiveQuery(prompt),
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
            }
          };
        }
      } catch (err) {
        const serverSearchDurationMs = getServerSearchDurationMs();
        let safeError = err.message || 'Internal server error';
        const apiKeyToRedact = searchProvider.apiKey || process.env.OPENROUTER_API_KEY;
        if (apiKeyToRedact) {
          safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
        }
        return {
          statusCode: 500,
          body: {
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
          }
        };
      }
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

        const input = parsedBody.input ?? parsedBody.text;
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
        const result = await executeAiRequest({
          input: trimmedInput,
          provider,
          session,
          store,
          requestStartTime
        });

        res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
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

        const prompt = parsedBody.prompt ?? parsedBody.input ?? parsedBody.text;
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

        const searchProvider = options.searchProvider || new OpenRouterSearchProvider();
        const result = await executeSearchRequest({
          prompt: trimmedPrompt,
          searchProvider,
          requestStartTime
        });

        res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      });

      return;
    }

    // Route: /api/auto (Brick 20 automatic search decision endpoint)
    if (url.pathname === '/api/auto') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      const requestStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

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

        const text = parsedBody.text ?? parsedBody.input ?? parsedBody.prompt;
        if (typeof text !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Input must be a string' }));
          return;
        }

        const trimmedText = text.trim();
        if (trimmedText.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Input cannot be empty' }));
          return;
        }

        const routeStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();
        const decisionFn = options.searchDecisionFn || decideSearchRoute;
        const decision = decisionFn(trimmedText);
        const routeEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();
        const routeDecisionMs = Math.max(0.001, Number((routeEndTime - routeStartTime).toFixed(3)));

        if (decision.route === 'search') {
          const searchProvider = options.searchProvider || new OpenRouterSearchProvider();
          const result = await executeSearchRequest({
            prompt: trimmedText,
            searchProvider,
            requestStartTime
          });
          const responseBody = {
            ...result.body,
            route: 'search',
            routeReason: decision.reason,
            routeDecisionMs,
            timing: {
              ...(result.body.timing || {}),
              routeDecisionMs
            }
          };
          res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseBody));
        } else {
          const provider = options.provider || new OpenRouterTextProvider();
          const result = await executeAiRequest({
            input: trimmedText,
            provider,
            session,
            store,
            requestStartTime
          });
          const responseBody = {
            ...result.body,
            route: 'ai',
            routeReason: decision.reason,
            routeDecisionMs,
            timing: {
              ...(result.body.timing || {}),
              routeDecisionMs
            }
          };
          res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseBody));
        }
      });

      return;
    }

    // Route: /api/read-page (Brick 21 Web Page Read v1)
    if (url.pathname === '/api/read-page') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      const requestStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

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

        const inputUrl = parsedBody.url ?? parsedBody.targetUrl;
        if (typeof inputUrl !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'INVALID_URL',
            code: 'INVALID_URL',
            message: 'URL must be a non-empty string',
            serverReadDurationMs: 0
          }));
          return;
        }

        const trimmedUrl = inputUrl.trim();
        if (trimmedUrl.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'INVALID_URL',
            code: 'INVALID_URL',
            message: 'URL cannot be empty',
            serverReadDurationMs: 0
          }));
          return;
        }

        try {
          const reader = options.pageReaderFn || ((u) => readWebPage(u, {
            fetchFn: options.fetchFn,
            dnsLookup: options.dnsLookup
          }));

          const result = await reader(trimmedUrl);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          const serverEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();
          const serverReadDurationMs = Math.max(0.001, Number((serverEndTime - requestStartTime).toFixed(3)));

          const errorCode = err.code || 'FETCH_FAILED';
          const safeMessage = err.message || 'Page read failed';

          let statusCode = 502;
          if (['INVALID_URL', 'UNSUPPORTED_PROTOCOL', 'URL_CREDENTIALS_NOT_ALLOWED', 'PORT_NOT_ALLOWED', 'LOCAL_OR_PRIVATE_HOST_BLOCKED', 'DNS_RESOLUTION_FAILED'].includes(errorCode)) {
            statusCode = 400;
          } else if (errorCode === 'PAGE_TOO_LARGE') {
            statusCode = 413;
          } else if (errorCode === 'FETCH_TIMEOUT') {
            statusCode = 504;
          } else if (['UNSUPPORTED_CONTENT_TYPE', 'NO_READABLE_CONTENT'].includes(errorCode)) {
            statusCode = 422;
          }

          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: errorCode,
            code: errorCode,
            message: safeMessage,
            requestedUrl: trimmedUrl,
            finalUrl: err.details?.finalUrl || null,
            httpStatus: err.details?.httpStatus || null,
            contentType: err.details?.contentType || null,
            serverReadDurationMs
          }));
        }
      });

      return;
    }

    // Route: /api/page-qa (Brick 22 Grounded Web Page Q&A v1)
    if (url.pathname === '/api/page-qa') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      const requestStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

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

        const inputUrl = parsedBody.url ?? parsedBody.targetUrl;
        const inputQuestion = parsedBody.question ?? parsedBody.prompt;

        if (typeof inputUrl !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'INVALID_URL',
            code: 'INVALID_URL',
            message: 'URL must be a non-empty string',
            serverPageQaDurationMs: 0
          }));
          return;
        }

        const trimmedUrl = inputUrl.trim();
        if (trimmedUrl.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'INVALID_URL',
            code: 'INVALID_URL',
            message: 'URL cannot be empty',
            serverPageQaDurationMs: 0
          }));
          return;
        }

        if (typeof inputQuestion !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'INVALID_QUESTION',
            code: 'INVALID_QUESTION',
            message: 'Question must be a non-empty string',
            serverPageQaDurationMs: 0
          }));
          return;
        }

        const trimmedQuestion = inputQuestion.trim();
        if (trimmedQuestion.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'INVALID_QUESTION',
            code: 'INVALID_QUESTION',
            message: 'Question cannot be empty',
            serverPageQaDurationMs: 0
          }));
          return;
        }

        try {
          const runner = options.pageQaFn || ((params) => executePageQa({
            url: params.url,
            question: params.question,
            options: {
              pageReaderFn: options.pageReaderFn,
              aiProvider: options.provider,
              textProvider: options.provider,
              fetchFn: options.fetchFn,
              dnsLookup: options.dnsLookup
            }
          }));

          const result = await runner({
            url: trimmedUrl,
            question: trimmedQuestion
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          const serverEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();
          const serverPageQaDurationMs = Math.max(0.001, Number((serverEndTime - requestStartTime).toFixed(3)));

          const errorCode = err.code || 'PAGE_QA_FAILED';
          let safeMessage = err.message || 'Page Q&A failed';
          const apiKeyToRedact = process.env.OPENROUTER_API_KEY;
          if (apiKeyToRedact) {
            safeMessage = safeMessage.replaceAll(apiKeyToRedact, '[REDACTED]');
          }

          let statusCode = 502;
          if (['INVALID_URL', 'INVALID_QUESTION', 'QUESTION_TOO_LONG', 'UNSUPPORTED_PROTOCOL', 'URL_CREDENTIALS_NOT_ALLOWED', 'PORT_NOT_ALLOWED', 'LOCAL_OR_PRIVATE_HOST_BLOCKED', 'DNS_RESOLUTION_FAILED'].includes(errorCode)) {
            statusCode = 400;
          } else if (errorCode === 'PAGE_TOO_LARGE') {
            statusCode = 413;
          } else if (errorCode === 'FETCH_TIMEOUT') {
            statusCode = 504;
          } else if (['UNSUPPORTED_CONTENT_TYPE', 'NO_READABLE_CONTENT'].includes(errorCode)) {
            statusCode = 422;
          }

          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: errorCode,
            code: errorCode,
            message: safeMessage,
            requestedUrl: trimmedUrl,
            finalUrl: err.details?.finalUrl || null,
            httpStatus: err.details?.httpStatus || null,
            contentType: err.details?.contentType || null,
            serverPageQaDurationMs
          }));
        }
      });

      return;
    }

    // Route: /api/research-one (Brick 23 Grounded Web Research v1)
    if (url.pathname === '/api/research-one') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      const requestStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

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

        const inputQuestion = parsedBody.question ?? parsedBody.prompt;

        if (typeof inputQuestion !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'INVALID_QUESTION',
            code: 'INVALID_QUESTION',
            message: 'Question must be a non-empty string',
            stage: 'validation',
            serverResearchDurationMs: 0
          }));
          return;
        }

        const trimmedQuestion = inputQuestion.trim();
        if (trimmedQuestion.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'INVALID_QUESTION',
            code: 'INVALID_QUESTION',
            message: 'Question cannot be empty',
            stage: 'validation',
            serverResearchDurationMs: 0
          }));
          return;
        }

        try {
          const runner = options.researchOneFn || ((params) => executeResearchOne({
            question: params.question,
            options: {
              searchProvider: options.searchProvider,
              pageReaderFn: options.pageReaderFn,
              aiProvider: options.provider,
              textProvider: options.provider,
              fetchFn: options.fetchFn,
              dnsLookup: options.dnsLookup
            }
          }));

          const result = await runner({
            question: trimmedQuestion
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          const serverEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();
          const serverResearchDurationMs = Math.max(0.001, Number((serverEndTime - requestStartTime).toFixed(3)));

          const errorCode = err.code || 'RESEARCH_FAILED';
          let safeMessage = err.message || 'Research request failed';
          const apiKeyToRedact = process.env.OPENROUTER_API_KEY;
          if (apiKeyToRedact) {
            safeMessage = safeMessage.replaceAll(apiKeyToRedact, '[REDACTED]');
          }
          const stage = err.stage || err.details?.stage || 'unknown';

          let statusCode = 502;
          if (['INVALID_QUESTION', 'QUESTION_TOO_LONG', 'INVALID_URL', 'UNSUPPORTED_PROTOCOL', 'URL_CREDENTIALS_NOT_ALLOWED', 'PORT_NOT_ALLOWED', 'LOCAL_OR_PRIVATE_HOST_BLOCKED', 'DNS_RESOLUTION_FAILED'].includes(errorCode)) {
            statusCode = 400;
          } else if (errorCode === 'PAGE_TOO_LARGE') {
            statusCode = 413;
          } else if (errorCode === 'FETCH_TIMEOUT') {
            statusCode = 504;
          } else if (['UNSUPPORTED_CONTENT_TYPE', 'NO_READABLE_CONTENT', 'NO_USABLE_SEARCH_SOURCE', 'SEARCH_NOT_EXECUTED', 'NO_READABLE_SEARCH_SOURCE'].includes(errorCode)) {
            statusCode = 422;
          }

          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: errorCode,
            code: errorCode,
            message: safeMessage,
            stage,
            sourcesFound: err.details?.sourcesFound ?? (err.sourcesFound ?? 0),
            pageReadAttempts: err.details?.pageReadAttempts ?? (err.pageReadAttempts ?? 0),
            attempts: err.details?.attempts ?? (err.attempts ?? []),
            selectedSourceIndex: err.details?.selectedSourceIndex ?? (err.selectedSourceIndex ?? null),
            selectedSource: err.details?.selectedSource ?? (err.selectedSource ?? null),
            searchDurationMs: err.details?.searchDurationMs ?? 0,
            pageReadDurationMs: err.details?.pageReadDurationMs ?? 0,
            providerQaDurationMs: err.details?.providerQaDurationMs ?? 0,
            serverResearchDurationMs
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
