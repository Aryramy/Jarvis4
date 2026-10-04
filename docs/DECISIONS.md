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

