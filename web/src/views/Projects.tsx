import { AnimatePresence } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Project } from "../../../shared/types";
import { projectHash } from "../lib/route";
import { Board, boardStatus } from "../projects/Board";
import { NewProjectDialog } from "../projects/NewProjectDialog";
import { ProjectDetail } from "../projects/ProjectDetail";
import { ToastProvider, useToasts } from "../projects/Toasts";
import { UntrackedTray } from "../projects/UntrackedTray";
import { useProjectsStore } from "../projects/useProjects";
import styles from "./Projects.module.css";

export interface ProjectsProps {
  /** Project id from #/projects/<id>, or null for the board (#/projects). */
  id: string | null;
}

// The #/projects view: the project tracker. The board (readout, area filter, status groups) sits
// beside the Untracked tray; #/projects/<id> opens one project, growing out of its card. App.tsx
// keeps this view mounted while only the id changes, so the card-to-detail morph can run and the
// toasts (with a pending Undo) survive the switch.
//
// Data: projectsApi through useProjectsStore (every write answers the fresh ProjectsState, then the
// snapshot is re-read so Home's tiles, the charts and Needs you catch up), notesApi for linked notes.

/** Board scroll (px) above which opening a project fades it in instead of morphing the card. */
const MORPH_MAX_SCROLL = 120;

/** "now", re-read every minute so countdowns stay true while the page is open. */
function useNow(everyMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

export function Projects({ id }: ProjectsProps) {
  return (
    // A presence boundary of our own: App's <AnimatePresence initial={false}> otherwise tells every
    // motion element that mounts later in this view (cards, toasts, the project's fade-in) to skip its
    // enter animation when the page was loaded straight onto #/projects.
    <AnimatePresence>
      <div key="projects-view">
        <ToastProvider>
          <ProjectsView id={id} />
        </ToastProvider>
      </div>
    </AnimatePresence>
  );
}

function ProjectsView({ id }: ProjectsProps) {
  const store = useProjectsStore();
  const toasts = useToasts();
  const now = useNow();
  const [newOpen, setNewOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const lastId = useRef<string | null>(id);
  const boardScroll = useRef(0);
  /**
   * The card-to-project morph runs only when the board is scrolled near the top. Further down, the
   * project opens at the top of the page, so a morph would fly in from below the fold; it fades in instead.
   */
  const canMorph = useRef(true);

  // Remember how far down the board was, to come back to the same place from a project.
  useEffect(() => {
    if (id !== null) return;
    const onScroll = () => {
      boardScroll.current = window.scrollY;
      canMorph.current = window.scrollY < MORPH_MAX_SCROLL;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [id]);

  // Moving between the board and a project inside this view (AppShell only handles view switches).
  useLayoutEffect(() => {
    const prev = lastId.current;
    lastId.current = id;
    if (prev === id) return;
    if (id) {
      window.scrollTo({ top: 0 });
      return;
    }
    if (prev) {
      window.scrollTo({ top: boardScroll.current });
      setHighlight(prev);
      // Back on the card you came from; when that project is gone (deleted), on the page itself.
      const card = document.querySelector<HTMLElement>(`[data-project-card="${CSS.escape(prev)}"]`);
      (card ?? document.getElementById("main"))?.focus({ preventScroll: true });
    }
  }, [id]);

  // The arrival pulse plays once.
  useEffect(() => {
    if (!highlight) return;
    const t = window.setTimeout(() => setHighlight(null), 1400);
    return () => window.clearTimeout(t);
  }, [highlight]);

  const onCreated = (project: Project) => {
    toasts.push({ tone: "success", message: `Created ${project.name}. Add its first task.` });
    window.location.hash = projectHash(project.id);
  };

  const onDeleted = (project: Project) => {
    window.location.hash = projectHash();
    toasts.push({ message: `Deleted ${project.name}. Its sources are back in Untracked; linked notes keep their files.` });
  };

  const trayStatus = { ...boardStatus(store), notice: undefined };

  return (
    <div className={styles.view}>
      {id ? (
        <ProjectDetail key={id} id={id} store={store} now={now} onDeleted={onDeleted} morph={canMorph.current} />
      ) : (
        <div className={styles.board}>
          <div className={styles.boardMain}>
            <Board store={store} now={now} onNewProject={() => setNewOpen(true)} highlight={highlight} />
          </div>
          <aside className={styles.tray} aria-label="Untracked names">
            <UntrackedTray store={store} status={trayStatus} onTracked={setHighlight} />
          </aside>
        </div>
      )}
      <NewProjectDialog open={newOpen} store={store} onClose={() => setNewOpen(false)} onCreated={onCreated} />
    </div>
  );
}
