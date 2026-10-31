import { forwardRef, useEffect, useRef, useState, type CSSProperties } from "react";
import type { NoteMeta, NoteVault, Project } from "../../../shared/types";
import type { MenuSection } from "../lib/contextMenu";
import { formatNumber } from "../lib/format";
import { ALL_NOTES, formatNoteDate, isReadOnlyNote, noteSection, placeLabel, READ_ONLY_TIP, sectionLabel } from "../lib/notes";
import { noteHash } from "../lib/route";
import { useMenuRegion } from "../ui/ContextMenu";
import { LockIcon, TaskIcon } from "./icons";
import { projectName } from "./useProjectOptions";
import styles from "./NoteList.module.css";

// The notes of the open section (and its subsections), newest first. Each row is a link to
// #/notes/<path>, so it works with the keyboard, middle-click and the browser's back button.
// Row: title and date, then chips (linked project, open action items, read only, subsection), then a
// two-line excerpt. Only the first rows animate in.
// Right-click (or the menu key) on a row shows the actions Notes builds for that note (menuFor).
//
// Long lists (a vault of 1,300 notes) render progressively: the first batch at once, then the next
// batch whenever the end of the list comes within a screen of view, so opening a big folder never
// stalls the page. A "Show more" button at the end does the same by hand or by keyboard. The open
// note's row is always rendered, so a deep link can scroll to it.

export interface NoteListProps {
  notes: NoteMeta[];
  /** The open row's path (ALL_NOTES for everything, or for the default vault with vaults). */
  section: string;
  /** v1.4 vaults (labels, read-only marks); null for an older server. */
  vaults?: NoteVault[] | null;
  openPath: string | null;
  projects: readonly Project[] | null;
  /** Right-click menu section for one note. */
  menuFor?: (note: NoteMeta) => MenuSection | null;
  /** Changes when the list shows something else (another folder, another filter): it starts over at the first batch. */
  resetKey?: string;
}

const STAGGER_ROWS = 12;
const FIRST_BATCH = 80;
const BATCH = 160;
/** Rows kept rendered past the open note, so it isn't the last one. */
const AFTER_OPEN = 20;

function subsectionOf(note: NoteMeta, section: string, vaults: NoteVault[] | null): string | null {
  const own = noteSection(note);
  if (own === section) return null;
  if (section === ALL_NOTES) return own ? placeLabel(own, vaults) : null;
  return sectionLabel(own.slice(section.length + 1));
}

/** The nearest ancestor that scrolls, for the "load more" observer; null means the window. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

export const NoteList = forwardRef<HTMLUListElement, NoteListProps>(function NoteList(
  { notes, section, vaults = null, openPath, projects, menuFor, resetKey = "" },
  ref,
) {
  const now = new Date();
  /** The note a right-click landed on. */
  const menuNote = useRef<NoteMeta | null>(null);
  const menu = useMenuRegion(() => (menuNote.current && menuFor ? menuFor(menuNote.current) : null));
  const moreRef = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(FIRST_BATCH);
  const [limitKey, setLimitKey] = useState(resetKey);
  if (limitKey !== resetKey) {
    // Another folder or filter: start again from the first batch (state reset while rendering).
    setLimitKey(resetKey);
    setLimit(FIRST_BATCH);
  }

  const openAt = openPath ? notes.findIndex((n) => n.path === openPath) : -1;
  const shown = Math.min(notes.length, Math.max(limit, openAt === -1 ? 0 : openAt + 1 + AFTER_OPEN));
  const rest = notes.length - shown;

  // Render the next batch once the end of the list is within a screen of view.
  useEffect(() => {
    const el = moreRef.current;
    if (!el || rest <= 0 || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit(() => shown + BATCH);
      },
      { root: scrollParent(el), rootMargin: "0px 0px 100% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, rest]);

  const visible = rest > 0 ? notes.slice(0, shown) : notes;

  return (
    <>
      <ul
        ref={ref}
        className={styles.list}
        aria-label={`Notes in ${placeLabel(section, vaults)}`}
        onContextMenu={(e) => {
          const link = e.target instanceof Element ? e.target.closest("a[data-path]") : null;
          const path = link?.getAttribute("data-path");
          menuNote.current = (path && notes.find((n) => n.path === path)) || null;
          menu.onContextMenu(e);
        }}
      >
        {visible.map((note, i) => {
          const open = note.path === openPath;
          const sub = subsectionOf(note, section, vaults);
          const date = formatNoteDate(note.created, now);
          const locked = isReadOnlyNote(note, vaults);
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
                    ? locked
                      ? "Already open in the editor, read only."
                      : "Already open in the editor; changes save as you type."
                    : locked
                      ? "Opens this note to read; the vault's rules keep it read only."
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
                {note.projectId || note.openActions > 0 || sub || locked ? (
                  <span className={styles.chips}>
                    {locked ? (
                      <span className={styles.chip} data-kind="locked" data-tip={READ_ONLY_TIP}>
                        <LockIcon size={11} />
                        Read only
                      </span>
                    ) : null}
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
      {rest > 0 ? (
        <div ref={moreRef} className={styles.more}>
          <button
            type="button"
            className={styles.moreButton}
            onClick={() => setLimit(shown + BATCH)}
            data-tip="Adds the next notes to this list; scrolling to the end does the same."
          >
            Show {formatNumber(Math.min(BATCH, rest))} more
          </button>
          <span className={`${styles.moreCount} num`}>{formatNumber(rest)} not shown yet</span>
        </div>
      ) : null}
    </>
  );
});
