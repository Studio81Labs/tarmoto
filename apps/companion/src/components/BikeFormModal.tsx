"use client";
import { t } from "@/i18n";
import { useEffect, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { Button, FieldLabel, Input } from "@tarmoto/ui";
import {
  EMPTY_BIKE_FORM,
  type BikeFormErrors,
  type BikeFormPayload,
  type BikeFormValues,
  bikeToFormValues,
  formValuesToPayload,
  hasErrors,
  validateBikeForm,
} from "@/lib/bikes";
import type { Bike } from "@/lib/types";
interface BikeFormModalProps {
  open: boolean;
  mode: "add" | "edit";
  initialBike?: Bike;
  onClose: () => void;
  onSubmit: (payload: BikeFormPayload) => Promise<void>;
}
export function BikeFormModal({
  open,
  mode,
  initialBike,
  onClose,
  onSubmit,
}: BikeFormModalProps) {
  const [values, setValues] = useState<BikeFormValues>(EMPTY_BIKE_FORM);
  const [errors, setErrors] = useState<BikeFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Reset form state whenever the modal opens with a different bike, so the
  // "Edit" form shows the target bike's values rather than stale form state.
  useEffect(() => {
    if (!open) return;
    setValues(initialBike ? bikeToFormValues(initialBike) : EMPTY_BIKE_FORM);
    setErrors({});
    setSubmitError(null);
    setSubmitting(false);
  }, [open, initialBike]);
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);
  if (!open) return null;
  function setField<K extends keyof BikeFormValues>(
    key: K,
    value: BikeFormValues[K],
  ) {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setSubmitError(null);
  }
  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    const validation = validateBikeForm(values);
    if (hasErrors(validation)) {
      setErrors(validation);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(formValuesToPayload(values));
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Could not save bike",
      );
      setSubmitting(false);
    }
  }
  const title = mode === "add" ? "Add a bike" : "Edit bike";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bike-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-sm"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-cream border border-line shadow-[0_24px_60px_rgba(14,14,16,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-5 border-b border-line">
          <h2
            id="bike-modal-title"
            className="font-sans font-extrabold tracking-[-0.5px] text-[22px] text-ink"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label={t("Close")}
            className="p-1 rounded-md text-fg-dim hover:text-ink hover:bg-paper transition disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="p-5 space-y-4" noValidate>
          <Field
            id="bike-make"
            label="Make"
            value={values.make}
            onChange={(v) => setField("make", v)}
            error={errors.make}
            placeholder={t("Yamaha")}
            autoFocus
          />
          <Field
            id="bike-model"
            label="Model"
            value={values.model}
            onChange={(v) => setField("model", v)}
            error={errors.model}
            placeholder={t("MT-09")}
          />
          <Field
            id="bike-year"
            label="Year"
            value={values.year}
            onChange={(v) => setField("year", v)}
            error={errors.year}
            placeholder="2024"
            inputMode="numeric"
            maxLength={4}
          />
          <Field
            id="bike-photo"
            label="Photo URL (optional)"
            value={values.photoUrl}
            onChange={(v) => setField("photoUrl", v)}
            error={errors.photoUrl}
            placeholder={t("https://\u2026")}
            helpText="Paste a link to a photo of your bike. File upload is coming soon."
          />

          {submitError && (
            <div className="rounded-lg border border-quality-q1/30 bg-quality-q1/10 px-3 py-2 text-sm text-red-400">
              {submitError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" disabled={submitting} onClick={onClose}>
              {t("Cancel ")}
            </Button>
            <Button
              type="submit"
              variant="accent"
              size="sm"
              uppercase
              loading={submitting}
            >
              {submitting
                ? t("Saving\u2026 ")
                : mode === "add"
                  ? "Add bike"
                  : "Save changes"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  placeholder?: string;
  helpText?: string;
  inputMode?: "text" | "numeric";
  maxLength?: number;
  autoFocus?: boolean;
}
function Field({
  id,
  label,
  value,
  onChange,
  error,
  placeholder,
  helpText,
  inputMode,
  maxLength,
  autoFocus,
}: FieldProps) {
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        onChange={onChange}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(inputMode !== undefined ? { inputMode } : {})}
        {...(maxLength !== undefined ? { maxLength } : {})}
        {...(autoFocus !== undefined ? { autoFocus } : {})}
        error={!!error}
        hint={error ?? helpText}
      />
    </div>
  );
}
