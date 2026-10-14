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

9. **Controlled Production Text-AI Migration to OpenRouter (Brick 17 Verified)**:
   - Production text AI has been successfully migrated to OpenRouter (`deepseek/deepseek-v4-flash-0731`), replacing Cheaper Inference as the primary text provider for `/api/ai`, `/api/ai/stream`, and `npm run ai`.
   - Cheaper Inference remains available for diagnostics and benchmark scripts (`CheaperInferenceProvider`), but is strictly decoupled from the production path (no automatic fallback or routing).
   - Human live verification confirmed:
     - Production identity: `/api/ai` uses OpenRouter with zero Cheaper calls.
     - Multilingual operation (English, Urdu, Arabic), memory persistence, streaming, and full sequential voice turns are all verified.
     - Latency improvement: OpenRouter production AI latency was materially faster than the previous Cheaper Inference 24–30s baseline across most tested turns (observed samples: 2261 ms, 3505 ms, 3600 ms, 4204 ms, 4279 ms, 9163 ms).
     - Latency variability: Significant latency variability still exists; the Urdu prompt observed 23351 ms provider duration. Do NOT claim permanent sub-5-second performance or a permanent fixed multiplier.
     - STT noise artifact: An unwanted `*Mario plays*` prefix hallucination was observed in Whisper STT during live voice turn Test F. Recorded as another STT quality/noise observation (not fixed in Brick 17).

10. **Observed STT Quality Variability Under a Noisy / Shared-Mic Environment (Brick 18 Live Diagnostic Context)**:
    - **Important Context**: Brick 18 live voice tests were performed using the laptop's built-in microphone in a shared environment where other people were speaking nearby.
    - **Non-Attribution**: Observed transcription anomalies cannot currently be attributed solely to OpenRouter, Whisper, `openai/whisper-large-v3-turbo`, or JARVIS STT logic.
    - **Possible Contributing Factors**:
      - nearby people speaking
      - overlapping speech
      - background noise
      - room acoustics
      - laptop microphone pickup pattern
      - distance from microphone
    - **Observed Examples**:
      - `*Mario plays*`
      - `*sad music*`
      - trailing Urdu text such as "سوے"
      - one Arabic script/language misrecognition
      - transliteration of English terms into Urdu/Arabic script
      - occasional omission/distortion in mixed-language speech
    - **Classification**: Recorded strictly as **OBSERVED STT QUALITY VARIABILITY UNDER A NOISY / SHARED-MIC ENVIRONMENT**. Do NOT classify them as confirmed Whisper hallucinations or confirmed provider defects.
    - **Status**: Root cause has NOT been isolated.
    - **Future Quiet-Environment Comparison**: A future controlled quiet-environment comparison may determine whether these behaviors originate primarily from:
      - input audio quality
      - background speech
      - microphone characteristics
      - STT model behavior
      - provider behavior
    - **Scope Preservation**: No correction or mitigation is implemented in Brick 18.

11. **STT Multi-Tier Latency Diagnostics (Brick 18 Verified)**:
    - Live multi-tier STT latency instrumentation (`providerSttDurationMs`, `serverSttDurationMs`, `clientSttDurationMs`) was verified across multiple languages and voice turns.
    - Empirical latency measurements (observed range: 1125 ms – 5645 ms across 10 live samples: 4556 ms, 3096 ms, 2026 ms, 3757 ms, 1125 ms, 2981 ms, 4896 ms, 2902 ms, 5645 ms, 4267 ms).
    - Timing pattern: `providerSttDurationMs ≈ serverSttDurationMs ≈ clientSttDurationMs`. Local server overhead was consistently minimal (a few milliseconds to a few dozen milliseconds).
    - Diagnostic finding: The primary STT latency occurred in the external OpenRouter/Whisper request path. Local JARVIS STT processing was not a significant bottleneck.
    - Do NOT generalize these empirical measurements into permanent performance claims.
    - Production STT provider (`openrouter`) and model (`openai/whisper-large-v3-turbo`) remain unchanged. No optimizations, silence trimming, VAD, fallbacks, or routing were implemented in Brick 18.

12. **Reliable Internet Search v1 Observations & Limitations (Brick 19 Verified)**:
    - **External Latency Variability**: Search latency is externally variable depending on upstream OpenRouter server tools and Exa search response times.
    - **Observed Latencies**: One 30000 ms timeout was observed during initial live testing before hardening; a successful unhardened search completed in ~29930 ms; after hardening (Exa `fast` mode, `max_uses: 1`, `max_results: 3`, `max_total_results: 3`, `max_characters: 1200`), final successful search completed in 15627 ms (an observed live improvement of ~14303 ms). Do NOT claim permanent sub-16-second performance or a permanent fixed latency ratio.
    - **Missing Search Request Usage Count**: OpenRouter may omit `usage.server_tool_use.web_search_requests` even when genuine search execution occurred and returned real citations. In such cases, `searchRequests` is reported as unavailable (`null`), and provider citation annotations (`url_citation`) serve as provider-level evidence (`searchUsed: true`, `searchEvidence: 'url_citation'`).
    - **Search Result Freshness**: Freshness depends on provider retrieval and ranking. A non-hardened search executed in October 2026 returned primarily 2025 results. Hardened prompt dynamic date awareness and honesty instructions ensure the assistant explicitly qualifies results (reporting newest source date found, noting lack of newer evidence). Exhaustive live web coverage is NOT guaranteed.
    - **Architectural Scope**: Search is explicit (`POST /api/search` via "Search Web" button), stateless, isolated from `ConversationSession` and `ConversationStore`, isolated from normal `/api/ai` and `/api/ai/stream`, and not connected to Voice Turn.
    - **No Autonomous Routing or Fallbacks**: No automatic decision engine, no tool loop, no second search engine, and no page fetching/deep browsing are implemented.

