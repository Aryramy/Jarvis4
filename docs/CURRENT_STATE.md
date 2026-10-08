Project: JARVIS4
Current Brick: 11
Status: VERIFIED
Last Verified Brick: BRICK-011
Current Feature: Voice transcript to existing JARVIS AI text response
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
- Web interface Ask JARVIS button (`#ask-jarvis-btn`), thinking loading indicator (`#jarvis-status`), and text response display (`#jarvis-response`)
- Compositional browser-driven architecture connecting verified Brick 10 speech-to-text transcript (`POST /api/stt`) to verified Brick 4/6 text AI pipeline (`POST /api/ai`)
- Human-in-the-loop explicit submission: transcript is displayed for human verification before explicit click on "Ask JARVIS" submits it to the AI
- Full Unicode preservation for multilingual prompts across English, Urdu, Arabic, and code-switched mixed sentences without transliteration, client-side translation, or language-specific routes
- Single shared conversation context between typed Ask AI, streaming Ask AI, and voice transcript queries across memory and disk persistence
- Independent state isolation and error handling: failed STT does not submit stale transcripts, failed AI requests leave transcripts visible, and duplicate requests are prevented via thinking state
- Comprehensive automated test suite (`tests/integration/voiceAiIntegration.test.js`) verifying all 25 Brick 11 integration requirements

## External integrations

- Cheaper Inference / OmniRoute hosted API (OpenAI-compatible `/chat/completions`)
- OpenRouter hosted API (OpenAI-compatible `/audio/transcriptions` with `openai/whisper-large-v3-turbo`)

## Known issues

- On this Windows machine, portable Node v24.21.0 is recommended for live external provider calls; the installed Node v24.19.0 exhibited an upstream Windows/libuv shutdown assertion after successful fetch.
- On corporate / office Wi-Fi networks, direct OpenRouter HTTPS connections are reset with ECONNRESET; mobile hotspot or unrestricted network bypasses this limitation and works reliably.
- Multilingual Whisper STT observations:
  - Occasional extra trailing hallucinated words ("Thank you", "موسیقی", "شكرا", "ملتا") generated during audio silence or trailing background noise.
  - Mixed English terms in Urdu speech may be transliterated phonetically into Urdu script rather than Latin script (e.g., "ڈیشپورٹ").
  - Live STT latency varies significantly depending on audio duration, gateway load, and routing (observed range: ~827ms to ~12s).
- Live AI provider timeout observation:
  - One Ask JARVIS request timed out during live verification; retry succeeded without loss of conversation context.
  - Model normalized hyphen in verification code ("NOVA742" instead of "NOVA-742") while preserving value and conversational context.
- System boundary reminders:
  - OpenRouter remains STT only.
  - Cheaper Inference remains the text AI/LLM provider.
  - TTS is NOT implemented.

## Last verification

Status: PASS (Exit Code: 0)
- Automated test & sanity verification: 221 tests across 14 suites passed offline (Exit Code: 0).
- Provider: OpenRouter (STT only) & Cheaper Inference (Text AI only)
- STT Model: openai/whisper-large-v3-turbo
- Text Model: deepseek-v4-flash-0731
- Endpoints: `POST /api/stt` and `POST /api/ai`
- Language selection: automatic / no configured language parameter
- Brick 4 browser live test: VERIFIED
- Brick 5 browser live streaming test: VERIFIED
- Brick 6 live browser & session test: VERIFIED
- Brick 7 browser live streaming & session test: VERIFIED
- Brick 8 live browser restart persistence test: VERIFIED
- Brick 9 browser live microphone capture test: VERIFIED
- Brick 10 browser live multilingual STT test: VERIFIED
- Brick 11 browser live voice transcript → AI test: VERIFIED — Human operator confirmed end-to-end browser execution:
  - TEST A (English Voice → AI): PASS (Spoken: "What is LLM explain it in one short sentence", STT Latency: 6188 ms, Transcript: "What is LLM explain it in one short sentence", JARVIS response: Relevant explanation of LLM returned successfully).
  - TEST B (Urdu Voice → AI): PASS (Spoken: "جارویس، پاور بی آئی کیا ہے؟", STT Latency: 3213 ms, Transcript: "جارویس پاور بی آئی کیا ہے ملتا", JARVIS response: Relevant Urdu response about Power BI returned; trailing word "ملتا" noted).
  - TEST C (Arabic Voice → AI): PASS (Spoken: "يا جارفس، ما هو Power BI؟", STT Latency: 4482 ms, Transcript: "جارو بيس ما هو باور بي آي؟", JARVIS response: Relevant Arabic response about Power BI returned; request meaning preserved).
  - TEST D (Mixed Urdu + English Voice → AI): PASS (Spoken: "Jarvis, مجھے Power BI dashboard کے بارے میں بتاؤ", STT Latency: 827 ms, Transcript: "جارویس مجھے پاور بی آئی ڈیشپورٹ کے بارے میں بتاؤ", JARVIS response: Relevant Urdu response explaining Power BI dashboards returned).
  - TEST E (Typed → Voice Shared Context): PASS (Typed: "My verification code is ORBIT-381.", Voice transcript: "What is my verification code?", STT Latency: 1492 ms, JARVIS response: Recalled ORBIT-381 from existing shared ConversationSession. First Ask JARVIS attempt timed out, retry succeeded cleanly without losing conversation context).
  - TEST F (Voice → Typed Shared Context): PASS (Voice: "My second verification code is NOVA-742.", Typed: "What second verification code did I tell you?", JARVIS response: Recalled NOVA742 from existing shared ConversationSession).
  - TEST G (New Recording without Refresh): PASS (Multiple distinct recordings captured, transcribed, and sent to JARVIS in same session without page refresh; each new transcript cleanly replaced prior current transcript with no stale submissions).
  - Architecture verified: Single microphone, single `/api/stt` endpoint, single OpenRouter STT provider, single `/api/ai` endpoint, single Cheaper Inference provider, single shared `ConversationSession`, zero language selectors, zero automatic submissions, and zero TTS.


