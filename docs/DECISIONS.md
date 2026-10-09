# Architectural Decision Records (ADR)

## ADR-0001: Brick-by-Brick Methodology
- **Status**: Accepted
- **Context**: Rebuilding JARVIS requires extreme stability, verifiable progress, and preventing architectural bloat or regressions.
- **Decision**: Adopt the strict `BUILD → TEST → MANUAL USE → VERIFY → COMMIT → NEXT BRICK` workflow. No future brick is started until the current brick is completely verified and committed.
- **Consequences**: Controlled, high-confidence iteration with zero unvetted code.

## ADR-0002: Native Node.js ESM Runtime & Built-in Test Runner
- **Status**: Accepted
- **Context**: Foundation needs to be lightweight, fast, and avoid third-party dependency bloat.
- **Decision**: Use modern Node.js (v20+) native ECMAScript Modules (`"type": "module"`) and the built-in `node:test` and `node:assert` runner.
- **Consequences**: Zero third-party dependencies required for Brick 0. Fast execution and zero installation overhead.

## ADR-0003: Unified Multilingual Voice Pipeline Architecture
- **Status**: Accepted (Design Principle for Future Implementation)
- **Context**: Support for multilingual communication (Urdu, English, Arabic, etc.) often suffers from fragmented, separate configurations and fragile mode switches.
- **Decision**: Mandate a single unified multilingual voice pipeline with automatic language detection, mid-sentence/dialogue code-switching, low latency streaming, and uniform provider interfaces.
- **Consequences**: Future voice implementations must adhere to this unified contract rather than implementing language-specific silos.

## ADR-0004: Minimal 4-Level Reusable Logger
- **Status**: Accepted
- **Context**: Logging needs to be uniform, clean, and provide standardized log levels without third-party libraries.
- **Decision**: Provide a minimal reusable logger supporting `DEBUG`, `INFO`, `WARN`, and `ERROR` levels with timestamped, structured output and configurable minimum log level via environment variables.
- **Consequences**: Clear diagnostic output across all components without complex logging frameworks.

## ADR-0005: Partitioned Test Structure
- **Status**: Accepted
- **Context**: Testing must be organized by scope to scale cleanly across future bricks.
- **Decision**: Partition `tests/` into `unit/`, `integration/`, `contract/`, `regression/`, and `smoke/`.
- **Consequences**: Predictable test organization as future features are added.

## ADR-0006: Separation of Text Processing Core and CLI Interface
- **Status**: Accepted
- **Context**: The text processing pipeline must serve terminal CLI now and future UI, voice, and orchestrator modules later without duplication.
- **Decision**: Encapsulate deterministic input validation, normalization, and response generation in `src/core/textCore.js` (`handleText`), keeping `src/cli/jarvis.js` as an agnostic command-line adapter that consumes the core's structured result.
- **Consequences**: Text processing remains purely functional and decoupled from CLI presentation and process exit lifecycles.

## ADR-0007: Minimal Local Web Interface using Built-in HTTP
- **Status**: Accepted
- **Context**: A local web interface is needed to interact with the text pipeline from a browser without introducing third-party framework dependencies.
- **Decision**: Implement a lightweight local HTTP server using Node.js built-in `node:http` serving vanilla HTML/CSS/JS and exposing `POST /api/text`, which directly invokes `handleText`.
- **Consequences**: Zero runtime dependencies, isolated web adapter layer, easily testable on ephemeral ports.

## ADR-0008: Isolated AI Provider Contract and Cheaper Inference Adapter
- **Status**: Accepted
- **Context**: Need to connect to an external hosted AI provider (Cheaper Inference / OmniRoute) without polluting existing deterministic text core or introducing third-party SDK dependencies.
- **Decision**: Define a reusable `AIProvider` base contract and implement `CheaperInferenceProvider` utilizing Node.js native `fetch` against OpenAI-compatible endpoints. Expose a dedicated `npm run ai` CLI command while keeping existing `jarvis` and `web` pipelines untouched.
- **Consequences**: Provider-specific networking and formatting logic is isolated inside `src/providers/`. Automated regression verification runs offline with mock harnesses, while real connectivity is validated through live commands.

