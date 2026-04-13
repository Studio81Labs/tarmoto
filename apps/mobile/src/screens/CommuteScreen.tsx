import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, fontSize, spacing, fontWeight } from '@/theme';

export default function CommuteScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Commute</Text>
      <Text style={styles.subtitle}>TODO: Implement CommuteScreen</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: colors.textTertiary,
    fontSize: fontSize.md,
  },
});
