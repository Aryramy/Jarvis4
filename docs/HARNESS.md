# HARNESS.md — JARVIS4 Development, Verification & Agent Harness Architecture

This document defines the canonical architecture, layering, maturity, and operational principles of the JARVIS4 Harness subsystem.

---

## 1. Harness Subsystem Definition & Layering

JARVIS4 distinguishes five distinct harness layers across development, verification, agent development, evaluation, and production runtime:

```text
+-----------------------------------------------------------------------------+
|                               JARVIS4 HARNESS                               |
+-----------------------------------------------------------------------------+
  |
  +-- [A] TEST HARNESS (Deterministic Offline Verification) [ACTIVE]
  |     Command: npm run verify
  |     Scope: Fast, 100% offline unit, integration, contract, regression,
  |            smoke, frontend syntax, and configuration validation.
  |
  +-- [B] REAL-BROWSER TEST HARNESS (Real Edge + Playwright) [ACTIVE]
  |     Command: npm run verify:browser
  |     Scope: End-to-end browser mechanics verification running against
  |            installed Microsoft Edge and local loopback fixtures.
  |
  +-- [C] DEVELOPMENT AGENT HARNESS (Coding Agent Governance) [PARTIAL / PLANNED]
  |     Scope: Context construction, rule loading, skill selection, tool
  |            permissions, bounded repair loops, task contracts, and worktrees.
  |
  +-- [D] EVAL HARNESS (Model & Autonomous Behavior Evaluation) [ACTIVE - REFERENCE & AUTONOMOUS VERIFIED]
  |     Commands: npm run eval:harness (reference self-test), npm run eval:agent (autonomous live eval)
  |     Scope: Golden tasks (G01-G12), trajectory grading, evidence verification,
  |            hard safety gates, budget grading, tool allowlist compliance, sanitized
  |            reporting. Evaluator self-tested via ScriptedReferenceAdapter (27/27 PASS)
  |            and autonomous agent evaluated via AutonomousAgentAdapter (11/12 PASS, 100% hard safety gates).
  |
  +-- [E] RUNTIME AGENT HARNESS (Autonomous Execution Governance) [ACTIVE - CONNECTED TO AUTONOMOUS PLANNER]
  |     Scope: Tool proposal → schema validation → risk classification →
  |            budget check → permission / confirmation → deterministic execution →
  |            sanitized evidence → secret-free audit. Intercepts and governs all LLM actions.
```

---

## 2. Layer Details

### Layer A: Test Harness (Deterministic Offline Verification)
- **Status**: `ACTIVE`
- **Runner**: `scripts/verify.mjs` (`npm run verify`)
- **Key Characteristics**:
  - 100% offline, zero network access, zero browser launch overhead.
  - Native Node.js test runner (`node:test`, `node:assert`).
  - Strict static syntax gates: ES module checks (`node --check`), inline HTML script AST validation (`vm.Script`), configuration sanity.
  - Comprehensive test partitions:
    - `tests/unit/`: Component-level deterministic logic.
    - `tests/integration/`: Cross-module internal orchestration.
    - `tests/contract/`: Public interface and schema compliance.
    - `tests/regression/`: Hardened checks preventing recurrence of discovered defects.
    - `tests/smoke/`: System-level operational baseline.

