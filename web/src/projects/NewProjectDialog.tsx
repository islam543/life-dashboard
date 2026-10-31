import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import type { DetectedProject, Project, ProjectArea, ProjectStatus } from "../../../shared/types";
import { errorMessage } from "../api";
import { projectsApi } from "../api/projects";
import {
  addedProject,
  AREA_LABEL,
  AREA_ORDER,
  detectedFacts,
  displayName,
  emptyProjectForm,
  LIMITS,
  matchesQuery,
  projectInputFrom,
  STATUS_LABEL,
  validateProjectForm,
  type ProjectFormErrors,
  type ProjectFormValues,
} from "../lib/projects";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import { CloseIcon } from "./icons";
import { KindIcon, partStyles } from "./parts";
import type { ProjectsStore } from "./useProjects";
import styles from "./Dialog.module.css";

// New project: name, area, status, deadline, description, and untracked names to fold in as its
// sources. One column, labels above fields, optional fields marked. Validation on submit, then each
// field re-checks as you fix it; an error summary takes focus. Escape on a form with typed answers
// asks once before discarding.

const NEW_STATUSES: readonly ProjectStatus[] = ["active", "idea", "paused"];
const SEARCH_FROM = 7;

/** Hover help on each status choice: where the project lands. */
const STATUS_TIP: Partial<Record<ProjectStatus, string>> = {
  active: "Starts it under Active; only Active projects show in Needs you.",
  idea: "Parks it under Ideas until you set it to Active on its page.",
  paused: "Files it under Paused, out of Needs you until you set it to Active.",
};

export interface NewProjectDialogProps {
  open: boolean;
  store: ProjectsStore;
  /** Status picked when the form opens (a lane's right-click menu: Add idea picks Idea). Default Active. */
  initialStatus?: ProjectStatus;
  onClose: () => void;
  onCreated: (project: Project) => void;
}

export function NewProjectDialog({ open, store, initialStatus, onClose, onCreated }: NewProjectDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession((s) => s + 1);
  }

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby="new-project-title" onClose={onClose}>
      {open && session > 0 ? (
        <NewProjectForm
          key={session}
          store={store}
          initialStatus={initialStatus}
          dialogRef={ref}
          onClose={onClose}
          onCreated={onCreated}
        />
      ) : null}
    </dialog>
  );
}

