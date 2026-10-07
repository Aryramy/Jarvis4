import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MicrophoneRecorder } from '../../src/web/microphone.js';

/**
 * Creates a mock audio track with a stop spy.
 */
function createMockTrack() {
  let stopped = false;
  return {
    kind: 'audio',
    enabled: true,
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
    }
  };
}

/**
 * Creates a mock MediaStream with one or more audio tracks.
 */
function createMockStream(tracks = [createMockTrack()]) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio')
  };
}

/**
 * Creates a mock MediaRecorder class.
 */
function createMockMediaRecorderClass(options = {}) {
  const supportedTypes = options.supportedTypes ?? ['audio/webm;codecs=opus', 'audio/webm'];
  const mockChunks = options.mockChunks ?? [new Blob(['mock-audio-chunk-12345'], { type: 'audio/webm' })];
  const simulateErrorOnStart = options.simulateErrorOnStart ?? false;
  const simulateErrorOnStop = options.simulateErrorOnStop ?? false;

  return class MockMediaRecorder {
    static isTypeSupported(type) {
      return supportedTypes.includes(type);
    }

    constructor(stream, recOptions = {}) {
      this.stream = stream;
      this.mimeType = recOptions.mimeType || 'audio/webm';
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
      this.onerror = null;
    }

    start() {
      if (simulateErrorOnStart) {
        throw new Error('Simulated MediaRecorder.start failure');
      }
      this.state = 'recording';
    }

    stop() {
      if (simulateErrorOnStop) {
        throw new Error('Simulated MediaRecorder.stop failure');
      }
      this.state = 'inactive';

      // Emit recorded chunks
      if (typeof this.ondataavailable === 'function') {
        for (const chunk of mockChunks) {
          this.ondataavailable({ data: chunk });
        }
      }

      // Trigger onstop asynchronously to mimic browser behavior
      queueMicrotask(() => {
        if (typeof this.onstop === 'function') {
          this.onstop();
        }
      });
    }
  };
}

