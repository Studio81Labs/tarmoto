/**
 * EditProfileModal — US-27 own-profile editing.
 *
 * Edits display name, bio, and home region. Avatar upload is handled in
 * `ProfileScreen` directly (one tap on the avatar) so this modal stays
 * focused on the text fields. Patches go through the existing
 * `PATCH /users/me` endpoint and write the result back to the auth store
 * so the rest of the app sees the new values without needing to reload.
 */
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import type { ProfileStackParamList } from "@/navigation/RootNavigator";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";

type Nav = NativeStackNavigationProp<ProfileStackParamList, "EditProfile">;

const t = brandColorsLight;

const DISPLAY_NAME_MAX = 100;
const BIO_MAX = 500;
const HOME_REGION_MAX = 120;

export default function EditProfileModal() {
  const translate = useTranslation();
  const navigation = useNavigation<Nav>();
  const user = useAuthStore((s) => s.user);
  const applyProfileUpdate = useAuthStore((s) => s.applyProfileUpdate);

  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [homeRegion, setHomeRegion] = useState(user?.home_region ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setValidation(translate("Display name is required."));
      return;
    }
    if (!user) return;

    setValidation(null);
    setError(null);
    setSubmitting(true);
    try {
      // The backend treats `null` as "clear this field" and `undefined`
      // (omitted key) as "leave unchanged". Convert the empty-string form
      // values into `null` so blanking the bio actually blanks it on the
      // server, and trim leading/trailing whitespace so a single space
      // doesn't accidentally pass the required-name check.
      const updated = await api.updateProfile({
        display_name: trimmedName,
        bio: bio.trim() ? bio.trim() : null,
        home_region: homeRegion.trim() ? homeRegion.trim() : null,
      });
      applyProfileUpdate(updated);
      navigation.goBack();
    } catch (err) {
      setError(
        getUserFacingErrorMessage(err, translate("Could not save profile.")),
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    displayName,
    bio,
    homeRegion,
    user,
    applyProfileUpdate,
    navigation,
    translate,
  ]);

  if (!user) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          {translate("Sign in to edit your profile.")}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.field}>
        <Text style={styles.label}>{translate("Display name")}</Text>
        <TextInput
          style={styles.input}
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={DISPLAY_NAME_MAX}
          editable={!submitting}
          accessibilityLabel={translate("Display name")}
          autoCapitalize="words"
          autoCorrect={false}
          placeholder={translate("Your rider name")}
          placeholderTextColor={t.mute}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{translate("Bio")}</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={bio}
          onChangeText={setBio}
          maxLength={BIO_MAX}
          multiline
          editable={!submitting}
          accessibilityLabel={translate("Bio")}
          placeholder={translate("A few words about your riding")}
          placeholderTextColor={t.mute}
        />
        <Text style={styles.hint}>
          {translate("{value0} / {value1}", {
            value0: bio.length,
            value1: BIO_MAX,
          })}
        </Text>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{translate("Home region")}</Text>
        <TextInput
          style={styles.input}
          value={homeRegion}
          onChangeText={setHomeRegion}
          maxLength={HOME_REGION_MAX}
          editable={!submitting}
          accessibilityLabel={translate("Home region")}
          placeholder={translate("Beskydy, Czech Republic")}
          placeholderTextColor={t.mute}
        />
      </View>

      {validation ? <Text style={styles.errorText}>{validation}</Text> : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <TouchableOpacity
        style={[styles.saveButton, submitting ? styles.disabled : null]}
        onPress={() => void handleSave()}
        disabled={submitting}
        accessibilityRole="button"
        accessibilityLabel={translate("Save profile")}
      >
        {submitting ? (
          <ActivityIndicator color={t.invFg} />
        ) : (
          <Text style={styles.saveLabel}>{translate("Save")}</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.cancelButton}
        onPress={() => navigation.goBack()}
        disabled={submitting}
        accessibilityRole="button"
        accessibilityLabel={translate("Cancel edit")}
      >
        <Text style={styles.cancelLabel}>{translate("Cancel")}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: t.bg },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s4,
  },
  field: { gap: brandSpacing.s1 },
  label: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 12,
    fontWeight: "600",
  },
  input: {
    backgroundColor: t.sunken,
    borderRadius: brandRadii.sm,
    borderWidth: 1,
    borderColor: t.line,
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    paddingHorizontal: brandSpacing.s3,
    paddingVertical: brandSpacing.s3,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: "top",
  },
  hint: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    textAlign: "right",
  },
  saveButton: {
    backgroundColor: t.invBg,
    borderRadius: brandRadii.pill,
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    alignItems: "center",
    justifyContent: "center",
    marginTop: brandSpacing.s2,
  },
  saveLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontWeight: "700",
    fontSize: 14,
  },
  cancelButton: {
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelLabel: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 14,
  },
  disabled: { opacity: 0.7 },
  errorText: {
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 13,
  },
  empty: {
    flex: 1,
    backgroundColor: t.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
  },
});
