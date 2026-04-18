"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Loader2, X } from "lucide-react";
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-5 border-b border-slate-800">
          <h2
            id="bike-modal-title"
            className="text-lg font-semibold text-white"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition disabled:opacity-50"
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
            placeholder="Yamaha"
            autoFocus
          />
          <Field
            id="bike-model"
            label="Model"
            value={values.model}
            onChange={(v) => setField("model", v)}
            error={errors.model}
            placeholder="MT-09"
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
            placeholder="https://…"
            helpText="Paste a link to a photo of your bike. File upload is coming soon."
          />

          {submitError && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-300">
              {submitError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-800 transition disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold text-sm hover:bg-tarmoto-cyan-light transition disabled:opacity-50 inline-flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Saving…
                </>
              ) : mode === "add" ? (
                "Add bike"
              ) : (
                "Save changes"
              )}
            </button>
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
  error?: string;
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
  const errorId = `${id}-error`;
  return (
    <div>
      <label htmlFor={id} className="block text-sm text-slate-400 mb-1.5">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        autoFocus={autoFocus}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        className={`w-full px-4 py-2.5 rounded-lg bg-slate-800 border text-white text-sm placeholder:text-slate-500 focus:outline-none transition ${
          error
            ? "border-red-500/50 focus:border-red-500"
            : "border-slate-700 focus:border-tarmoto-cyan"
        }`}
      />
      {error ? (
        <p id={errorId} className="mt-1 text-xs text-red-400">
          {error}
        </p>
      ) : helpText ? (
        <p className="mt-1 text-xs text-slate-500">{helpText}</p>
      ) : null}
    </div>
  );
}
