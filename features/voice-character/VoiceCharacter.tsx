import { Fit, RiveView, useRive, useRiveFile } from "@rive-app/react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import {
  AudioContext,
  AudioManager,
  AudioRecorder,
} from "react-native-audio-api";

import {
  clearTimeoutRef,
  findLeadingVoiceOffset,
  getRms,
  renderDetunedBuffer,
} from "./audio";
import PermissionButton from "./components/PermissionButton";
import {
  CHARACTER_STATE_KEYS,
  CharacterState,
  CONTINUE_VOICE_THRESHOLD,
  END_PADDING_MS,
  MONITOR_BUFFER_LENGTH,
  MONITOR_CHANNEL_COUNT,
  PRE_ROLL_MS,
  RESUME_GUARD_MS,
  SILENCE_TIMEOUT_MS,
  SOUND_AFTER_TALK_MS,
  START_VOICE_THRESHOLD,
  TALK_ANIMATION_TAIL_MS,
} from "./constants";

type AudioChunkHandler = Parameters<AudioRecorder["onAudioReady"]>[1];

AudioManager.setAudioSessionOptions({
  iosCategory: "playAndRecord",
  iosMode: "default",
  iosOptions: ["defaultToSpeaker"],
});

export default function VoiceCharacter() {
  const { riveFile } = useRiveFile(
    require("../../assets/rive/hear_and_talk.riv"),
  );
  const { riveRef, riveViewRef, setHybridRef } = useRive();
  const [isAudioReady, setIsAudioReady] = useState(false);
  const [needsPermission, setNeedsPermission] = useState(false);
  const isRiveReady = riveViewRef !== null;

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
  const talkStateResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const resetInputs = useCallback(() => {
    CHARACTER_STATE_KEYS.forEach((key) => {
      riveRef.current?.setBooleanInputValue(key, false);
    });
  }, [riveRef]);

  const setCharacterState = useCallback(
    (next: CharacterState) => {
      stateRef.current = next;
      resetInputs();
      riveRef.current?.setBooleanInputValue(next, true);
    },
    [resetInputs, riveRef],
  );

  useEffect(() => {
    if (!isRiveReady) {
      return;
    }

    setCharacterState(stateRef.current);
  }, [isRiveReady, setCharacterState]);

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

  const resetAfterPlayback = useCallback(() => {
    clearTimeoutRef(talkStateResetTimeoutRef);
    preparingPlaybackRef.current = false;

    const source = playbackSourceRef.current;
    if (source) {
      source.onEnded = null;
      source.disconnect();
    }
    playbackSourceRef.current = null;

    clearRecordingBuffer();
    clearPreRollBuffer();
    ignoreInputUntilRef.current = Date.now() + RESUME_GUARD_MS;
    setCharacterState("Check");
  }, [clearPreRollBuffer, clearRecordingBuffer, setCharacterState]);

  const finishPlayback = useCallback(() => {
    clearTimeoutRef(talkStateResetTimeoutRef);

    if (stateRef.current !== "Talk" || TALK_ANIMATION_TAIL_MS <= 0) {
      resetAfterPlayback();
      return;
    }

    talkStateResetTimeoutRef.current = setTimeout(() => {
      talkStateResetTimeoutRef.current = null;
      resetAfterPlayback();
    }, TALK_ANIMATION_TAIL_MS);
  }, [resetAfterPlayback]);

  const playBufferedSpeech = useCallback(async () => {
    const ctx = audioCtxRef.current;

    if (preparingPlaybackRef.current) {
      return;
    }

    if (!ctx || recordedFramesRef.current === 0) {
      clearRecordingBuffer();
      setCharacterState("Check");
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
        setCharacterState("Check");
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

      setCharacterState("Talk");

      source.start(
        ctx.currentTime + SOUND_AFTER_TALK_MS / 1000,
        voicedOffsetFrames / ctx.sampleRate,
      );
    } catch (error) {
      console.error("playBufferedSpeech error:", error);
      finishPlayback();
    }
  }, [clearRecordingBuffer, finishPlayback, setCharacterState]);

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

      const rms = getRms(chunk);
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
        setCharacterState("Hear");
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
    [
      appendPreRollChunk,
      clearPreRollBuffer,
      playBufferedSpeech,
      setCharacterState,
    ],
  );

  useEffect(() => {
    let cancelled = false;

    const initAudio = async () => {
      let sessionActive = false;
      let ctx: AudioContext | null = null;
      let recorder: AudioRecorder | null = null;

      try {
        setNeedsPermission(false);
        setIsAudioReady(false);

        const permission = await AudioManager.requestRecordingPermissions();

        if (permission !== "Granted") {
          console.warn("Microphone permission is not granted");
          if (!cancelled) {
            setNeedsPermission(true);
            Alert.alert(
              "Microphone access needed",
              "Microphone access was denied. You can enable it in the app settings.",
            );
          }
          return;
        }

        if (cancelled) {
          return;
        }

        const sessionActivated =
          await AudioManager.setAudioSessionActivity(true);

        if (!sessionActivated) {
          console.warn("Could not activate audio session");
          return;
        }

        sessionActive = true;
        if (cancelled) {
          return;
        }

        ctx = new AudioContext();
        await ctx.resume();
        if (cancelled) {
          return;
        }

        recorder = new AudioRecorder();
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
          return;
        }

        const startResult = recorder.start();

        if (startResult.status === "error") {
          console.warn(startResult.message);
          return;
        }

        if (cancelled) {
          return;
        }

        audioCtxRef.current = ctx;
        recorderRef.current = recorder;
        ctx = null;
        recorder = null;
        sessionActive = false;
        setIsAudioReady(true);
      } catch (error) {
        console.error("Audio init error:", error);
      } finally {
        if (recorder) {
          recorder.clearOnAudioReady();
          recorder.clearOnError();
          recorder.stop();
        }
        if (ctx) {
          await ctx.close();
        }
        if (sessionActive) {
          await AudioManager.setAudioSessionActivity(false);
        }
      }
    };

    void initAudio();

    return () => {
      cancelled = true;

      clearTimeoutRef(talkStateResetTimeoutRef);

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
      clearRecordingBuffer();
      clearPreRollBuffer();

      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (ctx) {
        void ctx.close();
      }

      void AudioManager.setAudioSessionActivity(false);
    };
  }, [clearPreRollBuffer, clearRecordingBuffer, handleAudioChunk]);

  const isCharacterReady = isAudioReady && isRiveReady;

  return (
    <View style={styles.character}>
      {needsPermission && (
        <View style={styles.loaderContainer}>
          <PermissionButton />
        </View>
      )}
      {!needsPermission && !isCharacterReady && (
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
            !isCharacterReady ? styles.characterHidden : null,
          ]}
          autoPlay={true}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loaderContainer: {
    alignItems: "center",
    justifyContent: "center",
    ...StyleSheet.absoluteFillObject,
  },
  character: {
    width: "100%",
    height: "100%",
  },
  characterHidden: {
    opacity: 0,
  },
});
