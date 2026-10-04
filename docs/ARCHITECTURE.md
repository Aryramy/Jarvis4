# JARVIS4 Architecture Specification

## 1. System Overview

JARVIS4 is designed around a modular, event-driven architecture with clear boundaries between the core runtime, peripheral adapters, and external providers.

```text
+-------------------------------------------------------------------+
|                            JARVIS4 Core                           |
|  +--------------------+  +------------------+  +---------------+  |
|  | Config & Logging   |  | Event Bus / State|  | Orchestrator  |  |
|  +--------------------+  +------------------+  +---------------+  |
+-------------------------------------------------------------------+
           |                         |                     |
           v                         v                     v
+---------------------+    +--------------------+  +----------------+
| Voice Pipeline      |    | Intelligence / LLM |  | Tools & Action |
| (Unified Multiling) |    | (Smart Routing)    |  | (OS / Browser) |
+---------------------+    +--------------------+  +----------------+
```

---

## 2. Brick 0 Foundation Architecture

In Brick 0, only the fundamental scaffolding is established:
- **`src/core/`**: Core application entry and lifecycle management.
- **`src/config/`**: Environment configuration parsing and validation.
- **`src/utils/`**: Shared lightweight utilities (e.g., standard logger with `DEBUG`, `INFO`, `WARN`, `ERROR` levels).
- **`scripts/verify.mjs`**: Strict sanity and verification runner.
- **`tests/`**: Native test suite partitioned into `unit`, `integration`, `contract`, `regression`, and `smoke`.

Zero external runtime dependencies are introduced in Brick 0. Standard ECMAScript modules (ESM) with Node.js built-ins (`node:test`, `node:assert`, `node:fs`, `node:path`) are used throughout.

---

## 3. Important Future Architecture Requirements

### 3.1 Unified Multilingual Voice Pipeline (Future Brick)

> [!IMPORTANT]
> JARVIS voice will eventually use **one unified multilingual voice pipeline**.
> It must **NOT** require separate manual configuration for Urdu, English, Arabic, or other languages.

The future voice architecture must adhere to the following principles:

1. **Automatic Multilingual Speech Understanding**: The pipeline must naturally detect and process incoming speech across multiple languages without user intervention or manual toggles.
2. **Automatic Language Switching**: Dynamic transitioning between languages mid-session without state resets.
3. **Mixed-Language Speech Support**: Seamless handling of code-switching / hybrid speech patterns (e.g., Urdu + English).
4. **Multilingual Speech Output**: Natural speech synthesis dynamically matched to the context and language.
5. **Streaming Audio**: End-to-end audio streaming to minimize latency.
6. **Low Latency & Fast Time-To-First-Audio (TTFA)**: Prioritizing immediate audible feedback.
7. **One Common Provider Interface**: Consistent abstraction over any speech-to-text (STT) or text-to-speech (TTS) backends.
8. **Provider Fallback Without Core Logic Changes**: Automatic fallback across providers (e.g. cloud vs local, or alternate vendors) without modifying JARVIS core orchestration.

*(Note: Do NOT implement this voice system in Brick 0. This requirement is documented for future architectural alignment.)*

### 3.2 Intelligence & Provider Agnosticism (Future Brick)
- Core orchestration must remain decoupled from specific LLM providers.
- Dynamic fallback and smart routing across tiers (fast/cheap inference vs deep reasoning).

### 3.3 Safe Tool Execution (Future Brick)
- Tool calls (filesystem, terminal commands, browser actions) must execute through explicit permission and validation boundaries.