## ADR-0009: Real AI Provider Integration into Local Web Interface
- **Status**: Accepted
- **Context**: Need to connect the Cheaper Inference provider adapter (Brick 3) to the local browser UI (Brick 2) without duplicating provider networking logic, breaking deterministic Brick 2 endpoints, or introducing external client/server frameworks.
- **Decision**: Expose a dedicated `POST /api/ai` endpoint in `src/web/server.js` that directly calls `CheaperInferenceProvider.generate()`, redacts API keys from error responses, and supports optional provider dependency injection for offline integration testing. Update `src/web/index.html` with an "Ask AI" button and a visible "Thinking..." loading state while preserving the deterministic test button.
- **Consequences**: The web interface supports both deterministic Brick 1 test requests (`/api/text`) and real AI generation requests (`/api/ai`). Automated verification remains strictly offline, deterministic, and isolated from ambient credentials.

## ADR-0010: Low-Latency Streaming AI Provider and HTTP Endpoint
- **Status**: Accepted
- **Context**: Low-latency interactions and future voice capabilities require text deltas to be rendered immediately as they are generated by the model, rather than waiting for the entire completion to finish.
- **Decision**: Add an async generator `stream(prompt)` to `CheaperInferenceProvider` parsing OpenAI-compatible Server-Sent Events (SSE). Expose `POST /api/ai/stream` on the local web server using newline-delimited JSON (NDJSON) streaming (`{"type":"delta","text":"..."}\n`, `{"type":"done"}\n`, `{"type":"error","message":"..."}\n`). Add an "Ask AI — Stream" button in the web UI that immediately streams incoming deltas to the interface without intermediate buffering.
- **Consequences**: Progressively streams model responses end-to-end with low latency while preserving all existing deterministic and non-streaming AI routes.

## ADR-0011: Temporary Short-Term Conversation Context and In-Memory Session Management
- **Status**: Accepted
- **Context**: Conversational continuity requires the assistant to remember preceding turns in the running session. However, persistent memory, database storage, disk serialization, vector databases, or embedding frameworks are strictly out of scope for this foundation stage.
- **Decision**:
  1. Implement `ConversationSession` (`src/core/conversationSession.js`) as a pure in-memory message history container holding ordered `{ role, content }` objects, strictly constrained by a configurable maximum message count (default 20) with FIFO message eviction.
  2. Extend `AIProvider` and `CheaperInferenceProvider` with `generateMessages(messages)` accepting ordered conversation turns, while retaining backward compatibility for stateless `generate(prompt)` and `stream(prompt)`.
  3. Integrate session context into the non-streaming `POST /api/ai` route. On provider failure or exception, deterministically roll back the user turn to preserve uncorrupted history.
  4. Expose `POST /api/conversation/clear` to allow the user or client to clear session history in memory.
  5. Add a "Clear Conversation" button in `src/web/index.html` updating UI state and clearing in-memory context.
  6. Streaming (`POST /api/ai/stream`) deliberately remains stateless in Brick 6 to maintain narrow scope.
- **Consequences**: Temporary conversational context operates cleanly during an active process run and is completely erased upon server restart or explicit clear. Zero external storage or database dependencies.

## ADR-0012: Streaming AI with Shared Temporary Short-Term Conversation Context
- **Status**: Accepted
- **Context**: In Brick 6, temporary conversational context was integrated into non-streaming `POST /api/ai`, while `POST /api/ai/stream` remained stateless. Brick 7 requires progressive streaming AI to share the exact same temporary `ConversationSession` bidirectionally with non-streaming AI without introducing separate memory stores, persistent databases, or disk files.
- **Decision**:
  1. Extend `AIProvider` base contract and `CheaperInferenceProvider` with `streamMessages(messages, options)` yielding text deltas from ordered `[{ role, content }]` messages. Refactor stateless `stream(prompt)` to delegate to `streamMessages([{ role: 'user', content: trimmedPrompt }])`.
  2. Connect `POST /api/ai/stream` in `src/web/server.js` to the single shared `ConversationSession` instance already utilized by `POST /api/ai`.
  3. Flow: Append user turn to session -> retrieve ordered history -> invoke `provider.streamMessages(messages)` -> stream deltas to client progressively via NDJSON -> accumulate completed assistant response server-side -> append assistant turn to session only upon clean stream completion.
  4. Error and Abort Safety: If provider streaming throws an error or the client prematurely disconnects (`res.on('close')` before `writableEnded`), roll back the user message turn via `session.pop()`, do not record partial/fake assistant messages, and safely preserve prior valid conversation state.
  5. Shared Clear: `POST /api/conversation/clear` empties the single shared session, resetting context for both streaming and non-streaming modes.
