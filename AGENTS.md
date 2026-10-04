# AGENTS.md — JARVIS4 Operating Rules for AI Agents

All AI agents, assistants, and developers operating on this repository must strictly adhere to the rules in this document.

## Core Development Philosophy

Every future brick must follow the mandatory workflow:

```text
BUILD → TEST → MANUAL USE → VERIFY → COMMIT → NEXT BRICK
```

**Never automatically continue to another brick.**

---

## Strict Rules for Future Agents

Every future agent must:

1. **Read `AGENTS.md`** first before starting any work.
2. **Read `docs/CURRENT_STATE.md`** to understand the current authorized status and capabilities.
3. **Read relevant architecture documentation** in `docs/` before making any edits.
4. **Work on only the explicitly requested brick.** Never bleed into other bricks or features.
5. **Never implement future features automatically.** If a feature belongs to a future brick, leave it out.
6. **Never refactor unrelated working code.** Confine all changes strictly to the task at hand.
7. **Prefer the smallest possible change** that safely and reliably fulfills the requirement.
8. **Never delete working functionality just to fix an error.** Find the root cause and fix it properly.
9. **Never hard-code fake successful responses** or create mock tests that mask missing functionality.
10. **Add or update tests for every functional change.** Every new piece of logic must have automated tests.
11. **Run verification before claiming success.** Execute `npm run verify` and ensure it exits with code 0.
12. **Never disable failing tests just to get a green result.**
13. **Never claim something works unless it was actually tested** and proven working.
14. **Record important architecture decisions** in `docs/DECISIONS.md`.
15. **Update `docs/CURRENT_STATE.md` after a verified brick.**
16. **Stop after the requested brick is complete.** Do not proceed to any subsequent brick without explicit user instruction.

---

## Prohibited Brick 0 Implementations

Brick 0 is foundation only. The following MUST NOT be implemented in Brick 0:
- AI / LLM
- Voice
- STT (Speech-to-Text)
- TTS (Text-to-Speech)
- Audio-to-audio
- Browser automation
- Internet search
- Memory
- Desktop control
- File control
- GUI
- Provider integrations
- Cheaper Inference
- OpenAI
- Gemini
- Wake word
