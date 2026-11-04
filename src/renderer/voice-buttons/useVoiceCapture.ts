import { useCallback, useEffect, useRef, useState } from 'react';
import { VOICE_MAX_RECORDING_MS } from '../../shared/voice-buttons';
import { composeLivePrompt, resolveDictationLiveText } from '../hooks/useDictation';
import {
  startAppleTranscriptionPcmTap,
  type ApplePcmTap,
} from '../meetings/apple-transcription-pcm';

export type VoiceCaptureStatus = 'idle' | 'connecting' | 'recording' | 'error';

const OPENAI_TRANSLATION_CALLS_URL = 'https://api.openai.com/v1/realtime/translations/calls';
const SILENCE_HOLD_MS = 3_000;
const SPEECH_RMS = 0.04;
const SILENCE_RMS = 0.015;

export interface VoiceCaptureStart {
  silenceStop: boolean;
}

/**
 * Records one take. macOS uses on-device Apple speech when the helper is available.
 * Windows and older Macs use the OpenAI realtime transcript. Audio is not saved.
 */
export function useVoiceCapture(onAutoStop: (transcript: string, audioMs: number) => void) {
  const [status, setStatus] = useState<VoiceCaptureStatus>('idle');
  const [liveText, setLiveText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(() => Array(8).fill(0.15));

  const statusRef = useRef(status);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const baselineRef = useRef('');
  const inputLiveRef = useRef('');
  const outputLiveRef = useRef('');
  const usingAppleRef = useRef(false);
  const pcmTapRef = useRef<ApplePcmTap | null>(null);
  const unsubsRef = useRef<Array<() => void>>([]);
  const startedAtRef = useRef(0);
  const cancelRef = useRef(false);
  const silenceStopRef = useRef(false);
  const heardSpeechRef = useRef(false);
  const silentSinceRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const onAutoStopRef = useRef(onAutoStop);
  statusRef.current = status;
  onAutoStopRef.current = onAutoStop;

  const publish = useCallback(() => {
    const live = resolveDictationLiveText(inputLiveRef.current, outputLiveRef.current);
    setLiveText(composeLivePrompt(baselineRef.current, live));
  }, []);

  const currentTranscript = useCallback(() => {
    const live = resolveDictationLiveText(inputLiveRef.current, outputLiveRef.current);
    return composeLivePrompt(baselineRef.current, live).trim();
  }, []);

  const stopMeters = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }, []);

  const releaseHardware = useCallback(() => {
    stopMeters();
    pcmTapRef.current?.stop();
    pcmTapRef.current = null;
    for (const unsub of unsubsRef.current) unsub();
    unsubsRef.current = [];
    peerRef.current?.close();
    peerRef.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (usingAppleRef.current) {
      usingAppleRef.current = false;
      void window.electronAPI?.voiceButtons?.appleStop().catch(() => undefined);
    }
  }, [stopMeters]);

  useEffect(() => () => releaseHardware(), [releaseHardware]);

  const watchLevels = useCallback(
    (stream: MediaStream) => {
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const bins = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(bins);
        let sum = 0;
        for (let i = 0; i < bins.length; i += 1) {
          const sample = (bins[i] - 128) / 128;
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / bins.length);
        if (rms > SPEECH_RMS) {
          heardSpeechRef.current = true;
          silentSinceRef.current = null;
        } else if (heardSpeechRef.current && rms < SILENCE_RMS) {
          silentSinceRef.current = silentSinceRef.current ?? Date.now();
        }
        const bars = Array.from({ length: 8 }, (_, index) => {
          const start = Math.floor((index / 8) * bins.length);
          const end = Math.floor(((index + 1) / 8) * bins.length);
          let energy = 0;
          for (let i = start; i < end; i += 1) energy += Math.abs(bins[i] - 128);
          const avg = energy / Math.max(1, end - start) / 64;
          return Math.max(0.12, Math.min(1, avg));
        });
        setLevels(bars);
        if (
          silenceStopRef.current &&
          silentSinceRef.current &&
          Date.now() - silentSinceRef.current > SILENCE_HOLD_MS &&
          statusRef.current === 'recording'
        ) {
          const transcript = currentTranscript();
          const audioMs = Date.now() - startedAtRef.current;
          releaseHardware();
          setStatus('idle');
          onAutoStopRef.current(transcript, audioMs);
          return;
        }
        rafRef.current = window.requestAnimationFrame(tick);
      };
      rafRef.current = window.requestAnimationFrame(tick);
    },
    [currentTranscript, releaseHardware]
  );

  const beginApple = useCallback(
    async (stream: MediaStream) => {
      unsubsRef.current.push(
        window.electronAPI.dictation.onApplePartial(({ text }) => {
          const trimmed = text.trim();
          if (!trimmed) return;
          inputLiveRef.current = trimmed;
          outputLiveRef.current = '';
          publish();
        }),
        window.electronAPI.dictation.onAppleFinal(({ text }) => {
          const trimmed = text.trim();
          if (!trimmed) return;
          inputLiveRef.current = '';
          baselineRef.current = composeLivePrompt(baselineRef.current, trimmed);
          publish();
        }),
        window.electronAPI.dictation.onAppleError(({ message }) => {
          setError(message || 'Speech recognition failed.');
          setStatus('error');
        })
      );
      await window.electronAPI.voiceButtons.appleStart();
      usingAppleRef.current = true;
      pcmTapRef.current = await startAppleTranscriptionPcmTap(stream, (pcm) => {
        window.electronAPI.dictation.appleTranscription.pushPcm(pcm);
      });
    },
    [publish]
  );

  const beginOpenAi = useCallback(
    async (stream: MediaStream) => {
      const { clientSecret } = await window.electronAPI.dictation.createRealtimeSession({
        targetLanguage: 'en',
      });
      if (cancelRef.current) return;
      const pc = new RTCPeerConnection();
      peerRef.current = pc;
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
      const events = pc.createDataChannel('oai-events');
      events.onmessage = (message) => {
        if (typeof message.data !== 'string') return;
        try {
          const event = JSON.parse(message.data) as { type?: string; delta?: string };
          if (event.type === 'session.input_transcript.delta' && event.delta) {
            inputLiveRef.current += event.delta;
            publish();
          } else if (event.type === 'session.output_transcript.delta' && event.delta) {
            outputLiveRef.current += event.delta;
            publish();
          }
        } catch {
          // Ignore malformed realtime events.
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
          return;
        }
        const onChange = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', onChange);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', onChange);
        window.setTimeout(() => {
          pc.removeEventListener('icegatheringstatechange', onChange);
          resolve();
        }, 2500);
      });
      if (cancelRef.current) return;
      const response = await fetch(OPENAI_TRANSLATION_CALLS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: pc.localDescription?.sdp ?? '',
      });
      if (!response.ok) throw new Error('Could not start speech recognition.');
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    },
    [publish]
  );

  const begin = useCallback(
    async (options: VoiceCaptureStart) => {
      if (statusRef.current === 'recording' || statusRef.current === 'connecting') return;
      cancelRef.current = false;
      silenceStopRef.current = options.silenceStop;
      heardSpeechRef.current = false;
      silentSinceRef.current = null;
      baselineRef.current = '';
      inputLiveRef.current = '';
      outputLiveRef.current = '';
      setLiveText('');
      setError(null);
      setStatus('connecting');
      try {
        const permission = await window.electronAPI.meetings.requestMicrophoneAccess();
        if (permission.permissions.microphone === 'denied') {
          throw new Error('Microphone access is off. Allow it in system settings.');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        if (cancelRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          setStatus('idle');
          return;
        }
        streamRef.current = stream;
        let liveStream = stream;
        const stt = await window.electronAPI.meetings.getSttProviderConfig();
        const useApple = window.electronAPI.platform === 'darwin' && stt.appleSupported;
        if (useApple) {
          try {
            await window.electronAPI.meetings.requestAppleSpeechAccess();
            await beginApple(liveStream);
          } catch (appleError) {
            console.warn('[VoiceButtons] Apple speech failed, using OpenAI', appleError);
            releaseHardware();
            liveStream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
              video: false,
            });
            streamRef.current = liveStream;
            await beginOpenAi(liveStream);
          }
        } else {
          await beginOpenAi(liveStream);
        }
        if (cancelRef.current) {
          releaseHardware();
          setStatus('idle');
          return;
        }
        startedAtRef.current = Date.now();
        setStatus('recording');
        watchLevels(liveStream);
        timerRef.current = window.setTimeout(() => {
          if (statusRef.current !== 'recording') return;
          const transcript = currentTranscript();
          const audioMs = Date.now() - startedAtRef.current;
          releaseHardware();
          setStatus('idle');
          onAutoStopRef.current(transcript, audioMs);
        }, VOICE_MAX_RECORDING_MS);
      } catch (caught) {
        releaseHardware();
        const message = caught instanceof Error ? caught.message : 'Could not start dictation.';
        setError(message);
        setStatus('error');
      }
    },
    [beginApple, beginOpenAi, currentTranscript, releaseHardware, watchLevels]
  );

  const end = useCallback(async (): Promise<{ transcript: string; audioMs: number }> => {
    const audioMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
    if (usingAppleRef.current) {
      await window.electronAPI.voiceButtons.appleStop().catch(() => undefined);
      usingAppleRef.current = false;
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
    const transcript = currentTranscript();
    releaseHardware();
    setStatus('idle');
    return { transcript, audioMs };
  }, [currentTranscript, releaseHardware]);

  const discard = useCallback(() => {
    cancelRef.current = true;
    releaseHardware();
    baselineRef.current = '';
    inputLiveRef.current = '';
    outputLiveRef.current = '';
    setLiveText('');
    setStatus('idle');
  }, [releaseHardware]);

  return { status, liveText, error, levels, begin, end, discard };
}