- **Consequences**: Both streaming and non-streaming AI operate over identical in-memory session history. Full backward compatibility is preserved for existing stateless CLI and provider calls. Temporary state remains strictly in RAM, vanishing on clear or process restart.

## ADR-0013: Minimal Persistent Conversation State Across Server Restart
- **Status**: Accepted
- **Context**: Prior to Brick 8, conversation history was purely in-memory and lost upon process termination. Brick 8 requires conversation state to survive server restarts using a minimal local file persistence mechanism without introducing external databases, ORMs, vector embeddings, summarization, or semantic memory systems.
- **Decision**:
  1. Implement `ConversationStore` (`src/core/conversationStore.js`) managing a local versioned JSON file (`runtime/conversation.json`, configurable via options or `CONVERSATION_STORE_PATH`).
  2. Implement safe atomic write operations via temporary files and rename/replace to prevent corruption during unexpected shutdowns.
  3. Safe corruption and missing file handling: missing file returns `[]`; malformed/corrupted file logs a controlled warning and starts cleanly with an empty session without crashing the server.
  4. Integrate persistence into `src/web/server.js`: on startup, restore valid saved turns into `ConversationSession` (respecting FIFO `maxMessages` bounds); on successful completion of normal or streaming AI turns, persist the updated state atomically; on stream failure or client abort, preserve prior valid state without recording partial turns.
  5. Clear synchronization: `POST /api/conversation/clear` empties both the in-memory `ConversationSession` and the persisted disk file (`store.clear()`).
  6. Git and security protection: ignore `runtime/` and temp files in `.gitignore`; strictly prohibit storing secrets, API keys, or authorization tokens.
- **Consequences**: Restarts restore previous conversation turns across both normal and streaming AI modes. Zero external database dependencies. Automated tests use isolated temporary files and do not touch developer runtime files.

## ADR-0014: Browser Microphone Capture Foundation
- **Status**: Accepted
- **Context**: Future voice interaction requires real microphone capture as an input foundation. However, Brick 9 is capture foundation only and must not implement speech recognition (STT), speech synthesis (TTS), language selection, wake word detection, or server audio upload endpoints. In accordance with ADR-0003, the capture layer must remain completely language-agnostic so that future multilingual processing operates over one unified pipeline.
- **Decision**:
  1. Implement `MicrophoneRecorder` (`src/web/microphone.js`) as an ESM module encapsulating browser `navigator.mediaDevices.getUserMedia({ audio: true })` and `MediaRecorder`.
  2. Implement safe capability and MIME type negotiation (`audio/webm;codecs=opus`, `audio/webm`, `audio/ogg;codecs=opus`, `audio/ogg`, `audio/mp4`, `audio/aac`).
  3. Validate completed recordings: verify audio Blob exists, verify Blob size > 0 (rejecting zero-byte captures), calculate capture duration, and generate capture metadata (`blob`, `size`, `type`, `durationMs`, `durationSec`, `url`).
  4. Implement robust hardware resource cleanup: stop all `MediaStream` audio tracks upon recording stop or cleanup to release microphone hardware and prevent resource leaks across repeated recording cycles.
  5. Minimal UI integration in `src/web/index.html`: add "Start Microphone" and "Stop Microphone" controls, microphone status indicator (`Idle`, `Requesting permission...`, `Recording`, `Captured`, `Error`), capture metadata display, and optional browser-native `<audio controls>` playback to allow humans to verify their recorded voice.
  6. Serve `microphone.js` directly via `GET /microphone.js` from the existing lightweight HTTP server. Audio remains in the browser without server upload endpoints in this brick.
  7. Automated verification is completely offline and deterministic using injected/mocked MediaDevices and MediaRecorder abstractions, ensuring no real hardware dependencies during automated tests.
- **Consequences**: Provides reliable browser microphone capture and metadata extraction ready for future unified multilingual STT integration in subsequent bricks, without premature framework dependencies or language silos.

