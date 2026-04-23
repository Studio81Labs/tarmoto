import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import Icon from "@react-native-vector-icons/material-design-icons";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";

type LinkAccountRoute = RouteProp<ProfileStackParamList, "LinkAccount">;

export default function LinkAccountScreen() {
  const route = useRoute<LinkAccountRoute>();
  const existingUser = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [email, setEmail] = useState(
    route.params?.email ?? existingUser?.email ?? "",
  );
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (route.params?.email) setEmail(route.params.email);
  }, [route.params?.email]);

  const helperText = useMemo(() => {
    if (existingUser?.email && existingUser.email === email.trim()) {
      return "This phone is already linked to that Tarmoto account.";
    }
    return "Sign in here to sync your rides, bikes, and profile details to this phone.";
  }, [email, existingUser?.email]);

  const handleSubmit = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setErrorMessage("Enter your email and password to link this phone.");
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const auth = await api.login(trimmedEmail, password);
      setUser(auth.user);
      setPassword("");
      setSuccessMessage(
        "Account linked. We're now syncing rides, bikes, and profile details to this phone.",
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Could not link this account.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.container}>
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Icon name="cellphone-link" size={28} color={colors.primary} />
          </View>
          <Text style={styles.title}>Link your Tarmoto account</Text>
          <Text style={styles.subtitle}>{helperText}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            accessibilityLabel="Email"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholder="rider@example.com"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            value={email}
            onChangeText={setEmail}
          />

          <Text style={[styles.label, styles.labelSpacing]}>Password</Text>
          <TextInput
            accessibilityLabel="Password"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Your Tarmoto password"
            placeholderTextColor={colors.textTertiary}
            secureTextEntry
            style={styles.input}
            value={password}
            onChangeText={setPassword}
          />

          {errorMessage ? (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {errorMessage}
            </Text>
          ) : null}

          {successMessage ? (
            <Text style={styles.successText}>{successMessage}</Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Link account"
            accessibilityState={{ disabled: submitting }}
            disabled={submitting}
            onPress={() => void handleSubmit()}
            style={[styles.button, submitting ? styles.buttonDisabled : null]}
          >
            {submitting ? (
              <ActivityIndicator color={colors.textInverse} />
            ) : (
              <>
                <Icon
                  name="login-variant"
                  size={18}
                  color={colors.textInverse}
                />
                <Text style={styles.buttonLabel}>Link account</Text>
              </>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    padding: spacing.xl,
    gap: spacing.lg,
    backgroundColor: colors.bg,
  },
  hero: {
    gap: spacing.md,
  },
  heroIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryAlpha15,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h1,
    fontWeight: fontWeight.bold,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 22,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  label: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  labelSpacing: {
    marginTop: spacing.lg,
  },
  input: {
    marginTop: spacing.sm,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    color: colors.textPrimary,
    fontSize: fontSize.md,
  },
  errorText: {
    marginTop: spacing.md,
    color: colors.danger,
    fontSize: fontSize.sm,
  },
  successText: {
    marginTop: spacing.md,
    color: colors.success,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  button: {
    marginTop: spacing.lg,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonLabel: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
});
