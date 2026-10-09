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
      audioDurationMs: inputAudioDurationMs,
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

    const turnStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    let stageTranscript = null;
    let stageAiResponse = null;
    let stageAudioBlob = null;
    let sttDurationMs = null;
    let clientSttDurationMs = null;
    let serverSttDurationMs = null;
    let providerSttDurationMs = null;
    let audioDurationMs = null;
    let audioSizeBytes = null;
    let audioMimeType = null;
    let aiDurationMs = null;
    let clientAiDurationMs = null;
    let serverAiDurationMs = null;
    let providerDurationMs = null;
    let ttsDurationMs = null;

    try {
      // -----------------------------------------------------------------
      // STEP 1 — STT
      // -----------------------------------------------------------------
      this.state = VoiceTurnState.STT;
      onStageChange?.(VoiceTurnState.STT, { text: 'Transcribing...' });

      const sttStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

      let sttRes;
      let sttData;
      try {
        const formData = new FormData();
        const filename = audioBlob.type && audioBlob.type.includes('ogg') ? 'recording.ogg' : 'recording.webm';
        formData.append('audio', audioBlob, filename);

        const durationToSend = typeof inputAudioDurationMs === 'number'
          ? inputAudioDurationMs
          : (typeof audioBlob.durationMs === 'number' ? audioBlob.durationMs : null);

        if (typeof durationToSend === 'number') {
          formData.append('audioDurationMs', String(durationToSend));
        }

        const headers = {};
        if (typeof durationToSend === 'number') {
          headers['X-Audio-Duration-Ms'] = String(durationToSend);
        }

        sttRes = await this.fetchFn('/api/stt', {
          method: 'POST',
          headers,
          body: formData
        });
        sttData = await sttRes.json().catch(() => ({}));
        clientSttDurationMs = Math.max(0, Math.round(((typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now()) - sttStartTime));
      } catch (networkErr) {
        clientSttDurationMs = Math.max(0, Math.round(((typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now()) - sttStartTime));
        this.state = VoiceTurnState.STT_ERROR;
        const err = networkErr.message || 'STT network error';
        this.lastError = { stage: 'STT', error: err, clientSttDurationMs };
        onStageChange?.(VoiceTurnState.STT_ERROR, { error: err, clientSttDurationMs });
        return { success: false, stage: VoiceTurnState.STT_ERROR, error: err, clientSttDurationMs };
      }

      serverSttDurationMs = sttData.timing?.serverSttDurationMs ?? (typeof sttData.serverSttDurationMs === 'number' ? sttData.serverSttDurationMs : null);
      providerSttDurationMs = sttData.timing?.providerSttDurationMs ?? (typeof sttData.providerSttDurationMs === 'number' ? sttData.providerSttDurationMs : null);
      audioDurationMs = sttData.audioDurationMs ?? sttData.audio?.audioDurationMs ?? (typeof inputAudioDurationMs === 'number' ? inputAudioDurationMs : (typeof audioBlob.durationMs === 'number' ? audioBlob.durationMs : null));
      audioSizeBytes = sttData.audioSizeBytes ?? sttData.audio?.audioSizeBytes ?? (typeof audioSize === 'number' ? audioSize : audioBlob.size);
      audioMimeType = sttData.audioMimeType ?? sttData.audio?.audioMimeType ?? audioBlob.type ?? 'audio/webm';

      // Check turn identity
      if (this.currentTurnId !== turnId) {
        return { success: false, cancelled: true };
      }

      const rawTranscript = sttData.text || sttData.transcript;
      if (!sttRes.ok || !sttData.success || typeof rawTranscript !== 'string' || rawTranscript.trim().length === 0) {
        this.state = VoiceTurnState.STT_ERROR;
        const err = sttData.error || 'Transcription failed';
        this.lastError = {
          stage: 'STT',
          error: err,
          clientSttDurationMs,
          serverSttDurationMs,
          providerSttDurationMs,
          audioDurationMs,
          audioSizeBytes,
          audioMimeType
        };
        onStageChange?.(VoiceTurnState.STT_ERROR, {
          error: err,
          clientSttDurationMs,
          serverSttDurationMs,
          providerSttDurationMs,
          audioDurationMs,
          audioSizeBytes,
          audioMimeType
        });
        return {
          success: false,
          stage: VoiceTurnState.STT_ERROR,
          error: err,
          clientSttDurationMs,
          serverSttDurationMs,
          providerSttDurationMs,
          audioDurationMs,
          audioSizeBytes,
          audioMimeType
        };
      }

      stageTranscript = rawTranscript;
      sttDurationMs = typeof sttData.durationMs === 'number' ? sttData.durationMs : clientSttDurationMs;
      onStageChange?.('STT_SUCCESS', {
        transcript: stageTranscript,
        durationMs: clientSttDurationMs,
        sttDurationMs,
        clientSttDurationMs,
        serverSttDurationMs,
        providerSttDurationMs,
        audioDurationMs,
        audioSizeBytes,
        audioMimeType
      });

      // -----------------------------------------------------------------
      // STEP 2 — AI
      // -----------------------------------------------------------------
      this.state = VoiceTurnState.AI;
      onStageChange?.(VoiceTurnState.AI, { text: 'Thinking...' });

      const aiStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

      let aiRes;
      let aiData;
      try {
        aiRes = await this.fetchFn('/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: stageTranscript })
        });
        aiData = await aiRes.json().catch(() => ({}));
        clientAiDurationMs = Math.max(0, Math.round(((typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now()) - aiStartTime));
      } catch (networkErr) {
        clientAiDurationMs = Math.max(0, Math.round(((typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now()) - aiStartTime));
        this.state = VoiceTurnState.AI_ERROR;
        const err = networkErr.message || 'AI network error';
        this.lastError = { stage: 'AI', error: err, clientAiDurationMs };
        onStageChange?.(VoiceTurnState.AI_ERROR, { error: err, transcript: stageTranscript, clientAiDurationMs });
        return { success: false, stage: VoiceTurnState.AI_ERROR, error: err, transcript: stageTranscript, clientAiDurationMs };
      }

      // Check turn identity
      if (this.currentTurnId !== turnId) {
        return { success: false, cancelled: true };
      }

      if (!aiRes.ok || !aiData.success || typeof aiData.response !== 'string' || aiData.response.trim().length === 0) {
        this.state = VoiceTurnState.AI_ERROR;
        const err = aiData.error || 'Failed to process AI request';
        this.lastError = { stage: 'AI', error: err, clientAiDurationMs };
        onStageChange?.(VoiceTurnState.AI_ERROR, { error: err, transcript: stageTranscript, clientAiDurationMs });
        return { success: false, stage: VoiceTurnState.AI_ERROR, error: err, transcript: stageTranscript, clientAiDurationMs };
      }

      stageAiResponse = aiData.response;
      serverAiDurationMs = aiData.timing?.serverAiDurationMs ?? (typeof aiData.serverAiDurationMs === 'number' ? aiData.serverAiDurationMs : null);
      providerDurationMs = aiData.timing?.providerDurationMs ?? (typeof aiData.providerDurationMs === 'number' ? aiData.providerDurationMs : null);
      aiDurationMs = clientAiDurationMs;

      onStageChange?.('AI_SUCCESS', {
        response: stageAiResponse,
        transcript: stageTranscript,
        durationMs: aiDurationMs,
        aiDurationMs,
        clientAiDurationMs,
        serverAiDurationMs,
        providerDurationMs
      });

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
      const totalDurationMs = Math.max(0, Math.round(((typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now()) - turnStartTime));

      if (typeof playAudioFn === 'function') {
        try {
          await playAudioFn(stageAudioBlob, {
            totalDurationMs,
            sttDurationMs,
            clientSttDurationMs,
            serverSttDurationMs,
            providerSttDurationMs,
            audioDurationMs,
            audioSizeBytes,
            audioMimeType,
            aiDurationMs,
            clientAiDurationMs,
            serverAiDurationMs,
            providerDurationMs,
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
            sttDurationMs,
            clientSttDurationMs,
            serverSttDurationMs,
            providerSttDurationMs,
            audioDurationMs,
            audioSizeBytes,
            audioMimeType,
            aiDurationMs,
            clientAiDurationMs,
            serverAiDurationMs,
            providerDurationMs,
            ttsDurationMs,
            transcript: stageTranscript,
            response: stageAiResponse
          };
        }
      }

      onStageChange?.(VoiceTurnState.PLAYING, {
        totalDurationMs,
        sttDurationMs,
        clientSttDurationMs,
        serverSttDurationMs,
        providerSttDurationMs,
        audioDurationMs,
        audioSizeBytes,
        audioMimeType,
        aiDurationMs,
        clientAiDurationMs,
        serverAiDurationMs,
        providerDurationMs,
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
        clientSttDurationMs,
        serverSttDurationMs,
        providerSttDurationMs,
        audioDurationMs,
        audioSizeBytes,
        audioMimeType,
        aiDurationMs,
        clientAiDurationMs,
        serverAiDurationMs,
        providerDurationMs,
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