## ADR-0015: Unified Multilingual Speech-to-Text using OpenRouter
- **Status**: Accepted
- **Context**: Brick 9 established the browser microphone capture foundation. Brick 10 requires connecting browser microphone recordings to a speech-to-text pipeline through OpenRouter without language silos, manual selectors, or per-language configuration.
- **Decision**:
  1. Reusable STT Provider Contract: Implement `SpeechToTextProvider` (`src/providers/speechToTextBase.js`) defining `transcribe(audioBytes, metadata, options)`.
  2. OpenRouter STT Adapter: Implement `OpenRouterSpeechToTextProvider` (`src/providers/openRouterSTT.js`) encapsulating OpenRouter HTTP multipart/form-data logic, model configuration (`openai/whisper-large-v3-turbo`), timeout handling via `AbortController`, duration measurement, Unicode preservation, and credential redaction.
  3. Single Multilingual Pipeline: Strictly omit the `language` parameter by default, allowing the multilingual Whisper model to automatically identify spoken language across English, Urdu, Arabic, and code-switched mixed sentences (e.g., Urdu + English) without language dropdowns, selectors, or per-language routes.
  4. Local Web Server Endpoint: Expose `POST /api/stt` in `src/web/server.js` accepting microphone audio (multipart or raw audio stream), validating audio presence, non-zero size, MIME type, and configuration. Audio is forwarded in-memory without saving to disk or polluting conversation memory.
  5. Minimal UI Extension: Add a "Transcribe" button to `src/web/index.html` after recording. When clicked, displays `STT: Transcribing...`, followed by measured latency (`STT: <ms> ms`) and transcript (`Transcript:\n<text>`). The transcript is NOT forwarded to Ask AI, nor is TTS added.
## ADR-0016: Voice Transcript to Existing JARVIS AI Pipeline Integration
- **Status**: Accepted
- **Context**: Brick 10 established multilingual speech-to-text via OpenRouter (`openai/whisper-large-v3-turbo`). Brick 11 requires connecting voice transcripts to the existing JARVIS text AI pipeline (Cheaper Inference) without creating redundant backend routes, without language silos, without speech output (TTS), and without automatic submission.
- **Decision**:
  1. Composable Architecture: Avoid creating a redundant compound backend route (e.g. `/api/voice-ai`). Compose the existing verified `POST /api/stt` and `POST /api/ai` endpoints directly from the browser.
  2. Explicit Human Control: Do not automatically submit transcripts to the AI. Require the human to explicitly click "Ask JARVIS" after reviewing the recognized text, keeping STT and AI verification independently observable.
  3. Shared Conversation Memory: Submitting transcripts to `POST /api/ai` transparently participates in the single existing `ConversationSession` and persistent `ConversationStore`. Context is shared seamlessly bidirectionally between typed prompts and voice-transcribed prompts.
  4. Language-Agnostic Unicode Flow: Transcripts in English, Urdu, Arabic, or code-switched mixed sentences are passed verbatim as Unicode UTF-8 strings to `POST /api/ai` without transliteration, client-side translation, or language-specific routes.
  5. State Isolation & Independent Error Handling: Client maintains current transcript state; new recordings reset transcript state until transcribed; failed STT cannot submit older transcripts; failed AI requests do not delete transcripts; busy state prevents accidental duplicate submission; and STT vs AI error displays remain strictly distinct.
- **Consequences**: Connects voice input to JARVIS AI text response with minimal code additions, zero external dependencies, zero secret leakage, and 100% offline automated test verification.

## ADR-0017: Unified Multilingual Text-to-Speech Output using OpenRouter
- **Status**: Accepted
- **Context**: Bricks 9–11 established browser microphone capture, speech-to-text via OpenRouter, and text generation via Cheaper Inference. Brick 12 requires adding voice output: converting the latest completed JARVIS text response into multilingual speech via OpenRouter TTS.
- **Decision**:
  1. Reusable TTS Provider Contract: Implement `TextToSpeechProvider` (`src/providers/textToSpeechBase.js`) defining `synthesize(text, options)`.
  2. OpenRouter TTS Adapter: Implement `OpenRouterTextToSpeechProvider` (`src/providers/openRouterTTS.js`) encapsulating OpenRouter HTTP logic, endpoint (`POST /audio/speech`), model (`elevenlabs/eleven-v4-turbo`), voice (`george`), and format (`mp3`).
  3. Unified Multilingual Architecture: The pipeline strictly omits any `language` parameter. The input Unicode text itself determines the spoken language (English, Urdu, Arabic, mixed). No language selectors, language dropdowns, per-language voices, per-language models, or per-language routes are used.
  4. Verbatim Text Transmission: Input text is sent exactly as received without translation or romanization/transliteration.
  5. Local Endpoint: Expose `POST /api/tts` in `src/web/server.js`, receiving `{ text }`, returning binary `audio/mpeg` with `X-TTS-Duration-Ms` and `Cache-Control: no-store`. Error responses are structured JSON with sanitized credentials.
  6. Explicit Human Action: TTS does NOT auto-speak. The user explicitly clicks "Speak Response" to synthesize the latest successfully completed JARVIS text response.
  7. Client State & Safety: `currentAssistantResponse` tracks the latest completed response only. Failed AI requests do not become speakable responses. Missing/empty responses prevent submission. Busy state prevents duplicate calls. Audio is played via `URL.createObjectURL(blob)` and previous object URLs are revoked. Replay is supported.
  8. Output-Only Memory: TTS audio is strictly a presentation layer and is NEVER stored in `ConversationSession`, `ConversationStore`, or conversation memory.
  9. Fully Mocked Offline Verification: Automated tests mock all network calls and make zero external network requests during `npm run verify`.
