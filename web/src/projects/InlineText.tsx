import { useEffect, useId, useLayoutEffect, useRef, useState, type ElementType, type KeyboardEvent } from "react";
import { errorMessage } from "../api";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import { PencilIcon } from "./icons";
import { partStyles } from "./parts";
import styles from "./InlineText.module.css";

// Text you edit where it sits: the project name, its description, a goal, a task. A pencil button
// (and a click on the text) switches to a field; Enter saves (Ctrl+Enter in a multi-line field),
// Escape cancels, leaving the field saves. A failed save keeps the field open with the text and
// the reason. Focus returns to the pencil after saving or cancelling.

export interface InlineTextProps {
  value: string;
  /** Accessible name of the field, e.g. "Project name". */
  label: string;
  /** Pencil button's accessible name, e.g. "Rename project". */
  editLabel: string;
  onSave: (next: string) => Promise<unknown> | void;
  maxLength: number;
  multiline?: boolean;
  /** Empty is not allowed: this message shows instead of saving. */
  requiredMessage?: string;
  /** Shown (muted) when the value is empty. */
  emptyText?: string;
  as?: ElementType;
  className?: string;
  /** Extra id for the text element (headings that label a region). */
  id?: string;
  /** Hide the pencil until the row is hovered or focused (dense lists); it stays reachable by Tab. */
  quietButton?: boolean;
}

export function InlineText({
  value,
  label,
  editLabel,
  onSave,
  maxLength,
  multiline = false,
  requiredMessage,
  emptyText,
  as: Tag = "span",
  className,
  id,
  quietButton = false,
}: InlineTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  /** Set when Escape or Enter already handled the field, so the blur that follows does not save again. */
  const handled = useRef(false);
  const uid = useId().replace(/:/g, "");
  const errorId = `inline-${uid}-error`;

  useLayoutEffect(() => {
    if (!editing) return;
    const el = fieldRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    buttonRef.current?.focus();
  }, [editing]);

  const start = () => {
    handled.current = false;
    setDraft(value);
    setError(null);
    setEditing(true);
  };

  const cancel = (refocus = true) => {
    handled.current = true;
    setError(null);
    setEditing(false);
    returnFocus.current = refocus;
  };

  const commit = async (refocus: boolean) => {
    if (saving) return;
    const next = multiline ? draft.replace(/\s+$/, "") : draft.trim();
    if (next === value.trim()) {
      cancel(refocus);
      return;
    }
    if (next === "" && requiredMessage) {
      setError(requiredMessage);
      fieldRef.current?.focus();
      return;
    }
    if ([...next].length > maxLength) {
      setError(`Keep it to ${maxLength} characters or fewer (now ${[...next].length}).`);
      fieldRef.current?.focus();
      return;
    }
    // The field is disabled while saving, which blurs it: that blur must not save a second time.
    handled.current = true;
    setSaving(true);
    try {
      await onSave(next);
      setSaving(false);
      setEditing(false);
      returnFocus.current = refocus;
    } catch (err) {
      setSaving(false);
      setError(errorMessage(err));
      handled.current = false;
      requestAnimationFrame(() => fieldRef.current?.focus());
    }
  };

  if (editing) {
    const common = {
      ref: fieldRef,
      value: draft,
      dir: "auto" as const,
      "aria-label": label,
      "aria-invalid": error ? true : undefined,
      "aria-describedby": error ? errorId : undefined,
      disabled: saving,
      className: multiline ? `${partStyles.textarea} ${styles.field}` : `${partStyles.input} ${styles.field}`,
      onChange: (e: { target: { value: string } }) => {
        setDraft(e.target.value);
        if (error) setError(null);
      },
      onBlur: () => {
        if (handled.current) return;
        void commit(false);
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        } else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void commit(true);
        }
      },
    };
    return (
      <span className={[styles.editing, Tag === "span" ? "" : styles.block].join(" ")} data-multiline={multiline || undefined}>
        {multiline ? <textarea {...common} rows={3} /> : <input {...common} type="text" />}
        <span className={styles.help} aria-hidden="true">
          {saving ? "Saving" : multiline ? "Ctrl+Enter to save, Esc to cancel" : "Enter to save, Esc to cancel"}
        </span>
        {error ? (
          <span id={errorId} className={partStyles.fieldError} role="alert">
            <StatusDot tone="danger" size={9} glow={false} />
            {error}
          </span>
        ) : null}
      </span>
    );
  }

  const empty = value.trim() === "";
  return (
    <span className={[styles.view, quietButton ? styles.quiet : ""].join(" ")}>
      <Tag id={id} className={[className, empty ? styles.empty : ""].filter(Boolean).join(" ")} dir="auto" onClick={start}>
        {empty ? (emptyText ?? "") : value}
      </Tag>
      <Button ref={buttonRef} variant="ghost" size="sm" icon={<PencilIcon />} aria-label={editLabel} title={editLabel} className={styles.pencil} onClick={start} />
    </span>
  );
}