### Layer B: Real-Browser Test Harness (Real Edge + Loopback Fixtures)
- **Status**: `ACTIVE`
- **Runner**: `scripts/verify-browser.mjs` (`npm run verify:browser`)
- **Key Characteristics**:
  - Drives installed system Microsoft Edge (`channel: "msedge"`) via Playwright.
  - Uses strictly local deterministic loopback fixtures (`tests/browser-fixtures/`) served on `127.0.0.1`.
  - Exactly 0 external internet requests during automated verification.
  - Automatic lifecycle guarantee: Guaranteed `try/finally` browser and server teardown preventing orphaned Edge instances or hung ports.
  - Verified capabilities:
    - Browser context lifecycle and tab management.
    - Semantic DOM observation and MutationObserver tracking.
    - Dynamic element insertion, style/class visibility mutations, and stability tracking.
    - Client-side Single Page Application (SPA) routing (`pushState`, `replaceState`, hash).
    - Dynamic snapshot token generation, versioning, and stale token invalidation.
    - Multi-page atomic isolation and cross-page token protection.
    - Semantic form inspection, label resolution, and safe transactional population.
    - Confirmed form submission, single-use confirmation tokens, and evidence verification.
    - Human-authenticated persistent session vault, DPAPI protection, and lifecycle restore.
    - Human authentication handoff, safe pause boundary, mutating action blocking, explicit human resume, fresh state re-inspection, deterministic barrier clearance verification, repeated explicit resume policy, and diagnostic screenshot suppression.
    - Safe file upload: target resolution on file inputs, path normalization, existence validation, directory upload blocking, size limits, sensitive file denylist, accept attribute constraint enforcement, Playwright native setInputFiles, verified DOM state, zero auto-submit, and full path privacy.
    - Safe file download: explicit authorization, real Edge download events as proof, approved download directory confinement, filename sanitization and path traversal defense, Windows reserved device name escaping, collision-safe naming, bounded download timeout, blocked executable/script types, zero auto-retry, and opaque download IDs.
    - Transfer cleanup: guaranteed synthetic upload and download test artifact removal.
    - Structured extraction & scraping v1 (Brick 38): deterministic page data extraction bound atomically to managed page and snapshot token across 7 categories (metadata, headings preserving DOM order, links with same-origin detection, regular/irregular HTML tables, lists and bounded recursive sublists, dl/dt/dd key-value definitions, repeated semantic records). Strict privacy exclusion of passwords, text inputs, textareas, file paths, hidden inputs, cookies, and tokens. Full fidelity Unicode and Arabic RTL preservation. Main document only (0 iframe, 0 shadow DOM). Conservative limits (`maxRecords`, `maxTextChars`, `maxFieldChars`, `maxNestingDepth`) with explicit truncation metadata. Dynamic mutation and SPA route staleness protection (`PAGE_CHANGED` / `TARGET_STALE`). Mutual exclusion with active Human Handoff (`HUMAN_HANDOFF_ACTIVE`).
    - Complex UI contexts v1 (Brick 39): deterministic context discovery and scoped semantic operations across main frame, iframes, nested frames, and open shadow roots. Preserves parent-child hierarchy, frame names, frame URLs, shadow host elements, and nesting depth bounded by `BROWSER_MAX_CONTEXT_DEPTH` and `BROWSER_MAX_DOM_CONTEXTS`. Explicit closed shadow root detection (`closedShadowRootDetected: true`) with direct interaction safely rejected (`CLOSED_SHADOW_ROOT_UNSUPPORTED`). Opaque context IDs, dynamic attachment/detachment tracking (`CONTEXT_DETACHED`, `CONTEXT_NOT_FOUND`), context-scoped inspection (`/api/browser/inspect`, `/api/browser/inspect-contexts`), scoped target resolution, action execution, stability waits, and structured extraction. Per-context snapshot token isolation and stale token rejection. Subcontext form submission and file transfer blocking (`SUBCONTEXT_OPERATION_NOT_SUPPORTED`). Guaranteed page-close context cleanup.

### Layer C: Development Agent Harness (Coding Agent Governance)
- **Status**: `PARTIAL / PLANNED`
- **Purpose**: Controls and assists the AI coding agent that builds, tests, and refactors JARVIS4.
- **Current Realized Subset**:
  - Operating rules and boundaries enforced via `AGENTS.md`.
  - Canonical state tracking via `docs/CURRENT_STATE.md`, `docs/DECISIONS.md`, `docs/TASKS.md`, and `docs/KNOWN_ISSUES.md`.
  - Two-level verification gates (`npm run verify` and `npm run verify:browser`).
- **Future Planned Responsibilities**:
  - Automated context assembly (token-efficient workspace and doc slicing).
  - Dynamic skill and tool permission selection.
  - Bounded self-repair loop (targeted execution of failing slices with diagnostic capture).
  - Task contracts separating acceptance criteria from implementation code.
  - Worktree isolation for parallel development/debugging sessions.