- **Consequences**: Completes the first manual voice loop (Voice Mic → STT → Transcript → Ask JARVIS → AI → Response → Speak Response → TTS → Playback) with explicit human controls, zero auto-chaining, zero secret leakage, and 100% offline verification.

## ADR-0018: One-Action Sequential Voice Turn Orchestration
- **Status**: Accepted
- **Context**: Bricks 9–12 established browser microphone capture, speech-to-text via OpenRouter STT, text AI via Cheaper Inference, and speech synthesis via OpenRouter TTS. However, exercising the complete loop required 3 separate explicit user actions: Transcribe -> Ask JARVIS -> Speak Response. Brick 13 requires connecting these already verified stages sequentially behind a single user action ("Run Voice Turn") operating on an existing captured audio recording, without continuous listening, wake words, automatic recording restarts, VAD, or redundant backend pipeline routes.
- **Decision**:
  1. Browser-Side Sequential Composition: Orchestrate existing local endpoints (`POST /api/stt` -> `POST /api/ai` -> `POST /api/tts` -> browser MP3 playback) entirely in the browser via `VoiceTurnRunner` (`src/web/voiceTurn.js`), without creating compound backend routes (`/api/voice`, `/api/voice-agent`, etc.).
  2. Single Explicit Action: User explicitly clicks "Run Voice Turn" (`#run-voice-turn-btn`) after completing a microphone recording. Old manual diagnostic controls (`Transcribe`, `Ask JARVIS`, `Speak Response`) remain fully functional.
  3. Client-Side Deterministic State Machine: Implemented via `VoiceTurnState` (`IDLE` -> `STT` -> `AI` -> `TTS` -> `PLAYING` -> `COMPLETE`). On failure, transitions to `STT_ERROR`, `AI_ERROR`, or `TTS_ERROR`, halting downstream execution immediately.
  4. Stale Data Protection: Each turn has a unique monotonically increasing turn ID; intermediate results are scoped strictly to the current turn execution. Failed STT cannot submit old transcripts to AI; failed AI cannot synthesize old responses; failed TTS cannot play old audio.
  5. Shared Conversation Context: Voice-turn AI calls submit directly to `POST /api/ai`, preserving conversation context in `ConversationSession` and `ConversationStore` seamlessly across typed and voice turns. Zero audio data is stored in conversation memory.
  6. Multilingual Verbatim Flow: Single pipeline without language parameters or selectors. Unicode strings are forwarded verbatim across English, Urdu, Arabic, and code-switched mixed sentences.
  7. Latency Measurement: Total voice turn latency (click to playback start) and individual stage latencies (`STT: <ms> ms`, `TTS: <ms> ms`) are tracked and displayed.
- **Consequences**: Enables single-click voice turn execution from captured audio while preserving existing independent controls, zero secrets exposure, and 100% offline automated test verification.