function NewProjectForm({
  store,
  initialStatus,
  dialogRef,
  onClose,
  onCreated,
}: {
  store: ProjectsStore;
  initialStatus?: ProjectStatus;
  dialogRef: RefObject<HTMLDialogElement>;
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const id = (name: string) => `np-${uid}-${name}`;
  const [values, setValues] = useState<ProjectFormValues>(() => {
    const empty = emptyProjectForm();
    return initialStatus && NEW_STATUSES.includes(initialStatus) ? { ...empty, status: initialStatus } : empty;
  });
  const [errors, setErrors] = useState<ProjectFormErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [query, setQuery] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const dirty =
    values.name.trim() !== "" || values.description.trim() !== "" || values.deadline !== "" || values.sources.length > 0;

  const untracked = store.state?.untracked ?? [];
  const filtered = useMemo(() => untracked.filter((d) => matchesQuery(d.name, query)), [untracked, query]);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Escape: closes an untouched form; with answers typed, the first press only warns.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      if (saving) return;
      if (!dirty || armed) onClose();
      else setArmed(true);
    };
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [dialogRef, dirty, armed, saving, onClose]);

  const update = (patch: Partial<ProjectFormValues>) => {
    setArmed(false);
    setFailure(null);
    setValues((v) => {
      const next = { ...v, ...patch };
      if (attempted) setErrors(validateProjectForm(next));
      return next;
    });
  };

  const toggleSource = (d: DetectedProject, on: boolean) => {
    const rest = values.sources.filter((s) => !(s.name === d.name && s.kind === d.kind));
    update({ sources: on ? [...rest, { name: d.name, kind: d.kind }] : rest });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setAttempted(true);
    const found = validateProjectForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setSaving(true);
    setFailure(null);
    const before = store.state?.projects ?? [];
    try {
      const next = await store.write(() => projectsApi.create(projectInputFrom(values)));
      const created = addedProject(before, next.projects);
      setSaving(false);
      onClose();
      if (created) onCreated(created);
    } catch (err) {
      setSaving(false);
      setFailure(errorMessage(err));
      requestAnimationFrame(() => summaryRef.current?.focus());
    }
  };

  const errorList = Object.entries(errors) as [keyof ProjectFormErrors, string][];
  const descLength = [...values.description].length;

  return (
    <form className={styles.form} noValidate onSubmit={(e) => void submit(e)}>
      <header className={styles.head}>
        <h2 id="new-project-title" className={styles.title}>
          New project
        </h2>
        <Button
          variant="ghost"
          size="sm"
          icon={<CloseIcon />}
          className={styles.close}
          aria-label="Close without saving"
          onClick={onClose}
          disabled={saving}
          tip={saving ? "Works again if creating the project fails." : "Closes the form and discards what you typed."}
        />
      </header>

      <div className={styles.body}>
        {errorList.length > 0 || failure ? (
          <div ref={summaryRef} className={styles.summary} role="alert" tabIndex={-1}>
            {failure ? (
              <p>
                <strong>Couldn't create the project.</strong> {failure}
              </p>
            ) : (
              <>
                <p>
                  <strong>Fix {errorList.length === 1 ? "this" : "these"} to create the project:</strong>
                </p>
                {errorList.map(([field, message]) => (
                  <button
                    key={field}
                    type="button"
                    className={styles.summaryLink}
                    onClick={() => document.getElementById(id(field))?.focus()}
                    data-tip="Moves to the field with this problem so you can fix it."
                  >
                    {message}
                  </button>
                ))}
              </>
            )}
          </div>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor={id("name")}>
            Name
            <span className={styles.counter} data-over={[...values.name.trim()].length > LIMITS.name || undefined}>
              {[...values.name.trim()].length}/{LIMITS.name}
            </span>
          </label>
          <input
            ref={nameRef}
            id={id("name")}
            className={partStyles.input}
            value={values.name}
            dir="auto"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? id("name-error") : undefined}
            onChange={(e) => update({ name: e.target.value })}
          />
          {errors.name ? (
            <p id={id("name-error")} className={partStyles.fieldError}>
              <StatusDot tone="danger" size={9} glow={false} />
              {errors.name}
            </p>
          ) : null}
        </div>

        <div className={styles.row}>
          <fieldset className={styles.field}>
            <legend className={styles.label}>Area</legend>
            <div className={styles.choices}>
              {AREA_ORDER.map((a) => (
                <label key={a} className={styles.choice} data-tip={`Files it under ${AREA_LABEL[a]}, for the board's Area filter and the life map.`}>
                  <input type="radio" name={id("area")} value={a} checked={values.area === a} onChange={() => update({ area: a as ProjectArea })} />
                  <span>{AREA_LABEL[a]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.field}>
            <legend className={styles.label}>Status</legend>
            <div className={styles.choices}>
              {NEW_STATUSES.map((s) => (
                <label key={s} className={styles.choice} data-tip={STATUS_TIP[s]}>
                  <input type="radio" name={id("status")} value={s} checked={values.status === s} onChange={() => update({ status: s })} />
                  <span>{STATUS_LABEL[s]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={id("deadline")}>
            Deadline <span className={styles.optional}>(optional)</span>
          </label>
          <input
            id={id("deadline")}
            type="date"
            className={partStyles.input}
            style={{ maxWidth: 200 }}
            value={values.deadline}
            aria-invalid={errors.deadline ? true : undefined}
            aria-describedby={errors.deadline ? id("deadline-error") : undefined}
            onChange={(e) => update({ deadline: e.target.value })}
          />
          {errors.deadline ? (
            <p id={id("deadline-error")} className={partStyles.fieldError}>
              <StatusDot tone="danger" size={9} glow={false} />
              {errors.deadline}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={id("description")}>
            Description <span className={styles.optional}>(optional)</span>
            {descLength > LIMITS.description * 0.8 ? (
              <span className={styles.counter} data-over={descLength > LIMITS.description || undefined}>
                {descLength}/{LIMITS.description}
              </span>
            ) : null}
          </label>
          <textarea
            id={id("description")}
            className={partStyles.textarea}
            rows={3}
            dir="auto"
            value={values.description}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={[id("description-hint"), errors.description ? id("description-error") : ""].filter(Boolean).join(" ")}
            onChange={(e) => update({ description: e.target.value })}
          />
          <p id={id("description-hint")} className={styles.hint}>
            What this project is for, in a line or two.
          </p>
          {errors.description ? (
            <p id={id("description-error")} className={partStyles.fieldError}>
              <StatusDot tone="danger" size={9} glow={false} />
              {errors.description}
            </p>
          ) : null}
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.label}>
            Fold in detected names <span className={styles.optional}>(optional)</span>
          </legend>
          <p className={styles.hint} id={id("sources-hint")}>
            Their Claude Code time and GitHub commits will count toward this project.
            {values.sources.length > 0 ? ` ${values.sources.length} selected.` : ""}
          </p>
          {untracked.length === 0 ? (
            <p className={styles.sourceNone}>No untracked names right now. You can add sources later from the project page.</p>
          ) : (
            <div className={styles.sourceBox}>
              {untracked.length >= SEARCH_FROM ? (
                <input
                  type="search"
                  className={partStyles.input}
                  aria-label="Filter detected names"
                  placeholder="Filter detected names"
                  value={query}
                  spellCheck={false}
                  onChange={(e) => setQuery(e.target.value)}
                />
              ) : null}
              <ul className={styles.sourceList} aria-describedby={id("sources-hint")}>
                {filtered.length === 0 ? <li className={styles.sourceNone}>Nothing matches “{query.trim()}”.</li> : null}
                {filtered.map((d) => {
                  const checked = values.sources.some((s) => s.name === d.name && s.kind === d.kind);
                  return (
                    <li key={`${d.kind}:${d.name}`} className={styles.sourceItem}>
                      <label>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => toggleSource(d, e.target.checked)}
                          data-tip="Folds this name in, so its time and commits count toward the new project."
                        />
                        <KindIcon kind={d.kind} />
                        <span className={styles.sourceName} dir="auto" title={d.name}>
                          {displayName(d.name)}
                        </span>
                        <span className={styles.sourceFacts}>{detectedFacts(d)}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </fieldset>
      </div>

      <footer className={styles.foot}>
        <p className={styles.footNote} aria-live="polite">
          {armed ? (
            <>
              <StatusDot tone="warn" size={9} glow={false} /> Press Esc again to discard this project.
            </>
          ) : null}
        </p>
        <Button
          variant="secondary"
          onClick={onClose}
          disabled={saving}
          tip={saving ? "Works again if creating the project fails." : "Closes the form without creating a project."}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={saving}
          loadingLabel="Creating"
          tip="Creates the project and opens its page, ready for its first task."
        >
          Create project
        </Button>
      </footer>
    </form>
  );
}