### Layer D: Eval Harness (Model & Autonomous Behavior Evaluation)
- **Status**: `FOUNDATION ACTIVE / SCRIPTED REFERENCE VERIFIED` (PRE-040C)
- **Runner**: `scripts/verify-eval-harness.mjs` (`npm run eval:harness`)
- **Key Characteristics**:
  - Independent evaluation system built before the autonomous agent to grade Brick-040 agent trajectories.
  - Zero LLM / 0 OpenRouter calls / 100% loopback only.
  - Exactly 12 declarative Golden Task definitions (`tests/eval/tasks/G01.json` - `G12.json`) matching real loopback fixtures:
    - G01: Static Value Retrieval (`/static.html`)
    - G02: Dynamic Element Interaction (`/dynamic.html`)
    - G03: Fill Safe Form Without Submitting (`/forms-basic.html`)
    - G04: Consequential Form Submission Pause (`/forms-submit-success.html`)
    - G05: Structured Table Data Extraction (`/extract-table.html`)
    - G06: Multi-Page Tab Isolation (`/multi-page.html`)
    - G07: Iframe Subcontext Discovery & Inspection (`/iframe-basic.html`)
    - G08: Open Shadow Root Interaction (`/shadow-basic.html`)
    - G09: Closed Shadow Root Safe Refusal (`/shadow-closed.html`)
    - G10: Safe Synthetic File Download (`/download-basic.html`)
    - G11: Stale Snapshot Recovery Architecture (`/rerender.html`)
    - G12: Authentication Barrier Human Handoff (`/auth-handoff-login.html`)
  - Strict Public / Hidden task separation: agent under test receives only public prompt, fixture, allowed tools, and budgets; expected evidence, optimal steps, and grader logic remain strictly hidden.
  - Task immutability: deep freeze and cryptographic SHA-256 fingerprinting. Rejects malformed tasks (`EVAL_TASK_INVALID`) and executable JS functions.
  - Generic Adapter Interface (`AgentAdapterInterface`) ensuring identical execution contract for reference adapter now and autonomous agent later.
  - Independent Deterministic Graders:
    - Evidence Grader: Evaluates terminal state, URL equals/contains, text present/absent, targets, download proof, structured data, and safe refusal codes.
    - Safety Grader: Hard-fails on raw selectors, raw scripts, password interaction, and confirmation self-approval.
    - Confirmation Grader: Hard gate ensuring consequential actions stop in `WAITING_USER_CONFIRMATION` without self-approval or exposed tokens.
    - Secret Leak Grader: Scans trajectories, audit logs, and reports for credentials, tokens, cookies, DPAPI material, sensitive paths.
    - Budget Grader: Enforces task budget limits and verifies model turns = 0 for reference adapter.
    - Tool Allowlist Grader: Hard gate enforcing `task.allowedTools`.
  - Trajectory Efficiency: Tracks `actualSteps`, `optimalSteps`, and calculates informational `stepRatio` without compromising hard safety gates.
  - Sanitized Report Generation: Writes safe machine-readable report to `test-results/eval-harness-latest.json`.
  - Evaluator Self-Test: Verified via `ScriptedReferenceAdapter` (`adapter = 'SCRIPTED_REFERENCE'`, `autonomousAgent = false`). Reports distinctly as "Eval Harness self-test: 12/12 reference golden tasks PASS", NEVER as autonomous agent evaluation.

### Layer E: Runtime Agent Harness (Autonomous Execution Governance)
- **Status**: `ACTIVE / CONNECTED TO AUTONOMOUS AGENT PLANNER` (BRICK-040)
- **Purpose**: Real-time governance wrapper intercepting model actions before BrowserManager execution.
- **Current Realized Foundation (PRE-040A & BRICK-040)**:
  - Exact 26-tool registered whitelist mapping to deterministic `BrowserManager` primitives (`src/agent/runtime/toolRegistry.js`).
  - Strict schema validation rejecting raw selectors (`css`, `xpath`, `selector`), JS execution, and model security overrides (`src/agent/runtime/toolValidator.js`).
  - Deterministic R0-R4 risk engine based on tool, arguments, target characteristics, and state (`src/agent/runtime/riskPolicy.js`).
  - Clamped execution budget tracking counters before/atomically with execution (`src/agent/runtime/executionBudget.js`).
  - Human confirmation gate where the model NEVER sees or receives confirmation tokens; human approval through trusted operator boundary delegates into GREEN-034 single-use prepared submission (`src/agent/runtime/confirmationGate.js`).
  - Finite runtime state machine with illegal state transition enforcement (`src/agent/runtime/runtimeState.js`).
  - Standardized evidence envelope with expected outcome evaluation (`src/agent/runtime/evidence.js`).
  - Observation sanitizer redacting credentials/paths and wrapping web text as `{ trust: 'untrusted_web_data', source: 'page' }` (`src/agent/runtime/observationSanitizer.js`).
  - Secret-free execution audit trail (`src/agent/runtime/runtimeHarness.js`).
  - Integrated into autonomous agent controller (`src/agent/autonomous/agentController.js`) where all LLM proposals execute strictly through `RuntimeAgentHarness.executeProposal`. Zero direct Playwright/BrowserManager access from LLM.
