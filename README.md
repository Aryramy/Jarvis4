# JARVIS4

JARVIS4 is a next-generation, voice-first modular personal AI assistant architecture being rebuilt completely from scratch using a strict brick-by-brick engineering methodology.

> [!NOTE]
> JARVIS4 is currently at **Brick 0 (Foundation)**. No AI, voice, assistant, or automation features exist yet.

---

## Vision

JARVIS4 is intended to become a resilient, low-latency, modular personal AI assistant featuring:
- A single unified multilingual voice pipeline (supporting seamless mixed-language speech like Urdu + English, Arabic, etc., with automatic language switching and zero manual language toggles).
- Provider-agnostic model routing and fallbacks without core logic changes.
- Streaming low-latency responses.
- Safe desktop, browser, and system execution modules.

All capabilities will be introduced incrementally across discrete, verified bricks.

---

## Brick-by-Brick Development Philosophy

To prevent regressions, architectural drift, and fragile codebases, every single brick in JARVIS4 strictly adheres to:

```text
BUILD → TEST → MANUAL USE → VERIFY → COMMIT → NEXT BRICK
```

- Each brick focuses on a single, isolated capability.
- No future brick begins until the current brick is verified and committed.
- No placeholder/fake successes are allowed.
- Zero unnecessary dependencies.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v20.0.0 or higher (v24+ recommended)

### Installation

Clone the repository and install (currently zero external dependencies):

```bash
git clone <repository-url>
cd Jarvis4
npm install
```

### Running Tests

Execute the automated test suite using Node's native test runner:

```bash
npm test
```

### Running Verification

Run the project sanity, syntax check, and test verification suite:

```bash
npm run verify
```

The verification script validates directory structure, configuration sanity, syntax validation across all source and test files, and automated tests. It exits with code `0` on success.