13. **Automatic Search Decision v1 Observations & Limitations (Brick 20 Verified)**:
    - **Conservative Decision Classifier**: Automatic routing is intentionally conservative to prevent unintended web queries, latency increases, and search API quota consumption.
    - **Ambiguous Freshness Intent**: Ambiguous or implicit temporal queries lacking explicit high-confidence markers (e.g. general questions that could benefit from live information but lack explicit freshness signals) default to normal AI.
    - **Manual Override Preserved**: The dedicated "Search Web" button (`POST /api/search`) remains available as an explicit manual override when users specifically require grounded live web search.
    - **Streaming & Voice Turn Not Auto-Routed**: Automatic decision routing applies exclusively to typed "Ask JARVIS" (`POST /api/auto`). Streaming AI (`POST /api/ai/stream`) and Voice Turn (`voiceTurn.js`) remain normal AI only.
    - **Stateless Search**: Search queries handled via automatic decision remain strictly stateless and do not write to `ConversationSession` or `ConversationStore`.
    - **Search Source Publication Dates**: Upstream search results may omit publication dates, resulting in `newestSourceDate = null` and `freshnessStatus = 'unknown'`.
    - **Search Latency**: When search is triggered, latency is governed by the external provider search path (observed range: ~9.6s to ~20.8s across live English, Urdu, and Arabic tests), while local routing decision overhead is negligible (~0.04 ms to ~22.7 ms).

14. **Web Page Read v1 Observations & Limitations (Brick 21 Verified)**:
    - **Single Explicit URL Only**: Web Page Read v1 reads one explicit URL only per request.
    - **Static Server-Returned HTML Only**: It reads static server-returned HTML only (`text/html` and `application/xhtml+xml`).
    - **No JavaScript Execution**: It does not execute JavaScript.
    - **JavaScript-Rendered Pages**: JavaScript-only applications (SPAs, dynamic client apps) may return little or no readable content; pages with no static text yield `NO_READABLE_CONTENT`.
    - **No Link Crawling**: It does not crawl or follow links on the page (except HTTP redirects).
    - **No Autonomous Search-to-Read Chaining**: It does not automatically open or fetch search-result URLs.
    - **No AI Summarization or Q&A**: It does not summarize or answer questions from page content yet.
    - **No PDF or Office Documents**: It does not support PDF or Office documents; rejected with `UNSUPPORTED_CONTENT_TYPE`.
    - **No Authenticated or Private Pages**: It does not support authenticated/private pages; embedded URL credentials are rejected with `URL_CREDENTIALS_NOT_ALLOWED`.
    - **No Cookies or Saved Credentials**: It does not send browser cookies, session tokens, or credentials.
    - **Raw Size Cap**: Raw page response size is capped at 1,500,000 bytes (`WEB_READ_MAX_BYTES=1500000`, `PAGE_TOO_LARGE`).
    - **Extracted Text Cap**: Extracted plain text is capped at 30,000 characters (`WEB_READ_MAX_TEXT_CHARS=30000`), truncated deterministically with boolean `truncated: true`.
    - **Redirect Cap**: Redirects are strictly limited to 3 hops (`WEB_READ_MAX_REDIRECTS=3`, `TOO_MANY_REDIRECTS`), each revalidated against SSRF rules, and HTTPS-to-HTTP downgrades are rejected (`INSECURE_REDIRECT_DOWNGRADE`).
    - **Port Restrictions**: Only ports 80 and 443 (or default omitted ports) are permitted; arbitrary explicit ports are blocked (`PORT_NOT_ALLOWED`).
    - **Stateless Isolation**: Web Page Read is strictly stateless and does NOT write page contents to `ConversationSession`, `ConversationStore`, or runtime conversation persistence files.

15. **Grounded Web Page Q&A v1 Observations & Limitations (Brick 22 Verified)**:
    - **One Explicit Webpage Only**: Grounded Q&A operates on one explicit user-provided webpage URL only.
    - **Static HTML/XHTML Only**: Reads static server-returned HTML only; JavaScript-rendered page content is not supported (client-only SPAs may yield empty or incomplete text).
    - **Page Text Cap**: Extracted plain text remains capped at 30,000 characters from Brick 21.
    - **Truncated Pages**: Page-QA may operate on truncated page content; `pageTruncated` must remain visible and model is warned content may be incomplete.
    - **No Search Fallback**: If the page does not contain the answer, Page Q&A does not fall back to web search or normal AI; it reports that the information was not found in the supplied page.
    - **No Multi-Page Research**: Does not crawl links, open citations, or perform multi-hop browsing.
    - **No Link Traversal**: Does not follow links found on the page.
    - **No Authenticated Page Access**: Does not support login or protected pages.
    - **No Browser Cookies or Credentials**: Requests send no browser cookies or credentials.
    - **No PDF Q&A**: Non-HTML documents remain unsupported.
    - **No Browser Automation**: Does not use Playwright, Puppeteer, or headless browsers.
    - **No Voice Turn Integration**: Page Q&A is not connected to voice turn or audio pipelines.
    - **No Automatic Ask JARVIS Routing**: Ask JARVIS does not automatically detect URLs or call Page Q&A.
    - **Instruction-Based Grounding**: Grounding is enforced through isolated prompt/data separation and tested behavior; do not claim mathematical proof that an LLM can never violate an instruction.
    - **Stateless Isolation**: Neither webpage contents nor questions/answers are recorded in `ConversationSession`, `ConversationStore`, or runtime persistence.

16. **Search → Read → Grounded Answer v1 Observations & Limitations (Brick 23 Verified)**:
    - **Single Search & Single Source Only**: Exactly one search request and exactly one selected citation source are processed per workflow.
    - **Deterministic Source Selection**: Source selection strictly follows provider result order, selecting the first valid HTTP/HTTPS citation URL. No LLM, embeddings, or keyword reranking is used.
    - **First Selected Source May Fail**: The first selected source may fail to load (e.g., DNS error, private IP block, HTTP error, timeout, or page too large).
    - **No Automatic Fallback**: If reading the selected source fails, the workflow immediately fails with a controlled error; it does NOT fall back to source 2, source 3, another search, or normal AI.
    - **Selected Page May Not Contain the Answer**: If the selected page lacks the necessary information, the model states that the answer was not found in the selected webpage; no secondary search or fallback is attempted.
    - **No Multi-Source Synthesis**: Does not merge or synthesize information from multiple search results.
    - **Search Answer Not Used as Final Evidence**: Search answer prose and search snippets are never passed into the grounded QA prompt. Only extracted static content of the selected page grounds the final answer.
    - **No PDF Reading**: PDFs returned in search citations are rejected with `UNSUPPORTED_CONTENT_TYPE`.
    - **No JavaScript Rendering**: Dynamic SPAs rendered via client JavaScript are not executed.
    - **No Authenticated Access**: Authenticated or paywalled sources cannot be accessed.
    - **No Crawling or Link Traversal**: Does not crawl or follow links from the selected page.
    - **No Automatic Ask JARVIS Routing**: `/api/auto` does not invoke `/api/research-one`.
    - **No Voice Turn Integration**: Voice Turn, STT, and TTS are not connected to Research-One.
    - **Latency Variability**: Search and AI latency remain externally variable (e.g. search 7.8s-10.2s, AI 1.4s-13.9s observed live); page reading stage was fast (~700ms-720ms).
    - **Stateless Isolation**: Workflow is strictly stateless and does NOT write questions, answers, URLs, or page text to `ConversationSession`, `ConversationStore`, or runtime persistence.

