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
  iosCategory: "record",
  iosMode: "default",
  iosOptions: [],
});

const audioRecorder = new AudioRecorder();

const VOLUME_THRESHOLD = 0.02;
const SILENCE_TIMEOUT_MS = 1000;
const DETUNE_CENTS = 700;

type CharacterState = "idle" | "listening" | "playing";

const STATE_INDEX: Record<CharacterState, number> = {
  idle: 0,
  listening: 1,
  playing: 2,
};

export default function VoiceCharacter() {
  const { riveFile } = useRiveFile(require("./assets/rive/hear_and_talk.riv"));
  const { riveViewRef, setHybridRef } = useRive();

  const { instance: viewModelInstance } = useViewModelInstance(riveFile, {
    onInit: (vmi) => vmi.numberProperty("state")?.set(STATE_INDEX.idle),
  });

  const { setValue: setRiveState } = useRiveNumber("state", viewModelInstance);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const stateRef = useRef<CharacterState>("idle");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animFrameRef = useRef<number>(0);

  const setState = useCallback(
    (next: CharacterState) => {
      stateRef.current = next;
      setRiveState(STATE_INDEX[next]);
      riveViewRef?.play();
    },
    [setRiveState, riveViewRef],
  );

  const playWithPitch = useCallback(
    async (uri: string) => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;

      try {
        const response = await fetch(uri);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        const source = await ctx.createBufferSource({ pitchCorrection: true });
        source.buffer = audioBuffer;
        source.detune.value = DETUNE_CENTS;
        source.connect(ctx.destination);
        source.onEnded = () => setState("idle");
        source.start();
      } catch (e) {
        console.error("playWithPitch error:", e);
        setState("idle");
      }
    },
    [setState],
  );

  const stopRecording = useCallback(async () => {
    if (stateRef.current !== "listening") return;

    setState("playing");

    try {
      const result = audioRecorder.stop();

      if (result.status === "success") {
        await playWithPitch(result.path);
      } else {
        setState("idle");
      }
    } catch (e) {
      console.error("stopRecording error:", e);
      setState("idle");
    }
  }, [setState, playWithPitch]);

  const onSilence = useCallback(() => {
    if (stateRef.current !== "listening") return;
    if (silenceTimerRef.current) return;

    silenceTimerRef.current = setTimeout(() => {
      silenceTimerRef.current = null;
      stopRecording();
    }, SILENCE_TIMEOUT_MS);
  }, [stopRecording]);

  const onVoice = useCallback(async () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    if (stateRef.current !== "idle") return;

    setState("listening");

    try {
      const result = audioRecorder.start();
      if (result.status === "error") {
        console.warn(result.message);
        return;
      }

      console.log("Recording started to file:", result.path);
    } catch (e) {
      console.error("startRecording error:", e);
      setState("idle");
    }
  }, [setState]);

  useEffect(() => {
    const init = async () => {
      const permissions = await AudioManager.requestRecordingPermissions();

      if (permissions !== "Granted") {
        console.warn("Permissions are not granted");
        return;
      }

      const success = await AudioManager.setAudioSessionActivity(true);

      if (!success) {
        console.warn("Could not activate the audio session");
        return;
      }
    };

    init();

    return () => {};
  }, [onVoice, onSilence]);

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