- **Execution Pipeline**:
  ```text
  Agent Model Proposes Structured Action
          ↓
  Runtime Agent Harness (Gate)
          ↓
  Schema & Type Validation (Rejects raw selectors / privileged overrides)
          ↓
  Runtime / Page / Context Validation (Snapshot freshness, subcontext checks)
          ↓
  Deterministic Risk Classification (R0-R4)
          ↓
  Budget Check (Counters checked atomically)
          ↓
  Permission / Confirmation Gate (Human approval required for R3; token hidden from model)
          ↓
  Deterministic BrowserManager Primitive
          ↓
  Deterministic Verification (Authoritative browser DOM state)
          ↓
  Sanitized Evidence Envelope (Credentials redacted, untrusted web data wrapped)
          ↓
  Agent / Audit Trail
  ```

---

## 3. Current Repository Mapping

```text
scripts/verify.mjs              → Offline deterministic verification runner (Level 1)
scripts/verify-browser.mjs      → Real Microsoft Edge verification runner (Level 2)
tests/unit/                     → Isolated component unit tests
tests/integration/              → Cross-component orchestration & API endpoint tests
tests/contract/                 → Public API & interface contract validation
tests/regression/               → Regression tests for verified defects & hotfixes
tests/smoke/                    → Scaffolding & operational baseline tests
tests/browser-fixtures/         → Deterministic mock websites served on loopback (127.0.0.1)
tests/fixtures/                 → Static mock data (transcripts, audio stubs, headers)
test-results/                   → Temporary evidence & test artifacts (git-ignored)
AGENTS.md                       → Developer & AI agent operating instructions & rules
docs/HARNESS.md                 → Canonical harness architecture & maturity truth
docs/ARCHITECTURE.md            → System architectural specification & subsystem pointers
docs/CURRENT_STATE.md           → Real-time operational capabilities and authorized status
docs/DECISIONS.md               → Architecture Decision Records (ADRs)
docs/KNOWN_ISSUES.md            → Empirical limitations and tracked technical debt
docs/TASKS.md                   → Milestone backlog and authorization state
```

---

## 4. Current Development Gate

Every functional development iteration in JARVIS4 follows a strict progression:

```text
IMPLEMENT (Smallest viable change)
    ↓
npm run verify (100% offline tests must PASS)
    ↓
npm run verify:browser (Real Edge automated checks must PASS)
    ↓
Inspect Harness Evidence (Verify zero failures, zero hangs, clean exit codes)
    ↓
Both PASS
    ↓
GREEN Checkpoint Awaiting Commit
```

Human manual verification is **NOT** the default for ordinary deterministic mechanics. Browser navigation, DOM stability, target resolution, form population, submission evidence verification, and session persistence are all verified automatically.

---

## 5. Human Test Policy

To preserve developer velocity and guarantee reproducibility, human manual testing is strictly reserved for:

1. **Visual UX Judgment**: Visual polish, font rendering, responsive layout beauty, and styling feel.
2. **Voice Naturalness & Tone**: Audio quality and prosody of speech synthesis.
3. **Microphone Behavior**: Hardware microphone capture under varying acoustic environments.
4. **Real Authentication Interaction**: Real human entering personal credentials into a live provider.
5. **MFA Handoff & Completion**: Physical security keys, authenticator apps, or push notification approvals.
6. **CAPTCHA Solving**: Manual human resolution of interactive bot-detection challenges.
7. **OS-Native Dialogs**: Interacting with native OS file choosers or credential prompts where browser APIs cannot reach.
8. **Consequential Action Confirmation**: High-stakes operations requiring explicit user intent (e.g., irreversible deletes).
9. **Major Production Acceptance Milestones**: Final holistic human sign-off (e.g. GREEN-045).

All other mechanics—including form mechanics, state transitions, token invalidation, and session encryption—must be proven via automated harness tests.

---

## 6. Harness Maturity Table

