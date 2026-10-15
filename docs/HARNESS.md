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
  +-- [D] EVAL HARNESS (Model & Autonomous Behavior Evaluation) [PLANNED]
  |     Scope: Golden tasks, trajectory evaluation, success scoring, safety
  |            scoring, tool correctness, latency, and cost benchmarking (Brick 40+).
  |
  +-- [E] RUNTIME AGENT HARNESS (Autonomous Execution Governance) [PLANNED]
  |     Scope: LLM action proposal → tool gate → schema validation → risk
  |            classification → permission check → confirmation → execution →
  |            deterministic verification → sanitized result → audit trail.
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

### Layer D: Eval Harness (Autonomous Model Evaluation)
- **Status**: `PLANNED` (Targeted around Brick 40+)
- **Purpose**: Evaluates autonomous model-driven decisions and interactive agent trajectories.
- **Expected Responsibilities**:
  - Curated "golden task" test suites across diverse web and tool workflows.
  - Trajectory evaluation (assessing reasoning quality, step efficiency, and safety).
  - Deterministic task success verification vs heuristic evaluation.
  - Safety scoring: Detecting attempted password interactions, prompt injection vulnerability, or policy bypass.
  - Latency, token economy, and API cost profiling per task.
  - Release gating: Minimum threshold scores required before greenlighting autonomous features.

### Layer E: Runtime Agent Harness (Autonomous Execution Governance)
- **Status**: `PLANNED`
- **Purpose**: Real-time governance wrapper intercepting model actions in production before external execution.
- **Expected Execution Pipeline**:
  ```text
  Model Proposes Action
          ↓
  Tool Gate (Is action authorized for current Brick/scope?)
          ↓
  Schema Validation (Strict parameter and type validation)
          ↓
  Risk Classification (Read-only vs mutation vs financial/credential risk)
          ↓
  Permission / Confirmation (Require explicit human confirmation for consequential actions)
          ↓
  Execution Boundary (Playwright action, filesystem, network call)
          ↓
  Deterministic Verification (Observe post-action evidence)
          ↓
  Sanitized Result (Filter cookies, tokens, and raw secrets)
          ↓
  Audit / Evidence Trail (Structured logging without credential leakage)
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
| **Independent eval harness** | `PLANNED` | Benchmark harness for autonomous decision scoring, safety, and trajectory evals. |
| **Runtime tool governance** | `PLANNED` | Preflight gate, risk categorization, and audit logging for model-issued tools. |
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

---

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
