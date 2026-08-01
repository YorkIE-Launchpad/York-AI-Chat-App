import { useCallback, useEffect, useRef, useState } from 'react';

export type DictationStatus = 'idle' | 'connecting' | 'recording' | 'error';

export type DictationErrorKind = 'mic_denied' | 'sign_in' | 'unsupported' | 'failed' | null;

const OPENAI_TRANSLATION_CALLS_URL = 'https://api.openai.com/v1/realtime/translations/calls';

/** Combine frozen baseline prompt with live translated transcript. */
export function composeLivePrompt(baseline: string, live: string): string {
  const liveText = live.trimStart();
  if (!liveText) {
    return baseline;
  }
  const base = baseline.trimEnd();
  if (!base) {
    return liveText;
  }
  return `${base} ${liveText}`;
}

const DEVANAGARI_RE = /[\u0900-\u097F]/;
const GUJARATI_RE = /[\u0A80-\u0AFF]/;

/** True when source transcript contains Hindi (Devanagari) or Gujarati script. */
export function hasIndicScript(text: string): boolean {
  return DEVANAGARI_RE.test(text) || GUJARATI_RE.test(text);
}

/**
 * Prefer Indian English / English input transcript; use English output translation
 * when the source contains Hindi or Gujarati script (or input is empty).
 */
export function resolveDictationLiveText(inputLive: string, outputLive: string): string {
  const input = inputLive.trim();
  if (input && hasIndicScript(input)) {
    return outputLive.trim() ? outputLive : inputLive;
  }
  if (input) {
    return inputLive;
  }
  return outputLive;
}

async function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return;
  }
  await new Promise<void>((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    // Fallback if gathering never fires (some Electron builds).
    window.setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }, 3000);
  });
}

export interface UseDictationOptions {
  enabled?: boolean;
  onTranscript: (text: string) => void;
  getPrompt?: () => string;
}

export interface UseDictationResult {
  status: DictationStatus;
  errorKind: DictationErrorKind;
  isAvailable: boolean;
  toggle: () => void;
  stop: () => void;
}

/**
 * Live chat dictation via OpenAI gpt-realtime-translate (WebRTC) + York-minted client secret.
 */
export function useDictation({
  enabled = true,
  onTranscript,
  getPrompt,
}: UseDictationOptions): UseDictationResult {
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [errorKind, setErrorKind] = useState<DictationErrorKind>(null);

  const statusRef = useRef(status);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const baselineRef = useRef('');
  const inputLiveRef = useRef('');
  const outputLiveRef = useRef('');
  const onTranscriptRef = useRef(onTranscript);
  const getPromptRef = useRef(getPrompt);
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);

  statusRef.current = status;
  onTranscriptRef.current = onTranscript;
  getPromptRef.current = getPrompt;

  const isAvailable =
    enabled &&
    typeof window !== 'undefined' &&
    window.electronAPI?.dictation?.createRealtimeSession !== undefined &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof RTCPeerConnection !== 'undefined';

  const cleanupSession = useCallback(() => {
    const peer = peerRef.current;
    peerRef.current = null;
    if (peer) {
      try {
        peer.close();
      } catch {
        // ignore
      }
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      cleanupSession();
    };
  }, [cleanupSession]);

  const publishLivePrompt = useCallback(() => {
    const live = resolveDictationLiveText(inputLiveRef.current, outputLiveRef.current);
    onTranscriptRef.current(composeLivePrompt(baselineRef.current, live));
  }, []);

  const handleRealtimeEvent = useCallback(
    (raw: string) => {
      let event: { type?: string; delta?: string };
      try {
        event = JSON.parse(raw) as { type?: string; delta?: string };
      } catch {
        return;
      }
      if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
        inputLiveRef.current += event.delta;
        publishLivePrompt();
        return;
      }
      if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
        outputLiveRef.current += event.delta;
        publishLivePrompt();
      }
    },
    [publishLivePrompt]
  );

  const stopSession = useCallback(() => {
    cancelledRef.current = true;
    startingRef.current = false;
    cleanupSession();
    setStatus('idle');
  }, [cleanupSession]);

  const startSession = useCallback(async () => {
    if (!isAvailable || startingRef.current) {
      if (!isAvailable) {
        setErrorKind('unsupported');
        setStatus('error');
      }
      return;
    }

    startingRef.current = true;
    cancelledRef.current = false;
    setErrorKind(null);
    setStatus('connecting');
    baselineRef.current = getPromptRef.current?.() ?? '';
    inputLiveRef.current = '';
    outputLiveRef.current = '';

    try {
      const permissionResult = await window.electronAPI.meetings.requestMicrophoneAccess();
      if (cancelledRef.current) {
        return;
      }
      if (permissionResult.permissions.microphone === 'denied') {
        setErrorKind('mic_denied');
        setStatus('error');
        return;
      }

      const { clientSecret } = await window.electronAPI.dictation.createRealtimeSession({
        targetLanguage: 'en',
      });
      if (cancelledRef.current) {
        return;
      }
      if (!clientSecret) {
        throw new Error('Missing realtime client secret');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (cancelledRef.current) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }

      const pc = new RTCPeerConnection();
      streamRef.current = stream;
      peerRef.current = pc;

      for (const track of stream.getAudioTracks()) {
        pc.addTrack(track, stream);
      }

      // Do not play translated speech — dictation only writes into the prompt.
      pc.ontrack = () => {
        // intentionally ignore remote audio
      };

      const events = pc.createDataChannel('oai-events');
      events.onmessage = (message) => {
        if (typeof message.data === 'string') {
          handleRealtimeEvent(message.data);
        }
      };

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected' ||
          pc.connectionState === 'closed'
        ) {
          const current = statusRef.current;
          if (current === 'recording' || current === 'connecting') {
            cleanupSession();
            if (pc.connectionState === 'failed') {
              setErrorKind('failed');
              setStatus('error');
            } else {
              setStatus('idle');
            }
          }
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      if (cancelledRef.current) {
        cleanupSession();
        return;
      }

      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) {
        throw new Error('Failed to create WebRTC offer');
      }

      const sdpResponse = await fetch(OPENAI_TRANSLATION_CALLS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: localSdp,
      });

      if (!sdpResponse.ok) {
        const errText = await sdpResponse.text();
        throw new Error(errText || `Realtime call failed (${sdpResponse.status})`);
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (cancelledRef.current) {
        cleanupSession();
        return;
      }

      setStatus('recording');
    } catch (error) {
      cleanupSession();
      if (cancelledRef.current) {
        setStatus('idle');
        return;
      }
      const name = error instanceof DOMException ? error.name : '';
      const message = error instanceof Error ? error.message : String(error);
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setErrorKind('mic_denied');
      } else if (/sign in/i.test(message)) {
        setErrorKind('sign_in');
      } else {
        setErrorKind('failed');
      }
      setStatus('error');
    } finally {
      startingRef.current = false;
    }
  }, [cleanupSession, handleRealtimeEvent, isAvailable]);

  const stop = useCallback(() => {
    if (statusRef.current === 'recording' || statusRef.current === 'connecting') {
      stopSession();
      return;
    }
    cleanupSession();
    setStatus('idle');
  }, [cleanupSession, stopSession]);

  const toggle = useCallback(() => {
    if (statusRef.current === 'connecting') {
      return;
    }
    if (statusRef.current === 'recording') {
      stopSession();
      return;
    }
    void startSession();
  }, [startSession, stopSession]);

  return {
    status,
    errorKind,
    isAvailable,
    toggle,
    stop,
  };
}