17. **Research Source Read-Fallback v1 Observations & Limitations (Brick 24 Verified)**:
    - **Maximum Sources Limited to Citations**: Maximum sources are limited to citations returned by the existing search configuration (currently at most 3).
    - **Authoritative Provider Citation Ranking**: Source evaluation order strictly follows provider ranking; no LLM, embedding, or domain reranking.
    - **Technical Read Fallback Only**: Fallback to subsequent citations is triggered strictly by approved technical or safe-read failures (`UNSUPPORTED_CONTENT_TYPE`, `LOCAL_OR_PRIVATE_HOST_BLOCKED`, `DNS_RESOLUTION_FAILED`, `FETCH_TIMEOUT`, `PAGE_TOO_LARGE`, `HTTP_ERROR`, `NO_READABLE_CONTENT`, `FETCH_FAILED`). Verified in live testing with PDF search results failing safely with `UNSUPPORTED_CONTENT_TYPE`.
    - **No Answer-Quality Fallback**: A readable page that lacks the answer (or where the model states "answer not found") immediately stops the pipeline without falling back to later citations.
    - **No Semantic Source Evaluation**: No semantic matching or relevance filtering occurs prior to reading candidate pages.
    - **No Multi-Source Synthesis**: Only the first successfully read page grounds the final answer; information from multiple sources is not synthesized.
    - **No Search Retry**: Zero second search queries or search retries when sources fail to read or provide answers.
    - **No Query Rewriting**: The original user query is not rewritten or expanded.
    - **No PDF Parsing**: PDFs returned in search results are safely skipped with `UNSUPPORTED_CONTENT_TYPE` and trigger fallback to the next candidate. Zero PDF parser was introduced.
    - **No JavaScript-Rendered Pages**: Dynamic SPAs rendered via client-side JavaScript are not executed; empty pages yield `NO_READABLE_CONTENT` and trigger fallback.
    - **No Authenticated Pages**: Authenticated, paywalled, or login-required sources cannot be accessed.
    - **No Browser Automation**: Does not use Playwright, Puppeteer, or headless browsers.
    - **No Automatic /api/auto Integration**: `/api/auto` does not invoke `/api/research-one`.
    - **No Voice Turn Integration**: Voice Turn, STT, and TTS remain separate and disconnected.
    - **Latency Variability**: Search, cumulative page-read, and AI generation latencies remain externally variable based on network and provider conditions. Empirical live test observations:
      - Live Test A: Search 10049 ms, Page Read 2264.029 ms, AI 9382 ms, Total 21715.762 ms.
      - Live Test C: Search 13246 ms, Page Read 990.494 ms, AI 8717 ms, Total 22953.768 ms.
      These are empirical measurements only; no permanent latency guarantees are claimed.
    - **Stateless Isolation**: Pipeline remains strictly stateless and does NOT write questions, answers, URLs, attempt diagnostics, or page text to `ConversationSession`, `ConversationStore`, or runtime persistence.

18. **Browser Escalation Policy Foundation v1 Observations & Limitations (Brick 25 Verified)**:
    - **Deterministic Pattern Matching**: Policy relies on deterministic pattern matching and guard rails rather than semantic LLM intent classification.
    - **Unusual Wording Ambiguity**: Unusual, colloquial, or novel interaction requests may not match established signals.
    - **No Browser Execution**: Brick 25 establishes policy foundation only; no browser library (Playwright, Puppeteer, Selenium) is installed, and no browser process is launched.
    - **No Usability Guarantee**: Deciding that a browser is required does not guarantee that the target website will be usable or that automation will succeed.
    - **HTTP 403 Ambiguity**: HTTP 403 is treated conservatively as a potential candidate for interactive browser or user intervention, but may also stem from IP blocking, geofencing, or permanent denial.
    - **No CAPTCHA / MFA Handling**: Bot-detection challenges and two-factor authentication flows are not implemented.
    - **No Authentication State / Session Storage**: Browser session, cookies, and credentials management are not implemented.
    - **No Navigation or Form Automation**: Real clicking, typing, page navigation, and form submission are deferred to future bricks.
    - **No DOM / Accessibility Inspection**: DOM tree, accessibility-tree, or element inspection is not implemented.
    - **No Automatic /api/auto Integration**: `/api/auto` does not invoke `/api/browser-decision`.
    - **No Voice Turn Integration**: Voice Turn, STT, and TTS remain separate and disconnected.
    - **No Self-Healing or Recovery**: Failed browser executions have no automated recovery mechanisms in this brick.
    - **Stateless Isolation**: `/api/browser-decision` is strictly stateless, read-only, and writes zero records to `ConversationSession`, `ConversationStore`, or runtime persistence.

19. **Playwright Browser Lifecycle Foundation v1 Observations & Limitations (Brick 26 Verified)**:
    - **Browser Lifecycle Only**: Only lifecycle control exists (launch, status, close); no page actions are supported.
    - **Browser Starts at about:blank**: Blank page only; no external URLs.
    - **No URL Navigation**: `page.goto`, reload, back, forward, and URL loading are prohibited in this brick.
    - **No Clicking**: Element clicking, tapping, or button activation are not implemented.
    - **No Typing**: Keyboard input, text filling, and form inputs are not implemented.
    - **No DOM Inspection**: Page content, HTML extraction, and selector queries are not implemented.
    - **No Accessibility Tree**: Accessibility tree inspection is not implemented.
    - **No Tabs / Windows Management**: Multiple tabs or secondary windows are not supported.
    - **No Downloads / Uploads**: File transfer and download listeners are not implemented.
    - **No Authentication**: Login, credentials, cookies, and session handling are not implemented.
    - **No User Profile Reuse**: Existing Edge/Chrome personal profiles, cookies, and history are completely inaccessible.
    - **No Persistent Browser Session**: Browser context is temporary and discarded on close.
    - **Browser Decision Not Automatically Connected to Execution**: `/api/browser-decision` evaluates need offline and does not launch the browser.
    - **No Automatic /api/auto Integration**: `/api/auto` is not connected to browser execution.
    - **No Voice Turn Integration**: Voice Turn, STT, and TTS remain separate and disconnected.
    - **Single Configured Channel Only**: Exactly one browser channel (`msedge`) is attempted; zero fallback channels are configured.
    - **Manual Window Close Reconciled**: Manual X-close of the managed window is caught via `page.on('close')` and active status checks, resetting state to `stopped` and preventing stale "Already Running" blockage.
    - **Stateless Isolation**: Browser lifecycle endpoints are strictly stateless and make zero writes to `ConversationSession`, `ConversationStore`, or runtime persistent files.