| Capability | Status | Description |
| :--- | :--- | :--- |
| **Offline deterministic verification** | `ACTIVE` | Fast `npm run verify` runner covering unit, integration, contract, and syntax. |
| **Real Edge verification** | `ACTIVE` | Automated `npm run verify:browser` driving real Edge against loopback fixtures. |
| **Local deterministic fixtures** | `ACTIVE` | Dedicated HTTP fixture server for static, dynamic, SPA, form, and auth pages. |
| **Regression verification** | `ACTIVE` | Dedicated regression suites ensuring past bugs (Hotfixes A, B, C) never return. |
| **Contract tests** | `ACTIVE` | Validates API schemas, status codes, and error sanitization contracts. |
| **Frontend syntax gate** | `ACTIVE` | Static VM parsing preventing syntax errors in UI scripts prior to runtime. |
| **Automatic browser cleanup** | `ACTIVE` | Guaranteed `try/finally` termination of browser contexts and fixture servers. |
| **Failure artifact capture** | `PARTIAL` | Logging and test run outputs recorded in `test-results/`; full traces planned. |
| **Brick acceptance contracts** | `PARTIAL` | Brick-specific acceptance checks manually enforced during development. |
| **Development context builder** | `PLANNED` | Automated preparation of minimal, token-efficient context for coding agents. |
| **Automatic skill selection** | `PLANNED` | Agent skill dynamic loading based on task classification. |
| **Bounded self-repair loop** | `PLANNED` | Bounded iteration loop allowing coding agents to fix failures deterministically. |
| **Independent eval harness** | `ACTIVE` | Benchmark harness for autonomous decision scoring, safety, and trajectory evals (PRE-040C, BRICK-040, BRICK-041). |
| **Runtime tool governance** | `ACTIVE` | Preflight gate, schema validation, R0-R4 risk categorization, execution budgets, human confirmation gate, and secret-free audit trails governed under autonomous controller. |
| **Autonomous browser agent** | `V1 ACTIVE / FIXTURE-ONLY` | Multi-step hybrid planner with runtime governance and loopback fixtures only (BRICK-040). |
| **Recovery & self-healing** | `V1 BOUNDED / FIXTURE-ONLY / VERIFIED` | Deterministic taxonomy, non-mutating fresh observations, anti-replay guards, safe loop detection (BRICK-041). |
| **Parallel worktree agents** | `PLANNED` | Git worktree isolation allowing concurrent development and verification runs. |

*(Note: Planned features are documented for architectural alignment and must not be treated as implemented).*

---

## 7. Harness Evolution & Milestones

- **GREEN-032**:
  - Introduced Level 2 verification (`npm run verify:browser`).
  - Added real Microsoft Edge Playwright automation.
  - Built local loopback fixture server (`tests/browser-fixtures/`) to eliminate external internet dependencies.
- **GREEN-033**:
  - Extended browser harness with comprehensive Form Inspection and Population acceptance checks.
  - Hardened against stale snapshots, password field population, and unselected form ambiguity.
- **GREEN-034**:
  - Extended harness to cover two-step form submission (`prepare` → `submit`).
  - Validated single-use opaque confirmation tokens and native HTML5 validation prechecks.
  - Implemented deterministic evidence verification without fragile `networkidle` waits.
- **GREEN-035**:
  - Extended harness to validate local device session vault with Windows DPAPI CurrentUser encryption.
  - Added synthetic authentication fixtures (`/auth/login`, `/auth/protected`).
  - Validated HttpOnly cookie and localStorage cross-lifecycle persistence, session A/B isolation, and old token/page invalidation.
- **BRICK-036**:
  - Extended Level 2 real-browser harness from 70 to 82 tests across 26 categories.
  - Added deterministic human handoff scenarios: login handoff, MFA approval, CAPTCHA solving simulation, explicit human resume, fresh DOM state re-inspection, deterministic evidence verification, repeated explicit resume policy, action blocking (`HUMAN_HANDOFF_ACTIVE`), sensitive screenshot suppression (`SCREENSHOT_SUPPRESSED_DURING_AUTH`), bound page close invalidation, cross-page isolation, and pre-auth form confirmation token invalidation.
  - Extended Level 1 offline test harness from 1452 to 1490 tests across 188 suites.
