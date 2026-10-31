import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../api";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import styles from "./ConfirmDialog.module.css";

// A small modal question on the native <dialog>: Escape and Cancel close it, focus starts on the
// safe choice (WAI-ARIA dialog pattern for destructive actions) and returns to the opener on close.
// `onConfirm` may be async: the button shows a spinner and a failure is shown inside the dialog.

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Label while onConfirm runs, e.g. "Moving to trash". */
  confirmingLabel?: string;
  cancelLabel: string;
  /** "danger" for deletes. */
  tone?: "danger" | "default";
  /** Which button has focus when the dialog opens. Default "cancel". */
  initialFocus?: "cancel" | "confirm";
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  confirmingLabel,
  cancelLabel,
  tone = "default",
  initialFocus = "cancel",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = `confirm-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setError(null);
      setBusy(false);
      dialog.showModal();
      (initialFocus === "confirm" ? confirmRef : cancelRef).current?.focus();
    }
    if (!open && dialog.open) {
      dialog.close();
      if (opener.current?.isConnected) opener.current.focus();
    }
  }, [open, initialFocus]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className={styles.inner} data-tone={tone}>
        <h2 id={titleId} className={styles.title} dir="auto">
          {title}
        </h2>
        <div className={styles.body}>{children}</div>
        {error ? (
          <p className={styles.error} role="alert">
            <StatusDot tone="danger" size={9} glow={false} />
            <span>{error}</span>
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant="primary"
            className={tone === "danger" ? styles.danger : undefined}
            onClick={() => void confirm()}
            loading={busy}
            loadingLabel={confirmingLabel}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
