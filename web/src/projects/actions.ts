import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { NoteMeta, Project, ProjectsState } from "../../../shared/types";
import { ApiRequestError, errorMessage } from "../api";
import { notesApi } from "../api/notes";
import { projectsApi, type ProjectPatch } from "../api/projects";
import type { MenuSection } from "../lib/contextMenu";
import { meetingNoteTitle, notesByProject } from "../lib/projects";
import { noteHash, projectHash } from "../lib/route";
import { useMenuRegion } from "../ui/ContextMenu";
import { absoluteLink } from "./menus";
import { useToasts } from "./Toasts";
import type { NotesState, ProjectsStore } from "./useProjects";

// Project actions shared by the visible controls and the right-click menus, so both do exactly the
// same thing: saving a field, starting a meeting note, deleting a project (with its confirm step),
// copying a project's link. Plus useTargetMenuRegion, a menu region that knows what was right-clicked.

/** Rows with a menu of their own (a task, a goal, a source) set this, so the page's menu stays out. */
export const ROW_MENU = "data-row-menu";

/**
 * useMenuRegion, but the builder also gets the element under the pointer (or the focused element for
 * the menu key), so an outer region can step aside for a card or a row, or skip open dialogs.
 */
export function useTargetMenuRegion(build: (target: Element | null) => MenuSection | null | undefined): {
  onContextMenu: (e: ReactMouseEvent) => void;
} {
  const target = useRef<Element | null>(null);
  const { onContextMenu: offer } = useMenuRegion(() => build(target.current));
  const onContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      target.current = e.target instanceof Element ? e.target : null;
      offer(e);
    },
    [offer],
  );
  return { onContextMenu };
}

/** Clicks a visible control inside `root`, so a menu item runs that control's own handler. */
export function clickIn(root: ParentNode | null | undefined, selector: string): void {
  root?.querySelector<HTMLElement>(selector)?.click();
}

/** Moves focus to a field inside `root`, scrolling it into view. */
export function focusIn(root: ParentNode | null | undefined, selector: string): void {
  root?.querySelector<HTMLElement>(selector)?.focus();
}

export function patchProject(s: ProjectsState, id: string, patch: Partial<Project>): ProjectsState {
  return { ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

/** Saves project fields. saveOrToast also reports a failure as a toast, for controls with no room for an inline error. */
export function useProjectSave(store: ProjectsStore) {
  const toasts = useToasts();
  const save = (id: string, patch: ProjectPatch) =>
    store.write(() => projectsApi.update(id, patch), (s) => patchProject(s, id, patch));
  const saveOrToast = (id: string, patch: ProjectPatch, what: string) =>
    save(id, patch).catch((err) => {
      toasts.push({ tone: "error", message: `Couldn't save the ${what}. ${errorMessage(err)}` });
      throw err;
    });
  return { save, saveOrToast };
}

export const MEETING_SECTION = "Meeting notes";

/** Hover help for New meeting note: what it does, or why it is off right now. */
export function meetingNoteTip(status: NotesState["status"]): string {
  switch (status) {
    case "ok":
    case "stale":
      return `Creates a dated note in ${MEETING_SECTION}, linked to this project, and opens it.`;
    case "not_connected":
      return "Needs a notes folder first; set NOTES_DIR in .env.";
    case "failed":
      return "Needs Notes to be reachable; retry in the Notes panel.";
    case "error":
      return "Needs a readable notes folder; the Notes panel says what went wrong.";
    case "never_run":
      return "Needs your notes to be read first, which happens on the next refresh.";
    default:
      return "Needs your notes to finish loading first.";
  }
}

/** New meeting note: writes a dated note in Meeting notes linked to the project, then opens it. */
export function useMeetingNote(store: ProjectsStore) {
  const toasts = useToasts();
  /** Id of the project whose note is being created. */
  const [creating, setCreating] = useState<string | null>(null);
  const ready = store.notes.status === "ok" || store.notes.status === "stale";

  const start = async (project: Project) => {
    if (creating) return;
    setCreating(project.id);
    try {
      const note = await notesApi.create({
        section: MEETING_SECTION,
        title: meetingNoteTitle(project.name, new Date()),
        projectId: project.id,
        template: "meeting",
      });
      window.location.hash = noteHash(note.path);
    } catch (err) {
      setCreating(null);
      toasts.push({ tone: "error", message: `Couldn't start a meeting note. ${errorMessage(err)}` });
    }
  };

  return { start, creating, ready, tip: meetingNoteTip(store.notes.status) };
}

export type MeetingNote = ReturnType<typeof useMeetingNote>;

/** Why New meeting note is off for `project`, or false when it can run. */
export function meetingNoteOff(note: MeetingNote): string | false {
  if (!note.ready) return note.tip;
  if (note.creating) return "Works again once the meeting note being started opens.";
  return false;
}

/**
 * Deleting a project: ask opens the confirm dialog (DeleteProjectDialog), confirm deletes and calls
 * onDeleted (also when it was already gone). A failure keeps the dialog open with the reason.
 */
export function useDeleteProject(
  store: ProjectsStore,
  onDeleted: (project: Project) => void,
  hooks?: { onStart?: () => void; onFail?: () => void },
) {
  const [project, setProject] = useState<Project | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = (p: Project) => {
    setProject(p);
    setError(null);
    setOpen(true);
  };

  const cancel = () => {
    setOpen(false);
    setError(null);
  };

  const confirm = async () => {
    if (!project) return;
    const p = project;
    setBusy(true);
    setError(null);
    hooks?.onStart?.();
    try {
      await store.write(() => projectsApi.remove(p.id));
      setOpen(false);
      setBusy(false);
      onDeleted(p);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        setOpen(false);
        setBusy(false);
        onDeleted(p);
        return;
      }
      hooks?.onFail?.();
      setBusy(false);
      setError(errorMessage(err));
    }
  };

  return { project, open, busy, error, ask, cancel, confirm };
}

/** Notes linked to `projectId`, or null when the notes could not be read. */
export function linkedNoteCount(notes: readonly NoteMeta[] | null, projectId: string): number | null {
  return notes ? (notesByProject(notes).get(projectId)?.length ?? 0) : null;
}

/** False where the page can't reach the clipboard (an insecure address); Copy link is then left out. */
export function canCopyLinks(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
}

/** Copies the project's full address and says so in a toast. */
export function copyProjectLink(project: Project, push: ReturnType<typeof useToasts>["push"]): void {
  const url = absoluteLink(projectHash(project.id), window.location);
  navigator.clipboard.writeText(url).then(
    () => push({ tone: "success", message: `Copied the link to ${project.name}.` }),
    () =>
      push({
        tone: "error",
        message: "Couldn't copy the link: the browser blocked the clipboard. Shift + right-click the card and copy the link address instead.",
      }),
  );
}
