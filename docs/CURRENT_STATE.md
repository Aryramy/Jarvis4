Project: JARVIS4
Current Brick: 3
Status: VERIFIED
Last Verified Brick: BRICK-003
Current Feature: Single Cheaper Inference AI provider connection
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

## External integrations

- Cheaper Inference / OmniRoute hosted API (OpenAI-compatible `/chat/completions`)

## Known issues

- On this Windows machine, portable Node v24.21.0 is recommended for live external provider calls; the installed Node v24.19.0 exhibited an upstream Windows/libuv shutdown assertion after successful fetch.

## Last verification

Status: PASS (Exit Code: 0)
- Automated test & sanity verification: 49 tests across 7 suites passed offline.
- Real live provider verification: `npm run ai -- "Reply with exactly: JARVIS4 AI CONNECTED"` successfully executed against live Cheaper Inference endpoint (`deepseek-v4-flash-0731`) and returned `JARVIS4 AI CONNECTED` (Exit code: 0).
