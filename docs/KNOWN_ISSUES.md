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
   - OpenRouter is used for STT (`/audio/transcriptions`) and TTS (`/audio/speech`); Cheaper Inference remains text AI/LLM (`/chat/completions`).

5. **Voice Turn Overall Latency & Diagnostic Observation (Brick 13)**:
   - STT latency is currently generally acceptable (~2.5s–3.2s).
   - TTS latency is currently generally acceptable (~1.2s–3.0s).
   - The complete voice turn is still significantly slower than desired (observed total elapsed times: ~18s–31s across live tests).
   - A large portion of the total elapsed time occurs outside the measured STT and TTS stages.
   - Brick 13 did not expose an isolated AI-stage latency measurement.

6. **Cheaper Inference External Provider Latency & Timeout Bottleneck (Brick 14 Diagnostic Finding)**:
   - Isolated AI timing instrumentation proved that the dominant bottleneck in the complete voice pipeline is the external Cheaper Inference request path (`providerDurationMs`: ~23.6s to ~30.0s).
   - Local JARVIS AI server overhead is negligible (~0–7 ms).
   - Live requests frequently take 24–30 seconds and repeatedly approach or hit the configured 30000 ms timeout threshold.
   - The measurement captures the full external request path (which may include routing, queueing, upstream provider processing, model inference, and upstream network latency); instrumentation does not single out any one upstream component as the sole cause.
   - This latency is unsuitable for a fast voice-assistant experience and is recorded as a verified performance issue for future optimization. No optimization was performed in Brick 14.

7. **Cheaper Inference Candidate Model Benchmark Findings (Brick 15 Diagnostic Finding)**:
   - Live latency benchmarking across 4 candidates (`deepseek-v4-flash-0731`, `aion-3.0-mini`, `deepseek-v4.1-flash`, `gemini-3.8-flash`) showed that 10 out of 12 sequential requests timed out at 30000 ms.
   - The only model to complete responses was `deepseek-v4.1-flash` (2/3 completed at ~29385 ms median, 1/3 timed out).
   - Normal production requests with `deepseek-v4-flash-0731` also repeatedly timed out at 30000 ms.
   - Model substitution on the current Cheaper Inference pathway does not resolve the latency bottleneck.
   - None of the tested candidates demonstrated responsiveness suitable for a conversational voice assistant.
   - Production model remains unchanged (`deepseek-v4-flash-0731`).
   - Resolving this bottleneck will require investigating alternative gateways/routes rather than model swaps on the existing pathway.

8. **Cross-Gateway Same-Model Latency Benchmark Findings (Brick 16 Diagnostic Finding)**:
   - Live cross-gateway benchmarking comparing the same model release (DeepSeek V4 Flash 0731) across Cheaper Inference (`deepseek-v4-flash-0731`) and OpenRouter (`deepseek/deepseek-v4-flash-0731`) demonstrated a dramatic difference in latency and reliability:
     - Cheaper Inference: 1/3 success, 2/3 timeouts (30011 ms, 25529 ms, 30013 ms); successful median: 25529 ms.
     - OpenRouter: 3/3 success, 0 timeouts (1314 ms, 674 ms, 483 ms); median: 674 ms (observed ~37.88x faster in this benchmark run).
   - Empirical finding: The same DeepSeek V4 Flash 0731 model release responded dramatically faster through OpenRouter than through Cheaper Inference. This strongly supports that gateway/path selection materially affects current JARVIS AI latency. Gateways may differ in upstream provider, queueing, routing, hardware, batching, geography, network path, provider selection, or infrastructure configuration.
   - This is an empirical finding from this benchmark only; it does not claim permanent speed advantage across all circumstances or future reliability from 3 samples.
   - Production provider remains unchanged: Cheaper Inference (`deepseek-v4-flash-0731`). No automatic switch, routing, or fallback was implemented.
   - Any controlled production migration to OpenRouter for text AI is deferred to a future brick after human review and safe commit of GREEN-016.




