import {
  Fit,
  RiveView,
  useRive,
  useRiveFile,
  useRiveNumber,
  useViewModelInstance,
} from "@rive-app/react-native";
import React, { useCallback, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import {
  AudioContext,
  AudioManager,
  AudioRecorder,
} from "react-native-audio-api";

AudioManager.setAudioSessionOptions({
  iosCategory: "playAndRecord",
  iosMode: "default",
  iosOptions: ["defaultToSpeaker"],
});

const VOLUME_THRESHOLD = 0.02;
const SILENCE_TIMEOUT_MS = 1000;
const END_PADDING_MS = 120;
const RESUME_GUARD_MS = 250;
const DETUNE_CENTS = 700;
const MONITOR_BUFFER_LENGTH = 1024;
const MONITOR_CHANNEL_COUNT = 1;

type CharacterState = "idle" | "listening" | "playing";

const STATE_INDEX: Record<CharacterState, number> = {
  idle: 0,
  listening: 1,
  playing: 2,
};

type AudioChunkHandler = Parameters<AudioRecorder["onAudioReady"]>[1];

export default function VoiceCharacter() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { riveFile } = useRiveFile(require("../assets/rive/hear_and_talk.riv"));
  const { riveViewRef, setHybridRef } = useRive();

  const { instance: viewModelInstance } = useViewModelInstance(riveFile, {
    onInit: (instance) =>
      instance.numberProperty("state")?.set(STATE_INDEX.idle),
  });

  const { setValue: setRiveState } = useRiveNumber("state", viewModelInstance);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const playbackSourceRef = useRef<ReturnType<
    AudioContext["createBufferSource"]
  > | null>(null);
  const stateRef = useRef<CharacterState>("idle");
  const chunksRef = useRef<Float32Array[]>([]);
  const recordedFramesRef = useRef(0);
  const lastVoiceFrameRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const ignoreInputUntilRef = useRef(0);

  const setState = useCallback(
    (next: CharacterState) => {
      stateRef.current = next;
      setRiveState(STATE_INDEX[next]);
      riveViewRef?.play();
    },
    [riveViewRef, setRiveState],
  );

  const clearRecordingBuffer = useCallback(() => {
    chunksRef.current = [];
    recordedFramesRef.current = 0;
    lastVoiceFrameRef.current = 0;
    lastVoiceAtRef.current = 0;
  }, []);

  const pauseMonitoring = useCallback(() => {
    const recorder = recorderRef.current;

    if (!recorder || !recorder.isRecording()) {
      return;
    }

    recorder.pause();
  }, []);

  const resumeMonitoring = useCallback(() => {
    const recorder = recorderRef.current;

    if (!recorder || !recorder.isPaused()) {
      return;
    }

    recorder.resume();
  }, []);

  const finishPlayback = useCallback(() => {
    playbackSourceRef.current = null;
    clearRecordingBuffer();
    ignoreInputUntilRef.current = Date.now() + RESUME_GUARD_MS;
    resumeMonitoring();
    setState("idle");
  }, [clearRecordingBuffer, resumeMonitoring, setState]);

  const playBufferedSpeech = useCallback(async () => {
    const ctx = audioCtxRef.current;

    if (!ctx || recordedFramesRef.current === 0) {
      clearRecordingBuffer();
      setState("idle");
      return;
    }

    try {
      const paddingFrames = Math.floor(
        (ctx.sampleRate * END_PADDING_MS) / 1000,
      );
      const framesToKeep = Math.min(
        recordedFramesRef.current,
        Math.max(1, lastVoiceFrameRef.current + paddingFrames),
      );
      const playbackBuffer = ctx.createBuffer(
        MONITOR_CHANNEL_COUNT,
        framesToKeep,
        ctx.sampleRate,
      );
      const output = playbackBuffer.getChannelData(0);

      let writeOffset = 0;

      for (const chunk of chunksRef.current) {
        if (writeOffset >= framesToKeep) {
          break;
        }

        const frames = Math.min(chunk.length, framesToKeep - writeOffset);
        output.set(chunk.subarray(0, frames), writeOffset);
        writeOffset += frames;
      }

      if (writeOffset === 0) {
        clearRecordingBuffer();
        setState("idle");
        return;
      }

      pauseMonitoring();
      setState("playing");

      await ctx.resume();

      const source = ctx.createBufferSource({ pitchCorrection: true });
      source.buffer = playbackBuffer;
      source.detune.value = DETUNE_CENTS;
      source.connect(ctx.destination);
      source.onEnded = finishPlayback;

      playbackSourceRef.current = source;
      source.start();
    } catch (error) {
      console.error("playBufferedSpeech error:", error);
      finishPlayback();
    }
  }, [clearRecordingBuffer, finishPlayback, pauseMonitoring, setState]);

  const handleAudioChunk = useCallback<AudioChunkHandler>(
    (event) => {
      if (Date.now() < ignoreInputUntilRef.current) {
        return;
      }

      if (stateRef.current === "playing") {
        return;
      }

      const chunk = new Float32Array(event.numFrames);
      event.buffer.copyFromChannel(chunk, 0);

      let sumSquares = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        const sample = chunk[index];
        sumSquares += sample * sample;
      }

      const rms = Math.sqrt(sumSquares / Math.max(chunk.length, 1));
      const now = Date.now();

      if (stateRef.current === "idle") {
        if (rms < VOLUME_THRESHOLD) {
          return;
        }

        chunksRef.current = [chunk];
        recordedFramesRef.current = chunk.length;
        lastVoiceFrameRef.current = chunk.length;
        lastVoiceAtRef.current = now;
        setState("listening");
        return;
      }

      if (stateRef.current !== "listening") {
        return;
      }

      chunksRef.current.push(chunk);
      recordedFramesRef.current += chunk.length;

      if (rms >= VOLUME_THRESHOLD) {
        lastVoiceAtRef.current = now;
        lastVoiceFrameRef.current = recordedFramesRef.current;
        return;
      }

      if (
        lastVoiceAtRef.current > 0 &&
        now - lastVoiceAtRef.current >= SILENCE_TIMEOUT_MS
      ) {
        void playBufferedSpeech();
      }
    },
    [playBufferedSpeech, setState],
  );

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      try {
        const permission = await AudioManager.requestRecordingPermissions();

        if (permission !== "Granted") {
          console.warn("Microphone permission is not granted");
          return;
        }

        const sessionActivated =
          await AudioManager.setAudioSessionActivity(true);

        if (!sessionActivated) {
          console.warn("Could not activate audio session");
          return;
        }

        const ctx = new AudioContext();
        await ctx.resume();

        const recorder = new AudioRecorder();
        recorder.onError((error) => {
          console.error("AudioRecorder error:", error.message);
        });

        const callbackResult = recorder.onAudioReady(
          {
            sampleRate: ctx.sampleRate,
            bufferLength: MONITOR_BUFFER_LENGTH,
            channelCount: MONITOR_CHANNEL_COUNT,
          },
          handleAudioChunk,
        );

        if (callbackResult.status === "error") {
          console.warn(callbackResult.message);
          await ctx.close();
          return;
        }

        const startResult = recorder.start();

        if (startResult.status === "error") {
          console.warn(startResult.message);
          recorder.clearOnAudioReady();
          await ctx.close();
          return;
        }

        if (!isMounted) {
          recorder.stop();
          recorder.clearOnAudioReady();
          recorder.clearOnError();
          await ctx.close();
          return;
        }

        audioCtxRef.current = ctx;
        recorderRef.current = recorder;
      } catch (error) {
        console.error("Audio init error:", error);
      }
    };

    void init();

    return () => {
      isMounted = false;

      const source = playbackSourceRef.current;
      if (source) {
        playbackSourceRef.current = null;
        source.onEnded = null;
        try {
          source.stop();
        } catch {}
      }

      const recorder = recorderRef.current;
      if (recorder) {
        recorder.clearOnAudioReady();
        recorder.clearOnError();
        if (recorder.isRecording() || recorder.isPaused()) {
          recorder.stop();
        }
      }

      recorderRef.current = null;
      clearRecordingBuffer();

      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (ctx) {
        void ctx.close();
      }

      void AudioManager.setAudioSessionActivity(false);
    };
  }, [clearRecordingBuffer, handleAudioChunk]);

  return (
    <View style={styles.container}>
      {riveFile && viewModelInstance && (
        <RiveView
          hybridRef={setHybridRef}
          file={riveFile}
          fit={Fit.Layout}
          style={styles.character}
          autoPlay={true}
          dataBind={viewModelInstance}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
  },
  character: {
    width: "100%",
    height: 400,
  },
});