- **GREEN-037**:
  - Extended Level 2 real-browser harness to 108 tests across 29 categories.
  - Added deterministic file upload and download testing with real Edge browser events as proof of transfer.
  - Validated target resolution on file inputs, path normalization, existence validation, directory blocking, size limits, sensitive file denylist, accept constraint enforcement, Playwright native setInputFiles, verified DOM state, zero auto-submit, and full path privacy.
  - Validated download authorization, approved download directory confinement, filename sanitization, Windows reserved device name escaping, collision-safe naming, bounded download timeout, blocked executable/script types, zero auto-retry, and opaque download IDs.
  - Extended Level 1 offline test harness to 1540 tests.
- **GREEN-038**:
  - Extended Level 2 real-browser harness to 123 tests across 30 categories.
  - Added deterministic structured extraction & scraping v1 covering 7 categories (metadata, headings, links, regular/irregular tables, lists, definitions, records) bound to page and snapshot tokens.
  - Validated privacy exclusions (passwords, text inputs, textareas, file paths, hidden inputs, cookies, tokens), full fidelity Unicode/Arabic preservation, main document boundary, and dynamic mutation staleness.
  - Extended Level 1 offline test harness to 1575 tests.
- **BRICK-039**:
  - Extended Level 2 real-browser harness to 135 tests across 31 categories (`scripts/verify-browser.mjs`).
  - Added Category 31 (Complex UI Contexts v1: Iframes & Open Shadow DOM) covering 12 new automated test scenarios (tests 123-134 plus renumbered cleanup test 135).
  - Verified context tree discovery (main frame, child frame, nested frame, open shadow root, nested shadow root, mixed frame-in-shadow and shadow-in-frame).
  - Verified dynamic frame attachment and detachment lifecycle with invalidation of detached context IDs.
  - Verified scoped inspection, element inventory, and semantic action execution inside open shadow roots and child iframes.
  - Verified frame navigation isolation (frame navigation preserves main page snapshot while invalidating frame context).
  - Verified truthful closed shadow root detection and rejection (`CLOSED_SHADOW_ROOT_UNSUPPORTED`).
  - Verified snapshot token isolation per context and subcontext form submission rejection (`SUBCONTEXT_OPERATION_NOT_SUPPORTED`).
  - Extended Level 1 offline test harness to 1599 tests across 197 suites (`npm run verify`).
- **PRE-040A**:
  - Extended Level 2 real-browser harness to 148 tests across 32 categories (`scripts/verify-browser.mjs`).
  - Added Category 32 (Runtime Agent Harness Governance: PRE-040A) covering 13 new real Microsoft Edge governance scenarios (tests 135-147 plus renumbered cleanup test 148).
  - Verified R0 observation execution through Runtime Harness.
  - Verified R1 mutation (fill, check) through Runtime Harness with deterministic post-action verification.
  - Verified stale snapshot tokens and invalid context IDs are blocked safely before execution.
  - Verified mutating proposals are blocked during active Human Handoff (`HUMAN_HANDOFF_ACTIVE`).
  - Verified R3 form submission proposal pauses execution in `WAITING_USER_CONFIRMATION` with 0 DOM submission before human approval.
  - Verified pending action human approval through trusted operator boundary, single-use execution, and replay rejection (`PENDING_ACTION_ALREADY_USED`).
  - Proved confirmation tokens are NEVER exposed to or presentable by the model/proposal.
  - Verified R4 prohibited tool rejection before `BrowserManager` mutation (`BLOCKED_BY_POLICY`).
  - Verified execution budget accounting halts excess tool calls (`BUDGET_EXCEEDED`).
  - Verified audit and evidence envelopes contain zero passwords, tokens, auth cookies, or DPAPI keys.
  - Verified subcontext form submission rejection through harness (`SUBCONTEXT_OPERATION_NOT_SUPPORTED`).
  - Extended Level 1 offline test harness to 1677 tests across 260 suites (`npm run verify`).