20. **Browser Navigation v1 Observations & Limitations (Brick 27 Verified)**:
    - **Verified Live Capabilities**: First real website navigation (`https://example.com/`), observational page status query without navigation, second navigation/history creation (`https://example.org/`), Back, Forward, Refresh, localhost/loopback blocking (`127.0.0.1`), stopped-browser navigation rejection (`BROWSER_NOT_RUNNING`), and zero browser auto-launch were confirmed working in live testing.
    - **Explicit URL Navigation Only**: Navigation accepts strictly valid HTTP and HTTPS URLs; search queries and unstructured natural language are rejected.
    - **No Search Queries Inside Browser**: Browser navigation cannot perform web searches; existing search system remains separate.
    - **No Element Clicking**: Element clicking, locator clicks, and button interactions are prohibited in this brick.
    - **No Typing**: Keyboard typing, text entry, and input field manipulation are prohibited in this brick.
    - **No Forms**: Form filling, submission, and validation are prohibited in this brick.
    - **No DOM / Accessibility Understanding**: DOM dumps, visible text extraction, element inventories, ARIA analysis, and accessibility trees are not implemented.
    - **No Multiple Tabs**: Owns at most one managed page; multi-tab navigation is prohibited.
    - **No Popup Handling**: Popups and new windows are not adopted or managed.
    - **No Authentication**: Login flows, credentials, cookies, and session state are not supported.
    - **No Browser Profile Reuse**: Existing personal profiles, extensions, cookies, and history are completely inaccessible.
    - **No CAPTCHA / MFA**: Bot challenges, CAPTCHAs, and multi-factor authentication are not supported.
    - **No Downloads / Uploads**: File transfer and download listeners are prohibited in this brick.
    - **No Automatic Browser Execution**: `/api/browser-decision` remains purely advisory policy and does not trigger navigation or execute browser actions automatically.
    - **No /api/auto Integration**: Ask JARVIS does not navigate or interact with the browser.
    - **No Voice Turn Integration**: Voice Turn, STT, and TTS remain completely disconnected from browser navigation.

21. **Page Understanding v1 Observations & Limitations (Brick 28 Verified)**:
    - **Live Verification on Real Webpages**:
      - `https://example.com/`: Basic inspection passed (correct URL, title, visible text, link detection, href returned; zero interaction).
      - `https://www.wikipedia.org/`: Complex page inspection passed (Title "Wikipedia", 2007 visible chars, 35 returned elements including heading, links, form, search input, select; input privacy verified).
      - `https://selenium.dev/selenium/web/web-form.html`: Real web form inspection passed (HTTP 200, Title "Web form", 276 visible chars, 19 elements: heading, form, text input, password, textarea, disabled input, link, select, file input, checkboxes, radios, button, color, date, range).
      - Real-World Input Privacy Verified: Text input values, passwords, textarea user entries, file paths, and hidden CSRF tokens are strictly omitted and never exposed.
    - **Transient Execution-Context Replacement & Live Fix**:
      - An unstable navigation test against an external endpoint (`httpbin.org`) timed out due to external 503 Service Temporarily Unavailable (not evidence of a navigation defect).
      - Inspecting immediately following unstable navigation exposed raw Playwright error: `page.evaluate: Execution context was destroyed, most likely because of a navigation`.
      - Live Fix implemented: inspection recognizes transient execution-context replacement and performs bounded recovery (waits for `domcontentloaded` stability and retries at most once; max 2 total attempts).
      - Controlled Errors: Persistent instability returns controlled `BROWSER_PAGE_BUSY` (HTTP 503) with message: "The page is still changing or loading. Try inspection again shortly." Generic failures return sanitized `BROWSER_INSPECTION_FAILED` (HTTP 500) with message: "Page inspection could not be completed."
      - Zero Raw Error Leakage: Raw Playwright error strings, internal JavaScript filenames, Windows paths, and stack traces are completely sanitized and never reach user-facing API or UI.
      - Live Fix Test A (Real HTTP 503 error-page inspection): External 503 error document was cleanly inspected; heading and text "503 Service Temporarily Unavailable" extracted; browser remained completely usable; zero raw error leakage occurred.
      - Live Fix Test B (Real web-form regression after fix): Form re-inspected cleanly on Selenium web form; 19/19 elements detected with identical structure and full privacy preserved.
      - Future Scope Boundary: Element targeting, selectors, and interactive actions belong to Brick 29; Brick 29 has not been started.
    - **Read-Only Main-Document Inspection Only**: Inspection operates strictly on the active managed page's main document. Cross-origin iframe traversal, iframe orchestration, and shadow DOM traversal systems are not implemented.
    - **Point-in-Time Snapshot Staleness**: Inspection returns a static, point-in-time observational snapshot. If the page mutates after inspection, the returned snapshot may become stale. No `MutationObserver`, continuous page monitoring, or background polling is implemented.
    - **Untrusted Page Content**: All extracted text and element attributes are treated as untrusted data. Webpage content saying "ignore previous instructions" or similar prompts remains plain extracted webpage text. Zero AI interpretation is performed over inspected page content.
    - **Bounded Text and Element Inventory**: Visible text is bounded by `BROWSER_INSPECTION_MAX_TEXT_CHARS` (default 12,000). Element inventory is bounded by `BROWSER_INSPECTION_MAX_ELEMENTS` (default 100). Individual element text is bounded by `BROWSER_INSPECTION_MAX_ELEMENT_TEXT_CHARS` (default 300). Truncation flags (`textTruncated`, `elementsTruncated`) are explicitly returned.
    - **Supported Element Categories**: Observational element inventory extracts only `heading`, `link`, `button`, `input`, `textarea`, `select`, and `form`. Non-visible elements (`display: none`, `visibility: hidden`, `hidden`, zero-size, `<script>`, `<style>`, `<template>`) are excluded where practical.
    - **No Element Targeting or Selectors**: No CSS selectors, XPath selectors, Playwright locators, JavaScript handles, or backend node IDs are exposed or generated. Reliable element targeting is deferred to Brick 29.
    - **No Interactive Execution**: Inspection performs zero clicking, typing, filling, pressing, focusing, hovering, scrolling, form submitting, file uploading, downloading, or cookie/storage modification.
    - **No Navigation Side Effects**: Inspection does not navigate to discovered links or fetch discovered URLs (`page.goto`, reload, back, forward are never called during inspection or recovery).
    - **No AI / Search Provider Usage**: Zero OpenRouter calls, zero LLM calls, zero search calls, and zero Exa calls are made. Inspection is 100% deterministic local evaluation.
    - **Browser Lifecycle Required**: Browser must already be running; auto-launch is strictly forbidden (`BROWSER_NOT_RUNNING`). If the managed page was manually closed, lifecycle reconciles to stopped.
    - **Subsystem Decoupling**: `/api/auto`, `/api/browser-decision`, STT, TTS, and Voice Turn remain completely disconnected from page inspection.

