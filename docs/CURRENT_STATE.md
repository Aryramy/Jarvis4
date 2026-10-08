Project: JARVIS4
Current Brick: 12
Status: VERIFIED
Last Verified Brick: BRICK-012
Current Feature: Multilingual JARVIS text response → voice output
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
  - Automatic voice conversation / auto-chaining is NOT Brick 12.
  - User explicitly clicks: Transcribe → Ask JARVIS → Speak Response.

## Last verification

Status: BRICK-012 VERIFIED (Exit Code: 0)
- Automated test & sanity verification: 265 tests across 16 suites passed offline (Exit Code: 0).
- Providers:
  - STT: OpenRouter (`openai/whisper-large-v3-turbo` at `POST /audio/transcriptions`)
  - AI: Cheaper Inference (`deepseek-v4-flash-0731` at `POST /chat/completions`)
  - TTS: OpenRouter (`elevenlabs/eleven-v4-turbo`, voice: `george`, format: `mp3` at `POST /audio/speech`)
- Endpoints: `POST /api/stt`, `POST /api/ai`, `POST /api/tts`
- Complete manual voice loop verified:
  Microphone → OpenRouter STT → Transcript → Explicit Ask JARVIS → Cheaper Inference AI → JARVIS Text Response → Explicit Speak Response → OpenRouter TTS (`elevenlabs/eleven-v4-turbo`, voice `george`) → Browser Audio Playback
- Multilingual architecture: ONE model and ONE voice for all languages (English, Urdu, Arabic, mixed). NO language parameter sent. Input Unicode text itself determines language spoken.
- Presentation only: TTS audio is NOT stored in `ConversationSession` or `ConversationStore`.
- Brick 12 browser live tests: VERIFIED — Human operator confirmed end-to-end execution:
  - TEST A (English TTS): PASS (JARVIS response: "Power BI is Microsoft's analytics service that turns raw data into interactive, visual insights through dashboards and reports.", TTS Latency: 3053 ms, Audio generation/playback: PASS).
  - TEST B (Urdu TTS): PASS (JARVIS response: "پاور بی آئی مائیکروسافٹ کا ایک تجزیاتی پلیٹ فارم ہے جو خام ڈیٹا کو انٹرایکٹو ڈیش بورڈز اور رپورٹس کے ذریعے بصری بصیرت میں تبدیل کرتا ہے۔", TTS Latency: 2515 ms, Same model elevenlabs/eleven-v4-turbo, Same voice george, No language configuration change occurred).
  - TEST C (Arabic TTS): PASS (JARVIS response: "Power BI هو أداة تحليلات من مايكروسوفت تحوّل البيانات إلى تقارير ولوحات تفاعلية لفهم أفضل.", TTS Latency: 2657 ms, Same TTS pipeline used successfully).
  - TEST D (Mixed / Multilingual TTS): PASS (JARVIS response: "جارویس: پاور بی آئی ڈیش بورڈ ایک انٹرایکٹو صفحہ ہے جو اہم ڈیٹا کو بصری شکل میں دکھاتا ہے۔", TTS Latency: 2020 ms, Same endpoint/model/voice used successfully).
  - TEST E (Complete Voice Loop): PASS (Microphone capture: 5.8s, 85.8 KB, audio/webm;codecs=opus; STT Latency: 3935 ms; Transcript: "What is Power BI in one sentence?"; JARVIS response: "Sir, Power BI is Microsoft's analytics service that transforms raw data into interactive, visual insights through dashboards and reports."; TTS Latency: 2152 ms; Complete flow verified from mic to browser playback).
  - TEST F (New AI Response): PASS (Without page refresh, new AI response generated and Speak Response synthesized the NEW response; previous response not accidentally used).
  - TEST G (Replay): PASS (Speak Response used again on current response; audio generated/played again successfully without page reload. Subsequent mic capture of 5.8s and STT of 3261 ms remained fully functional).
- Prior bricks verified:
  - Brick 4 browser live test: VERIFIED
  - Brick 5 browser live streaming test: VERIFIED
  - Brick 6 live browser & session test: VERIFIED
  - Brick 7 browser live streaming & session test: VERIFIED
  - Brick 8 live browser restart persistence test: VERIFIED
  - Brick 9 browser live microphone capture test: VERIFIED
  - Brick 10 browser live multilingual STT test: VERIFIED
  - Brick 11 browser live voice transcript → AI test: VERIFIED


