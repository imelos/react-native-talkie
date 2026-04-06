import { Fit, RiveView, useRive, useRiveFile } from "@rive-app/react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  AudioContext,
  AudioManager,
  AudioRecorder,
  OfflineAudioContext,
} from "react-native-audio-api";

AudioManager.setAudioSessionOptions({
  iosCategory: "playAndRecord",
  iosMode: "default",
  iosOptions: ["defaultToSpeaker"],
});

const START_VOICE_THRESHOLD = 0.02;
const CONTINUE_VOICE_THRESHOLD = 0.012;
const SILENCE_TIMEOUT_MS = 1000;
const PRE_ROLL_MS = 180;
const END_PADDING_MS = 320;
const RESUME_GUARD_MS = 250;
const DETUNE_CENTS = 700;
const MONITOR_BUFFER_LENGTH = 1024;
const MONITOR_CHANNEL_COUNT = 1;
const LEADING_VOICE_WINDOW_SIZE = 256;
const TALK_ANIMATION_LEAD_MS = 40;
const PLAYBACK_SCHEDULE_AHEAD_MS = 30;

const CharacterStates = {
  Check: "Check",
  Hear: "Hear",
  Talk: "Talk",
};

type CharacterState = keyof typeof CharacterStates;

type AudioChunkHandler = Parameters<AudioRecorder["onAudioReady"]>[1];