22. **Reliable Element Targeting v1 Observations & Limitations (Brick 29 Verified)**:
    - **Live Verification on Real Webpages**:
      - `https://www.selenium.dev/selenium/web/web-form.html`: Submit button resolved uniquely with high confidence (`matchedBy: ["kind", "accessibleName"]`, `formAction: "submitted-form.html"`); zero interaction.
      - Selenium Password input resolved uniquely with high confidence (`inputType: "password"`, `name: "my-password"`); password value and input value strictly omitted.
      - `https://www.wikipedia.org/`: Search input resolved uniquely with high confidence (`inputType: "search"`); form metadata observed safely; input value omitted; typing: NO.
      - Partial semantic link matching verified on Wikipedia English link (`English 7,249,000+ articles`), returning medium confidence and correct href without false high-confidence claims.
      - Snapshot Stability verified: Unchanged page resolved twice yielded identical snapshot token (`snap_v4_mv58qhxy_4`) and identical opaque targetId.
      - Snapshot Invalidation verified: Navigation from Wikipedia to Selenium form produced fresh snapshot (`snap_v2_mv58xz0o_6`), cleanly invalidating prior snapshot.
      - Ambiguity Protection verified: Two Selenium checkbox inputs with `name="my-check"` returned controlled `TARGET_AMBIGUOUS` with candidate count 2; first DOM element was NOT arbitrarily chosen.
      - Semantic Disambiguation verified: Specific target `{ kind: "input", name: "Checked checkbox" }` resolved uniquely with high confidence (`checked: true`).
      - Target Not Found verified: Non-existent target returned controlled `TARGET_NOT_FOUND` with candidate count 0, message "No matching element found on the current page"; zero guessing, zero web search, zero AI fallback.
      - Non-Latin Unicode verified: Japanese link `日本語` on Wikipedia resolved uniquely with medium confidence (`href: "//ja.wikipedia.org/"`) without translation services.
      - Arabic Discovery & Targeting verified: Inspected Arabic Wikipedia (`https://ar.wikipedia.org/`), discovered visible search button `[button] <button> : "بحث"`, and resolved it uniquely with high confidence (`accessibleName: "بحث"`, form `searchform`, snapshot `snap_v2_mv59azn7_9`); real Arabic targeting verified with zero translation dependencies.
    - **Important Target-ID Contract for Future Brick 30**:
      - Opaque `targetId` values may repeat structurally across documents.
      - TargetId MUST NEVER be treated as globally valid by itself.
      - Future Brick 30 interaction must couple target identity with the current document snapshot and/or perform immediate semantic re-resolution immediately before acting.
      - A targetId without matching current snapshot context must not authorize an action.
    - **Read-Only Semantic Resolution**: Brick 29 resolves targets against the active managed page observationally but performs NO interaction.
    - **Zero Clicking**: `click`, `dblclick`, `tap` are strictly prohibited and not implemented.
    - **Zero Typing & Filling**: `fill`, `type`, `press`, `setInputFiles` are strictly prohibited and not implemented.
    - **Zero Form Execution**: Submitting forms, selecting options, or executing controls is deferred to future bricks (Brick 30 & Brick 33).
    - **Zero Tabs & Popups**: Operates strictly on the single managed page. No tab opening or popup management.
    - **Zero Authentication**: No session management, credential handling, or login automation.
    - **Main Document Scope**: No cross-origin iframe orchestration or shadow DOM piercing.
    - **Zero AI / Planner**: Makes 0 OpenRouter calls, 0 LLM calls, 0 Exa calls, and 0 search calls. No semantic LLM target choice.
    - **Bespoke / Custom Controls Limitation**: Unconventional custom widgets (e.g., canvas-rendered UI or unstandardized controls without semantic HTML/ARIA markup) may remain unresolved until later bricks.
    - **Snapshot Staleness & Invalidation**: Resolved targets and opaque target IDs are tied to document snapshot tokens and are immediately invalidated on navigation, back, forward, refresh, document re-render, page close, or browser restart.
    - **Decoupled from Existing Subsystems**: `/api/auto`, `/api/browser-decision`, STT, TTS, and Voice Turn remain completely disconnected from target resolution.

