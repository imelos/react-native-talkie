import { StyleSheet, View } from "react-native";

import VoiceCharacter from "../features/voice-character/VoiceCharacter";

export default function Index() {
  return (
    <View style={styles.container}>
      <VoiceCharacter />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#d6e2ea",
  },
});
