import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTurnRunner, VoiceTurnState } from '../../src/web/voiceTurn.js';

describe('VoiceTurnRunner - Unit Tests (Brick 13)', () => {
  let mockFetchCalls = [];
  let mockSttTranscript = 'Default transcription';
  let mockSttFail = false;
  let mockSttDurationMs = 312;
  let mockAiResponse = 'Default JARVIS response';
  let mockAiFail = false;
  let mockTtsBytes = new Uint8Array([0xFF, 0xFB, 0x90, 0x44]);
  let mockTtsFail = false;
  let mockTtsDurationMs = 150;

  const createMockFetch = () => {
    return async (url, options) => {
      mockFetchCalls.push({ url, options });

      if (url === '/api/stt') {
        if (mockSttFail) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ success: false, error: 'STT provider error' })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, text: mockSttTranscript, durationMs: mockSttDurationMs })
        };
      }

      if (url === '/api/ai') {
        if (mockAiFail) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ success: false, error: 'AI provider error' })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, response: mockAiResponse })
        };
      }

      if (url === '/api/tts') {
        if (mockTtsFail) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ success: false, error: 'TTS provider error' })
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-type': 'audio/mpeg',
            'x-tts-duration-ms': String(mockTtsDurationMs)
          }),
          blob: async () => new Blob([mockTtsBytes], { type: 'audio/mpeg' })
        };
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ success: false, error: 'Not Found' })
      };
    };
  };

  beforeEach(() => {
    mockFetchCalls = [];
    mockSttTranscript = 'Default transcription';
    mockSttFail = false;
    mockSttDurationMs = 312;
    mockAiResponse = 'Default JARVIS response';
    mockAiFail = false;
    mockTtsBytes = new Uint8Array([0xFF, 0xFB, 0x90, 0x44]);
    mockTtsFail = false;
    mockTtsDurationMs = 150;
  });

  // 1. Initialization and state
  test('initializes in IDLE state with default configuration', () => {
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    assert.equal(runner.getState(), VoiceTurnState.IDLE);
    assert.equal(runner.isBusy, false);
    assert.equal(runner.turnCounter, 0);
  });

  test('throws if fetchFn is completely absent', async () => {
    const runner = new VoiceTurnRunner({ fetchFn: null });
    const dummyBlob = new Blob(['audio'], { type: 'audio/webm' });
    await assert.rejects(
      async () => {
        await runner.execute({ audioBlob: dummyBlob });
      },
      /fetch implementation is required/
    );
  });

  // 2. Safety checks: no recording, empty, active recording
  test('rejects safely when audioBlob is missing without network call', async () => {
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const result = await runner.execute({ audioBlob: null });
    assert.equal(result.success, false);
    assert.equal(result.stage, 'NO_RECORDING');
    assert.equal(result.error, 'No recording captured');
    assert.equal(mockFetchCalls.length, 0);
    assert.equal(runner.getState(), VoiceTurnState.IDLE);
    assert.equal(runner.isBusy, false);
  });

  test('rejects safely when audioBlob is zero bytes without network call', async () => {
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const emptyBlob = new Blob([], { type: 'audio/webm' });
    const result = await runner.execute({ audioBlob: emptyBlob });
    assert.equal(result.success, false);
    assert.equal(result.stage, 'EMPTY_RECORDING');
    assert.match(result.error, /0 bytes/);
    assert.equal(mockFetchCalls.length, 0);
    assert.equal(runner.getState(), VoiceTurnState.IDLE);
    assert.equal(runner.isBusy, false);
  });

  test('rejects safely when audioSize is explicitly 0 without network call', async () => {
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const blob = new Blob(['something'], { type: 'audio/webm' });
    const result = await runner.execute({ audioBlob: blob, audioSize: 0 });
    assert.equal(result.success, false);
    assert.equal(result.stage, 'EMPTY_RECORDING');
    assert.equal(mockFetchCalls.length, 0);
  });

  test('rejects safely when microphone is currently recording without network call', async () => {
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const dummyBlob = new Blob(['audio-data'], { type: 'audio/webm' });
    const result = await runner.execute({ audioBlob: dummyBlob, isRecording: true });
    assert.equal(result.success, false);
    assert.equal(result.stage, 'RECORDING');
    assert.equal(result.error, 'Microphone is currently recording');
    assert.equal(mockFetchCalls.length, 0);
    assert.equal(runner.getState(), VoiceTurnState.IDLE);
  });

  test('prevents concurrent / duplicate voice turn execution while busy', async () => {
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    runner.isBusy = true;
    const dummyBlob = new Blob(['audio-data'], { type: 'audio/webm' });
    const result = await runner.execute({ audioBlob: dummyBlob });
    assert.equal(result.success, false);
    assert.match(result.error, /already in progress/);
    assert.equal(mockFetchCalls.length, 0);
  });

  // 3. Pipeline order: STT -> AI -> TTS -> Playback
  test('executes stages in exact order: STT then AI then TTS', async () => {
    const stagesSeen = [];
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const audioBlob = new Blob(['recorded-audio-bytes'], { type: 'audio/webm' });

    let playbackCalled = false;
    const result = await runner.execute({
      audioBlob,
      onStageChange: (stage) => {
        stagesSeen.push(stage);
      },
      playAudioFn: async () => {
        playbackCalled = true;
      }
    });

    assert.equal(result.success, true);
    assert.equal(playbackCalled, true);
    assert.equal(mockFetchCalls.length, 3);
    assert.equal(mockFetchCalls[0].url, '/api/stt');
    assert.equal(mockFetchCalls[1].url, '/api/ai');
    assert.equal(mockFetchCalls[2].url, '/api/tts');

    // Transitions: STT -> STT_SUCCESS -> AI -> AI_SUCCESS -> TTS -> TTS_SUCCESS -> PLAYING
    assert.ok(stagesSeen.indexOf(VoiceTurnState.STT) !== -1);
    assert.ok(stagesSeen.indexOf(VoiceTurnState.AI) > stagesSeen.indexOf(VoiceTurnState.STT));
    assert.ok(stagesSeen.indexOf(VoiceTurnState.TTS) > stagesSeen.indexOf(VoiceTurnState.AI));
    assert.ok(stagesSeen.indexOf(VoiceTurnState.PLAYING) > stagesSeen.indexOf(VoiceTurnState.TTS));
  });

  // 4. Exact text flow
  test('STT transcript becomes exact AI prompt and AI response becomes exact TTS input', async () => {
    mockSttTranscript = 'Exact voice transcript input text.';
    mockAiResponse = 'Exact AI response output text.';

    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const audioBlob = new Blob(['audio'], { type: 'audio/webm' });

    await runner.execute({
      audioBlob,
      playAudioFn: async () => {}
    });

    // Check AI call body
    const aiCall = mockFetchCalls.find(c => c.url === '/api/ai');
    assert.ok(aiCall);
    const aiBody = JSON.parse(aiCall.options.body);
    assert.equal(aiBody.input, mockSttTranscript);

    // Check TTS call body
    const ttsCall = mockFetchCalls.find(c => c.url === '/api/tts');
    assert.ok(ttsCall);
    const ttsBody = JSON.parse(ttsCall.options.body);
    assert.equal(ttsBody.text, mockAiResponse);
  });

  // 5. Multilingual Unicode preservation
  test('preserves exact Urdu Unicode text across STT -> AI -> TTS without modification', async () => {
    mockSttTranscript = 'پاور بی آئی کیا ہے؟ ایک مختصر جملے میں جواب دیں۔';
    mockAiResponse = 'پاور بی آئی مائیکروسافٹ کا ایک ڈیٹا اینالیٹکس ٹول ہے۔';

    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const audioBlob = new Blob(['audio-urdu'], { type: 'audio/webm' });

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => {}
    });

    assert.equal(result.success, true);
    assert.equal(result.transcript, mockSttTranscript);
    assert.equal(result.response, mockAiResponse);

    const aiCall = mockFetchCalls.find(c => c.url === '/api/ai');
    assert.equal(JSON.parse(aiCall.options.body).input, mockSttTranscript);

    const ttsCall = mockFetchCalls.find(c => c.url === '/api/tts');
    assert.equal(JSON.parse(ttsCall.options.body).text, mockAiResponse);
  });

  test('preserves exact Arabic Unicode text across STT -> AI -> TTS without modification', async () => {
    mockSttTranscript = 'ما هو Power BI في جملة واحدة؟';
    mockAiResponse = 'Power BI هو أداة تحليل بيانات من مايكروسوفت.';

    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const audioBlob = new Blob(['audio-arabic'], { type: 'audio/webm' });

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => {}
    });

    assert.equal(result.success, true);
    assert.equal(result.transcript, mockSttTranscript);
    assert.equal(result.response, mockAiResponse);
  });

  test('preserves exact mixed Urdu and English text without modification', async () => {
    mockSttTranscript = 'Jarvis, مجھے Power BI dashboard کے بارے میں بتائیں۔';
    mockAiResponse = 'Power BI dashboard ایک interactive صفحہ ہے جو data دکھاتا ہے۔';

    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const audioBlob = new Blob(['audio-mixed'], { type: 'audio/webm' });

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => {}
    });

    assert.equal(result.success, true);
    assert.equal(result.transcript, mockSttTranscript);
    assert.equal(result.response, mockAiResponse);
  });

  test('preserves emojis and symbols across pipeline without corruption', async () => {
    mockSttTranscript = 'Hello JARVIS 🤖✨ tell me about space 🚀';
    mockAiResponse = 'Space is vast and fascinating! 🌌🪐';

    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const audioBlob = new Blob(['audio-emoji'], { type: 'audio/webm' });

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => {}
    });

    assert.equal(result.success, true);
    assert.equal(result.transcript, mockSttTranscript);
    assert.equal(result.response, mockAiResponse);
  });

  // 6. Error handling and pipeline stopping
  test('STT failure stops pipeline before calling AI or TTS and transitions to STT_ERROR', async () => {
    mockSttFail = true;
    const stagesSeen = [];
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const audioBlob = new Blob(['audio'], { type: 'audio/webm' });

    let playbackCalled = false;
    const result = await runner.execute({
      audioBlob,
      onStageChange: (stage) => stagesSeen.push(stage),
      playAudioFn: async () => { playbackCalled = true; }
    });

    assert.equal(result.success, false);
    assert.equal(result.stage, VoiceTurnState.STT_ERROR);
    assert.equal(runner.getState(), VoiceTurnState.STT_ERROR);
    assert.equal(runner.isBusy, false);
    assert.equal(playbackCalled, false);

    // Only STT was called; AI and TTS were NOT called
    assert.equal(mockFetchCalls.length, 1);
    assert.equal(mockFetchCalls[0].url, '/api/stt');
    assert.ok(!stagesSeen.includes(VoiceTurnState.AI));
    assert.ok(!stagesSeen.includes(VoiceTurnState.TTS));
  });

  test('AI failure stops pipeline before calling TTS and transitions to AI_ERROR', async () => {
    mockAiFail = true;
    const stagesSeen = [];
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const audioBlob = new Blob(['audio'], { type: 'audio/webm' });

    let playbackCalled = false;
    const result = await runner.execute({
      audioBlob,
      onStageChange: (stage) => stagesSeen.push(stage),
      playAudioFn: async () => { playbackCalled = true; }
    });

    assert.equal(result.success, false);
    assert.equal(result.stage, VoiceTurnState.AI_ERROR);
    assert.equal(runner.getState(), VoiceTurnState.AI_ERROR);
    assert.equal(runner.isBusy, false);
    assert.equal(playbackCalled, false);

    // STT succeeded, AI failed, TTS was NOT called
    assert.equal(mockFetchCalls.length, 2);
    assert.equal(mockFetchCalls[0].url, '/api/stt');
    assert.equal(mockFetchCalls[1].url, '/api/ai');
    assert.ok(!stagesSeen.includes(VoiceTurnState.TTS));
    // Successful transcript is preserved in result
    assert.equal(result.transcript, mockSttTranscript);
  });

  test('TTS failure stops playback and transitions to TTS_ERROR', async () => {
    mockTtsFail = true;
    const stagesSeen = [];
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const audioBlob = new Blob(['audio'], { type: 'audio/webm' });

    let playbackCalled = false;
    const result = await runner.execute({
      audioBlob,
      onStageChange: (stage) => stagesSeen.push(stage),
      playAudioFn: async () => { playbackCalled = true; }
    });

    assert.equal(result.success, false);
    assert.equal(result.stage, VoiceTurnState.TTS_ERROR);
    assert.equal(runner.getState(), VoiceTurnState.TTS_ERROR);
    assert.equal(runner.isBusy, false);
    assert.equal(playbackCalled, false);

    // STT, AI, and TTS were called, but playback did not occur
    assert.equal(mockFetchCalls.length, 3);
    assert.equal(result.transcript, mockSttTranscript);
    assert.equal(result.response, mockAiResponse);
  });

  test('playback failure transitions to PLAYBACK_ERROR cleanly', async () => {
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const audioBlob = new Blob(['audio'], { type: 'audio/webm' });

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => {
        throw new Error('Audio hardware decode failure');
      }
    });

    assert.equal(result.success, false);
    assert.equal(result.stage, VoiceTurnState.PLAYBACK_ERROR);
    assert.equal(runner.getState(), VoiceTurnState.PLAYBACK_ERROR);
    assert.equal(runner.isBusy, false);
  });

  // 7. Latency measurement
  test('measures total voice-turn elapsed latency from start to playback readiness', async () => {
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    const audioBlob = new Blob(['audio'], { type: 'audio/webm' });

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => {}
    });

    assert.equal(result.success, true);
    assert.ok(typeof result.totalDurationMs === 'number');
    assert.ok(result.totalDurationMs >= 0);
    assert.equal(result.sttDurationMs, mockSttDurationMs);
    assert.equal(result.ttsDurationMs, mockTtsDurationMs);
  });

  // 8. Stale data protection
  test('second turn uses new audio recording and does not reuse old state', async () => {
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });

    // Turn 1
    mockSttTranscript = 'Turn 1 transcript';
    mockAiResponse = 'Turn 1 AI response';
    const blob1 = new Blob(['audio-1'], { type: 'audio/webm' });
    const res1 = await runner.execute({ audioBlob: blob1, playAudioFn: async () => {} });
    assert.equal(res1.transcript, 'Turn 1 transcript');
    assert.equal(res1.response, 'Turn 1 AI response');

    // Turn 2
    mockSttTranscript = 'Turn 2 transcript';
    mockAiResponse = 'Turn 2 AI response';
    const blob2 = new Blob(['audio-2'], { type: 'audio/webm' });
    const res2 = await runner.execute({ audioBlob: blob2, playAudioFn: async () => {} });
    assert.equal(res2.transcript, 'Turn 2 transcript');
    assert.equal(res2.response, 'Turn 2 AI response');

    assert.equal(runner.turnCounter, 2);
  });

  // 9. Boundary checks: No prohibited features
  test('does not contain wake word, continuous listening, or automatic microphone restart', () => {
    const runner = new VoiceTurnRunner({ fetchFn: createMockFetch() });
    assert.equal(runner.wakeWord, undefined);
    assert.equal(runner.listenContinuously, undefined);
    assert.equal(runner.autoRestart, undefined);
    assert.equal(runner.vad, undefined);
  });
});
