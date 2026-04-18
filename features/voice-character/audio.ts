import type { MutableRefObject } from "react";
import { AudioContext, OfflineAudioContext } from "react-native-audio-api";

import {
  CONTINUE_VOICE_THRESHOLD,
  DETUNE_CENTS,
  LEADING_VOICE_WINDOW_SIZE,
} from "./constants";

export function findLeadingVoiceOffset(audioData: Float32Array) {
  if (audioData.length === 0) {
    return 0;
  }

  for (
    let start = 0;
    start < audioData.length;
    start += LEADING_VOICE_WINDOW_SIZE
  ) {
    const end = Math.min(start + LEADING_VOICE_WINDOW_SIZE, audioData.length);
    const rms = getRms(audioData.subarray(start, end));
    if (rms >= CONTINUE_VOICE_THRESHOLD) {
      return start;
    }
  }

  return 0;
}

export function getRms(audioData: Float32Array) {
  let sumSquares = 0;

  for (let index = 0; index < audioData.length; index += 1) {
    const sample = audioData[index];
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / Math.max(audioData.length, 1));
}

export function clearTimeoutRef(
  timeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  if (!timeoutRef.current) {
    return;
  }

  clearTimeout(timeoutRef.current);
  timeoutRef.current = null;
}

export async function renderDetunedBuffer(
  sourceBuffer: ReturnType<AudioContext["createBuffer"]>,
  framesToKeep: number,
  sampleRate: number,
) {
  const offlineCtx = new OfflineAudioContext({
    numberOfChannels: sourceBuffer.numberOfChannels,
    length: framesToKeep,
    sampleRate,
  });
  const offlineBuffer = offlineCtx.createBuffer(
    sourceBuffer.numberOfChannels,
    framesToKeep,
    sampleRate,
  );

  for (let channel = 0; channel < sourceBuffer.numberOfChannels; channel += 1) {
    offlineBuffer.copyToChannel(sourceBuffer.getChannelData(channel), channel);
  }

  const offlineSource = offlineCtx.createBufferSource({
    pitchCorrection: true,
  });
  offlineSource.buffer = offlineBuffer;
  offlineSource.detune.value = DETUNE_CENTS;
  offlineSource.connect(offlineCtx.destination);
  offlineSource.start();

  return offlineCtx.startRendering();
}

export function applyHighPass(
  input: Float32Array,
  sampleRate: number,
  cutoffHz: number,
): Float32Array {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = rc / (rc + dt); // ~0.982 at 150 Hz / 44100 Hz

  const output = new Float32Array(input.length);
  let prev_in = 0;
  let prev_out = 0;

  for (let i = 0; i < input.length; i++) {
    output[i] = alpha * (prev_out + input[i] - prev_in);
    prev_in = input[i];
    prev_out = output[i];
  }

  return output;
}
