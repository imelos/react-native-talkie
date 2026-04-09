The current implementation is intentionally kept in a single file. Since the constants, helper functions, and audio logic are all specific to this screen, keeping them together makes the flow easier to read for now. They can be extracted later if the feature grows, needs reuse, or would benefit from isolated testing.

The same applies to the component structure. A separate `VoiceCharacter` component would be a reasonable next refactor, with `app/index.tsx` acting only as the screen entry point. For this task, I kept everything together because the feature is still compact and the single-file version is easier to follow.

`expo prebuild` is required

Used `react-native-audio-api` as this lib has reliable way for pitch sifting via `.detune` prop. This approach was a better fit because it works directly on in-memory audio buffers, so pitch shifting and playback scheduling do not depend on creating temporary audio files.
`expo-av` rate-based playback approach was not ideal for this use case, where voice transformation quality and timing control both mattered

Used `OfflineAudioContext` to render pitch-shifted audio offline and avoid real-time pitch-correction spikes.

The character renders only after audio initialization completes; if microphone permission is denied, a button appears that opens the system Settings screen.

Rive animations use `ref.setBooleanInputValue` directly - `useViewModelInstance` wasn't viable since the designer seems hadn't attached a view model to the file.

Added `SOUND_AFTER_TALK_MS` and `TALK_ANIMATION_TAIL_MS` constants to fine-tune talk animation sync with speech playback.
