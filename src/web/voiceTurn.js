/**
 * Voice Turn Sequential Orchestration Controller for JARVIS4 (Brick 13).
 *
 * Implements a client-side sequential state machine connecting verified local endpoints:
 *   Captured Audio -> POST /api/stt -> Transcript -> POST /api/ai -> Response -> POST /api/tts -> Audio Playback
 *
 * Boundaries:
 * - Sequential one-action trigger: strictly requires prior captured recording.
 * - No automatic microphone restart, no continuous listening, no wake word, no VAD.
 * - No backend compound route: orchestrates existing /api/stt, /api/ai, /api/tts.
 * - Single multilingual pipeline without language selectors or language toggles.
 * - Exact text flow: verbatim Unicode strings passed across all stages.
 */

export const VoiceTurnState = Object.freeze({
  IDLE: 'IDLE',
  STT: 'STT',
  AI: 'AI',
  TTS: 'TTS',
  PLAYING: 'PLAYING',
  COMPLETE: 'COMPLETE',
  STT_ERROR: 'STT_ERROR',
  AI_ERROR: 'AI_ERROR',
  TTS_ERROR: 'TTS_ERROR',
  PLAYBACK_ERROR: 'PLAYBACK_ERROR'
});

export class VoiceTurnRunner {
  /**
   * @param {Object} [options]
   * @param {typeof fetch} [options.fetchFn] - Optional fetch implementation for testing
   */
  constructor(options = {}) {
    this.fetchFn = options.fetchFn !== undefined ? options.fetchFn : (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.state = VoiceTurnState.IDLE;
    this.isBusy = false;
    this.turnCounter = 0;
    this.currentTurnId = 0;
    this.lastResult = null;
    this.lastError = null;
  }

  /**
   * Returns current state machine state.
   * @returns {string}
   */
  getState() {
    return this.state;
  }

  /**
   * Executes a sequential one-action voice turn over a captured audio recording.
   *
   * @param {Object} params
   * @param {Blob} params.audioBlob - Audio Blob captured from microphone
   * @param {number} [params.audioSize] - Size in bytes of captured audio
   * @param {boolean} [params.isRecording] - Whether microphone is currently active
   * @param {Function} [params.onStageChange] - Callback invoked on state transition: (state, details) => void
   * @param {Function} [params.playAudioFn] - Callback to initiate audio playback: async (blob, metrics) => void
   * @returns {Promise<{ success: boolean, stage?: string, transcript?: string, response?: string, audioBlob?: Blob, totalDurationMs?: number, sttDurationMs?: number, ttsDurationMs?: number, error?: string }>}
   */
  async execute(params = {}) {
    const {
      audioBlob,
      audioSize,
      isRecording = false,
      onStageChange,
      playAudioFn
    } = params;

    // Safety Check 1: Prevent duplicate concurrent voice turn execution
    if (this.isBusy) {
      return {
        success: false,
        error: 'Voice turn is already in progress',
        stage: this.state
      };
    }

    // Safety Check 2: Reject if microphone is actively capturing audio
    if (isRecording) {
      this.state = VoiceTurnState.IDLE;
      const err = 'Microphone is currently recording';
      onStageChange?.(VoiceTurnState.IDLE, { error: err });
      return {
        success: false,
        error: err,
        stage: 'RECORDING'
      };
    }

    // Safety Check 3: Reject if audioBlob is absent
    if (!audioBlob) {
      this.state = VoiceTurnState.IDLE;
      const err = 'No recording captured';
      onStageChange?.(VoiceTurnState.IDLE, { error: err });
      return {
        success: false,
        error: err,
        stage: 'NO_RECORDING'
      };
    }

    // Safety Check 4: Reject zero-byte captures
    const size = typeof audioSize === 'number' ? audioSize : audioBlob.size;
    if (size === 0 || audioBlob.size === 0) {
      this.state = VoiceTurnState.IDLE;
      const err = 'Captured audio is empty (0 bytes)';
      onStageChange?.(VoiceTurnState.IDLE, { error: err });
      return {
        success: false,
        error: err,
        stage: 'EMPTY_RECORDING'
      };
    }

    if (!this.fetchFn) {
      throw new Error('fetch implementation is required for VoiceTurnRunner');
    }

    // Establish deterministic turn identity to prevent stale data contamination
    const turnId = ++this.turnCounter;
    this.currentTurnId = turnId;
    this.isBusy = true;
    this.lastError = null;
    this.lastResult = null;

    const turnStartTime = Date.now();
    let stageTranscript = null;
    let stageAiResponse = null;
    let stageAudioBlob = null;
    let sttDurationMs = null;
    let ttsDurationMs = null;

    try {
      // -----------------------------------------------------------------
      // STEP 1 — STT
      // -----------------------------------------------------------------
      this.state = VoiceTurnState.STT;
      onStageChange?.(VoiceTurnState.STT, { text: 'Transcribing...' });

      let sttRes;
      let sttData;
      try {
        const formData = new FormData();
        const filename = audioBlob.type && audioBlob.type.includes('ogg') ? 'recording.ogg' : 'recording.webm';
        formData.append('audio', audioBlob, filename);

        sttRes = await this.fetchFn('/api/stt', {
          method: 'POST',
          body: formData
        });
        sttData = await sttRes.json().catch(() => ({}));
      } catch (networkErr) {
        this.state = VoiceTurnState.STT_ERROR;
        const err = networkErr.message || 'STT network error';
        this.lastError = { stage: 'STT', error: err };
        onStageChange?.(VoiceTurnState.STT_ERROR, { error: err });
        return { success: false, stage: VoiceTurnState.STT_ERROR, error: err };
      }

      // Check turn identity
      if (this.currentTurnId !== turnId) {
        return { success: false, cancelled: true };
      }

      if (!sttRes.ok || !sttData.success || typeof sttData.text !== 'string' || sttData.text.trim().length === 0) {
        this.state = VoiceTurnState.STT_ERROR;
        const err = sttData.error || 'Transcription failed';
        this.lastError = { stage: 'STT', error: err };
        onStageChange?.(VoiceTurnState.STT_ERROR, { error: err });
        return { success: false, stage: VoiceTurnState.STT_ERROR, error: err };
      }

      stageTranscript = sttData.text;
      sttDurationMs = typeof sttData.durationMs === 'number' ? sttData.durationMs : null;
      onStageChange?.('STT_SUCCESS', { transcript: stageTranscript, durationMs: sttDurationMs });

      // -----------------------------------------------------------------
      // STEP 2 — AI
      // -----------------------------------------------------------------
      this.state = VoiceTurnState.AI;
      onStageChange?.(VoiceTurnState.AI, { text: 'Thinking...' });

      let aiRes;
      let aiData;
      try {
        aiRes = await this.fetchFn('/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: stageTranscript })
        });
        aiData = await aiRes.json().catch(() => ({}));
      } catch (networkErr) {
        this.state = VoiceTurnState.AI_ERROR;
        const err = networkErr.message || 'AI network error';
        this.lastError = { stage: 'AI', error: err };
        onStageChange?.(VoiceTurnState.AI_ERROR, { error: err, transcript: stageTranscript });
        return { success: false, stage: VoiceTurnState.AI_ERROR, error: err, transcript: stageTranscript };
      }

      // Check turn identity
      if (this.currentTurnId !== turnId) {
        return { success: false, cancelled: true };
      }

      if (!aiRes.ok || !aiData.success || typeof aiData.response !== 'string' || aiData.response.trim().length === 0) {
        this.state = VoiceTurnState.AI_ERROR;
        const err = aiData.error || 'Failed to process AI request';
        this.lastError = { stage: 'AI', error: err };
        onStageChange?.(VoiceTurnState.AI_ERROR, { error: err, transcript: stageTranscript });
        return { success: false, stage: VoiceTurnState.AI_ERROR, error: err, transcript: stageTranscript };
      }

      stageAiResponse = aiData.response;
      onStageChange?.('AI_SUCCESS', { response: stageAiResponse, transcript: stageTranscript });

      // -----------------------------------------------------------------
      // STEP 3 — TTS
      // -----------------------------------------------------------------
      this.state = VoiceTurnState.TTS;
      onStageChange?.(VoiceTurnState.TTS, { text: 'Generating speech...' });

      let ttsRes;
      try {
        ttsRes = await this.fetchFn('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: stageAiResponse })
        });
      } catch (networkErr) {
        this.state = VoiceTurnState.TTS_ERROR;
        const err = networkErr.message || 'TTS network error';
        this.lastError = { stage: 'TTS', error: err };
        onStageChange?.(VoiceTurnState.TTS_ERROR, { error: err, transcript: stageTranscript, response: stageAiResponse });
        return { success: false, stage: VoiceTurnState.TTS_ERROR, error: err, transcript: stageTranscript, response: stageAiResponse };
      }

      // Check turn identity
      if (this.currentTurnId !== turnId) {
        return { success: false, cancelled: true };
      }

      if (!ttsRes.ok) {
        const errData = await ttsRes.json().catch(() => ({}));
        this.state = VoiceTurnState.TTS_ERROR;
        const err = errData.error || 'Failed to synthesize speech';
        this.lastError = { stage: 'TTS', error: err };
        onStageChange?.(VoiceTurnState.TTS_ERROR, { error: err, transcript: stageTranscript, response: stageAiResponse });
        return { success: false, stage: VoiceTurnState.TTS_ERROR, error: err, transcript: stageTranscript, response: stageAiResponse };
      }

      const durHeader = ttsRes.headers?.get?.('x-tts-duration-ms');
      ttsDurationMs = durHeader ? Number(durHeader) : null;

      try {
        stageAudioBlob = await ttsRes.blob();
      } catch (blobErr) {
        this.state = VoiceTurnState.TTS_ERROR;
        const err = blobErr.message || 'Failed to read audio blob';
        this.lastError = { stage: 'TTS', error: err };
        onStageChange?.(VoiceTurnState.TTS_ERROR, { error: err, transcript: stageTranscript, response: stageAiResponse });
        return { success: false, stage: VoiceTurnState.TTS_ERROR, error: err, transcript: stageTranscript, response: stageAiResponse };
      }

      if (!stageAudioBlob || stageAudioBlob.size === 0) {
        this.state = VoiceTurnState.TTS_ERROR;
        const err = 'Empty audio received';
        this.lastError = { stage: 'TTS', error: err };
        onStageChange?.(VoiceTurnState.TTS_ERROR, { error: err, transcript: stageTranscript, response: stageAiResponse });
        return { success: false, stage: VoiceTurnState.TTS_ERROR, error: err, transcript: stageTranscript, response: stageAiResponse };
      }

      // Check turn identity
      if (this.currentTurnId !== turnId) {
        return { success: false, cancelled: true };
      }

      onStageChange?.('TTS_SUCCESS', { audioBlob: stageAudioBlob, durationMs: ttsDurationMs });

      // -----------------------------------------------------------------
      // STEP 4 — PLAYBACK
      // -----------------------------------------------------------------
      this.state = VoiceTurnState.PLAYING;
      const totalDurationMs = Date.now() - turnStartTime;

      if (typeof playAudioFn === 'function') {
        try {
          await playAudioFn(stageAudioBlob, {
            totalDurationMs,
            sttDurationMs,
            ttsDurationMs
          });
        } catch (playErr) {
          this.state = VoiceTurnState.PLAYBACK_ERROR;
          const err = playErr.message || 'Playback failed';
          this.lastError = { stage: 'PLAYBACK', error: err };
          onStageChange?.(VoiceTurnState.PLAYBACK_ERROR, { error: err });
          return {
            success: false,
            stage: VoiceTurnState.PLAYBACK_ERROR,
            error: err,
            totalDurationMs,
            transcript: stageTranscript,
            response: stageAiResponse
          };
        }
      }

      onStageChange?.(VoiceTurnState.PLAYING, {
        totalDurationMs,
        sttDurationMs,
        ttsDurationMs,
        transcript: stageTranscript,
        response: stageAiResponse
      });

      const turnResult = {
        success: true,
        transcript: stageTranscript,
        response: stageAiResponse,
        audioBlob: stageAudioBlob,
        totalDurationMs,
        sttDurationMs,
        ttsDurationMs
      };

      this.lastResult = turnResult;
      return turnResult;
    } finally {
      this.isBusy = false;
    }
  }
}

export default VoiceTurnRunner;
