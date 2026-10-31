import { forwardRef, useRef, type CSSProperties } from "react";
import type { NoteMeta, Project } from "../../../shared/types";
import type { MenuSection } from "../lib/contextMenu";
import { formatNumber } from "../lib/format";
import { ALL_NOTES, formatNoteDate, noteSection, sectionLabel } from "../lib/notes";
import { noteHash } from "../lib/route";
import { useMenuRegion } from "../ui/ContextMenu";
import { TaskIcon } from "./icons";
import { projectName } from "./useProjectOptions";
import styles from "./NoteList.module.css";

// The notes of the open section (and its subsections), newest first. Each row is a link to
// #/notes/<path>, so it works with the keyboard, middle-click and the browser's back button.
// Row: title and date, then chips (linked project, open action items, subsection), then a
// two-line excerpt. Only the first rows animate in; a long list renders at once.
// Right-click (or the menu key) on a row shows the actions Notes builds for that note (menuFor).

export interface NoteListProps {
  notes: NoteMeta[];
  /** The open section path (ALL_NOTES for everything). */
  section: string;
  openPath: string | null;
  projects: readonly Project[] | null;
  /** Right-click menu section for one note. */
  menuFor?: (note: NoteMeta) => MenuSection | null;
}

const STAGGER_ROWS = 12;

function subsectionOf(note: NoteMeta, section: string): string | null {
  const own = noteSection(note);
  if (own === section) return null;
  if (section === ALL_NOTES) return own ? sectionLabel(own) : null;
  return sectionLabel(own.slice(section.length + 1));
}

export const NoteList = forwardRef<HTMLUListElement, NoteListProps>(function NoteList(
  { notes, section, openPath, projects, menuFor },
  ref,
) {
  const now = new Date();
  /** The note a right-click landed on. */
  const menuNote = useRef<NoteMeta | null>(null);
  const menu = useMenuRegion(() => (menuNote.current && menuFor ? menuFor(menuNote.current) : null));
  return (
    <ul
      ref={ref}
      className={styles.list}
      aria-label={`Notes in ${sectionLabel(section)}`}
      onContextMenu={(e) => {
        const link = e.target instanceof Element ? e.target.closest("a[data-path]") : null;
        const path = link?.getAttribute("data-path");
        menuNote.current = (path && notes.find((n) => n.path === path)) || null;
        menu.onContextMenu(e);
      }}
    >
      {notes.map((note, i) => {
        const open = note.path === openPath;
        const sub = subsectionOf(note, section);
        const date = formatNoteDate(note.created, now);
        return (
          <li
            key={note.path}
            className={styles.row}
            style={i < STAGGER_ROWS ? ({ "--i": i } as CSSProperties) : undefined}
            data-stagger={i < STAGGER_ROWS ? "" : undefined}
          >
            <a
              className={styles.link}
              href={noteHash(note.path)}
              aria-current={open ? "page" : undefined}
              data-path={note.path}
              data-tip={
                open
                  ? "Already open in the editor; changes save as you type."
                  : "Opens this note in the editor; the note open now saves first."
              }
            >
              <span className={styles.head}>
                <span className={styles.title} dir="auto">
                  {note.title || "Untitled note"}
                </span>
                {date ? (
                  <time className={`${styles.date} num`} dateTime={note.created}>
                    {date}
                  </time>
                ) : null}
              </span>
              {note.projectId || note.openActions > 0 || sub ? (
                <span className={styles.chips}>
                  {note.projectId ? (
                    <span className={styles.chip} data-kind="project" dir="auto">
                      <span className="sr-only">Project: </span>
                      {projectName(projects, note.projectId)}
                    </span>
                  ) : null}
                  {note.openActions > 0 ? (
                    <span className={styles.chip} data-kind="actions">
                      <TaskIcon />
                      <span className="num">{formatNumber(note.openActions)}</span> open
                      <span className="sr-only"> {note.openActions === 1 ? "action item" : "action items"}</span>
                    </span>
                  ) : null}
                  {sub ? (
                    <span className={styles.sub} dir="auto">
                      <span className="sr-only">In </span>
                      {sub}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {note.excerpt ? (
                <span className={styles.excerpt} dir="auto">
                  {note.excerpt}
                </span>
              ) : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
});
