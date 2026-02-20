'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

export type VoiceRecordingState = 'idle' | 'warming_up' | 'recording' | 'transcribing';

interface UseVoiceRecordingOptions {
  onTranscript?: (text: string) => void;
  onError?: (error: string) => void;
}

interface UseVoiceRecordingReturn {
  state: VoiceRecordingState;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  cancelRecording: () => void;
  isSupported: boolean;
  analyser: AnalyserNode | null;
  recordingStartTime: number | null;
}

export function useVoiceRecording({
  onTranscript,
  onError,
}: UseVoiceRecordingOptions = {}): UseVoiceRecordingReturn {
  const [state, setState] = useState<VoiceRecordingState>('idle');
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const highpassRef = useRef<BiquadFilterNode | null>(null);
  const lowpassRef = useRef<BiquadFilterNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const cancelledRef = useRef(false);

  // Check browser support after mount to avoid SSR hydration mismatch
  // (server returns false, client returns true → different DOM → radix-ui crash)
  const [isSupported, setIsSupported] = useState(false);
  useEffect(() => {
    setIsSupported(
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    );
  }, []);

  const cleanup = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
    if (highpassRef.current) {
      highpassRef.current.disconnect();
      highpassRef.current = null;
    }
    if (lowpassRef.current) {
      lowpassRef.current.disconnect();
      lowpassRef.current = null;
    }
    if (compressorRef.current) {
      compressorRef.current.disconnect();
      compressorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setAnalyser(null);
    setRecordingStartTime(null);
  }, [setAnalyser, setRecordingStartTime]);

  const transcribeAudio = useCallback(
    async (audioBlob: Blob) => {
      setState('transcribing');

      try {
        // Use FileReader for efficient native base64 encoding
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result as string;
            // Strip the data URL prefix (e.g., "data:audio/webm;base64,")
            const base64Data = dataUrl.split(',')[1];
            resolve(base64Data);
          };
          reader.onerror = reject;
          reader.readAsDataURL(audioBlob);
        });

        // Send to transcription API
        const response = await fetch('/api/speech/transcribe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ audio: base64 }),
        });

        if (!response.ok) {
          const errData = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(errData.error || 'Transcription failed');
        }

        const data = (await response.json()) as { text?: string };
        const text = data.text?.trim();

        if (text) {
          onTranscript?.(text);
        }
      } catch (e) {
        console.error('[useVoiceRecording] Transcription error:', e);
        onError?.(e instanceof Error ? e.message : 'Transcription failed');
      } finally {
        setState('idle');
      }
    },
    [onTranscript, onError]
  );

  const startRecording = useCallback(async () => {
    if (!isSupported) {
      onError?.('Voice recording is not supported in this browser');
      return;
    }

    try {
      setState('warming_up');
      cancelledRef.current = false;

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // Use AudioContext + AnalyserNode to detect when audio is actually flowing
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;

      const highpass = audioContext.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 120;
      highpass.Q.value = 0.707;

      const lowpass = audioContext.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 4000;
      lowpass.Q.value = 0.707;

      const compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.value = -40;
      compressor.knee.value = 20;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.2;

      analyserRef.current = analyser;
      sourceRef.current = source;
      highpassRef.current = highpass;
      lowpassRef.current = lowpass;
      compressorRef.current = compressor;
      setAnalyser(analyser);

      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(compressor);
      compressor.connect(analyser);

      // Wait for actual audio signal (not silence) with timeout
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const warmUpResult = await new Promise<'signal' | 'timeout' | 'cancelled'>((resolve) => {
        const timeoutId = setTimeout(() => resolve('timeout'), 5000);
        const checkAudio = () => {
          if (cancelledRef.current) {
            clearTimeout(timeoutId);
            resolve('cancelled');
            return;
          }
          analyser.getByteFrequencyData(dataArray);
          const hasSignal = dataArray.some((v) => v > 0);
          if (hasSignal) {
            clearTimeout(timeoutId);
            resolve('signal');
          } else {
            requestAnimationFrame(checkAudio);
          }
        };
        checkAudio();
      });
      if (warmUpResult === 'cancelled') {
        cleanup();
        setState('idle');
        return;
      }

      if (cancelledRef.current) {
        cleanup();
        setState('idle');
        return;
      }

      if (warmUpResult === 'timeout') {
        // Proceed anyway after timeout - mic might be very quiet
        console.warn('[useVoiceRecording] Warm-up timeout, proceeding anyway');
      }

      // Determine best audio format - prefer opus for smaller files
      let mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'audio/mp4';
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = ''; // Let browser choose
          }
        }
      }

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
        audioBitsPerSecond: 16000, // Whisper resamples to 16kHz anyway
      });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (cancelledRef.current) {
          cleanup();
          setState('idle');
          return;
        }

        const audioBlob = new Blob(chunksRef.current, {
          type: mediaRecorder.mimeType || 'audio/webm',
        });
        cleanup();

        // Only transcribe if we have audio data
        if (audioBlob.size > 0) {
          await transcribeAudio(audioBlob);
        } else {
          setState('idle');
        }
      };

      mediaRecorder.onerror = () => {
        cleanup();
        setState('idle');
        onError?.('Recording failed');
      };

      // Only show recording state once MediaRecorder is actually capturing
      mediaRecorder.onstart = () => {
        setRecordingStartTime(Date.now());
        setState('recording');
      };

      // Start recording - collect data every 250ms for smoother stop
      mediaRecorder.start(250);
    } catch (e) {
      cleanup();
      setState('idle');

      if (e instanceof DOMException) {
        if (e.name === 'NotAllowedError') {
          onError?.('Microphone access denied');
        } else if (e.name === 'NotFoundError') {
          onError?.('No microphone found');
        } else {
          onError?.(e.message);
        }
      } else {
        onError?.('Failed to start recording');
      }
    }
  }, [isSupported, cleanup, transcribeAudio, onError]);

  const stopRecording = useCallback(() => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === 'recording'
    ) {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    cleanup();
    setState('idle');
  }, [cleanup]);

  return {
    state,
    startRecording,
    stopRecording,
    cancelRecording,
    isSupported,
    analyser,
    recordingStartTime,
  };
}
