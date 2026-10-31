import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { Note, NoteSection, NoteTemplate } from "../../../shared/types";
import { errorMessage } from "../api";
import { notesApi } from "../api/notes";
import { allSectionPaths, defaultTemplate, sectionLabel, TEMPLATES, validateTitle } from "../lib/notes";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import { CloseIcon } from "./icons";
import styles from "./NewNoteDialog.module.css";

// New note: title (focused on open), section and template. The template follows the section
// (Meeting inside Meeting notes, Personal inside Personal notes, else Blank) until you pick one
// yourself. Enter creates; Escape or Cancel closes. The server writes the file with the template's
// headings and the editor opens with the caret under the first heading.

/** Hover help for each template: what the new file starts with. */
const TEMPLATE_TIPS: Record<NoteTemplate, string> = {
  meeting: "Starts with five meeting headings and an empty task under Action items.",
  personal: "Starts with a single Notes heading, with the caret under it.",
  blank: "Starts with an empty page and no headings.",
};

export interface NewNoteDialogProps {
  open: boolean;
  sections: NoteSection[];
  /** Section picked when the dialog opens. */
  initialSection: string;
  /**
   * Template picked when the dialog opens ("New meeting note here" in the right-click menu). It then
   * stays when the section changes, as if picked by hand. Null or absent: the template follows the section.
   */
  initialTemplate?: NoteTemplate | null;
  onCancel: () => void;
  onCreated: (note: Note) => void;
}

export function NewNoteDialog({ open, sections, initialSection, initialTemplate, onCancel, onCreated }: NewNoteDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [title, setTitle] = useState("");
  const [section, setSection] = useState(initialSection);
  const [template, setTemplate] = useState<NoteTemplate>(defaultTemplate(initialSection));
  const [templateTouched, setTemplateTouched] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uid = useId().replace(/:/g, "");
  const ids = {
    heading: `new-note-${uid}`,
    title: `new-note-title-${uid}`,
    titleError: `new-note-title-error-${uid}`,
    section: `new-note-section-${uid}`,
    template: `new-note-template-${uid}`,
  };
  const paths = useMemo(() => allSectionPaths(sections), [sections]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setTitle("");
      setSection(initialSection);
      setTemplate(initialTemplate ?? defaultTemplate(initialSection));
      setTemplateTouched(!!initialTemplate);
      setTitleError(null);
      setFailure(null);
      setBusy(false);
      dialog.showModal();
      titleRef.current?.focus();
    }
    if (!open && dialog.open) {
      dialog.close();
      if (opener.current?.isConnected) opener.current.focus();
    }
    // Only the open flag reopens the form; the section and template are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = validateTitle(title);
    setTitleError(problem);
    if (problem) {
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const note = await notesApi.create({ section, title: title.trim(), template });
      onCreated(note);
    } catch (err) {
      setFailure(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={ids.heading}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
        <div className={styles.head}>
          <h2 id={ids.heading} className={styles.heading}>
            New note
          </h2>
          <Button
            variant="ghost"
            size="sm"
            icon={<CloseIcon />}
            aria-label="Close"
            onClick={onCancel}
            disabled={busy}
            className={styles.close}
            tip="Closes the form without creating a note; Esc does the same."
          />
        </div>

        <div className={styles.field}>
          <label htmlFor={ids.title} className={styles.label}>
            Title
          </label>
          <input
            ref={titleRef}
            id={ids.title}
            className={styles.input}
            value={title}
            dir="auto"
            autoComplete="off"
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? ids.titleError : undefined}
            onChange={(e) => {
              setTitle(e.target.value);
              if (titleError) setTitleError(validateTitle(e.target.value));
            }}
          />
          {titleError ? (
            <p id={ids.titleError} className={styles.error}>
              {titleError}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label htmlFor={ids.section} className={styles.label}>
            Section
          </label>
          <select
            id={ids.section}
            className={styles.input}
            value={section}
            data-tip="Picks the section folder for the note; the template follows it until you pick one."
            onChange={(e) => {
              const next = e.target.value;
              setSection(next);
              if (!templateTouched) setTemplate(defaultTemplate(next));
            }}
          >
            {paths.map((p) => (
              <option key={p} value={p}>
                {sectionLabel(p)}
              </option>
            ))}
          </select>
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>Template</legend>
          <div className={styles.templates}>
            {TEMPLATES.map((t) => (
              <label key={t.id} className={styles.template} data-tip={TEMPLATE_TIPS[t.id]}>
                <input
                  type="radio"
                  name={ids.template}
                  value={t.id}
                  checked={template === t.id}
                  onChange={() => {
                    setTemplate(t.id);
                    setTemplateTouched(true);
                  }}
                />
                <span className={styles.templateName}>{t.label}</span>
                <span className={styles.templateHint}>{t.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {failure ? (
          <p className={styles.failure} role="alert">
            <StatusDot tone="danger" size={9} glow={false} />
            <span>Couldn't create the note. {failure}</span>
          </p>
        ) : null}

        <div className={styles.actions}>
          <Button variant="ghost" onClick={onCancel} disabled={busy} tip="Closes the form; no note is created.">
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            loadingLabel="Creating"
            tip="Writes the markdown file in the chosen section and opens it, ready to type."
          >
            Create note
          </Button>
        </div>
      </form>
    </dialog>
  );
}
