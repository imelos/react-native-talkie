export const START_VOICE_THRESHOLD = 0.02;
export const CONTINUE_VOICE_THRESHOLD = 0.012;
export const SILENCE_TIMEOUT_MS = 1000;
export const PRE_ROLL_MS = 180;
export const END_PADDING_MS = 220;
export const RESUME_GUARD_MS = 250;
export const DETUNE_CENTS = 700;
export const MONITOR_BUFFER_LENGTH = 1024;
export const MONITOR_CHANNEL_COUNT = 1;
export const LEADING_VOICE_WINDOW_SIZE = 256;
export const SOUND_AFTER_TALK_MS = 900;
export const TALK_ANIMATION_TAIL_MS = 120;

export const CharacterStates = {
  Check: "Check",
  Hear: "Hear",
  Talk: "Talk",
} as const;

export type CharacterState =
  (typeof CharacterStates)[keyof typeof CharacterStates];

export const CHARACTER_STATE_KEYS = Object.values(
  CharacterStates,
) as CharacterState[];
