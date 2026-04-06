Used OfflineAudioContext to render pitch-shifted audio offline and avoid real-time pitch-correction spikes.

The character renders only after audio initialization completes; if microphone permission is denied, a button appears that opens the system Settings screen.

Rive animations use `ref.setBooleanInputValue` directly - `useViewModelInstance` wasn't viable since the designer seems hadn't attached a view model to the file.

Added `TALK_ANIMATION_LEAD_MS` and `TALK_ANIMATION_TAIL_MS` constants to fine-tune talk animation sync with speech playback.
