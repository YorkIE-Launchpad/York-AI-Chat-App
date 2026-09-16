const TARGET_SAMPLE_RATE = 16_000;

function downsampleToPcm16(input: Float32Array, inputSampleRate: number): Int16Array {
  if (input.length === 0) {
    return new Int16Array(0);
  }
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);
  let offset = 0;
  for (let i = 0; i < outputLength; i += 1) {
    const nextOffset = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = offset; j < nextOffset; j += 1) {
      sum += input[j];
      count += 1;
    }
    offset = nextOffset;
    const sample = count > 0 ? sum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

export interface ApplePcmTap {
  stop(): void;
}

/**
 * Tap a MediaStream, resample to 16 kHz mono PCM16, and push chunks to main.
 */
export async function startAppleTranscriptionPcmTap(
  stream: MediaStream,
  onPcmChunk: (pcm: ArrayBuffer) => void
): Promise<ApplePcmTap> {
  const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  source.connect(processor);
  // Must reach destination so onaudioprocess fires in Chromium/Electron.
  processor.connect(audioContext.destination);

  processor.onaudioprocess = (event) => {
    const channel = event.inputBuffer.getChannelData(0);
    const pcm = downsampleToPcm16(channel, audioContext.sampleRate);
    if (pcm.length === 0) {
      return;
    }
    const chunk = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
    onPcmChunk(chunk as ArrayBuffer);
  };

  return {
    stop() {
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
      void audioContext.close().catch(() => undefined);
    },
  };
}
