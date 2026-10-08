import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { startServer } from '../../src/web/server.js';
import { CheaperInferenceProvider } from '../../src/providers/cheaperInference.js';
import { OpenRouterSpeechToTextProvider } from '../../src/providers/openRouterSTT.js';
import { ConversationSession } from '../../src/core/conversationSession.js';
import { ConversationStore } from '../../src/core/conversationStore.js';

describe('Voice Transcript to JARVIS AI Integration - Brick 11', () => {
  const AI_ENV_VARS = [
    'CHEAPER_INFERENCE_API_KEY',
    'CHEAPER_INFERENCE_BASE_URL',
    'CHEAPER_INFERENCE_MODEL',
    'CHEAPER_INFERENCE_TIMEOUT_MS',
    'OPENROUTER_API_KEY',
    'OPENROUTER_STT_BASE_URL',
    'OPENROUTER_STT_MODEL',
    'OPENROUTER_STT_TIMEOUT_MS'
  ];

  let originalEnv = {};
  let server;
  let baseUrl;
  let currentTestStoreFile;

  // Mock states
  let lastSttAudioBytes = null;
  let mockSttTranscript = 'Hello Jarvis, this is an automated transcript.';
  let mockSttFail = false;

  let lastAiReceivedMessages = null;
  let mockAiResponseText = 'JARVIS AI text response.';
  let mockAiFail = false;
  let mockAiThrow = false;

  const mockSttFetchFn = async (url, options) => {
    if (mockSttFail) {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        json: async () => ({ error: { message: 'STT provider failed' } })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ text: mockSttTranscript })
    };
  };

  const mockAiFetchFn = async (url, options) => {
    if (mockAiThrow) {
      throw new Error('Network connection timeout');
    }

    if (mockAiFail) {
      return {
        ok: false,
        status: 500,
        statusText: 'Provider Internal Error',
        json: async () => ({ error: { message: 'Cheaper Inference provider error' } })
      };
    }

    const body = options?.body ? JSON.parse(options.body) : {};
    lastAiReceivedMessages = body.messages || null;

    if (body.stream) {
      const sseContent = `data: ${JSON.stringify({ choices: [{ delta: { content: mockAiResponseText } }] })}\n\ndata: [DONE]\n\n`;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseContent));
            controller.close();
          }
        })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: mockAiResponseText
            }
          }
        ]
      })
    };
  };

  let sttProvider;
  let aiProvider;
  let sharedSession;
  let sharedStore;

  before(async () => {
    originalEnv = {};
    for (const key of AI_ENV_VARS) {
      if (key in process.env) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
      }
    }

    currentTestStoreFile = join(tmpdir(), `test-b11-store-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    sharedStore = new ConversationStore({ filePath: currentTestStoreFile });
    sharedSession = new ConversationSession();

    sttProvider = new OpenRouterSpeechToTextProvider({
      apiKey: 'sk-or-b11-test-key',
      model: 'openai/whisper-large-v3-turbo',
      fetchFn: mockSttFetchFn
    });

    aiProvider = new CheaperInferenceProvider({
      apiKey: 'sk-ci-b11-test-key',
      model: 'deepseek-v4-flash-0731',
      fetchFn: mockAiFetchFn
    });

    // Start test server with injected mock providers
    server = await startServer(0, '127.0.0.1', {
      sttProvider,
      provider: aiProvider,
      session: sharedSession,
      store: sharedStore
    });
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  beforeEach(() => {
    if (sharedSession) sharedSession.clear();
    if (sharedStore) sharedStore.clear();

    lastSttAudioBytes = null;
    mockSttTranscript = 'Hello Jarvis, this is an automated transcript.';
    mockSttFail = false;

    lastAiReceivedMessages = null;
    mockAiResponseText = 'JARVIS AI text response.';
    mockAiFail = false;
    mockAiThrow = false;
  });

  afterEach(() => {
    if (sharedSession) sharedSession.clear();
    if (sharedStore) sharedStore.clear();
  });

  after((done) => {
    if (currentTestStoreFile && existsSync(currentTestStoreFile)) {
      try { unlinkSync(currentTestStoreFile); } catch {}
    }

    for (const key of AI_ENV_VARS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }

    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  // =========================================================================
  // 1. HTML & Web UI Controls Contract
  // =========================================================================

  test('GET / serves HTML containing Brick 11 Ask JARVIS button and response displays', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);

    const html = await res.text();
    // Brick 11 UI additions
    assert.match(html, /id="ask-jarvis-btn"/);
    assert.match(html, /id="jarvis-status"/);
    assert.match(html, /id="jarvis-response"/);
    assert.match(html, /Ask JARVIS/);

    // Initial button state: disabled
    assert.match(html, /<button type="button" id="ask-jarvis-btn" disabled>Ask JARVIS<\/button>/);

    // Brick 9 & 10 microphone & STT elements remain intact
    assert.match(html, /id="start-mic-btn"/);
    assert.match(html, /id="stop-mic-btn"/);
    assert.match(html, /id="transcribe-btn"/);
    assert.match(html, /id="mic-status"/);
    assert.match(html, /id="mic-meta"/);
    assert.match(html, /id="audio-playback"/);
    assert.match(html, /id="stt-status"/);
    assert.match(html, /id="transcript-display"/);

    // Brick 1-8 prior controls remain intact
    assert.match(html, /id="text-input"/);
    assert.match(html, /id="send-btn"/);
    assert.match(html, /id="ask-ai-btn"/);
    assert.match(html, /id="ask-ai-stream-btn"/);
    assert.match(html, /id="clear-conv-btn"/);
    assert.match(html, /id="response-area"/);
    assert.match(html, /id="status-indicator"/);
  });

  test('HTML script enforces transcript validation before sending to AI', async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();

    // Validates that transcript is non-empty
    assert.match(html, /if \(!currentTranscript \|\| typeof currentTranscript !== 'string' \|\| currentTranscript\.trim\(\)\.length === 0\)/);
    // Sets busy state
    assert.match(html, /setBusy\(true, 'Status: Thinking\.\.\.'\)/);
    assert.match(html, /jarvisStatus\.textContent = 'JARVIS: Thinking\.\.\.'/);
    // Distinct STT vs AI error displays
    assert.match(html, /jarvisStatus\.textContent = 'JARVIS AI: Error'/);
    assert.match(html, /sttStatus\.textContent = 'STT: Error'/);
    // Preserves transcript on AI failure (does not clear transcriptDisplay)
    assert.doesNotMatch(html, /jarvisStatus\.textContent = 'JARVIS AI: Error'[\s\S]*?transcriptDisplay\.textContent = ''/);
    // Resets currentTranscript to null when transcribing starts so failed STT cannot submit old transcript
    assert.match(html, /transcribeBtn\.addEventListener\('click'[\s\S]*?currentTranscript = null;/);
  });

  // =========================================================================
  // 2. End-to-End Voice Transcript → AI Pipeline (English)
  // =========================================================================

  test('successful transcript can be sent into existing AI path and returns AI text response', async () => {
    sharedSession.clear();
    mockSttTranscript = 'What is Power BI? Explain it in one short sentence.';
    mockAiResponseText = 'Power BI is an interactive data visualization software by Microsoft.';

    // Step 1: STT request produces transcript
    const audioBytes = Buffer.from('AUDIO_ENGLISH_QUERY');
    const sttRes = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: audioBytes
    });
    assert.equal(sttRes.status, 200);
    const sttData = await sttRes.json();
    assert.equal(sttData.success, true);
    assert.equal(sttData.text, 'What is Power BI? Explain it in one short sentence.');

    // Step 2: Browser sends exact transcript to POST /api/ai
    const aiRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: sttData.text })
    });
    assert.equal(aiRes.status, 200);
    const aiData = await aiRes.json();
    assert.equal(aiData.success, true);
    assert.equal(aiData.response, 'Power BI is an interactive data visualization software by Microsoft.');

    // Step 3: Verify exact transcript reached AI provider
    assert.ok(lastAiReceivedMessages);
    const lastMsg = lastAiReceivedMessages[lastAiReceivedMessages.length - 1];
    assert.equal(lastMsg.role, 'user');
    assert.equal(lastMsg.content, 'What is Power BI? Explain it in one short sentence.');
  });

  // =========================================================================
  // 3. Multilingual and Unicode Preservation
  // =========================================================================

  test('Urdu transcript is preserved exactly without corruption or transliteration', async () => {
    sharedSession.clear();
    const urduQuery = 'جارویس، پاور بی آئی کیا ہے؟';
    const urduReply = 'پاور بی آئی مائیکروسافٹ کا ایک ڈیٹا اینالیٹکس ٹول ہے۔';
    mockSttTranscript = urduQuery;
    mockAiResponseText = urduReply;

    // STT
    const sttRes = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from('AUDIO_URDU')
    });
    const sttData = await sttRes.json();
    assert.equal(sttData.text, urduQuery);

    // AI
    const aiRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: sttData.text })
    });
    assert.equal(aiRes.status, 200);
    const aiData = await aiRes.json();
    assert.equal(aiData.response, urduReply);

    // Exact Unicode preserved in AI provider messages
    assert.ok(lastAiReceivedMessages);
    const lastMsg = lastAiReceivedMessages[lastAiReceivedMessages.length - 1];
    assert.equal(lastMsg.content, urduQuery);
  });

  test('Arabic transcript is preserved exactly without corruption', async () => {
    sharedSession.clear();
    const arabicQuery = 'يا جارفس، ما هو Power BI؟';
    const arabicReply = 'Power BI هي خدمة لتحليل الأعمال تم تطويرها بواسطة Microsoft.';
    mockSttTranscript = arabicQuery;
    mockAiResponseText = arabicReply;

    // STT
    const sttRes = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from('AUDIO_ARABIC')
    });
    const sttData = await sttRes.json();
    assert.equal(sttData.text, arabicQuery);

    // AI
    const aiRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: sttData.text })
    });
    assert.equal(aiRes.status, 200);
    const aiData = await aiRes.json();
    assert.equal(aiData.response, arabicReply);

    assert.ok(lastAiReceivedMessages);
    const lastMsg = lastAiReceivedMessages[lastAiReceivedMessages.length - 1];
    assert.equal(lastMsg.content, arabicQuery);
  });

  test('mixed-language (Urdu + English) transcript is preserved accurately', async () => {
    sharedSession.clear();
    const mixedQuery = 'Jarvis, مجھے Power BI dashboard کے بارے میں بتاؤ';
    mockSttTranscript = mixedQuery;
    mockAiResponseText = 'Power BI ڈیش بورڈ ڈیٹا کو بصری انداز میں دکھاتا ہے۔';

    const sttRes = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from('AUDIO_MIXED')
    });
    const sttData = await sttRes.json();
    assert.equal(sttData.text, mixedQuery);

    const aiRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: sttData.text })
    });
    assert.equal(aiRes.status, 200);
    const aiData = await aiRes.json();
    assert.equal(aiData.success, true);

    assert.ok(lastAiReceivedMessages);
    const lastMsg = lastAiReceivedMessages[lastAiReceivedMessages.length - 1];
    assert.equal(lastMsg.content, mixedQuery);
  });

  test('Unicode emojis and complex symbols in transcript are preserved without corruption', async () => {
    sharedSession.clear();
    const emojiQuery = 'Hello JARVIS 🤖✨ What is 1 + 1? 🚀';
    mockSttTranscript = emojiQuery;
    mockAiResponseText = '1 + 1 = 2 🚀';

    const sttRes = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from('AUDIO_EMOJI')
    });
    const sttData = await sttRes.json();

    const aiRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: sttData.text })
    });
    assert.equal(aiRes.status, 200);
    assert.ok(lastAiReceivedMessages);
    const lastMsg = lastAiReceivedMessages[lastAiReceivedMessages.length - 1];
    assert.equal(lastMsg.content, emojiQuery);
  });

  // =========================================================================
  // 4. Validation: Empty / Missing / Whitespace Transcript Prevention
  // =========================================================================

  test('POST /api/ai rejects missing input property safely', async () => {
    const res = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Input must be a string/);
  });

  test('POST /api/ai rejects empty transcript safely', async () => {
    const res = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Input cannot be empty/);
  });

  test('POST /api/ai rejects whitespace-only transcript safely', async () => {
    const res = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '   \t \r\n  ' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Input cannot be empty/);
  });

  // =========================================================================
  // 5. Subsequent Recordings Replace Prior Transcript
  // =========================================================================

  test('new successful transcription replaces prior current transcript', async () => {
    sharedSession.clear();

    // Transcript 1
    mockSttTranscript = 'First question from voice 1';
    const sttRes1 = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from('AUDIO_1')
    });
    const sttData1 = await sttRes1.json();
    assert.equal(sttData1.text, 'First question from voice 1');

    // Transcript 2 (without restart or refresh)
    mockSttTranscript = 'Second question from voice 2';
    const sttRes2 = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from('AUDIO_2')
    });
    const sttData2 = await sttRes2.json();
    assert.equal(sttData2.text, 'Second question from voice 2');

    // Submitting transcript 2
    const aiRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: sttData2.text })
    });
    assert.equal(aiRes.status, 200);

    // AI received question 2
    assert.ok(lastAiReceivedMessages);
    const lastMsg = lastAiReceivedMessages[lastAiReceivedMessages.length - 1];
    assert.equal(lastMsg.content, 'Second question from voice 2');
  });

  // =========================================================================
  // 6. STT Failure Behavior
  // =========================================================================

  test('failed STT returns controlled error and does not trigger AI call', async () => {
    mockSttFail = true;
    lastAiReceivedMessages = null;

    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from('AUDIO_FAIL')
    });

    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /STT provider failed/);

    // AI provider was never called
    assert.equal(lastAiReceivedMessages, null);
  });

  // =========================================================================
  // 7. AI Failure Behavior & Rollback Safety
  // =========================================================================

  test('failed AI request returns controlled error and rolls back user turn from session', async () => {
    sharedSession.clear();
    mockAiFail = true;

    const initialSessionSize = sharedSession.size;

    const res = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'This AI call will fail.' })
    });

    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Cheaper Inference provider error/);

    // User turn rolled back: session size unchanged
    assert.equal(sharedSession.size, initialSessionSize);
  });

  test('AI network exception is controlled safely without crashing server', async () => {
    sharedSession.clear();
    mockAiThrow = true;

    const res = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'This will trigger a network exception.' })
    });

    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Network connection timeout/);

    // Server remains responsive
    const healthRes = await fetch(`${baseUrl}/`);
    assert.equal(healthRes.status, 200);
  });

  // =========================================================================
  // 8. Shared Conversation Context (Typed ↔ Voice Transcript)
  // =========================================================================

  test('Test E: Typed prompt followed by voice transcript shares ConversationSession context', async () => {
    sharedSession.clear();

    // Step 1: Typed prompt
    mockAiResponseText = 'Acknowledged. Your project code is ORBIT-381.';
    const typedRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'My project code is ORBIT-381.' })
    });
    assert.equal(typedRes.status, 200);
    assert.equal(sharedSession.size, 2);

    // Step 2: Voice transcript prompt
    mockSttTranscript = 'What is my project code?';
    mockAiResponseText = 'Your project code is ORBIT-381.';

    const aiRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: mockSttTranscript })
    });
    assert.equal(aiRes.status, 200);

    // Step 3: Verify AI provider received both turns in history
    assert.ok(lastAiReceivedMessages);
    assert.equal(lastAiReceivedMessages.length, 3);
    assert.deepEqual(lastAiReceivedMessages, [
      { role: 'user', content: 'My project code is ORBIT-381.' },
      { role: 'assistant', content: 'Acknowledged. Your project code is ORBIT-381.' },
      { role: 'user', content: 'What is my project code?' }
    ]);
  });

  test('Test F: Voice transcript followed by typed prompt shares ConversationSession context', async () => {
    sharedSession.clear();

    // Step 1: Voice transcript prompt
    mockSttTranscript = 'My second verification code is NOVA-742.';
    mockAiResponseText = 'Understood. Saved second verification code NOVA-742.';
    const voiceAiRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: mockSttTranscript })
    });
    assert.equal(voiceAiRes.status, 200);
    assert.equal(sharedSession.size, 2);

    // Step 2: Typed prompt
    mockAiResponseText = 'The second verification code is NOVA-742.';
    const typedRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'What second verification code did I tell you?' })
    });
    assert.equal(typedRes.status, 200);

    // Step 3: Verify AI provider received both turns in history
    assert.ok(lastAiReceivedMessages);
    assert.equal(lastAiReceivedMessages.length, 3);
    assert.deepEqual(lastAiReceivedMessages, [
      { role: 'user', content: 'My second verification code is NOVA-742.' },
      { role: 'assistant', content: 'Understood. Saved second verification code NOVA-742.' },
      { role: 'user', content: 'What second verification code did I tell you?' }
    ]);
  });

  test('Voice transcript followed by streaming Ask AI shares same ConversationSession context', async () => {
    sharedSession.clear();

    // Turn 1: Voice transcript
    mockAiResponseText = 'Turn 1 assistant answer';
    const voiceAiRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Voice prompt for stream test' })
    });
    assert.equal(voiceAiRes.status, 200);

    // Turn 2: Streaming call
    mockAiResponseText = 'Streaming delta reply';
    const streamRes = await fetch(`${baseUrl}/api/ai/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Streaming prompt following voice' })
    });
    assert.equal(streamRes.status, 200);
    const streamBody = await streamRes.text();
    assert.match(streamBody, /delta/);

    // Stream received prior voice turns
    assert.ok(lastAiReceivedMessages);
    assert.equal(lastAiReceivedMessages.length, 3);
    assert.equal(lastAiReceivedMessages[0].content, 'Voice prompt for stream test');
    assert.equal(lastAiReceivedMessages[2].content, 'Streaming prompt following voice');
  });

  // =========================================================================
  // 9. Persistent Conversation Behavior Across Server Restarts
  // =========================================================================

  test('Voice transcript AI request is persisted atomically to ConversationStore', async () => {
    sharedSession.clear();
    const tempStorePath = join(tmpdir(), `test-b11-persist-${Date.now()}.json`);
    const store = new ConversationStore({ filePath: tempStorePath });
    const session = new ConversationSession();

    let persistServer;
    try {
      persistServer = await startServer(0, '127.0.0.1', {
        provider: aiProvider,
        sttProvider,
        session,
        store
      });
      const pUrl = `http://127.0.0.1:${persistServer.address().port}`;

      mockAiResponseText = 'Persisted response to voice transcript';
      const aiRes = await fetch(`${pUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Voice question to be persisted' })
      });
      assert.equal(aiRes.status, 200);

      // Verify file exists and has saved turns
      assert.ok(existsSync(tempStorePath));
      const loaded = store.load();
      assert.equal(loaded.length, 2);
      assert.equal(loaded[0].content, 'Voice question to be persisted');
      assert.equal(loaded[1].content, 'Persisted response to voice transcript');
    } finally {
      if (persistServer) await new Promise(r => persistServer.close(r));
      try { unlinkSync(tempStorePath); } catch {}
    }
  });

  // =========================================================================
  // 10. Clear Conversation
  // =========================================================================

  test('POST /api/conversation/clear clears shared context after voice transcript calls', async () => {
    sharedSession.clear();

    // Turn 1
    await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Turn before clear' })
    });
    assert.equal(sharedSession.size, 2);

    // Clear
    const clearRes = await fetch(`${baseUrl}/api/conversation/clear`, {
      method: 'POST'
    });
    assert.equal(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.equal(clearData.success, true);
    assert.equal(sharedSession.size, 0);

    // Next voice transcript starts fresh
    await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Voice turn after clear' })
    });
    assert.equal(sharedSession.size, 2);
    assert.equal(lastAiReceivedMessages.length, 1);
    assert.equal(lastAiReceivedMessages[0].content, 'Voice turn after clear');
  });

  // =========================================================================
  // 11. Regressions for Prior Bricks
  // =========================================================================

  test('Deterministic /api/text still functions correctly', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Deterministic baseline check' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.response, 'JARVIS received: Deterministic baseline check');
  });

  test('Static /microphone.js route still serves module cleanly', async () => {
    const res = await fetch(`${baseUrl}/microphone.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/javascript/);
    const body = await res.text();
    assert.match(body, /export class MicrophoneRecorder/);
  });
});
