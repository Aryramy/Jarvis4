Project: JARVIS4
Current Brick: 14
Status: VERIFIED
Last Verified Brick: BRICK-014
Current Feature: AI Latency Instrumentation & Bottleneck Diagnosis
Next Feature: NOT AUTHORIZED

## Working capabilities

- Zero-dependency Node.js ESM project foundation
- Minimal reusable 4-level logger supporting DEBUG, INFO, WARN, ERROR
- Environment configuration loader and validator (including Cheaper Inference, OpenRouter STT, and OpenRouter TTS settings)
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
- Reusable base text-to-speech contract (`TextToSpeechProvider` in `src/providers/textToSpeechBase.js`)
- OpenRouter multilingual text-to-speech adapter (`OpenRouterTextToSpeechProvider` in `src/providers/openRouterTTS.js`) connecting to `/audio/speech` using `elevenlabs/eleven-v4-turbo` and voice `george` (format: `mp3`)
- Single multilingual TTS pipeline: language parameter strictly omitted; input text itself determines language spoken across English, Urdu, Arabic, and mixed code-switched text
- Verbatim text forwarding: Unicode text preserved without translation, transliteration, or romanization
- Local TTS web endpoint (`POST /api/tts`) accepting `{ text }`, returning binary `audio/mpeg` with `X-TTS-Duration-Ms` timing header and `Cache-Control: no-store`
- Web interface Speak Response button (`#speak-response-btn`), TTS status indicator (`#tts-status`), and native browser audio playback (`#tts-playback`)
- Explicit human action only: TTS is never automatic or auto-played; user explicitly clicks "Speak Response"
- Deterministic client response state: `currentAssistantResponse` tracks latest successfully completed AI response only; failed AI states, transcripts, and prompts do not become speakable
- Audio playback cleanup: object URLs revoked via `URL.revokeObjectURL` on replacement; replay supported without page reload
- Output-only presentation: TTS audio is strictly presentation layer and is never added to `ConversationSession` or `ConversationStore` memory
- Comprehensive automated test suite (`tests/integration/ttsEndpoint.test.js` & `tests/unit/openRouterTTS.test.js`) verifying all Brick 12 requirements offline
- Sequential one-action voice turn orchestration module (`VoiceTurnRunner` in `src/web/voiceTurn.js`)
- Dedicated `/voiceTurn.js` static module route served by minimal HTTP server
- Client-side deterministic state machine (`IDLE` -> `STT` -> `AI` -> `TTS` -> `PLAYING` -> `COMPLETE` / `STT_ERROR` / `AI_ERROR` / `TTS_ERROR` / `PLAYBACK_ERROR`)
- Web interface Run Voice Turn button (`#run-voice-turn-btn`), stage-specific status indicator (`#voice-turn-status`), and total voice-turn elapsed latency measurement
- Sequential composition of existing verified local endpoints: captured audio Blob -> `POST /api/stt` -> transcript -> `POST /api/ai` -> JARVIS response -> `POST /api/tts` -> browser MP3 playback triggered from a single explicit action
- Preserved existing manual diagnostic controls (`Start Microphone`, `Stop Microphone`, `Transcribe`, `Ask JARVIS`, `Speak Response`)
- Strict stale-data protection with monotonic turn identity: failed STT stops pipeline and cannot submit old transcripts to AI; failed AI stops pipeline and cannot synthesize old responses; failed TTS stops pipeline and cannot play old audio
- Shared conversational continuity: voice-turn AI requests seamlessly participate in `ConversationSession` and `ConversationStore` alongside typed prompts
- Zero audio bytes stored in conversation memory: TTS audio is strictly presentation layer
- Full Unicode preservation across English, Urdu, Arabic, and code-switched mixed speech without language selectors, manual mode switches, or language-specific routes
- Comprehensive automated test suite (`tests/integration/voiceTurnSequence.test.js` & `tests/unit/voiceTurn.test.js`) verifying all 53 Brick 13 requirements offline (300 tests passed, 0 failed)
- Strict boundary adherence: zero continuous listening, zero automatic recording restarts, zero wake words, zero VAD
- Multi-tier AI latency instrumentation (Brick 14):
  - `providerDurationMs`: External Cheaper Inference provider HTTP round-trip timing measured directly in `CheaperInferenceProvider`
  - `serverAiDurationMs`: Server-side endpoint timing measured inside `/api/ai` request handler encompassing session/store and request lifecycle
  - `clientAiDurationMs`: Browser orchestration timing measured across `/api/ai` fetch and response parsing
- Diagnostic timing metadata contract exposed in `/api/ai` (`timing: { providerDurationMs, serverAiDurationMs }`) with credential redaction and zero prompt leakage
- Visible diagnostic UI displays: `AI: <ms> ms` for typed Ask AI / Ask JARVIS, and full pipeline stage breakdown (`STT: <ms> ms`, `AI: <ms> ms`, `TTS: <ms> ms`, `Voice Turn Total: <ms> ms`) for automated Voice Turn
- Automated test suite expanded to 318 tests across 20 suites passing offline with zero live external calls (Exit Code: 0)

## External integrations

- Cheaper Inference / OmniRoute hosted API (OpenAI-compatible `/chat/completions`)
- OpenRouter hosted API (OpenAI-compatible `/audio/transcriptions` with `openai/whisper-large-v3-turbo` for STT, and `/audio/speech` with `elevenlabs/eleven-v4-turbo` with voice `george` for TTS)

## Known issues