23. **Basic Real Browser Interactions v1 Observations & Limitations (Brick 30 Verified)**:
    - **Human Live Verification Completed**: Verified across 15 real browser interaction tests:
      - Fill text input: Text input "JARVIS BRICK30 TEST" entered and verified; no navigation; input privacy preserved.
      - Checkbox check: Default checkbox checked.
      - Checkbox uncheck: Checked checkbox unchecked.
      - Native select: Discovered live issue where native select option text contaminated enclosing `<label>`/accessible name, resolving only medium confidence. Fixed cleanly in `src/browser/pageInspection.js` by excluding nested select/options and form controls from label text. After fix, "Dropdown (select)" resolved unique, high confidence, and selecting "Two" verified cleanly (`selectedText = "Two"`). High-confidence requirement strictly maintained without weakening to medium confidence.
      - Safe same-tab click: Return to index navigated to `index.html` with new snapshot token and verified destination.
      - Stale snapshot protection: Old snapshot token rejected with `TARGET_STALE`.
      - Password block: Password input fill blocked with `PASSWORD_INTERACTION_NOT_AUTHORIZED`.
      - File input block: File input fill blocked with `FILE_INTERACTION_NOT_AUTHORIZED`.
      - Form submission block: Submit button click blocked with `FORM_SUBMISSION_NOT_AUTHORIZED`.
      - Ambiguous target protection: `my-check` returned `TARGET_AMBIGUOUS`.
      - Radio check: Default radio checked.
      - Radio uncheck block: Default radio uncheck rejected with `ACTION_NOT_SUPPORTED_FOR_TARGET`.
      - Disabled input protection: Disabled input fill blocked with `TARGET_DISABLED`.
      - Missing target protection: Non-existent button rejected with `TARGET_NOT_FOUND`.
      - Medium-confidence interaction safety: Wikipedia English link (partial match) blocked with `TARGET_CONFIDENCE_TOO_LOW`.
    - **Single Primitive Interactions Only**: Brick 30 supports only single primitive interactions (`click`, `fill`, `check`, `uncheck`, `select`). Exactly one action per request is allowed.
    - **No Form Submission / Workflow**: Blocked intentionally in Brick 30 (`FORM_SUBMISSION_NOT_AUTHORIZED`). Form submission and result confirmation belong to Brick 34.
    - **No Multi-Step Sequences / Plans**: Requests with multiple actions, action arrays, or action sequences are strictly rejected (`MULTI_ACTION_NOT_SUPPORTED`). Multi-step browser execution belongs to Brick 40.
    - **No Arbitrary Keyboard System**: Arbitrary key combinations, function keys, and shortcut execution (`Enter`, `Ctrl+Enter`, etc.) are prohibited in Brick 30.
    - **No Tabs / Windows / Popups**: Popups and new tabs are blocked (`POPUP_NOT_SUPPORTED`). Tab and window management belongs to Brick 31.
    - **No Authentication**: Password input interactions are blocked (`PASSWORD_INTERACTION_NOT_AUTHORIZED`). Authentication workflows belong to Brick 35.
    - **No File Upload / Download**: File input interactions are blocked (`FILE_INTERACTION_NOT_AUTHORIZED`) and file downloads are blocked (`DOWNLOAD_NOT_AUTHORIZED`). File handling belongs to Brick 37.
    - **No Iframe Orchestration / Shadow DOM**: Operates strictly on the main document of the single managed page.
    - **No Autonomous Browser Planner**: Performs 0 OpenRouter, 0 LLM, 0 Exa, and 0 web search calls. Webpage content cannot alter JARVIS action policy.
    - **No Consequential-Action Policy Engine Yet**: Safety/permissions gating belongs to Brick 43.
    - **Snapshot Staleness Requirement**: Actions require `expectedSnapshotToken` matching the active page snapshot. Any document mutation or navigation invalidates previous snapshots (`TARGET_STALE`).
    - **High-Confidence Re-Resolution Prerequisite**: Semantic targets are immediately re-resolved against the active DOM immediately prior to action. Targets resolving with medium or low confidence are rejected (`TARGET_CONFIDENCE_TOO_LOW`).
    - **Decoupled from Existing Subsystems**: `/api/auto`, `/api/browser-decision`, STT, TTS, and Voice Turn remain completely disconnected from browser action execution.
    - **Production Milestone**: The browser subsystem is not yet production-ready; GREEN-045 remains the production-ready milestone.

