/**
 * EmergencyContactsScreen — US-12 AC #4.
 *
 * List, add, edit, and delete the rider's emergency contacts. Backed by
 * `/users/me/contacts` (GET / POST / PATCH / DELETE). Contacts marked
 * `is_emergency` are the ones the backend will SMS/call when a crash
 * alert dispatches (out-of-scope for this issue, but the toggle is
 * surfaced now so the data is captured).
 *
 * Brand: migrated onto the cream + ink brand system (Phase 3) so the
 * Settings → Safety → Emergency contacts flow stays consistent. See
 * docs/design/mobile-spec/README.md.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Icon } from "@/components/Icon";
import {
  brandColorsLight,
  brandFonts,
  brandRadii,
  brandSpacing,
  statusFg,
} from "@/theme/brand";
import { Toggle } from "@/components/brand";
import { api } from "@/services/api";
import type { EmergencyContact, EmergencyContactInput } from "@/types";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";

const t = brandColorsLight;
const INK = "#0E0E10";

type FormMode =
  { kind: "create" } | { kind: "edit"; contact: EmergencyContact };

export default function EmergencyContactsScreen() {
  const translate = useTranslation();
  const [contacts, setContacts] = useState<EmergencyContact[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FormMode | null>(null);

  const loadContacts = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await api.listContacts();
      setContacts(list);
    } catch (err) {
      setLoadError(
        getUserFacingErrorMessage(err, translate("Couldn't load contacts.")),
      );
    }
  }, [translate]);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  const handleSaved = useCallback((saved: EmergencyContact, mode: FormMode) => {
    setContacts((prev) => {
      if (!prev) return [saved];
      if (mode.kind === "create") return [saved, ...prev];
      return prev.map((c) => (c.id === saved.id ? saved : c));
    });
    setEditing(null);
  }, []);

  const handleDelete = useCallback(
    (contact: EmergencyContact) => {
      Alert.alert(
        translate("Delete contact?"),
        translate("{value0} will no longer be alerted in a crash.", {
          value0: contact.name,
        }),
        [
          { text: translate("Cancel"), style: "cancel" },
          {
            text: translate("Delete"),
            style: "destructive",
            onPress: async () => {
              try {
                await api.deleteContact(contact.id);
                setContacts((prev) =>
                  prev ? prev.filter((c) => c.id !== contact.id) : prev,
                );
              } catch (err) {
                Alert.alert(
                  translate("Couldn't delete contact"),
                  getUserFacingErrorMessage(err, translate("Try again.")),
                );
              }
            },
          },
        ],
      );
    },
    [translate],
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{translate("Emergency contacts")}</Text>
      <Text style={styles.subtitle}>
        {translate(
          "These contacts get alerted with your location if Tarmoto detects a crash and you don't cancel within {seconds, plural, one {# second} other {# seconds}}.",
          { seconds: 30 },
        )}
      </Text>

      <TouchableOpacity
        style={styles.addBtn}
        onPress={() => setEditing({ kind: "create" })}
        accessibilityRole="button"
        accessibilityLabel={translate("Add emergency contact")}
      >
        <Icon name="plus" size={20} color={INK} />
        <Text style={styles.addLabel}>{translate("Add contact")}</Text>
      </TouchableOpacity>

      {loadError ? (
        <View style={styles.errorBanner}>
          <Icon name="alert-circle-outline" size={18} color={statusFg.danger} />
          <Text style={styles.errorText}>{loadError}</Text>
          <TouchableOpacity onPress={() => void loadContacts()}>
            <Text style={styles.retryLink}>{translate("Retry")}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {contacts === null && !loadError ? (
        <ActivityIndicator color={t.accent} />
      ) : null}

      {contacts && contacts.length === 0 ? (
        <Text style={styles.emptyText}>
          {translate(
            "No contacts yet. Add at least one so help can reach you in a crash.",
          )}
        </Text>
      ) : null}

      {contacts?.map((contact) => (
        <View key={contact.id} style={styles.card}>
          <View style={styles.cardBody}>
            <Text style={styles.contactName}>{contact.name}</Text>
            <Text style={styles.contactPhone}>{contact.phone}</Text>
            {contact.is_emergency ? (
              <View style={styles.badge}>
                <Icon name="bell-ring-outline" size={12} color={t.invFg} />
                <Text style={styles.badgeLabel}>
                  {translate("Emergency contact")}
                </Text>
              </View>
            ) : (
              <Text style={styles.contactNote}>
                {translate("Will not be alerted")}
              </Text>
            )}
          </View>
          <View style={styles.cardActions}>
            <TouchableOpacity
              onPress={() => setEditing({ kind: "edit", contact })}
              accessibilityRole="button"
              accessibilityLabel={translate("Edit {value0}", {
                value0: contact.name,
              })}
              style={styles.iconBtn}
            >
              <Icon name="pencil-outline" size={20} color={t.fg} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleDelete(contact)}
              accessibilityRole="button"
              accessibilityLabel={translate("Delete {value0}", {
                value0: contact.name,
              })}
              style={styles.iconBtn}
            >
              <Icon
                name="trash-can-outline"
                size={20}
                color={statusFg.danger}
              />
            </TouchableOpacity>
          </View>
        </View>
      ))}

      <ContactFormModal
        mode={editing}
        onClose={() => setEditing(null)}
        onSaved={handleSaved}
      />
    </ScrollView>
  );
}

interface ContactFormModalProps {
  mode: FormMode | null;
  onClose: () => void;
  onSaved: (contact: EmergencyContact, mode: FormMode) => void;
}

function ContactFormModal({ mode, onClose, onSaved }: ContactFormModalProps) {
  const translate = useTranslation();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [isEmergency, setIsEmergency] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mode) return;
    if (mode.kind === "edit") {
      setName(mode.contact.name);
      setPhone(mode.contact.phone);
      setIsEmergency(mode.contact.is_emergency);
    } else {
      setName("");
      setPhone("");
      setIsEmergency(true);
    }
    setError(null);
  }, [mode]);

  const submit = useCallback(async () => {
    if (!mode) return;
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();
    if (!trimmedName) {
      setError(translate("Name is required."));
      return;
    }
    if (!trimmedPhone) {
      setError(translate("Phone number is required."));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload: EmergencyContactInput = {
        name: trimmedName,
        phone: trimmedPhone,
        is_emergency: isEmergency,
      };
      const saved =
        mode.kind === "create"
          ? await api.addContact(payload)
          : await api.updateContact(mode.contact.id, payload);
      // Reset submitting BEFORE onSaved, otherwise the parent's
      // mode-clear unmounts this component and React logs a "set state
      // on unmounted" warning that bubbles up as an AggregateError in
      // tests.
      setSubmitting(false);
      onSaved(saved, mode);
      return;
    } catch (err) {
      setError(
        getUserFacingErrorMessage(err, translate("Couldn't save contact.")),
      );
      setSubmitting(false);
    }
  }, [mode, name, phone, isEmergency, onSaved, translate]);

  const visible = mode !== null;
  const title =
    mode?.kind === "create"
      ? translate("Add contact")
      : translate("Edit contact");

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="formSheet"
    >
      <View style={styles.modalContainer}>
        <Text style={styles.modalTitle}>{title}</Text>

        <Text style={styles.label}>{translate("Name")}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={translate("Jane Doe")}
          placeholderTextColor={t.mute}
          style={styles.input}
          autoCapitalize="words"
          accessibilityLabel={translate("Contact name")}
        />

        <Text style={styles.label}>{translate("Phone")}</Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          placeholder={translate("+420 123 456 789")}
          placeholderTextColor={t.mute}
          style={styles.input}
          keyboardType="phone-pad"
          accessibilityLabel={translate("Contact phone")}
        />

        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>{translate("Alert in a crash")}</Text>
            <Text style={styles.helpText}>
              {translate(
                "When off, this contact stays in your list but is not notified.",
              )}
            </Text>
          </View>
          <Toggle
            on={isEmergency}
            onToggle={setIsEmergency}
            accessibilityLabel={translate("Alert this contact in a crash")}
          />
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.modalActions}>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={onClose}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel={translate("Cancel")}
          >
            <Text style={styles.secondaryLabel}>{translate("Cancel")}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.primaryBtn, submitting ? styles.disabled : null]}
            onPress={() => void submit()}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel={translate("Save contact")}
            accessibilityState={{ disabled: submitting }}
          >
            {submitting ? (
              <ActivityIndicator color={INK} />
            ) : (
              <Text style={styles.primaryLabel}>{translate("Save")}</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.bg,
  },
  content: {
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
    paddingBottom: brandSpacing.s8,
  },
  title: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  subtitle: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    lineHeight: 20,
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    gap: brandSpacing.s2,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    backgroundColor: t.accent,
  },
  addLabel: {
    color: INK,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "800",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
    padding: brandSpacing.s4,
    borderRadius: brandRadii.lg,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  cardBody: {
    flex: 1,
    gap: brandSpacing.s1,
  },
  contactName: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    fontWeight: "700",
  },
  contactPhone: {
    color: t.dim,
    fontFamily: brandFonts.mono,
    fontSize: 13,
  },
  contactNote: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingHorizontal: brandSpacing.s2,
    paddingVertical: 2,
    borderRadius: brandRadii.pill,
    backgroundColor: t.invBg,
  },
  badgeLabel: {
    color: t.invFg,
    fontFamily: brandFonts.sans,
    fontSize: 10,
    fontWeight: "800",
  },
  cardActions: {
    flexDirection: "row",
    gap: brandSpacing.s2,
  },
  iconBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    textAlign: "center",
    paddingVertical: brandSpacing.s5,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s2,
    padding: brandSpacing.s3,
    borderRadius: brandRadii.md,
    borderWidth: 1,
    borderColor: statusFg.danger,
    backgroundColor: "rgba(179,38,30,0.08)",
  },
  errorText: {
    color: statusFg.danger,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    flex: 1,
  },
  retryLink: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "800",
  },
  modalContainer: {
    flex: 1,
    backgroundColor: t.bg,
    padding: brandSpacing.s5,
    gap: brandSpacing.s3,
  },
  modalTitle: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  label: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 13,
    fontWeight: "700",
  },
  input: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 16,
    padding: brandSpacing.s3,
    borderRadius: brandRadii.md,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.line,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: brandSpacing.s3,
  },
  helpText: {
    color: t.dim,
    fontFamily: brandFonts.sans,
    fontSize: 11,
    marginTop: 2,
  },
  modalActions: {
    flexDirection: "row",
    gap: brandSpacing.s3,
    marginTop: "auto",
    paddingTop: brandSpacing.s4,
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: t.accent,
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryLabel: {
    color: INK,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "800",
  },
  secondaryBtn: {
    flex: 1,
    minHeight: 44,
    paddingVertical: brandSpacing.s3,
    borderRadius: brandRadii.pill,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: t.lineStrong,
  },
  secondaryLabel: {
    color: t.fg,
    fontFamily: brandFonts.sans,
    fontSize: 14,
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.6,
  },
});
