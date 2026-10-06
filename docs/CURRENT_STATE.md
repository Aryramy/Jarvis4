Project: JARVIS4
Current Brick: 6
Status: VERIFIED
Last Verified Brick: BRICK-006
Current Feature: Temporary short-term conversation context
Next Feature: NOT AUTHORIZED

## Working capabilities

- Zero-dependency Node.js ESM project foundation
- Minimal reusable 4-level logger supporting DEBUG, INFO, WARN, ERROR
- Environment configuration loader and validator (including Cheaper Inference settings)
- Automated native test runner suite (`node:test`, `node:assert`)
- Comprehensive verification suite (`scripts/verify.mjs` / `npm run verify`)
- Deterministic text request/response core (`handleText`) with input validation and whitespace normalization
- Terminal CLI (`npm run jarvis -- "<text>"`)
- Local web interface (`npm run web` at `http://127.0.0.1:8080`)
- Cheaper Inference / OmniRoute AI Provider Adapter (`CheaperInferenceProvider` in `src/providers/cheaperInference.js`)
- Live AI CLI command (`npm run ai -- "<prompt>"`) verified against live hosted provider (`deepseek-v4-flash-0731`)
- Real AI web endpoint (`POST /api/ai`) routing to CheaperInferenceProvider with input validation and credential protection
- Web interface Ask AI button and visible thinking loading state (`Status: Thinking...`)
- Cheaper Inference streaming adapter (`stream(prompt)`) parsing OpenAI-compatible Server-Sent Events (SSE)
- Streaming AI web endpoint (`POST /api/ai/stream`) serving newline-delimited JSON deltas with connection abort tracking
- Web interface Ask AI — Stream button progressively rendering text deltas in real time without buffering
- In-memory conversation session component (`ConversationSession` in `src/core/conversationSession.js`) managing short-term temporary message history (FIFO bound by default 20 turns)
- Message-based provider support (`generateMessages(messages)`) in `AIProvider` and `CheaperInferenceProvider` preserving turn order
- Short-term conversation context integration into non-streaming web AI endpoint (`POST /api/ai`) with deterministic rollback on provider failure
- Clear conversation endpoint (`POST /api/conversation/clear`) resetting in-memory session history
- Web interface Clear Conversation button (`#clear-conv-btn`) and status feedback (`Conversation cleared.`)

## External integrations

- Cheaper Inference / OmniRoute hosted API (OpenAI-compatible `/chat/completions`)

## Known issues

- On this Windows machine, portable Node v24.21.0 is recommended for live external provider calls; the installed Node v24.19.0 exhibited an upstream Windows/libuv shutdown assertion after successful fetch.

## Last verification

Status: PASS (Exit Code: 0)
- Automated test & sanity verification: 99 tests across 8 suites passed offline.
- Real live provider verification (Brick 3): `npm run ai -- "Reply with exactly: JARVIS4 AI CONNECTED"` successfully executed against live Cheaper Inference endpoint (`deepseek-v4-flash-0731`) and returned `JARVIS4 AI CONNECTED`.
- Brick 4 browser live test: VERIFIED — Human operator confirmed end-to-end browser execution through `POST /api/ai` to hosted model (`deepseek-v4-flash-0731`) with real AI response rendered in browser.
- Brick 5 browser live streaming test: VERIFIED — Human operator confirmed live streaming behavior: progressive text delta display before full response completion, continuous delta arrival, normal completion, return to Ready status, non-streaming and deterministic paths functioning, and zero Node/libuv crashes.
- Brick 6 live browser & session test: VERIFIED — Human operator confirmed same-session recall with Ask AI, confirmed Clear Conversation removes temporary context, confirmed server restart removes temporary context without persistent memory leakage, and streaming remained intentionally stateless.