24. **Tabs, Windows & Popups v1 Observations & Limitations (Brick 31 Verified)**:
    - **Human Live Verification Completed**: Verified across 16 real browser lifecycle and interaction tests (Tests A through P):
      - Test A (Initial browser lifecycle): Edge remained open after launch (`Browser Connected = Yes`, `Context Open = Yes`, `Page Open = Yes`, `URL = about:blank`). PASS.
      - Test B (Initial page registry): Managed page count = 1, opaque pageId assigned, initial page active, creationType = 'initial'. PASS.
      - Test C (Open second managed page): Opened `https://example.com/`; managed page count = 2; Example.com became active; original page remained managed. PASS.
      - Test D (Switch page): Switched back to initial page without reload or navigation; both pages remained managed. PASS.
      - Test E (Active-page endpoint routing): Page status followed active page (`https://example.com/`, "Example Domain"). PASS.
      - Test F (Close background page): Closed background `about:blank`; Example.com remained active; managed page count = 1. PASS.
      - Test G (Close active page fallback): Opened Example.org, closed active Example.org; Example.com became active fallback. PASS.
      - Test H (Manual tab close reconciliation): User manually closed tab in Edge; registry reconciled; closed page removed; no ghost page; survivor active. PASS.
      - Test I (Block new page): Selenium "Open new window" link clicked with `popupPolicy = block`; returned controlled `POPUP_NOT_SUPPORTED` (`Popup/new-page creation is blocked by the current popup policy.`); managed count remained 1; opener remained active; no new tab remained. PASS.
      - Test J (Allow-single new page): Selenium "Open new window" clicked with `popupPolicy = allow-single`; adopted exactly 1 new tab; `New Page Created = Yes`, `Popup Created = Yes`, `Creation Type = popup`, total pages = 2; new tab active with matching URL (`simple_page.html`) and title ("Simple Page"). PASS.
      - Test K (Switch back to opener): Opener became active; Simple Page remained managed in background; page status followed opener. PASS.
      - Test L (Close background new page): Closed Simple Page; count = 1; opener remained active; no ghost page. PASS.
      - Test M (Cross-page snapshot block): Snapshot from Selenium page rejected on Example.com with `TARGET_STALE`. PASS.
      - Test N (Active page fallback): Closed active Example.com; Selenium page became active; count = 1. PASS.
      - Test O (Final page shutdown): Closed final page; browser reconciled to stopped (`Browser State = stopped`, `Page Open = No`); endpoints rejected safely. PASS.
      - Test P (Old page ID invalidation): Attempted `switch-page` with old lifecycle ID; returned `PAGE_NOT_FOUND` (`Page "pg_..." not found`). PASS.
    - **Live Fixes Discovered & Resolved**:
      - *Fix A (Initial Page Self-Close)*: Legitimate initial page created by `context.newPage()` was misclassified by context listener as an unsolicited popup and immediately closed. Fixed with explicit internal page-creation tickets, live-page lifecycle reconciliation, and listener detachment.
      - *Fix B (Blocked New Page False Success)*: Action-created pages under `popupPolicy = block` were swallowed by spontaneous cleanup before the action layer could observe them, reporting false success. Fixed with action-scoped observation windows for both `block` and `allow-single`.
      - *Fix C (Real Playwright Event Timing Race)*: Edge CDP delivered page lifecycle events slightly after `click()` promise resolved, causing listeners to be detached prematurely. Fixed with bounded post-click event settlement window (`BROWSER_POPUP_SETTLE_MS = 500 ms`) before policy evaluation and cleanup.
      - *Fix D (URL/Title Cross-Page Mixing & Terminology)*: `result.currentUrl` was retained from the opener while `result.title` was updated to the new tab. Fixed so `currentUrl` and `title` always refer strictly to the same active Page; introduced preferred generic `New Page Created` terminology alongside backward-compatible `Popup Created`.
    - **Terminology**: Playwright represents tabs, popup windows, and separate browser windows uniformly as `Page` objects. Brick 31 manages these uniformly. External/user-facing terminology prefers "new page" or "new tab/page" rather than assuming every new Page is literally a popup. Preserves `creationType` metadata where available. Does NOT claim OS-level window classification.
    - **No Autonomous Tab Planning**: Page switching, opening, and closing require explicit caller or user action. JARVIS does not autonomously determine which tab to visit.
    - **No Dynamic SPA Recovery**: Dynamic SPA orchestration and mutation-driven planning belong to Brick 32.
    - **No Form Submission Workflow**: Form submissions remain strictly blocked (`FORM_SUBMISSION_NOT_AUTHORIZED`). Belongs to Brick 34.
    - **No Authentication Persistence**: No persistent cookies, `storageState`, login flows, or session replay. Belongs to Brick 35.
    - **No MFA / CAPTCHA Handling**: Multi-factor authentication and CAPTCHA solving are not implemented.
    - **No Upload / Download**: File uploads and downloads remain blocked (`FILE_INTERACTION_NOT_AUTHORIZED`, `DOWNLOAD_NOT_AUTHORIZED`). Belongs to Brick 37.
    - **No Iframe Orchestration / Shadow DOM**: Multi-page lifecycle manages top-level Pages only; nested frames and shadow DOMs remain unmanaged.
    - **No General JavaScript Dialog Workflow**: No alert, confirm, or prompt interaction agents. Dismissal is minimal lifecycle cleanup only.
    - **No OS-Level Window Positioning**: Pages are managed strictly through Playwright Page abstractions; OS-level window coordinates and native window handles are not tracked.
    - **No Multi-Step Browser Agent**: No multi-action chains, planner loops, or autonomous goal decomposition. Belongs to Brick 40.
    - **No Voice-Driven Page Switching**: Voice Turn, STT, and TTS are not connected to browser page management.
    - **Zero AI / Zero Search**: Page management, switching, and adoption perform 0 LLM calls and 0 search calls.
25. **Dynamic Sites & SPAs v1 Observations & Limitations (Brick 32 Verified)**:
    - **Main Document Only**: Dynamic tracking and bounded wait primitives observe only the top-level main document. Nested iframes and shadow DOM traversal remain unmanaged (deferred to Brick 39).
    - **No `networkidle`**: Network requests are never used to determine DOM stability. Pages with ongoing WebSockets, long polling, ads, or background analytics can still settle reliably once the main document semantic DOM is quiet for `BROWSER_DOM_QUIET_MS` (default 300 ms).
    - **Strict Privacy Preservation**: Revision tracking records only numeric revisions and monotonic timestamps. Passwords, text input contents, textarea contents, file paths, cookies, localStorage, sessionStorage, and hidden tokens are never observed or exposed.
    - **No Automatic Action Retry / Self-Healing**: When a target element is missing, detached, or stale at interaction time, the action rejects immediately (`TARGET_STALE`, `TARGET_NOT_FOUND`, `TARGET_CHANGED`). No automatic retry loop or semantic query rewriting is performed (deferred to Brick 41).
    - **No Forced DOM Modifications**: Observation only. JARVIS never deletes loading overlays, spinners, or disables disabled controls to force actionability.
    - **Read-Only Readiness Primitives**: `wait-for-target` is strictly read-only and never performs clicks, fills, checks, or navigations.
    - **Zero AI / Zero Search**: Dynamic tracking and wait primitives perform 0 LLM calls, 0 OpenRouter calls, and 0 search calls.
    - **No Form Submission Workflow**: Submit buttons remain blocked (`FORM_SUBMISSION_NOT_AUTHORIZED`, deferred to Brick 34); form workflows belong to Brick 33.
    - **Production Milestone**: Infrastructure towards GREEN-045; Brick 32 alone is not production-ready.

