Project: JARVIS4
Current Brick: 10
Status: VERIFIED
Last Verified Brick: BRICK-010
Current Feature: Unified multilingual speech-to-text
Next Feature: NOT AUTHORIZED

## Working capabilities

- Zero-dependency Node.js ESM project foundation
- Minimal reusable 4-level logger supporting DEBUG, INFO, WARN, ERROR
- Environment configuration loader and validator (including Cheaper Inference and OpenRouter STT settings)
- Automated native test runner suite (`node:test`, `node:assert`)
- Comprehensive verification suite (`scripts/verify.mjs` / `npm run verify`)
- Deterministic text request/response core (`handleText`) with input validation and whitespace normalization
- Terminal CLI (`npm run jarvis -- "<text>"`)
- Local web interface (`npm run web` at `http://127.0.0.1:8080`)
- Cheaper Inference / OmniRoute AI Provider Adapter (`CheaperInferenceProvider` in `src/providers/cheaperInference.js`)
- Live AI CLI command (`npm run ai -- "<prompt>"`) verified against live hosted provider (`deepseek-v4-flash-0731`)
- Real AI web endpoint (`POST /api/ai`) routing to CheaperInferenceProvider with input validation and credential protection
- Web interface Ask AI button and visible thinking loading state (`Status: Thinking...`)
- Cheaper Inference streaming adapter (`stream(prompt)` and `streamMessages(messages)`) parsing OpenAI-compatible Server-Sent Events (SSE)
- Streaming AI web endpoint (`POST /api/ai/stream`) serving newline-delimited JSON deltas with connection abort tracking and conversation context integration
- Web interface Ask AI — Stream button progressively rendering text deltas in real time without buffering
- In-memory conversation session component (`ConversationSession` in `src/core/conversationSession.js`) managing temporary message history (FIFO bound by default 20 turns)
- Minimal local conversation store component (`ConversationStore` in `src/core/conversationStore.js`) managing atomic JSON persistence (`runtime/conversation.json`) across server restarts
- Message-based provider support (`generateMessages(messages)` and `streamMessages(messages)`) in `AIProvider` and `CheaperInferenceProvider` preserving turn order
- Single shared conversation context preserved seamlessly across server restarts for both normal Ask AI (`POST /api/ai`) and streaming Ask AI (`POST /api/ai/stream`)
- Deterministic rollback on provider failure or client abort preventing corruption of persisted and in-memory conversation history
- Clear conversation endpoint (`POST /api/conversation/clear`) resetting in-memory session history and removing persisted storage file
- Web interface Clear Conversation button (`#clear-conv-btn`) and status feedback (`Conversation cleared.`)
- Language-agnostic browser microphone capture module (`MicrophoneRecorder` in `src/web/microphone.js`) with capability and MIME type detection (`audio/webm`, `audio/ogg`, etc.)
- Clean audio hardware release: stops all MediaStream audio tracks on recording stop and cleanup to prevent resource leaks
- Web interface microphone capture controls (`#start-mic-btn`, `#stop-mic-btn`), status display (`#mic-status`), capture metadata display (`#mic-meta`), and browser-native audio playback (`#audio-playback`)
- Dedicated `/microphone.js` static module route served by minimal HTTP server
- Reusable base speech-to-text contract (`SpeechToTextProvider` in `src/providers/speechToTextBase.js`)
- OpenRouter multilingual speech-to-text adapter (`OpenRouterSpeechToTextProvider` in `src/providers/openRouterSTT.js`) connecting to `/audio/transcriptions` with `openai/whisper-large-v3-turbo`
- Strict single multilingual pipeline architecture: automatic language detection without language selector, language dropdown, or per-language configuration
- Real STT web endpoint (`POST /api/stt`) accepting browser microphone recordings (multipart or raw audio stream) with validation (presence, >0 bytes, MIME type, max size 25MB, configuration) and in-memory forwarding
- Web interface Transcribe button (`#transcribe-btn`), STT status indicator (`#stt-status`), latency display, and transcript output (`#transcript-display`)

## External integrations

- Cheaper Inference / OmniRoute hosted API (OpenAI-compatible `/chat/completions`)
- OpenRouter hosted API (OpenAI-compatible `/audio/transcriptions` with `openai/whisper-large-v3-turbo`)

## Known issues