- On this Windows machine, portable Node v24.21.0 is recommended for live external provider calls; the installed Node v24.19.0 exhibited an upstream Windows/libuv shutdown assertion after successful fetch.
- On corporate / office Wi-Fi networks, direct OpenRouter HTTPS connections are reset with ECONNRESET; mobile hotspot or unrestricted network bypasses this limitation and works reliably.
- Multilingual Whisper STT observations:
  - Occasional extra trailing hallucinated words ("Thank you", "موسیقی", "شكرا", "ملتا") generated during audio silence or trailing background noise.
  - Mixed English terms in Urdu speech may be transliterated phonetically into Urdu script rather than Latin script (e.g., "ڈیشپورٹ").
  - Live STT latency varies depending on audio duration, gateway load, and routing.
- System boundary reminders:
  - OpenRouter is used for STT (`/audio/transcriptions`) and TTS (`/audio/speech`).
  - Cheaper Inference remains the text AI/LLM provider (`/chat/completions`).
  - Brick 13 is one-action sequential voice turn; automatic recording restart, continuous listening, and wake words are strictly prohibited.
  - User explicitly clicks "Run Voice Turn" after recording.
- Voice turn overall latency & diagnostic observation (Brick 13):
  - STT latency is currently generally acceptable (~2.5s–3.2s).
  - TTS latency is currently generally acceptable (~1.2s–3.0s).
  - The complete voice turn is still significantly slower than desired (observed total elapsed times: ~18s–31s across live tests).
  - A large portion of the total elapsed time occurs outside the measured STT and TTS stages.
  - Brick 13 does not expose an isolated AI-stage latency measurement. The remaining elapsed time may include AI provider latency, network roundtrip delays, request/response handling, and client orchestration overhead.
  - Future architectural principle: measure isolated AI latency first. Do not optimize or modify AI provider/model until empirical measurement identifies the actual bottleneck.

## Last verification

Status: BRICK-014 VERIFIED (Exit Code: 0)
- Automated test & sanity verification: 318 tests across 20 suites passed offline (Exit Code: 0).
- Providers:
  - STT: OpenRouter (`openai/whisper-large-v3-turbo` at `POST /audio/transcriptions`)
  - AI: Cheaper Inference (`deepseek-v4-flash-0731` at `POST /chat/completions`)
  - TTS: OpenRouter (`elevenlabs/eleven-v4-turbo`, voice: `george`, format: `mp3` at `POST /audio/speech`)
- Endpoints: `POST /api/stt`, `POST /api/ai`, `POST /api/tts`
- Complete one-action voice turn pipeline with isolated AI latency instrumentation verified:
  Microphone Capture → Single Click "Run Voice Turn" → OpenRouter STT → Transcript → Cheaper Inference AI → JARVIS Text Response → OpenRouter TTS (`elevenlabs/eleven-v4-turbo`, voice `george`) → Browser Audio Playback
- Multilingual architecture: ONE model and ONE voice for all languages (English, Urdu, Arabic, mixed). NO language selector, NO manual language switch, NO per-language routes.
- Presentation only: TTS audio is NOT stored in `ConversationSession` or `ConversationStore`.
- Brick 14 live verification tests (Human operator confirmed):
  - TEST A (Simple Typed AI Latency): PASS (Query: "What is 2 + 2? Answer with only the number.", Response: "4", clientAiDurationMs: 29190 ms, providerDurationMs: 29064 ms, serverAiDurationMs: 29071 ms, local server overhead: ~7 ms)
  - TEST B (Voice Turn AI Latency): PASS (Query: "What is the capital of Japan? Answer briefly.", STT: 5299 ms, providerDurationMs: 26797 ms, serverAiDurationMs: 26798 ms, TTS ≈ 2000 ms, local server overhead: ~1 ms)
  - TEST C (Second AI Request - Variability): PASS (Query: "What is the capital of France? Answer briefly.", Response: "Paris", providerDurationMs: 23686 ms, serverAiDurationMs: 23687 ms, local server overhead: ~1 ms; confirmed significant variance between provider requests)
  - TEST D (Conversation Context & Timeout Observation): PASS (Query: "My test number is 4821.", initial attempt timed out at providerDurationMs: 30016 ms, retry succeeded at 29979 ms; Recall Query: "What is my test number?", initial attempt timed out at providerDurationMs: 30009 ms, retry succeeded at 27319 ms with response "Your test number is **4821**, sir."; confirmed memory context remains functional across timeouts and retries)
- Diagnostic Result & Bottleneck Isolation supported by evidence:
  - External Cheaper Inference provider request path is the dominant measured bottleneck (~23.6s to 30.0s).
  - Local JARVIS AI server overhead is negligible (~0–7 ms in tested cases).
  - Repeated near-30-second timeouts were observed (30009 ms, 30016 ms), proving the route frequently approaches or exceeds the configured 30000 ms timeout.
  - The measurement captures the full external request path (routing, queueing, upstream provider processing, model inference, network latency); no specific upstream component is proven to be the sole cause.
  - Recorded as a verified performance issue for future architectural optimization. Zero optimization performed in Brick 14.
- Prior bricks verified:
  - Brick 4 browser live test: VERIFIED
  - Brick 5 browser live streaming test: VERIFIED
  - Brick 6 live browser & session test: VERIFIED
  - Brick 7 browser live streaming & session test: VERIFIED
  - Brick 8 live browser restart persistence test: VERIFIED
  - Brick 9 browser live microphone capture test: VERIFIED
  - Brick 10 browser live multilingual STT test: VERIFIED
  - Brick 11 browser live voice transcript → AI test: VERIFIED
  - Brick 12 browser live TTS test: VERIFIED



