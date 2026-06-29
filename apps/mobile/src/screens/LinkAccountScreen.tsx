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
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";

type LinkAccountRoute = RouteProp<ProfileStackParamList, "LinkAccount">;

const t = brandColorsLight;

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
            <Icon name="cellphone-link" size={28} color={t.fg} />
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
            placeholderTextColor={t.mute}
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
            placeholderTextColor={t.mute}
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
              <ActivityIndicator color={t.invFg} />
            ) : (
              <>
                <Icon name="login-variant" size={18} color={t.invFg} />
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
    backgroundColor: t.bg,
  },
  container: {
    flex: 1,
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
    backgroundColor: t.bg,
  },
  hero: {
    gap: brandSpacing.s3,
  },
  heroIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.raised2,
  },
  title: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  subtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    lineHeight: 22,
  },
  card: {
    backgroundColor: t.raised,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: t.line,
    padding: brandSpacing.s4,
  },
  label: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "600",
  },
  labelSpacing: {
    marginTop: brandSpacing.s4,
  },
  input: {
    marginTop: brandSpacing.s2,
    backgroundColor: t.sunken,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: brandRadii.sm,
    paddingHorizontal: brandSpacing.s4,
    paddingVertical: brandSpacing.s3,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
  },
  errorText: {
    marginTop: brandSpacing.s3,
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  successText: {
    marginTop: brandSpacing.s3,
    color: statusFg.success,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    lineHeight: 20,
  },
  button: {
    marginTop: brandSpacing.s4,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: brandSpacing.s2,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
});
