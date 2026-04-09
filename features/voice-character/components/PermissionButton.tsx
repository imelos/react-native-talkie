import React from "react";
import { Linking, Pressable, StyleSheet, Text } from "react-native";

export default function PermissionButton() {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={Linking.openSettings}
      style={({ pressed }) => [
        styles.permissionButton,
        pressed ? styles.permissionButtonPressed : null,
      ]}
    >
      <Text style={styles.permissionButtonText}>GrantMicrophonePermission</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
});
