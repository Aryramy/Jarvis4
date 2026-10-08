# Known Issues

Currently tracked issues in JARVIS4:

1. **Windows Node.js Runtime Version for Live Network Calls**:
   - On this Windows machine, live external provider calls should use portable Node.js `v24.21.0` (or newer).
   - An upstream Windows/libuv socket shutdown assertion was observed on Node.js `v24.19.0` after a successful HTTP fetch. The exact same application code executes and terminates cleanly with exit code 0 under portable Node.js `v24.21.0`.

2. **Office Wi-Fi Direct OpenRouter Connection Reset (ECONNRESET)**:
   - On certain restricted corporate / office Wi-Fi networks, direct HTTPS requests to OpenRouter (`https://openrouter.ai/api/v1`) are reset with `ECONNRESET`.
   - Bypassing the network restriction (e.g. via mobile hotspot or unrestricted network) connects cleanly and functions reliably.

3. **Whisper Multilingual STT Quality & Latency Observations (Brick 10)**:
   - Occasional extra trailing words (such as "Thank you", "موسیقی", or "شكرا") may appear in Whisper output during audio padding or trailing silence.
   - Code-switched mixed English terms within Urdu sentences may be transliterated phonetically into Urdu script rather than Latin script (e.g. "پاور بی آئی ڈیش بورڈ اوپن").
   - Live transcription latency currently varies between roughly 3.4 seconds and 12 seconds depending on network route, audio size, and provider load. These are baseline observations and will be addressed in future optimization bricks.
