# Known Issues

Currently tracked issues in JARVIS4:

1. **Windows Node.js Runtime Version for Live Network Calls**:
   - On this Windows machine, live external provider calls should use portable Node.js `v24.21.0` (or newer).
   - An upstream Windows/libuv socket shutdown assertion was observed on Node.js `v24.19.0` after a successful HTTP fetch. The exact same application code executes and terminates cleanly with exit code 0 under portable Node.js `v24.21.0`.

2. **Office Wi-Fi Direct OpenRouter Connection Reset (ECONNRESET)**:
   - On certain restricted corporate / office Wi-Fi networks, direct HTTPS requests to OpenRouter (`https://openrouter.ai/api/v1`) are reset with `ECONNRESET`.
   - Bypassing the network restriction (e.g. via mobile hotspot or unrestricted network) connects cleanly and functions reliably.

3. **Whisper Multilingual STT Quality & Latency Observations (Brick 10 & Brick 11)**:
   - Occasional extra trailing words (such as "Thank you", "موسیقی", "شكرا", or "ملتا") may appear in Whisper output during audio padding or trailing background noise.
   - Code-switched mixed English terms within Urdu sentences may be transliterated phonetically into Urdu script rather than Latin script (e.g., "پاور بی آئی ڈیشپورٹ").
   - Live transcription latency varies significantly depending on network route, audio size, and provider load (observed range: ~827 ms to ~12 seconds).
   - The wake/name portion in other languages (such as Arabic "جارو بيس") may be transcribed phonetically or imperfectly, but query meaning was preserved and correctly understood by the AI model.

4. **Live AI Request Timeout & Model Normalization Observations (Brick 11)**:
   - An occasional request timeout was observed during live `Ask JARVIS` submission to Cheaper Inference; retrying the request succeeded cleanly without losing conversation context.
   - The AI model normalized/dropped punctuation/hyphens in recall responses (e.g., recalling "NOVA742" for "NOVA-742") while accurately preserving code identity and conversation continuity.
   - OpenRouter remains speech-to-text only; Cheaper Inference remains text AI/LLM only; TTS is NOT implemented.