26. **Forms v1 — Understand, Map & Safely Populate Observations & Limitations (Brick 33 Verified)**:
    - **Form Discovery & Inspection**: Deterministic inspection (`POST /api/browser/inspect-form`) discovers `<form>` elements and formless controls on the active managed page without exposing raw HTML, CSS selectors, XPath, ElementHandles, cookies, or hidden tokens. Multiple forms are semantically distinguished, returning `FORM_AMBIGUOUS` if target form is unspecified and ambiguous.
    - **Field Semantics & Accessibility Resolution**: Supported fields (`text`, `email`, `tel`, `url`, `number`, `search`, `textarea`, `select`, `checkbox`, `radio`) are semantically mapped using `<label for>`, wrapping parent `<label>`, `aria-label`, `aria-labelledby`, placeholder fallbacks, and `<fieldset><legend>` context. Radio buttons are grouped semantically; checkboxes enforce explicit boolean target state; select controls map by option label/value without guessing.
    - **Safe Population & Snapshot Authorization**: Form population (`POST /api/browser/fill-form`) requires `expectedSnapshotToken` strictly bound to `pageId`, `documentVersion`, and `semanticRevision`. Stale or cross-page tokens are blocked with `TARGET_STALE`.
    - **Preflight Before Mutation & Atomicity**: The entire requested field set is strictly validated before ANY DOM modification. If any field fails preflight (missing, ambiguous, password, file, hidden, disabled, readonly, invalid option), exactly zero mutations occur. Execution is transactional with post-mutation verification; mid-operation unexpected failure attempts safe rollback and truthfully reports `PARTIAL_FORM_UPDATE` if rollback is incomplete.
    - **Strict Privacy**: Password fields are detected (`sensitive: true`) but values are never exposed or filled (`SENSITIVE_FIELD_NOT_ALLOWED`). File inputs are protected (`FILE_INPUT_NOT_ALLOWED`, deferred to Brick 37). Hidden fields and tokens are protected (`ACTION_NOT_SUPPORTED_FOR_TARGET`). User-supplied values are never persisted in logs, snapshots, conversation store, or test diagnostics.
    - **Form Submission STRICTLY BLOCKED**: Preserves `FORM_SUBMISSION_NOT_AUTHORIZED`. Zero calls to `form.submit()`, `requestSubmit()`, submit button clicks, reset clicks, or Enter key finalization. Submission and result confirmation belong to Brick 34.
    - **Zero AI / Zero Autonomous Value Generation**: Exactly 0 LLM calls, 0 OpenRouter calls, 0 search calls. No guessing, no memory auto-complete, no autonomous filling.
    - **Automated Real-Browser Verification**: Verified automatically via Playwright against local fixtures without requiring human manual form mechanics testing.

27. **Confirmed Form Submission & Result Verification v1 Observations & Limitations (Brick 34 Verified)**:
    - **Deterministic Two-Step Flow**: Form submission is never executed implicitly. Requires explicit authorization via `POST /api/browser/prepare-form-submit` followed by `POST /api/browser/submit-form`.
    - **Opaque Single-Use Confirmation Tokens**: Token (`conf_<timestamp>_<hex>`) is short-lived (`BROWSER_CONFIRMATION_TTL_MS`, default 60s), stored strictly in memory, and bound to `pageId`, `documentVersion`, `semanticRevision`, `snapshotToken`, form, submitter, and verification expectations. Token is consumed at the execution boundary; duplicate submissions are blocked with `CONFIRMATION_ALREADY_USED`.
    - **HTML5 Native Form Validation Precheck**: Evaluates browser-native validation (`checkValidity()`) during preparation. If any required or pattern constraint is invalid, returns `FORM_VALIDATION_FAILED` with zero confirmation token generated.
    - **Strict Security Boundaries**:
      - Passwords & Credential Authentication: Submission of forms containing password fields is strictly blocked with `AUTH_FORM_NOT_SUPPORTED` (deferred to Brick 35).
      - File Uploads: Submission of forms containing file upload controls is strictly blocked with `FILE_FORM_NOT_SUPPORTED` (deferred to Brick 37).
    - **Submission Mechanism & Zero Script Injection**: Clicks the resolved DOM submit button element handle directly. Zero calls to `form.submit()`, zero synthetic JavaScript injection, zero Enter-key submission, and zero reset button usage.
    - **Evidence-Based Result Verification**: Submission success requires deterministic post-action evidence observation (`url-equals`, `url-contains`, `url-changed`, `target-present`, `target-absent`, `text-present`, `spa-route-changed`, `document-navigation`) within bounded timeout (`BROWSER_SUBMIT_VERIFY_TIMEOUT_MS`, default 10s).
    - **Truthful Failure Reporting & Strictly Zero Auto-Retry**: If the submit button clicks but verification evidence is not observed, reports `SUBMISSION_ATTEMPTED_BUT_NOT_VERIFIED` (`submissionAttempted: true, verified: false`). Never claims success and NEVER automatically retries under any circumstance (prevents duplicate orders/messages/transactions).
    - **Atomic Cross-Page Isolation**: Tokens cannot be submitted across pages (`CROSS_PAGE_TOKEN_BLOCKED`). Switching active pages does not mutate or submit unselected pages.
    - **Zero AI / Zero Search**: 0 LLM calls, 0 search calls. Local loopback fixtures only.

28. **Human-Authenticated Persistent Browser Sessions v1 & Local Device Session Vault Observations & Limitations (Brick 35 In Progress)**:
    - **Human Authentication Model (Not Autonomous Login)**: JARVIS launches an isolated Edge context where the human manually signs into websites. Saving session state is an explicit user action (`POST /api/browser/sessions/save`), strictly never automated or triggered by URL changes, cookies appearing, or browser closure.
    - **Zero Password Automation**: Interacting with, reading, filling, generating, or saving passwords remains strictly prohibited. No credentials are saved or handled by JARVIS.
    - **Zero MFA / CAPTCHA Bypass**: No MFA interception, TOTP token handling, or CAPTCHA solving. Brick 36 will own structured handoff for human continuation.
    - **Storage State Boundaries & Supported Technologies**:
      - HttpOnly and standard cookies: SUPPORTED and persisted across browser restarts.
      - localStorage: SUPPORTED and persisted across browser restarts.
      - IndexedDB: NOT SUPPORTED by Playwright's `context.storageState()` API. Truthfully reported as NOT SUPPORTED; no fake claims.
    - **Truthful Authentication Semantics**: Restoring session state restores browser client storage (`sessionProfileLoaded: true, sessionStateRestored: true`), NOT guaranteed active authentication. Upstream server expirations, token revocations, IP restrictions, and enterprise SSO re-prompts must be handled truthfully by failing or displaying authentication prompts. JARVIS never generically claims `authenticated: true`.
    - **Local Device Protection & Fail-Closed Behavior**: Production session ciphertext is protected using Windows DPAPI (`DataProtectionScope.CurrentUser`). If DPAPI is unavailable, the system strictly fails closed with `SESSION_VAULT_UNAVAILABLE` with ZERO fallback to unencrypted plaintext.
    - **Strict Isolation & Old State Invalidation**: Restoring or activating a session invalidates all previous page IDs, snapshot tokens, target IDs, and form confirmation tokens. Cross-session leakage is strictly prevented.
    - **Sensitive Artifact Protection**: Auth tokens, cookies, passwords, and storage states are never exposed in UI, REST responses, logs, debug output, docs, or Git. Safe profiles only expose opaque session IDs (`sess_...`), human-readable labels, timestamps, and origin hostnames.