## ADR-0019: AI Latency Instrumentation and Bottleneck Diagnosis
- **Status**: Accepted
- **Context**: In Brick 13, complete sequential voice turns exhibited noticeable latency (~18s–31s), with STT taking ~2.5s–3.2s and TTS taking ~1.2s–3.0s. The AI stage was suspected of accounting for the majority of the elapsed time, but isolated AI timing was not previously instrumented. Optimization without empirical measurement violates core architecture guidelines.
- **Decision**:
  1. Multi-tier High-Resolution/Monotonic Timing: Instrument three independent latency metrics using monotonic clocks (`performance.now()` where available):
     - `providerDurationMs`: Measured inside `CheaperInferenceProvider` immediately across external HTTP provider calls.
     - `serverAiDurationMs`: Measured inside `/api/ai` from request handler entry to response readiness, capturing server-side session/store and payload processing.
     - `clientAiDurationMs`: Measured in the browser from before `fetch('/api/ai')` until the response is parsed.
  2. Safe Response Metadata Contract: Expose `{ timing: { providerDurationMs, serverAiDurationMs } }` in the `/api/ai` JSON response without altering existing response keys (`success`, `response`, `error`) and without leaking secrets, API keys, or prompt internals.
  3. UI Diagnostic Visibility: In `index.html`, display `AI: <ms> ms` for typed Ask AI, Ask JARVIS, and automated Voice Turn. Voice Turn displays a complete breakdown across all stages: `STT: <ms> ms`, `AI: <ms> ms`, `TTS: <ms> ms`, and `Voice Turn Total: <ms> ms`.
  4. Diagnostic Only: Strictly prohibit provider changes, model switching, fallback routing, prompt engineering, streaming TTS, or speculation in this brick.
  5. 100% Mocked Offline Tests: Automated tests execute with deterministic mocks and zero live network requests during `npm run verify`.
- **Consequences**: Makes the AI stage and external provider latency fully observable and isolated without altering conversation semantics or breaking existing contracts.

## ADR-0020: Cheaper Inference AI Latency Benchmark & Candidate Selection
- **Status**: Accepted
- **Context**: In Brick 14, multi-tier timing instrumentation isolated the dominant latency bottleneck in the voice pipeline to the external Cheaper Inference request path (23.6s–30.0s), with local server overhead negligible (0–7 ms). To evaluate whether faster models exist on the Cheaper Inference / OmniRoute gateway for short JARVIS-style requests without risking production regressions, an isolated, safe, manually-invoked benchmark tool is needed.
- **Decision**:
  1. Isolated Diagnostic Tooling: Implement `scripts/benchmark-ai-latency.mjs` and expose explicit CLI command `npm run benchmark:ai`. The benchmark is strictly an operator diagnostic tool and is NEVER invoked automatically by `verify.mjs`, web server startup, `/api/ai`, voice turns, or automated test suites.
  2. Production Model Immutability: The production model (`deepseek-v4-flash-0731`) and `/api/ai` configuration remain completely unchanged. The benchmark instantiates isolated provider instances without mutating `.env`, `process.env`, or production config.
  3. Live Model Catalog Discovery: Discovers available models via `GET /v1/models` from the configured base URL without hard-coding static catalogs. Filters out non-text models (embeddings, audio, whisper, vision/diffusion, moderation) and caps candidate selection at 1 baseline + up to 3 alternatives (4 models total). Supports discovery-only mode via `--discover` making zero prompt requests.
  4. Sequential Execution & Deterministic Evaluation: Runs 3 sequential trials per candidate (max 12 total live requests) with 30000 ms timeout per trial using deterministic short prompt `"What is 2 + 2? Answer with only the number."` expecting `"4"`. Sequential execution prevents local contention and rate-limit ambiguity.
  5. Correctness Filter & Statistical Metric: Evaluates semantic correctness; candidates that fail fast or answer incorrectly are never selected as fastest candidate. Computes min, max, average, and median latencies. For 3 trials, median latency determines the fastest observed candidate.
  6. Gitignored Runtime Output: Results saved to `runtime/ai-benchmark-latest.json` (and `.txt`), completely ignored by git. All secrets and API keys are strictly redacted from logs, errors, and stored JSON.
  7. 100% Mocked Offline Tests: Automated test suite (`tests/unit/benchmarkAiLatency.test.js`) executes 100% offline with zero live network requests during `npm run verify`.
- **Consequences**:
  - Live benchmark executed with 12 sequential requests across 4 models (`deepseek-v4-flash-0731`, `aion-3.0-mini`, `deepseek-v4.1-flash`, `gemini-3.8-flash`).
  - Empirical finding: 10/12 requests timed out near 30s. Only `deepseek-v4.1-flash` completed 2/3 requests (median: 29385 ms, with 1 timeout).
  - Decision: NO production model switch is authorized or performed. Changing model ID alone on the existing Cheaper Inference request path does not resolve latency. Production model remains `deepseek-v4-flash-0731`. Future architectural investigation must focus on alternative gateways/pathways rather than blind model swapping on the same provider path.