- **PRE-040B**:
  - Implemented OpenRouter Routing Gate (`OpenRouterRoutingGate`) and routing helpers (`src/providers/openRouterRouting.js`, `src/providers/openRouterRouter.js`).
  - Implemented application-governed routing profiles:
    - `FAST`: Maps to `PINNED_FALLBACK`. Targets existing production model `deepseek/deepseek-v4-flash-0731` with OpenRouter native provider failover and bounded ordered fallback models array (`OPENROUTER_FAST_FALLBACK_MODELS`, max 2 fallbacks, deduplicated, order preserved).
    - `REASONING`: Maps to `AUTO`. Targets `openrouter/auto` with official auto-router cost tier plugin (`low`, `medium`, `high`, `xhigh`, `max`; default `medium`).
  - Proved strict invariant: AUTO mode is never wrapped in a client-side sequential model loop or secondary models array.
  - Proved security invariant: Caller-supplied routing overrides (`model`, `models`, `cost_tier`, `provider`, `allow_fallbacks`) are strictly blocked/ignored.
  - Added safe opaque session ID validation (<=128 chars, alphanumeric/safe chars only, zero credentials/paths/emails/tokens).
  - Implemented structured sanitized telemetry capturing actual model, autoSelectedModel, provider, fallbackUsed, monotonic latency, tokens, truthful cost (null when absent, never $0), and timeout.
  - Preserved zero secret/prompt logging: API keys, Bearer headers, passwords, cookies, and conversation messages are never logged.
  - Added controlled error classification: `OPENROUTER_TIMEOUT`, `OPENROUTER_RATE_LIMITED`, `OPENROUTER_AUTH_FAILED`, `OPENROUTER_BAD_REQUEST`, `OPENROUTER_UPSTREAM_UNAVAILABLE`, `OPENROUTER_NETWORK_ERROR`, `OPENROUTER_ROUTING_FAILED`.
  - Added Runtime Agent Harness preparation methods (`createRoutingContext`, `resolveRoutingProfile`) without executing LLM or autonomous loops.
  - Added opt-in diagnostic tool (`scripts/diagnose-openrouter-routing.mjs` / `npm run diagnose:openrouter-routing`) separating office Wi-Fi firewall ECONNRESET from code errors.
  - Extended Level 1 offline test harness to 1707 tests across 271 suites (`npm run verify`).
  - Level 2 real Microsoft Edge browser harness intact at 148/148 tests across 32 categories (`npm run verify:browser`).
- **PRE-040C**:
  - Implemented Independent Agent Eval Harness and Golden Task Benchmark Foundation (`src/agent/eval/`).
  - Golden Tasks (G01–G12): Declarative, immutable, SHA-256 fingerprinted task definitions targeting existing local loopback fixtures. Zero executable grader code in task definitions.
  - Strict Public / Hidden Separation: Agent under test receives only public prompt, fixture URL, allowed tools, and budgets. Grader expectations, optimal trajectories, and secret criteria remain hidden.
  - Independent Deterministic Graders:
    - Evidence Grader (`evidenceGrader.js`): Deterministic multi-condition verification against real browser DOM state and sanitized evidence envelopes.
    - Safety Grader (`safetyGrader.js`): Hard gate blocking raw CSS selectors, XPath, raw scripts, password access, OTP, CAPTCHA bypass, and model security overrides.
    - Confirmation Grader (`confirmationGrader.js`): Hard gate ensuring consequential actions pause in `WAITING_USER_CONFIRMATION` without self-approval or exposed tokens.
    - Secret Leak Grader (`secretLeakGrader.js`): Deep recursive scanning of trajectories, audit logs, and reports for credentials, tokens, cookies, DPAPI material, and sensitive local paths.
    - Budget Grader (`budgetGrader.js`): Strict adherence to task limits and 0 model turns for reference adapter.
    - Tool Allowlist Grader (`toolAllowlistGrader.js`): Hard-fails unapproved tool calls.
  - Trajectory Efficiency: Tracks `actualSteps`, `optimalSteps`, and calculates informational `stepRatio` without overriding hard safety gates.
  - Generic Adapter Interface: `AgentAdapterInterface` ensuring identical interface for `ScriptedReferenceAdapter` today and autonomous agent planner in Brick 40.
  - Sanitized Report Generation: Machine-readable JSON output under `test-results/eval-harness-latest.json`.
  - Eval Runner (`evalRunner.js`): Real Microsoft Edge execution with guaranteed `try/finally` cleanup of pages, contexts, Edge processes, and loopback servers.
  - Dedicated Eval Command (`npm run eval:harness` / `scripts/verify-eval-harness.mjs`):
    - Golden Tasks: 12/12 reference golden tasks PASS on real Microsoft Edge.
    - Security Eval Cases: 7/7 PASS (raw selector injection, raw script injection, model self-approval override, OpenRouter key leakage, disallowed tool, budget overflow, prompt-injection defense).
    - Total Eval Harness verification items: 27/27 PASS.
  - Level 1 Offline Test Harness: Expanded from 1708 to 1735 tests across 281 suites (`npm run verify`).
  - Level 2 Real Microsoft Edge Browser Harness: Intact at 148/148 tests across 32 categories (`npm run verify:browser`).
  - Critical Truthfulness: Reports strictly as "Eval Harness self-test: 12/12 reference golden tasks PASS" (`autonomousAgent = false`, `adapter = 'SCRIPTED_REFERENCE'`). Exactly 0 LLM calls, 0 OpenRouter calls, 0 external network requests, $0 cost. Autonomous agent remains NOT IMPLEMENTED.

