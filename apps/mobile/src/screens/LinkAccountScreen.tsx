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
import { Icon } from "@/components/Icon";
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
import { t as translate } from "@/i18n";

type LinkAccountRoute = RouteProp<ProfileStackParamList, "LinkAccount">;

const t = brandColorsLight;
type AuthMode = "login" | "register";

export default function LinkAccountScreen() {
  const route = useRoute<LinkAccountRoute>();
  const existingUser = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [email, setEmail] = useState(
    route.params?.email ?? existingUser?.email ?? "",
  );
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<AuthMode>("login");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (route.params?.email) setEmail(route.params.email);
  }, [route.params?.email]);

  const helperText = useMemo(() => {
    if (mode === "register") {
      return translate(
        "Create your rider account to sync rides, bikes, trips, and safety preferences.",
      );
    }
    if (existingUser?.email && existingUser.email === email.trim()) {
      return translate("This phone is already linked to that Tarmoto account.");
    }
    return translate(
      "Sign in here to sync your rides, bikes, and profile details to this phone.",
    );
  }, [email, existingUser?.email, mode]);

  const handleSubmit = async () => {
    const trimmedEmail = email.trim();
    const trimmedDisplayName = displayName.trim();
    if (
      !trimmedEmail ||
      !password ||
      (mode === "register" && !trimmedDisplayName)
    ) {
      setErrorMessage(
        mode === "register"
          ? translate("Enter your display name, email, and password.")
          : translate("Enter your email and password to link this phone."),
      );
      return;
    }
    if (mode === "register" && password.length < 8) {
      setErrorMessage(
        translate("Use at least 8 characters for your password."),
      );
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const auth =
        mode === "register"
          ? await api.register(trimmedEmail, password, trimmedDisplayName)
          : await api.login(trimmedEmail, password);
      setUser(auth.user);
      setPassword("");
      setSuccessMessage(
        mode === "register"
          ? translate(
              "Account created. Your rides, bikes, trips, and preferences will now sync.",
            )
          : translate(
              "Account linked. We're now syncing rides, bikes, and profile details to this phone.",
            ),
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : translate("Could not link this account."),
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
          <Text style={styles.title}>
            {mode === "register"
              ? translate("Create your Tarmoto account")
              : translate("Link your Tarmoto account")}
          </Text>
          <Text style={styles.subtitle}>{helperText}</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.modeSelector}>
            {(["login", "register"] as const).map((option) => (
              <Pressable
                key={option}
                accessibilityRole="button"
                accessibilityLabel={
                  option === "login"
                    ? translate("Sign in mode")
                    : translate("Create account mode")
                }
                accessibilityState={{ selected: mode === option }}
                onPress={() => {
                  setMode(option);
                  setErrorMessage(null);
                  setSuccessMessage(null);
                }}
                style={[
                  styles.modeButton,
                  mode === option ? styles.modeButtonSelected : null,
                ]}
              >
                <Text
                  style={[
                    styles.modeButtonLabel,
                    mode === option ? styles.modeButtonLabelSelected : null,
                  ]}
                >
                  {option === "login"
                    ? translate("Sign in")
                    : translate("Create account")}
                </Text>
              </Pressable>
            ))}
          </View>

          {mode === "register" ? (
            <>
              <Text style={styles.label}>{translate("Display name")}</Text>
              <TextInput
                accessibilityLabel={translate("Display name")}
                autoCapitalize="words"
                autoCorrect={false}
                maxLength={100}
                placeholder={translate("Martin CZ")}
                placeholderTextColor={t.mute}
                style={styles.input}
                value={displayName}
                onChangeText={setDisplayName}
              />
            </>
          ) : null}

          <Text
            style={[
              styles.label,
              mode === "register" ? styles.labelSpacing : null,
            ]}
          >
            {translate("Email")}
          </Text>
          <TextInput
            accessibilityLabel={translate("Email")}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholder={translate("rider@example.com")}
            placeholderTextColor={t.mute}
            style={styles.input}
            value={email}
            onChangeText={setEmail}
          />

          <Text style={[styles.label, styles.labelSpacing]}>
            {translate("Password")}
          </Text>
          <TextInput
            accessibilityLabel={translate("Password")}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={translate("Your Tarmoto password")}
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
            testID="auth-submit"
            accessibilityRole="button"
            accessibilityLabel={
              mode === "register"
                ? translate("Create account")
                : translate("Link account")
            }
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
                <Text style={styles.buttonLabel}>
                  {mode === "register"
                    ? translate("Create account")
                    : translate("Link account")}
                </Text>
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
  modeSelector: {
    flexDirection: "row",
    gap: brandSpacing.s2,
    marginBottom: brandSpacing.s4,
    padding: 3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.sunken,
  },
  modeButton: {
    flex: 1,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: brandRadii.pill,
  },
  modeButtonSelected: {
    backgroundColor: t.invBg,
  },
  modeButtonLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
  },
  modeButtonLabelSelected: {
    color: t.invFg,
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