describe('MicrophoneRecorder - Unit Tests (Brick 9)', () => {
  let mockTrack;
  let mockStream;
  let MockMediaRecorder;
  let mockMediaDevices;

  beforeEach(() => {
    mockTrack = createMockTrack();
    mockStream = createMockStream([mockTrack]);
    MockMediaRecorder = createMockMediaRecorderClass();
    mockMediaDevices = {
      getUserMedia: async () => mockStream
    };
  });

  // 1. Initialization
  test('initializes in idle state with null stream and recorder', () => {
    const recorder = new MicrophoneRecorder();
    assert.equal(recorder.state, 'idle');
    assert.equal(recorder.stream, null);
    assert.equal(recorder.mediaRecorder, null);
    assert.equal(recorder.capturedAudio, null);
    assert.equal(recorder.error, null);
  });

  // 2. isSupported detection
  test('isSupported returns false when mediaDevices is missing', () => {
    const recorder = new MicrophoneRecorder({
      mediaDevices: null,
      MediaRecorder: MockMediaRecorder
    });
    assert.equal(recorder.isSupported(), false);
  });

  test('isSupported returns false when getUserMedia is missing', () => {
    const recorder = new MicrophoneRecorder({
      mediaDevices: {},
      MediaRecorder: MockMediaRecorder
    });
    assert.equal(recorder.isSupported(), false);
  });

  test('isSupported returns false when MediaRecorder is missing', () => {
    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: null
    });
    assert.equal(recorder.isSupported(), false);
  });

  test('isSupported returns true when mediaDevices and MediaRecorder are available', () => {
    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: MockMediaRecorder
    });
    assert.equal(recorder.isSupported(), true);
  });

  // 3. Unsupported error handling on start()
  test('start throws error when mediaDevices is missing', async () => {
    const recorder = new MicrophoneRecorder({
      mediaDevices: null,
      MediaRecorder: MockMediaRecorder
    });

    await assert.rejects(
      () => recorder.start(),
      /Microphone access.*not supported/
    );
    assert.equal(recorder.state, 'error');
    assert.match(recorder.error, /not supported/);
  });

  test('start throws error when MediaRecorder is missing', async () => {
    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: null
    });

    await assert.rejects(
      () => recorder.start(),
      /MediaRecorder API is not supported/
    );
    assert.equal(recorder.state, 'error');
    assert.match(recorder.error, /MediaRecorder API is not supported/);
  });

  // 4. Permission denial & device errors
  test('start handles permission denial (NotAllowedError)', async () => {
    const deniedDevices = {
      getUserMedia: async () => {
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        throw err;
      }
    };

    const recorder = new MicrophoneRecorder({
      mediaDevices: deniedDevices,
      MediaRecorder: MockMediaRecorder
    });

    await assert.rejects(
      () => recorder.start(),
      /Microphone permission denied/
    );
    assert.equal(recorder.state, 'error');
    assert.equal(recorder.error, 'Microphone permission denied');
  });

  test('start handles missing microphone hardware (NotFoundError)', async () => {
    const notFoundDevices = {
      getUserMedia: async () => {
        const err = new Error('Requested device not found');
        err.name = 'NotFoundError';
        throw err;
      }
    };

    const recorder = new MicrophoneRecorder({
      mediaDevices: notFoundDevices,
      MediaRecorder: MockMediaRecorder
    });

    await assert.rejects(
      () => recorder.start(),
      /No microphone hardware found/
    );
    assert.equal(recorder.state, 'error');
    assert.equal(recorder.error, 'No microphone hardware found');
  });

  test('start handles generic getUserMedia rejection', async () => {
    const failedDevices = {
      getUserMedia: async () => {
        throw new Error('Audio hardware device busy');
      }
    };

    const recorder = new MicrophoneRecorder({
      mediaDevices: failedDevices,
      MediaRecorder: MockMediaRecorder
    });

    await assert.rejects(
      () => recorder.start(),
      /Audio hardware device busy/
    );
    assert.equal(recorder.state, 'error');
    assert.equal(recorder.error, 'Audio hardware device busy');
  });

  // 5. MIME Type Negotiation
  test('getBestMimeType selects first supported format', () => {
    const CustomMediaRecorder = class {
      static isTypeSupported(type) {
        return type === 'audio/webm;codecs=opus';
      }
    };

    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: CustomMediaRecorder
    });

    assert.equal(recorder.getBestMimeType(), 'audio/webm;codecs=opus');
  });

  test('getBestMimeType falls back to audio/ogg if audio/webm unsupported', () => {
    const CustomMediaRecorder = class {
      static isTypeSupported(type) {
        return type === 'audio/ogg';
      }
    };

    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: CustomMediaRecorder
    });

    assert.equal(recorder.getBestMimeType(), 'audio/ogg');
  });

  test('getBestMimeType returns empty string if no candidate is supported', () => {
    const CustomMediaRecorder = class {
      static isTypeSupported() {
        return false;
      }
    };

    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: CustomMediaRecorder
    });

    assert.equal(recorder.getBestMimeType(), '');
  });

  test('getBestMimeType returns empty string if MediaRecorder has no isTypeSupported method', () => {
    const CustomMediaRecorder = class {};

    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: CustomMediaRecorder
    });

    assert.equal(recorder.getBestMimeType(), '');
  });

  // 6. Normal Recording Lifecycle & State Transitions
  test('successful start transitions to recording state', async () => {
    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: MockMediaRecorder
    });

    assert.equal(recorder.state, 'idle');
    const result = await recorder.start();

    assert.equal(recorder.state, 'recording');
    assert.equal(result.mimeType, 'audio/webm;codecs=opus');
    assert.ok(recorder.stream);
    assert.ok(recorder.mediaRecorder);
  });

  test('stop transitions to captured state and returns audio metadata', async () => {
    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: MockMediaRecorder
    });

    await recorder.start();
    assert.equal(recorder.state, 'recording');

    const capture = await recorder.stop();

    assert.equal(recorder.state, 'captured');
    assert.ok(capture);
    assert.ok(capture.blob instanceof Blob);
    assert.ok(capture.size > 0);
    assert.match(capture.type, /audio\/webm/);
    assert.equal(typeof capture.durationMs, 'number');
    assert.equal(typeof capture.durationSec, 'number');
    assert.equal(recorder.capturedAudio, capture);
  });

  // 7. Zero-byte rejection
  test('stop flags zero-byte captured audio as error', async () => {
    const ZeroByteMediaRecorder = createMockMediaRecorderClass({
      mockChunks: [] // No chunks emitted
    });

    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: ZeroByteMediaRecorder
    });

    await recorder.start();
    await assert.rejects(
      () => recorder.stop(),
      /Captured audio is empty \(0 bytes\)/
    );

    assert.equal(recorder.state, 'error');
    assert.equal(recorder.capturedAudio, null);
    assert.equal(recorder.error, 'Captured audio is empty (0 bytes)');
  });

  // 8. Track Cleanup on stop()
  test('stop cleanly stops all audio tracks to release microphone hardware', async () => {
    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: MockMediaRecorder
    });

    await recorder.start();
    assert.equal(mockTrack.stopped, false);

    await recorder.stop();
    assert.equal(mockTrack.stopped, true);
    assert.equal(recorder.stream, null);
  });

  // 9. Cleanup method
  test('cleanup cleanly stops active tracks and resets state', async () => {
    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: MockMediaRecorder
    });

    await recorder.start();
    assert.equal(mockTrack.stopped, false);
    assert.equal(recorder.state, 'recording');

    recorder.cleanup();
    assert.equal(mockTrack.stopped, true);
    assert.equal(recorder.stream, null);
    assert.equal(recorder.mediaRecorder, null);
    assert.equal(recorder.state, 'idle');
  });

  // 10. Repeated recording without stale state
  test('repeated start and stop cycles work cleanly without stale recorder state', async () => {
    let track1 = createMockTrack();
    let track2 = createMockTrack();
    let callCount = 0;

    const rotatingDevices = {
      getUserMedia: async () => {
        callCount++;
        return createMockStream([callCount === 1 ? track1 : track2]);
      }
    };

    const recorder = new MicrophoneRecorder({
      mediaDevices: rotatingDevices,
      MediaRecorder: MockMediaRecorder
    });

    // Cycle 1
    await recorder.start();
    assert.equal(recorder.state, 'recording');
    const capture1 = await recorder.stop();
    assert.equal(recorder.state, 'captured');
    assert.equal(track1.stopped, true);
    assert.ok(capture1.size > 0);

    // Cycle 2
    await recorder.start();
    assert.equal(recorder.state, 'recording');
    assert.equal(track2.stopped, false);
    const capture2 = await recorder.stop();
    assert.equal(recorder.state, 'captured');
    assert.equal(track2.stopped, true);
    assert.ok(capture2.size > 0);
  });

  // 11. Recorder error scenarios
  test('MediaRecorder start failure triggers error state and cleanup', async () => {
    const FailingStartMediaRecorder = createMockMediaRecorderClass({
      simulateErrorOnStart: true
    });

    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: FailingStartMediaRecorder
    });

    await assert.rejects(
      () => recorder.start(),
      /Failed to start MediaRecorder/
    );
    assert.equal(recorder.state, 'error');
    assert.equal(mockTrack.stopped, true);
  });

  test('MediaRecorder stop failure triggers error state and cleanup', async () => {
    const FailingStopMediaRecorder = createMockMediaRecorderClass({
      simulateErrorOnStop: true
    });

    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: FailingStopMediaRecorder
    });

    await recorder.start();
    await assert.rejects(
      () => recorder.stop(),
      /Failed to stop MediaRecorder/
    );
    assert.equal(recorder.state, 'error');
    assert.equal(mockTrack.stopped, true);
  });

  test('calling stop when not recording returns existing capturedAudio without crashing', async () => {
    const recorder = new MicrophoneRecorder({
      mediaDevices: mockMediaDevices,
      MediaRecorder: MockMediaRecorder
    });

    const res1 = await recorder.stop();
    assert.equal(res1, null);

    await recorder.start();
    const capture = await recorder.stop();
    assert.ok(capture);

    // Call stop again when already captured
    const res2 = await recorder.stop();
    assert.equal(res2, capture);
  });
});
