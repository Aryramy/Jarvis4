/**
 * Browser Microphone Capture Controller for JARVIS4 (Brick 9).
 * Provides language-agnostic audio recording and metadata extraction.
 *
 * NOTE: This brick captures audio only. It does not transcribe or perform STT.
 */

export class MicrophoneRecorder {
  /**
   * @param {Object} [options]
   * @param {MediaDevices} [options.mediaDevices] - Override for navigator.mediaDevices
   * @param {typeof MediaRecorder} [options.MediaRecorder] - Override for MediaRecorder class
   */
  constructor(options = {}) {
    this.mediaDevices = options.mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);
    this.MediaRecorderClass = options.MediaRecorder || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);

    this.state = 'idle'; // 'idle' | 'requesting' | 'recording' | 'captured' | 'error'
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.selectedMimeType = '';
    this.startTime = 0;
    this.capturedAudio = null;
    this.error = null;
  }

  /**
   * Checks whether the browser supports mediaDevices.getUserMedia and MediaRecorder.
   * @returns {boolean}
   */
  isSupported() {
    return Boolean(
      this.mediaDevices &&
      typeof this.mediaDevices.getUserMedia === 'function' &&
      this.MediaRecorderClass
    );
  }

  /**
   * Returns the best supported audio MIME type for MediaRecorder.
   * @returns {string}
   */
  getBestMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/aac'
    ];

    if (this.MediaRecorderClass && typeof this.MediaRecorderClass.isTypeSupported === 'function') {
      for (const type of candidates) {
        if (this.MediaRecorderClass.isTypeSupported(type)) {
          return type;
        }
      }
    }

    return '';
  }

  /**
   * Requests microphone permission and begins audio recording.
   * @returns {Promise<{ mimeType: string }>}
   */
  async start() {
    if (!this.isSupported()) {
      const errorMsg = !this.mediaDevices || typeof this.mediaDevices.getUserMedia !== 'function'
        ? 'Microphone access (navigator.mediaDevices.getUserMedia) is not supported in this browser'
        : 'MediaRecorder API is not supported in this browser';
      this.state = 'error';
      this.error = errorMsg;
      throw new Error(errorMsg);
    }

    // Clean up any lingering active stream
    this.cleanup();

    this.state = 'requesting';
    this.error = null;
    this.capturedAudio = null;
    this.chunks = [];

    let stream;
    try {
      stream = await this.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this.state = 'error';
      let msg = err.message || 'Failed to acquire microphone access';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        msg = 'Microphone permission denied';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        msg = 'No microphone hardware found';
      }
      this.error = msg;
      throw new Error(msg);
    }

    this.stream = stream;
    const mimeType = this.getBestMimeType();
    this.selectedMimeType = mimeType;

    try {
      const recorderOptions = mimeType ? { mimeType } : undefined;
      this.mediaRecorder = new this.MediaRecorderClass(stream, recorderOptions);
    } catch (err) {
      this.cleanup();
      this.state = 'error';
      this.error = `Failed to initialize MediaRecorder: ${err.message}`;
      throw new Error(this.error);
    }

    this.chunks = [];
    this.mediaRecorder.ondataavailable = (event) => {
      if (event && event.data && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    try {
      this.mediaRecorder.start(100);
    } catch (err) {
      this.cleanup();
      this.state = 'error';
      this.error = `Failed to start MediaRecorder: ${err.message}`;
      throw new Error(this.error);
    }

    this.startTime = Date.now();
    this.state = 'recording';
    return { mimeType: this.selectedMimeType };
  }

  /**
   * Stops recording and resolves with capture metadata and audio Blob.
   * @returns {Promise<{ blob: Blob, size: number, type: string, durationMs: number, durationSec: number, url: string }>}
   */
  async stop() {
    if (this.state !== 'recording' || !this.mediaRecorder) {
      return this.capturedAudio;
    }

    return new Promise((resolve, reject) => {
      this.mediaRecorder.onstop = () => {
        const durationMs = Math.max(0, Date.now() - (this.startTime || Date.now()));
        const mimeType = this.mediaRecorder?.mimeType || this.selectedMimeType || 'audio/webm';

        // Stop all microphone tracks to turn off the hardware recording indicator
        if (this.stream) {
          try {
            const tracks = this.stream.getTracks ? this.stream.getTracks() : [];
            for (const track of tracks) {
              if (typeof track.stop === 'function') {
                track.stop();
              }
            }
          } catch {}
          this.stream = null;
        }

        let blob;
        try {
          blob = new Blob(this.chunks, { type: mimeType });
        } catch (err) {
          this.state = 'error';
          this.error = `Failed to construct audio Blob: ${err.message}`;
          reject(new Error(this.error));
          return;
        }

        if (!blob || blob.size === 0) {
          this.state = 'error';
          this.error = 'Captured audio is empty (0 bytes)';
          this.capturedAudio = null;
          reject(new Error(this.error));
          return;
        }

        let objectUrl = '';
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          try {
            objectUrl = URL.createObjectURL(blob);
          } catch {}
        }

        this.capturedAudio = {
          blob,
          size: blob.size,
          type: blob.type || mimeType,
          durationMs,
          durationSec: Number((durationMs / 1000).toFixed(1)),
          url: objectUrl
        };

        this.state = 'captured';
        resolve(this.capturedAudio);
      };

      this.mediaRecorder.onerror = (err) => {
        this.cleanup();
        this.state = 'error';
        this.error = `MediaRecorder error: ${(err && err.message) || 'Unknown error'}`;
        reject(new Error(this.error));
      };

      try {
        this.mediaRecorder.stop();
      } catch (err) {
        this.cleanup();
        this.state = 'error';
        this.error = `Failed to stop MediaRecorder: ${err.message}`;
        reject(new Error(this.error));
      }
    });
  }

  /**
   * Cleans up microphone stream tracks and active recorder resources.
   */
  cleanup() {
    if (this.stream) {
      try {
        const tracks = this.stream.getTracks ? this.stream.getTracks() : [];
        for (const track of tracks) {
          if (typeof track.stop === 'function') {
            track.stop();
          }
        }
      } catch {}
      this.stream = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {}
    }
    this.mediaRecorder = null;

    if (this.state === 'recording' || this.state === 'requesting') {
      this.state = 'idle';
    }
  }
}

export default MicrophoneRecorder;
