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




