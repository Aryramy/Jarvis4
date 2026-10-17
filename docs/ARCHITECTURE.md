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

---

## 4. Development, Verification & Harness Architecture

Development verification, future coding agent orchestration, autonomous model evaluation, and runtime tool governance are formally defined in:
- [HARNESS.md](file:///c:/Users/arehman/Desktop/AI%20Projects/Jarvis4/docs/HARNESS.md)

Refer to that document for harness layering (Test Harness, Real-Browser Harness, Development Agent Harness, Eval Harness, Runtime Agent Harness), repository mapping, maturity status, and operating contracts.

---

## 5. Runtime Agent Harness & Tool Governance Architecture (PRE-040A)

Between future autonomous planning/LLM agents (Brick 40) and deterministic browser capabilities (Bricks 26-39), JARVIS4 enforces an unbypassable deterministic governance boundary:

```text
USER TASK
   ↓
AGENT MODEL (Brick 40 - Not Started)
   ↓
STRUCTURED TOOL PROPOSAL
   ↓
RUNTIME AGENT HARNESS (PRE-040A)
   ↓
Schema & Argument Validation (Rejects raw selectors, XPath, JS, privileged overrides)
   ↓
Runtime / Page / Context Validation (Snapshot freshness, subcontext checks)
   ↓
Deterministic Risk Classification (R0-R4)
   ↓
Execution Budget Check (Clamped counters tracked atomically)
   ↓
Permission / Confirmation Gate (Human operator approves R3; token hidden from model)
   ↓
Deterministic BrowserManager Primitive
   ↓
Deterministic Verification (Authoritative browser DOM state)
   ↓
Sanitized Evidence Envelope (Redacted secrets, untrusted web data wrapping)
   ↓
AGENT / AUDIT TRAIL
```

Key Architectural Invariants:
1. **Zero LLM Execution in Governance**: Governance rules are 100% deterministic code. Exactly 0 LLM calls, 0 OpenRouter calls.
2. **Whitelisted Tool Registry**: Exact 26 tools. Unknown tools fail closed (`TOOL_NOT_REGISTERED`). Zero dynamic method invocation on `BrowserManager`.
3. **No Raw Selectors or Executable Code**: Schemas strictly reject CSS selectors, XPaths, JS code, and CDP commands.
4. **Human Confirmation Boundary & Token Privacy**: The model NEVER receives or presents confirmation tokens. Consequential proposals pause in `WAITING_USER_CONFIRMATION`. Operator approves through trusted UI. Harness delegates into GREEN-034 single-use prepared submission.
5. **Untrusted Web Data Wrapping**: Webpage content wrapped with `{ trust: 'untrusted_web_data', source: 'page' }` preventing prompt-injection privilege escalation.
6. **Finite State Machine**: Legal state transitions strictly enforced across all run states.

---

## 6. OpenRouter Routing Gate & Telemetry Architecture (PRE-040B)

In PRE-040B, the OpenRouter text provider layer is hardened before introducing autonomous browser planning (Brick 40) or task evaluation (PRE-040C).

```text
CALLER / FUTURE AGENT
         │
         │  (profile: 'FAST' | 'REASONING', messages, sessionId)
         ▼
OpenRouterRoutingGate
  ├─ buildRoutingRequest()
  │    ├─ Resolves application-controlled profile policy
  │    ├─ Blocks / ignores caller model overrides & cost tampering
  │    ├─ Validates safe opaque sessionId (rejects PII, paths, secrets)
  │    └─ FAST: PINNED_FALLBACK (primary model + native models array)
  │       REASONING: AUTO (openrouter/auto + cost_tier plugin)
  │
  ├─ Network Dispatch
  │    ├─ OpenRouter native provider failover preserved (no restrictive candidate filters)
  │    ├─ Native OpenRouter models fallback (zero client sequential loops)
  │    ├─ Client retry count = 0 (fail-fast policy)
  │    └─ Bounded timeout per profile
  │
  ├─ Telemetry & Cost Accounting
  │    ├─ Actual serving model extracted
  │    ├─ autoSelectedModel tracked separately from fallbackUsed
  │    ├─ Truthful cost: actual returned cost or null (never $0)
  │    └─ Zero secret / full-prompt logging
  │
  └─ Controlled Error Classification
       └─ Standardized error codes (TIMEOUT, RATE_LIMITED, AUTH_FAILED, etc.)
```

Architectural Principles:
1. **Application-Controlled Routing Policy**: Future planner or callers can only request a bounded profile (`FAST` or `REASONING`). Callers cannot supply arbitrary model IDs, cost tiers, or bypass failover.
2. **Native OpenRouter Fallbacks**: Pinned fallback mode uses the native OpenRouter `models` array rather than client-side catch-and-retry sequential loops.
3. **No Duplicate Auto Fallback**: Auto mode uses `openrouter/auto` directly with its internal selection, never wrapped in another fallback chain.
4. **Telemetry Privacy**: API keys, Bearer headers, passwords, cookies, and conversation contents are never logged.
5. **Truthful Cost**: Returned cost is reported directly. Unknown cost is reported as `null`, never fabricated or assumed $0.

---

## 7. Independent Agent Eval Harness & Golden Task Architecture (PRE-040C)

Before implementing the autonomous agent (Brick 40), JARVIS4 builds an independent evaluation system to grade agent behavior.

```text
AGENT UNDER TEST
      │
      ▼  (trajectory / tool proposals)
Runtime Agent Harness (PRE-040A)
      │
      ▼
BrowserManager (Bricks 26-39)
      │
      ▼
Real Browser State (Local Loopback Fixtures)


INDEPENDENT EVAL HARNESS (PRE-040C)
      │
      ├─ Task Definition (Public Prompt, Fixture, Allowed Tools, Budgets)
      ├─ Hidden Expected Evidence (Expected DOM, text, URLs, downloads, refusals)
      ├─ Safety & Confirmation Hard Gates (No raw selectors, scripts, credentials, or self-approval)
      ├─ Trajectory Grader (Hard gate validation + Informational stepRatio)
      └─ Sanitized Report Generation (test-results/eval-harness-latest.json)
```

Architectural Principles:
1. **Separation of Public Task from Hidden Expectations**: The agent under test receives only public prompt, fixture URL, allowed tools, and execution budget. Hidden expected evidence, grader code, and reference trajectories are strictly concealed.
2. **Task Immutability & Zero Executable Code**: Task definitions are deeply frozen and SHA-256 fingerprinted. Task files contain only declarative JSON conditions; executable JS in task definitions is rejected with `EVAL_TASK_INVALID`.
3. **Deterministic Graders**: Evidence, Safety, Confirmation, Secret Leak, Budget, and Tool Allowlist graders are pure deterministic code. Exactly 0 LLM calls or heuristic grading.
4. **Hard Gates vs Informational Metrics**: Safety, secret protection, confirmation compliance, budget adherence, allowed-tool compliance, and verified final state are non-negotiable hard gates (100% required). Step efficiency (`stepRatio = actualSteps / optimalSteps`), duration, and latency are secondary informational metrics. A high efficiency score cannot mask a hard gate failure.
5. **Generic Adapter Interface**: `AgentAdapterInterface` defines `runTask({ publicTask, runtimeHarness, runId, browserManager })`. Implemented in PRE-040C by `ScriptedReferenceAdapter` for evaluator self-test; will be implemented by the autonomous agent adapter in Brick 40.
6. **Critical Truthfulness**: PRE-040C validates the Eval Harness itself against scripted reference trajectories (`autonomousAgent = false`). Reports distinctly as "Eval Harness self-test", NEVER as autonomous agent evaluation. Exactly 0 LLM calls, 0 OpenRouter calls, 0 external network requests, $0 cost.

---

## 8. Autonomous Web Agent & Multi-Step Planner Architecture (BRICK-040)

```text
User Task Request / Evaluation Harness
                │
                ▼
     AutonomousAgentController
                │
   ┌────────────┴────────────┐
   │  Hybrid Planner Loop    │
   │  (State Machine +       │
   │   Structured Output)    │
   └────────────┬────────────┘
                │
                ▼  1 Tool Call Per Turn
    RuntimeAgentHarness (PRE-040A)
                │
   ┌────────────┴────────────┐
   ▼                         ▼
Consequential Action?     Allowed Read/Mutating Action?
   │                         │
   ▼                         ▼
PAUSE (Operator Approval)  BrowserManager (Bricks 26-39)
                             │
                             ▼
                    Real Browser Fixtures
```

Architectural Principles:
1. **Hybrid Planning Model**: Initial 2-4 milestone plan formulated at task start. Plan is dynamically updated on state changes, unexpected observations, or harness rejection without rigid lock-in.
2. **One Tool Proposal Per Turn**: Strictly one proposal per turn. Parallel or bulk tool executions are rejected.
3. **Deterministic Governance Enforcement**: All agent actions pass through `RuntimeAgentHarness`. Consequential submissions pause for human operator approval; authentication barriers halt in `NEEDS_HUMAN_AUTH`; stale snapshots trigger re-observation.
4. **Strict Schema Validation & Sanitization**: LLM output is strictly validated against JSON schema. Unredacted secrets and raw selectors/code are blocked.
5. **Bounded Routing & Timeouts**: Routing defaults to `FAST` profile (`deepseek-v4-flash-0731`) with `reasoning: { effort: 'none' }` to eliminate reasoning token blowup and clamp latency to ~800ms per turn. Each model call is bounded by `Math.min(10000, remainingBudgetMs)` with zero infinite retry.
6. **Evaluator Isolation**: The agent interacts solely with public task data via `AutonomousAgentAdapter`. Hidden criteria and expected evidence are completely isolated.

---

## 9. Bounded Recovery & Self-Healing Browser Agent Architecture (BRICK-041)

```text
FAILURE
   ↓
DETERMINISTIC CLASSIFICATION
   ↓
FRESH NON-MUTATING OBSERVATION
   ↓
UPDATED PAGE / CONTEXT / SNAPSHOT
   ↓
BOUNDED REPLAN
   ↓
NEW TOOL PROPOSAL
```

Architectural Principles:
1. **Deterministic Recovery Policy vs. Model Decisiveness**: Runtime/controller policy exclusively determines failure taxonomy, recoverability, and permitted recovery operations (`recoveryPolicy.js`). The model NEVER decides whether a failure is recoverable or allowed to retry.
2. **Strict Prohibition of Automatic Mutation Replay**: Runtime code NEVER automatically replays mutating actions (`click`, `fill`, `check`, `uncheck`, `select`, `fillForm`, `uploadFile`, `downloadFile`, `submitForm`) after failure. Mutation recovery requires fresh non-mutating observation followed by an entirely new model proposal.
3. **Explicit Mutation Outcome Classification**:
   - `EFFECT_VERIFIED`: Evidence confirms the action succeeded. Do not repeat.
   - `NO_EFFECT_VERIFIED`: Evidence confirms the action did not occur. A fresh proposal may be permitted after observation.
   - `OUTCOME_UNCERTAIN`: Outcome cannot be verified safely. Halts in `MUTATION_OUTCOME_UNCERTAIN` without auto-retry.
4. **Consequential Retry & Confirmation Replay Hard Protection**: R3 consequential actions with uncertain execution halt safely in `CONSEQUENTIAL_OUTCOME_UNCERTAIN`. Zero confirmation replay, zero token reuse, and zero model self-approval.
5. **Separate Deterministic Recovery Budgets**: Clamped limits (`maxRecoveryCycles = 2`, `maxReplans = 2`, `maxSameFailureOccurrences = 2`, `maxContextRediscoveries = 2`, `maxRecoveryWaits = 2`). All recovery operations consume standard execution budgets (tool calls, model turns, runtime ms); no hidden recovery channels. Model cannot override or expand budgets.
6. **Privacy-Preserving Same-Failure Loop Detection**: Safe fingerprinting hashes `failureClass`, `tool`, `pageId`, `contextId`, `semanticTarget`, and `milestone` (redacting all page text, secrets, and raw attributes). If identical failure patterns exceed threshold, execution halts in `RECOVERY_EXHAUSTED`.
7. **Semantic Re-Grounding & Context Renewal**: Target rediscovery uses semantic role and accessible identifiers. Detached iframes require explicit context rediscovery (`listContexts`) to obtain a fresh `contextId`. Stale snapshots require fresh `inspectPage` to obtain a fresh `snapshotToken`. Arbitrary CSS/XPath/JS guessing is prohibited.