- On this Windows machine, portable Node v24.21.0 is recommended for live external provider calls; the installed Node v24.19.0 exhibited an upstream Windows/libuv shutdown assertion after successful fetch.
- On corporate / office Wi-Fi networks, direct OpenRouter HTTPS connections are reset with ECONNRESET; mobile hotspot or unrestricted network bypasses this limitation and works reliably.
- Multilingual Whisper STT observations:
  - Occasional extra trailing hallucinated words ("Thank you", "موسیقی", "شكرا") generated during audio silence or trailing background noise.
  - Mixed English terms in Urdu speech may be transliterated phonetically into Urdu script rather than Latin script.
  - Live STT latency currently varies significantly between ~3.4s and ~12s depending on audio duration, gateway load, and routing.

## Last verification

Status: PASS (Exit Code: 0)
- Automated test & sanity verification: 200 tests across 13 suites passed offline (Exit Code: 0).
- Provider: OpenRouter
- Model: openai/whisper-large-v3-turbo
- Endpoint: /audio/transcriptions
- Language selection: automatic / no configured language parameter
- Real live provider verification (Brick 3): `npm run ai -- "Reply with exactly: JARVIS4 AI CONNECTED"` successfully executed against live Cheaper Inference endpoint (`deepseek-v4-flash-0731`) and returned `JARVIS4 AI CONNECTED`.
- Brick 4 browser live test: VERIFIED — Human operator confirmed end-to-end browser execution through `POST /api/ai` to hosted model (`deepseek-v4-flash-0731`) with real AI response rendered in browser.
- Brick 5 browser live streaming test: VERIFIED — Human operator confirmed live streaming behavior: progressive text delta display before full response completion, continuous delta arrival, normal completion, return to Ready status, non-streaming and deterministic paths functioning, and zero Node/libuv crashes.
- Brick 6 live browser & session test: VERIFIED — Human operator confirmed same-session recall with Ask AI, confirmed Clear Conversation removes temporary context, confirmed server restart removes temporary context without persistent memory leakage, and streaming remained intentionally stateless in Brick 6.
- Brick 7 browser live streaming & session test: VERIFIED — Human operator confirmed end-to-end live verification: Stream -> Stream context recall, Normal Ask AI -> Ask AI — Stream shared context, Ask AI — Stream -> Normal Ask AI shared context, Clear Conversation removes shared context cleanly, server restart removes temporary context without persistence leakage, streaming remained progressive, and zero crashes occurred.
- Brick 8 live browser restart persistence test: VERIFIED — Human operator confirmed end-to-end persistence across restarts: Normal Ask AI -> server restart -> Normal Ask AI restored context, Ask AI — Stream -> server restart -> Normal Ask AI restored context, Normal Ask AI -> server restart -> Ask AI — Stream restored context with progressive streaming, Clear Conversation cleared disk and memory state, server restart after Clear did not restore old context, and zero process crashes occurred.
- Brick 9 browser live microphone capture test: VERIFIED — Human operator confirmed end-to-end live browser microphone capture: browser permission request succeeded, Start Microphone captured real speech, Stop Microphone completed non-zero recording with accurate duration and MIME type, native audio playback reproduced clear spoken audio, second recording worked cleanly without page refresh, microphone tracks were released cleanly between recordings, and all existing features (Deterministic Test, Ask AI, Ask AI — Stream, Clear Conversation, persistent conversation state) remained fully functional.
- Brick 10 browser live multilingual STT test: VERIFIED — Human operator confirmed end-to-end live multilingual speech-to-text through OpenRouter (`openai/whisper-large-v3-turbo`):
  - English Test: PASS (Latency: 12054 ms, Transcript: `"Hello Jarvis, this is Multilingual Speech Test No. 742 Thank you."`)
  - Urdu Test: PASS (Latency: 3435 ms, Transcript: `"جارویز آج ہم ملٹی لنگویل وائز تیسٹ کر رہے ہیں۔ موسیقی"`)
  - Arabic Test: PASS (Latency: 9385 ms, Transcript: `"يا جارفس نحن نختبر التعرف على الكلام متعدد اللغات اليوم شكرا"`)
  - Mixed Urdu + English Test: PASS (Latency: 6408 ms, Transcript: `"جارویس مجھے پاور بی آئی ڈیش بورڈ اوپن کرنا ہے"`)
  - Repeat without page refresh: PASS (New recording produced new transcript with updated latency)
  - All tests used single microphone, single `/api/stt` endpoint, single OpenRouter provider, single model, zero language selectors, zero language parameters, and zero per-language configurations.


