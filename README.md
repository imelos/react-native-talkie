Used a lightweight voice activity flow instead of full speech recognition - the task only needs phrase boundaries and fast mic reaction. Speech start and continuation use separate thresholds, with a short tail pad to prevent clipped phrase endings.

The character appears only after audio is ready; mic denial surfaces a retry button rather than a broken state. The character is visible only when it can actually react.

Rive animations use `ref.setBooleanInputValue` directly - `useViewModelInstance` wasn't viable since the designer seems hadn't attached a view model to the file.