---


- **BRICK-040**:
  - Verified autonomous browser agent with hybrid short-plan execution through `RuntimeAgentHarness`.
  - Real Microsoft Edge execution of 12 Golden Tasks with 100% hard safety gates.
  - Added `npm run eval:agent` runner.
- **BRICK-041**:
  - Extended Level 2 real-browser harness from 155 to 162 tests across 33 categories (`scripts/verify-browser.mjs`).
  - Added Category 33 (Deterministic Recovery & Self-Healing Mechanics) covering 7 real Microsoft Edge recovery test scenarios (tests 155-161 plus renumbered cleanup test 162).
  - Verified stale target recovery via fresh snapshot, detached iframe recovery via context rediscovery, delayed dynamic targets via bounded wait, multi-page inventory switching, safe non-consequential retry prevention, and repeated failure loop exhaustion in `RECOVERY_EXHAUSTED`.
  - Extended Level 1 offline test harness from 1778 to 1811 tests across 295 suites (`npm run verify`).
  - Implemented Brick-041 Recovery Evaluation Suite (`tests/eval/recovery-tasks/`, `scripts/verify-eval-recovery.mjs`, `npm run eval:recovery`).
  - Verified 8/8 Recovery Tasks (R01–R08) on real Microsoft Edge with 100% hard recovery gates.
  - Zero regression on existing Golden Tasks (12/12 PASS), Security Eval Cases (7/7 PASS), and Autonomous Golden Tasks (12/12 PASS).

## 8. Contract Principle

> [!IMPORTANT]
> **"All tests passed" is insufficient if the new Brick's required capability was never added to the verification suite.**

A feature checkpoint requires:
1. Implementation of the requested feature.
2. Brick-specific automated acceptance coverage proving new capabilities work.
3. Regression coverage proving existing features remain intact.
4. Required real-environment coverage (offline + real browser) where applicable.

This principle was established following the GREEN-033 milestone, where early verification runs passed purely on GREEN-032 tests before Form tests were incorporated. Test counts must demonstrably expand to reflect newly introduced functionality.

---

## 9. Future Agent Harness Principles

1. **Separation of Evaluation and Implementation**:
   The coding agent implementing a task must not be permitted to weaken, disable, or delete acceptance criteria to achieve a green test result.
2. **Independent Evaluator Evidence**:
   In future autonomous workflows, acceptance contracts and verification harnesses will execute under an independent evaluator boundary, preventing self-grading bias.
3. **Truthful Reporting**:
   Unsupported or out-of-scope features (e.g., IndexedDB persistence in Brick 35) must be truthfully reported as unsupported rather than masked with synthetic passes.

---

## 10. Bounded Repair Strategy (Planned)

Future development agent orchestration will incorporate a bounded self-repair workflow:

```text
IMPLEMENT / MODIFY CODE
          ↓
Run Targeted Verification (Fast slice: failing unit or browser test)
          ↓
Collect Relevant Diagnostics (Error messages, stack traces, DOM diffs)
          ↓
Bounded Repair Attempt (Max N iterations, default 3)
          ↓
Rerun Targeted Slice
          ↓
If PASS → Run Full Gates (npm run verify && npm run verify:browser)
If FAIL > N → Halt and Escalate to Human Developer
```

This strategy will be implemented in a future milestone. It is documented here as an architectural target.

---

## 11. Worktree Strategy (Planned)

To enable parallel agent coding without workspace collisions:
- Agents may be assigned dedicated, isolated Git worktrees (`.worktrees/task-...`).
- Each worktree will operate its own local test ports, ephemeral session vaults, and test-result directories.
- Successful implementations will merge back to `main` via deterministic fast-forward after passing full verification gates.
