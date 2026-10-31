import { useEffect, useRef } from "react";
import type { Project } from "../../../shared/types";
import { plural } from "../lib/format";
import { displayName, sourceCount } from "../lib/projects";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import { partStyles } from "./parts";
import styles from "./Dialog.module.css";

// The confirm step before deleting a project. Says exactly what happens: its sources go back to
// Untracked, its tasks and goals go, its linked notes keep their files. Focus starts on Keep
// project, so Enter never deletes by accident; Escape keeps it too.

export interface DeleteProjectDialogProps {
  open: boolean;
  project: Project;
  /** Notes linked to the project; null when the notes folder could not be read. */
  noteCount: number | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function listNames(names: readonly string[], max = 4): string {
  const shown = names.slice(0, max).map(displayName);
  return names.length > max ? `${shown.join(", ")} and ${names.length - max} more` : shown.join(", ");
}

export function DeleteProjectDialog({ open, project, noteCount, busy, error, onCancel, onConfirm }: DeleteProjectDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      keepRef.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const sources = [...project.sources.sessions, ...project.sources.repos];
  const nSources = sourceCount(project.sources);
  const openTasks = project.tasks.filter((t) => !t.done).length;

  return (
    <dialog
      ref={ref}
      className={`${styles.dialog} ${styles.danger}`}
      aria-labelledby="delete-project-title"
      aria-describedby="delete-project-what"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClose={() => {
        if (open && !busy) onCancel();
      }}
    >
      <div className={styles.form}>
        <header className={styles.head}>
          <h2 id="delete-project-title" className={styles.title} dir="auto">
            Delete {project.name}?
          </h2>
        </header>
        <div className={styles.body}>
          <ul id="delete-project-what" className={styles.consequences}>
            <li>
              <span>
                {nSources === 0 ? (
                  "It has no sources, so no time moves."
                ) : (
                  <>
                    {nSources === 1
                      ? "Its source goes back to Untracked, where you can track it again."
                      : `Its ${plural(nSources, "source")} go back to Untracked, where you can track them again.`}{" "}
                    <span className={styles.names} dir="auto">
                      {listNames(sources)}
                    </span>
                  </>
                )}
              </span>
            </li>
            <li data-tone={project.tasks.length + project.goals.length > 0 ? "danger" : undefined}>
              <span>
                {project.tasks.length + project.goals.length === 0
                  ? "It has no tasks or goals to lose."
                  : `Its ${plural(project.tasks.length, "task")}${openTasks > 0 ? ` (${openTasks} open)` : ""} and ${plural(project.goals.length, "goal")} are deleted. This can't be undone.`}
              </span>
            </li>
            <li>
              <span>
                {noteCount === null
                  ? "Linked notes keep their files in the vault."
                  : noteCount === 0
                    ? "No notes are linked to it."
                    : `Its ${plural(noteCount, "linked note")} keep their files in the vault.`}
              </span>
            </li>
          </ul>
          {error ? (
            <p className={partStyles.fieldError} role="alert">
              <StatusDot tone="danger" size={9} glow={false} />
              Couldn't delete the project. {error}
            </p>
          ) : null}
        </div>
        <footer className={styles.foot}>
          <Button ref={keepRef} variant="secondary" onClick={onCancel} disabled={busy}>
            Keep project
          </Button>
          <Button variant="secondary" className={partStyles.dangerSolid} onClick={onConfirm} loading={busy} loadingLabel="Deleting">
            Delete project
          </Button>
        </footer>
      </div>
    </dialog>
  );
}