export default function VoiceCharacter() {
  const { riveFile } = useRiveFile(require("../assets/rive/hear_and_talk.riv"));
  const { riveViewRef, setHybridRef } = useRive();
  const [isAudioReady, setIsAudioReady] = useState(false);
  const [isRiveReady, setIsRiveReady] = useState(false);
  const [needsPermission, setNeedsPermission] = useState(false);
  const didInitAudioRef = useRef(false);
  const isMountedRef = useRef(true);
  const isInitializingAudioRef = useRef(false);
  const riveInputRef = useRef<typeof riveViewRef>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const playbackSourceRef = useRef<ReturnType<
    AudioContext["createBufferSource"]
  > | null>(null);
  const stateRef = useRef<CharacterState>("Check");
  const preRollChunksRef = useRef<Float32Array[]>([]);
  const preRollFramesRef = useRef(0);
  const chunksRef = useRef<Float32Array[]>([]);
  const recordedFramesRef = useRef(0);
  const lastVoiceFrameRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const ignoreInputUntilRef = useRef(0);
  const preparingPlaybackRef = useRef(false);
  const talkStateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    riveInputRef.current = riveViewRef;
    setIsRiveReady(Boolean(riveViewRef));
    if (!riveViewRef) {
      return;
    }

    // Rive can mount after audio state changes, so reapply the current state here.
    Object.keys(CharacterStates).forEach((key) => {
      riveViewRef.setBooleanInputValue(key, false);
    });
    riveViewRef.setBooleanInputValue(stateRef.current, true);
  }, [riveViewRef]);

  const resetInputs = useCallback(() => {
    Object.keys(CharacterStates).forEach((key) => {
      riveInputRef.current?.setBooleanInputValue(key, false);
    });
  }, []);

  const setState = useCallback(
    (next: CharacterState) => {
      stateRef.current = next;
      resetInputs();
      riveInputRef.current?.setBooleanInputValue(next, true);
    },
    [resetInputs],
  );

  const clearRecordingBuffer = useCallback(() => {
    chunksRef.current = [];
    recordedFramesRef.current = 0;
    lastVoiceFrameRef.current = 0;
    lastVoiceAtRef.current = 0;
  }, []);

  const appendPreRollChunk = useCallback(
    (chunk: Float32Array, sampleRate: number) => {
      preRollChunksRef.current.push(chunk);
      preRollFramesRef.current += chunk.length;

      const maxPreRollFrames = Math.floor((sampleRate * PRE_ROLL_MS) / 1000);

      while (
        preRollChunksRef.current.length > 0 &&
        preRollFramesRef.current > maxPreRollFrames
      ) {
        const droppedChunk = preRollChunksRef.current.shift();
        if (!droppedChunk) {
          break;
        }
        preRollFramesRef.current -= droppedChunk.length;
      }
    },
    [],
  );

  const clearPreRollBuffer = useCallback(() => {
    preRollChunksRef.current = [];
    preRollFramesRef.current = 0;
  }, []);

  const finishPlayback = useCallback(() => {
    if (talkStateTimeoutRef.current) {
      clearTimeout(talkStateTimeoutRef.current);
      talkStateTimeoutRef.current = null;
    }
    preparingPlaybackRef.current = false;
    playbackSourceRef.current = null;
    clearRecordingBuffer();
    clearPreRollBuffer();
    ignoreInputUntilRef.current = Date.now() + RESUME_GUARD_MS;
    setState("Check");
  }, [clearPreRollBuffer, clearRecordingBuffer, setState]);

  const renderDetunedBuffer = useCallback(
    async (
      sourceBuffer: ReturnType<AudioContext["createBuffer"]>,
      framesToKeep: number,
      sampleRate: number,
    ) => {
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

      for (
        let channel = 0;
        channel < sourceBuffer.numberOfChannels;
        channel += 1
      ) {
        offlineBuffer.copyToChannel(
          sourceBuffer.getChannelData(channel),
          channel,
        );
      }

      const offlineSource = offlineCtx.createBufferSource({
        pitchCorrection: true,
      });
      offlineSource.buffer = offlineBuffer;
      offlineSource.detune.value = DETUNE_CENTS;
      offlineSource.connect(offlineCtx.destination);
      offlineSource.start();

      return offlineCtx.startRendering();
    },
    [],
  );

  const findLeadingVoiceOffset = useCallback((audioData: Float32Array) => {
    if (audioData.length === 0) {
      return 0;
    }

    for (
      let start = 0;
      start < audioData.length;
      start += LEADING_VOICE_WINDOW_SIZE
    ) {
      const end = Math.min(start + LEADING_VOICE_WINDOW_SIZE, audioData.length);
      let sumSquares = 0;

      for (let index = start; index < end; index += 1) {
        const sample = audioData[index];
        sumSquares += sample * sample;
      }

      const rms = Math.sqrt(sumSquares / Math.max(end - start, 1));
      if (rms >= CONTINUE_VOICE_THRESHOLD) {
        return start;
      }
    }

    return 0;
  }, []);

  const playBufferedSpeech = useCallback(async () => {
    const ctx = audioCtxRef.current;

    if (preparingPlaybackRef.current) {
      return;
    }

    if (!ctx || recordedFramesRef.current === 0) {
      clearRecordingBuffer();
      setState("Check");
      return;
    }

    try {
      preparingPlaybackRef.current = true;

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
      const playbackData = playbackBuffer.getChannelData(0);

      let writeOffset = 0;

      for (const chunk of chunksRef.current) {
        if (writeOffset >= framesToKeep) {
          break;
        }

        const frames = Math.min(chunk.length, framesToKeep - writeOffset);
        playbackData.set(chunk.subarray(0, frames), writeOffset);
        writeOffset += frames;
      }

      if (writeOffset === 0) {
        preparingPlaybackRef.current = false;
        clearRecordingBuffer();
        setState("Check");
        return;
      }

      const renderedBuffer = await renderDetunedBuffer(
        playbackBuffer,
        framesToKeep,
        ctx.sampleRate,
      );

      await ctx.resume();

      const source = ctx.createBufferSource();
      source.buffer = renderedBuffer;
      source.connect(ctx.destination);
      source.onEnded = finishPlayback;

      playbackSourceRef.current = source;
      const renderedData = renderedBuffer.getChannelData(0);
      const voicedOffsetFrames = findLeadingVoiceOffset(renderedData);
      const startAt = ctx.currentTime + PLAYBACK_SCHEDULE_AHEAD_MS / 1000;
      const sourceLatencyMs = Math.max(source.getLatency() * 1000, 0);
      const talkDelayMs = Math.max(
        PLAYBACK_SCHEDULE_AHEAD_MS +
          sourceLatencyMs +
          (voicedOffsetFrames / ctx.sampleRate) * 1000 -
          TALK_ANIMATION_LEAD_MS,
        0,
      );

      if (talkStateTimeoutRef.current) {
        clearTimeout(talkStateTimeoutRef.current);
      }
      talkStateTimeoutRef.current = setTimeout(() => {
        talkStateTimeoutRef.current = null;
        if (playbackSourceRef.current === source) {
          setState("Talk");
        }
      }, talkDelayMs);

      source.start(startAt, voicedOffsetFrames / ctx.sampleRate);
    } catch (error) {
      console.error("playBufferedSpeech error:", error);
      finishPlayback();
    }
  }, [
    clearRecordingBuffer,
    finishPlayback,
    findLeadingVoiceOffset,
    renderDetunedBuffer,
    setState,
  ]);

  const handleAudioChunk = useCallback<AudioChunkHandler>(
    (event) => {
      if (Date.now() < ignoreInputUntilRef.current) {
        return;
      }

      if (stateRef.current === "Talk" || preparingPlaybackRef.current) {
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

      if (stateRef.current === "Check") {
        appendPreRollChunk(chunk, event.buffer.sampleRate);

        if (rms < START_VOICE_THRESHOLD) {
          return;
        }

        chunksRef.current = [...preRollChunksRef.current];
        recordedFramesRef.current = preRollFramesRef.current;
        lastVoiceFrameRef.current = recordedFramesRef.current;
        lastVoiceAtRef.current = now;
        clearPreRollBuffer();
        setState("Hear");
        return;
      }

      if (stateRef.current !== "Hear") {
        return;
      }

      chunksRef.current.push(chunk);
      recordedFramesRef.current += chunk.length;

      if (rms >= CONTINUE_VOICE_THRESHOLD) {
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
    [appendPreRollChunk, clearPreRollBuffer, playBufferedSpeech, setState],
  );

  const initAudio = useCallback(async () => {
    if (isInitializingAudioRef.current) {
      return;
    }

    isInitializingAudioRef.current = true;
    try {
      setNeedsPermission(false);
      setIsAudioReady(false);

      const permission = await AudioManager.requestRecordingPermissions();

      if (permission !== "Granted") {
        console.warn("Microphone permission is not granted");
        if (isMountedRef.current) {
          setNeedsPermission(true);
          Alert.alert(
            "Microphone access needed",
            "Microphone access was denied. You can enable it in the app settings.",
          );
        }
        return;
      }

      const sessionActivated = await AudioManager.setAudioSessionActivity(true);

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

      if (!isMountedRef.current) {
        recorder.stop();
        recorder.clearOnAudioReady();
        recorder.clearOnError();
        await ctx.close();
        return;
      }

      audioCtxRef.current = ctx;
      recorderRef.current = recorder;
      setIsAudioReady(true);
    } catch (error) {
      console.error("Audio init error:", error);
    } finally {
      isInitializingAudioRef.current = false;
    }
  }, [handleAudioChunk]);

  useEffect(() => {
    if (didInitAudioRef.current) {
      return;
    }
    didInitAudioRef.current = true;
    isMountedRef.current = true;
    void initAudio();

    return () => {
      isMountedRef.current = false;

      if (talkStateTimeoutRef.current) {
        clearTimeout(talkStateTimeoutRef.current);
        talkStateTimeoutRef.current = null;
      }

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
        recorder.stop();
      }

      recorderRef.current = null;
      setIsAudioReady(false);
      setIsRiveReady(false);
      setNeedsPermission(false);
      isInitializingAudioRef.current = false;
      clearRecordingBuffer();
      clearPreRollBuffer();

      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (ctx) {
        void ctx.close();
      }

      void AudioManager.setAudioSessionActivity(false);
    };
  }, [clearPreRollBuffer, clearRecordingBuffer, initAudio]);

  return (
    <View style={styles.container}>
      {needsPermission && (
        <View style={styles.loaderContainer}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void Linking.openSettings();
            }}
            style={({ pressed }) => [
              styles.permissionButton,
              pressed ? styles.permissionButtonPressed : null,
            ]}
          >
            <Text style={styles.permissionButtonText}>
              GrantMicrophonePermission
            </Text>
          </Pressable>
        </View>
      )}
      {!needsPermission && (!isAudioReady || !isRiveReady) && (
        <View style={styles.loaderContainer}>
          <ActivityIndicator size="large" color="#264653" />
        </View>
      )}
      {riveFile && (
        <RiveView
          hybridRef={setHybridRef}
          file={riveFile}
          fit={Fit.Contain}
          style={[
            styles.character,
            !isAudioReady || !isRiveReady ? styles.characterHidden : null,
          ]}
          autoPlay={true}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#d6e2ea",
    alignItems: "center",
    justifyContent: "center",
  },
  loaderContainer: {
    alignItems: "center",
    justifyContent: "center",
    ...StyleSheet.absoluteFillObject,
  },
  permissionButton: {
    backgroundColor: "#264653",
    borderRadius: 999,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  permissionButtonPressed: {
    opacity: 0.85,
  },
  permissionButtonText: {
    color: "#f4f7f9",
    fontSize: 16,
    fontWeight: "600",
  },
  character: {
    width: "100%",
    height: "100%",
  },
  characterHidden: {
    opacity: 0,
  },
});
