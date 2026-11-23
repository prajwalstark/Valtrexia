"use client";

import type { ChannelState } from "@/lib/notifications-core";

/** Pieces the channel forms share. */

export type FormAction = (previous: ChannelState, formData: FormData) => Promise<ChannelState>;

export const TYPES = [
  { value: "failed", label: "Failed backups" },
  { value: "missed", label: "Missed backups" },
  { value: "stale", label: "Backups past their SLA" },
] as const;

export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p id={id} className="mt-1.5 text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

export function Check({
  name,
  value,
  label,
  checked,
  onChange,
}: {
  name: string;
  value?: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        name={name}
        value={value ?? "on"}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-[var(--color-iris)]"
      />
      {label}
    </label>
  );
}
