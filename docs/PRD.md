# JARVIS4 Product Requirements Document (PRD)

## 1. Product Vision

JARVIS4 is an intelligent, low-latency, modular personal AI assistant engineered to run locally and orchestrate voice, desktop, browser, and reasoning workflows seamlessly.

Rebuilt from the ground up following the lessons of previous iterations, JARVIS4 prioritizes:
- Extreme reliability and stability through strict brick-by-brick development.
- A single unified multilingual voice pipeline eliminating language-specific configurations.
- Minimal dependency overhead and clean architectural boundaries.
- Flexible, provider-agnostic intelligence with smart routing and resilient fallback mechanisms.

---

## 2. Brick-by-Brick Progression

JARVIS4 development is divided into discrete, independently testable bricks. No brick begins until the preceding brick has been built, tested, manually used, verified, and committed.

- **Brick 0**: Engineering Foundation, Testing, and Verification Scaffold (Current)
- **Future Bricks (Deferred)**:
  - Core event loop and runtime orchestration
  - Configuration and secure secrets management
  - Unified Multilingual Voice Pipeline (STT/TTS/Audio streaming)
  - LLM Provider Abstraction & Smart Routing
  - Context & Memory Management
  - Local Tool Execution (Filesystem, Terminal, Desktop automation)
  - Browser Automation & Web Intelligence
  - Interface / UI (CLI / GUI)

---

## 3. Scope of Brick 0 (Foundation)

### In-Scope
- Safe directory hierarchy (`src/`, `tests/`, `docs/`, `scripts/`).
- Native Node.js test infrastructure (`node:test`, `node:assert`).
- Comprehensive verification suite (`scripts/verify.mjs` via `npm run verify`).
- Minimal reusable logger supporting `DEBUG`, `INFO`, `WARN`, `ERROR`.
- Centralized configuration blueprint.
- Strict operational documentation (`AGENTS.md`, `CURRENT_STATE.md`, `TASKS.md`, `DECISIONS.md`, `KNOWN_ISSUES.md`, `ARCHITECTURE.md`).

### Explicitly Out-of-Scope (Strictly Prohibited in Brick 0)
- AI / LLM models and client wrappers
- Voice pipelines, STT, TTS, and audio handling
- Browser automation and web scrapers
- Internet search
- Memory systems and databases
- Desktop, keyboard, mouse, and OS control
- File manipulation tools
- Graphical user interfaces (GUI)
- Provider integrations (OpenAI, Gemini, Anthropic, etc.)
- Wake word detection
