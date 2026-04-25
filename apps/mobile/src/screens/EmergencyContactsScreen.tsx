/**
 * EmergencyContactsScreen — US-12 AC #4.
 *
 * List, add, edit, and delete the rider's emergency contacts. Backed by
 * `/users/me/contacts` (GET / POST / PATCH / DELETE). Contacts marked
 * `is_emergency` are the ones the backend will SMS/call when a crash
 * alert dispatches (out-of-scope for this issue, but the toggle is
 * surfaced now so the data is captured).
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import { borderRadius, colors, fontSize, fontWeight, spacing } from "@/theme";
import { api } from "@/services/api";
import type { EmergencyContact, EmergencyContactInput } from "@/types";

type FormMode =
  | { kind: "create" }
  | { kind: "edit"; contact: EmergencyContact };

export default function EmergencyContactsScreen() {
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
        err instanceof Error ? err.message : "Couldn't load contacts.",
      );
    }
  }, []);

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

  const handleDelete = useCallback((contact: EmergencyContact) => {
    Alert.alert(
      "Delete contact?",
      `${contact.name} will no longer be alerted in a crash.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await api.deleteContact(contact.id);
              setContacts((prev) =>
                prev ? prev.filter((c) => c.id !== contact.id) : prev,
              );
            } catch (err) {
              Alert.alert(
                "Couldn't delete contact",
                err instanceof Error ? err.message : "Try again.",
              );
            }
          },
        },
      ],
    );
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Emergency contacts</Text>
      <Text style={styles.subtitle}>
        These contacts get alerted with your location if Tarmoto detects a crash
        and you don't cancel within 30 seconds.
      </Text>

      <TouchableOpacity
        style={styles.addBtn}
        onPress={() => setEditing({ kind: "create" })}
        accessibilityRole="button"
        accessibilityLabel="Add emergency contact"
      >
        <Icon name="plus" size={20} color={colors.textInverse} />
        <Text style={styles.addLabel}>Add contact</Text>
      </TouchableOpacity>

      {loadError ? (
        <View style={styles.errorBanner}>
          <Icon name="alert-circle-outline" size={18} color={colors.danger} />
          <Text style={styles.errorText}>{loadError}</Text>
          <TouchableOpacity onPress={() => void loadContacts()}>
            <Text style={styles.retryLink}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {contacts === null && !loadError ? (
        <ActivityIndicator color={colors.primary} />
      ) : null}

      {contacts && contacts.length === 0 ? (
        <Text style={styles.emptyText}>
          No contacts yet. Add at least one so help can reach you in a crash.
        </Text>
      ) : null}

      {contacts?.map((contact) => (
        <View key={contact.id} style={styles.card}>
          <View style={styles.cardBody}>
            <Text style={styles.contactName}>{contact.name}</Text>
            <Text style={styles.contactPhone}>{contact.phone}</Text>
            {contact.is_emergency ? (
              <View style={styles.badge}>
                <Icon
                  name="bell-ring-outline"
                  size={12}
                  color={colors.textInverse}
                />
                <Text style={styles.badgeLabel}>Emergency contact</Text>
              </View>
            ) : (
              <Text style={styles.contactNote}>Will not be alerted</Text>
            )}
          </View>
          <View style={styles.cardActions}>
            <TouchableOpacity
              onPress={() => setEditing({ kind: "edit", contact })}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${contact.name}`}
              style={styles.iconBtn}
            >
              <Icon name="pencil-outline" size={20} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleDelete(contact)}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${contact.name}`}
              style={styles.iconBtn}
            >
              <Icon name="trash-can-outline" size={20} color={colors.danger} />
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
      setError("Name is required.");
      return;
    }
    if (!trimmedPhone) {
      setError("Phone number is required.");
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
      setError(err instanceof Error ? err.message : "Couldn't save contact.");
      setSubmitting(false);
    }
  }, [mode, name, phone, isEmergency, onSaved]);

  const visible = mode !== null;
  const title = mode?.kind === "create" ? "Add contact" : "Edit contact";

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="formSheet"
    >
      <View style={styles.modalContainer}>
        <Text style={styles.modalTitle}>{title}</Text>

        <Text style={styles.label}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Jane Doe"
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          autoCapitalize="words"
          accessibilityLabel="Contact name"
        />

        <Text style={styles.label}>Phone</Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          placeholder="+420 123 456 789"
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          keyboardType="phone-pad"
          accessibilityLabel="Contact phone"
        />

        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Alert in a crash</Text>
            <Text style={styles.helpText}>
              When off, this contact stays in your list but is not notified.
            </Text>
          </View>
          <Switch
            value={isEmergency}
            onValueChange={setIsEmergency}
            accessibilityLabel="Alert this contact in a crash"
          />
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.modalActions}>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={onClose}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.secondaryLabel}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.primaryBtn, submitting ? styles.disabled : null]}
            onPress={() => void submit()}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Save contact"
            accessibilityState={{ disabled: submitting }}
          >
            {submitting ? (
              <ActivityIndicator color={colors.textInverse} />
            ) : (
              <Text style={styles.primaryLabel}>Save</Text>
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
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fontSize.h1,
    fontWeight: fontWeight.bold,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  addLabel: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardBody: {
    flex: 1,
    gap: spacing.xs,
  },
  contactName: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  contactPhone: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
  },
  contactNote: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontStyle: "italic",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.pill,
    backgroundColor: colors.primary,
  },
  badgeLabel: {
    color: colors.textInverse,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  cardActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  iconBtn: {
    padding: spacing.sm,
  },
  emptyText: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    textAlign: "center",
    paddingVertical: spacing.xl,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.bgCard,
  },
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
    flex: 1,
  },
  retryLink: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  modalTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
  },
  label: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  input: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  helpText: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  modalActions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: "auto",
    paddingTop: spacing.lg,
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    alignItems: "center",
  },
  primaryLabel: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  secondaryBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.pill,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  disabled: {
    opacity: 0.6,
  },
});
