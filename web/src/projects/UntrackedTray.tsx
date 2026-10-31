import { AnimatePresence, motion } from "motion/react";
import { useId, useMemo, useRef, useState } from "react";
import type { DetectedProject, Project, ProjectsState } from "../../../shared/types";
import { errorMessage } from "../api";
import { projectsApi } from "../api/projects";
import { MOTION } from "../hooks/useReducedMotion";
import { plural } from "../lib/format";
import { projectHash } from "../lib/route";
import { addedProject, detectedFacts, displayName, rankProjectsFor, seenText, trackInput, withSource, STATUS_LABEL } from "../lib/projects";
import { Button } from "../ui/Button";
import { useMenuRegion } from "../ui/ContextMenu";
import { EmptyState } from "../ui/EmptyState";
import { Panel, type PanelStatus } from "../ui/Panel";
import { ChevronIcon, FoldIcon, HideIcon, TrackIcon } from "./icons";
import { handOffFocus, KindIcon } from "./parts";
import { Picker } from "./Picker";
import { useToasts } from "./Toasts";
import type { ProjectsStore } from "./useProjects";
import styles from "./UntrackedTray.module.css";

// Curation: auto-detected session and repo names active in the last 90 days that belong to no
// project. Track one (it becomes a project), add it to a project (it becomes one of that project's
// sources), or hide it (it leaves this list and every chart). Hidden names are listed under the tray
// with Unhide. The server answers every action with the fresh registry.
// Right-click a name: Track, Add to project, Hide (a hidden name: Unhide), the row's own buttons.

const FIRST_ROWS = 12;

/** Hover help on a row's other buttons while one action on that name is saving. */
const BUSY_TIP = "Works again once the current change to this name is saved.";
const TRACK_TIP = "Creates an active Work project from this name; rename or move it later on its page.";
const ADD_TIP = "Adds this name as a source of a project you already have, so its activity counts there.";
const HIDE_TIP = "Hides this name from Untracked, the time bars and the life map; Unhide brings it back.";
const UNHIDE_TIP = "Returns this name to Untracked and the charts if it was active in the last 90 days.";

export interface UntrackedTrayProps {
  store: ProjectsStore;
  status: PanelStatus;
  /** A project was created by Track: the board pulses its card. */
  onTracked: (projectId: string) => void;
}

/** Optimistic local copy: the name leaves `untracked` at once. */
function withoutUntracked(s: ProjectsState, d: DetectedProject): ProjectsState {
  return { ...s, untracked: s.untracked.filter((u) => !(u.name === d.name && u.kind === d.kind)) };
}

export function UntrackedTray({ store, status, onTracked }: UntrackedTrayProps) {
  const state = store.state;
  const count = state?.untracked.length ?? 0;
  return (
    <Panel
      title="Untracked"
      {...status}
      notice={undefined}
      skeleton="rows"
      meta={state ? String(count) : undefined}
      className={styles.panel}
      bodyClassName={styles.scroll}
    >
      {state ? <TrayBody store={store} state={state} onTracked={onTracked} /> : null}
    </Panel>
  );
}

function TrayBody({ store, state, onTracked }: { store: ProjectsStore; state: ProjectsState; onTracked: (id: string) => void }) {
  const toasts = useToasts();
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<Record<string, "track" | "add" | "hide" | undefined>>({});
  const items = state.untracked;
  const shown = showAll ? items : items.slice(0, FIRST_ROWS);
  const keyOf = (d: Pick<DetectedProject, "name" | "kind">) => `${d.kind}:${d.name}`;
  const setBusyFor = (d: DetectedProject, what: "track" | "add" | "hide" | undefined) =>
    setBusy((b) => ({ ...b, [keyOf(d)]: what }));
  const listRef = useRef<HTMLUListElement>(null);

  /** The row is about to leave the list: move focus to the next row's Track button so the keyboard keeps its place. */
  const keepFocus = (d: DetectedProject) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-untracked]") ?? [])];
    const i = rows.findIndex((r) => r.dataset.untracked === keyOf(d));
    const next = rows[i + 1] ?? rows[i - 1];
    handOffFocus(rows[i], next?.querySelector<HTMLElement>("[data-part=track]") ?? document.getElementById("main"));
  };

  const track = async (d: DetectedProject) => {
    keepFocus(d);
    setBusyFor(d, "track");
    try {
      const next = await store.write(() => projectsApi.create(trackInput(d)), (s) => withoutUntracked(s, d));
      const created = addedProject(state.projects, next.projects);
      if (created) onTracked(created.id);
      toasts.push({
        tone: "success",
        message: `Tracking ${created?.name ?? displayName(d.name)} as a new project.`,
        action: created ? { label: "Open", onAction: () => (window.location.hash = projectHash(created.id)) } : undefined,
      });
    } catch (err) {
      toasts.push({ tone: "error", message: `Couldn't track ${displayName(d.name)}. ${errorMessage(err)}` });
    } finally {
      setBusyFor(d, undefined);
    }
  };

  const addTo = async (d: DetectedProject, project: Project) => {
    keepFocus(d);
    setBusyFor(d, "add");
    try {
      await store.write(
        () => projectsApi.update(project.id, { sources: withSource(project.sources, d) }),
        (s) => ({
          ...withoutUntracked(s, d),
          projects: s.projects.map((p) => (p.id === project.id ? { ...p, sources: withSource(p.sources, d) } : p)),
        }),
      );
      toasts.push({ tone: "success", message: `Added ${displayName(d.name)} to ${project.name}. Its time and commits count there now.` });
    } catch (err) {
      toasts.push({ tone: "error", message: `Couldn't add ${displayName(d.name)} to ${project.name}. ${errorMessage(err)}` });
    } finally {
      setBusyFor(d, undefined);
    }
  };

  const hide = async (d: DetectedProject) => {
    keepFocus(d);
    setBusyFor(d, "hide");
    try {
      await store.write(
        () => projectsApi.hide(d.name),
        (s) => ({ ...withoutUntracked(s, d), hidden: s.hidden.includes(d.name) ? s.hidden : [...s.hidden, d.name] }),
      );
      toasts.push({
        message: `Hid ${displayName(d.name)}. It no longer counts in charts.`,
        action: { label: "Undo", onAction: () => void unhide(d.name) },
      });
    } catch (err) {
      toasts.push({ tone: "error", message: `Couldn't hide ${displayName(d.name)}. ${errorMessage(err)}` });
    } finally {
      setBusyFor(d, undefined);
    }
  };

  const unhide = async (name: string) => {
    try {
      await store.write(
        () => projectsApi.unhide(name),
        (s) => ({ ...s, hidden: s.hidden.filter((h) => h !== name) }),
      );
      toasts.push({ message: `Unhid ${displayName(name)}. It shows in Untracked again if it was active in the last 90 days.` });
    } catch (err) {
      toasts.push({ tone: "error", message: `Couldn't unhide ${displayName(name)}. ${errorMessage(err)}` });
    }
  };

  return (
    <div className={styles.body}>
      {items.length === 0 ? (
        <EmptyState
          tone="ok"
          size="inline"
          title="Nothing untracked."
          body="Every session and repo active in the last 90 days belongs to a project or is hidden."
        />
      ) : (
        <>
          <p className={styles.intro}>Active in the last 90 days and in no project. Track, fold into a project, or hide.</p>
          <ul ref={listRef} className={styles.list}>
            <AnimatePresence initial={false}>
              {shown.map((d) => (
                <UntrackedRow
                  key={keyOf(d)}
                  rowKey={keyOf(d)}
                  item={d}
                  projects={state.projects}
                  busy={busy[keyOf(d)]}
                  onTrack={() => void track(d)}
                  onAdd={(p) => void addTo(d, p)}
                  onHide={() => void hide(d)}
                />
              ))}
            </AnimatePresence>
          </ul>
          {items.length > FIRST_ROWS ? (
            <Button
              variant="ghost"
              size="sm"
              className={styles.more}
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
              tip={showAll ? `Shows only the first ${FIRST_ROWS} names again.` : `Lists every untracked name, not just the first ${FIRST_ROWS}.`}
            >
              {showAll ? "Show fewer" : `Show all ${items.length}`}
            </Button>
          ) : null}
        </>
      )}
      <HiddenList names={state.hidden} onUnhide={(n) => void unhide(n)} />
    </div>
  );
}

/** One untracked name, as a list item (a direct child of the list's AnimatePresence, so it can animate out). */
function UntrackedRow({
  rowKey,
  item,
  projects,
  busy,
  onTrack,
  onAdd,
  onHide,
}: {
  rowKey: string;
  item: DetectedProject;
  projects: readonly Project[];
  busy: "track" | "add" | "hide" | undefined;
  onTrack: () => void;
  onAdd: (p: Project) => void;
  onHide: () => void;
}) {
  const name = displayName(item.name);
  const rowRef = useRef<HTMLLIElement>(null);
  const off = (what: "track" | "add" | "hide") => (busy && busy !== what ? BUSY_TIP : busy === what ? "Already saving this change." : false);
  const menu = useMenuRegion(() => ({
    title: name,
    items: [
      { label: "Track", icon: <TrackIcon />, tip: TRACK_TIP, disabled: off("track"), onSelect: onTrack },
      {
        label: "Add to project",
        icon: <FoldIcon />,
        tip: ADD_TIP,
        disabled: off("add") || (projects.length === 0 ? "No projects yet; use Track to start one." : false),
        // Opens the row's own project picker, focused on its search box.
        onSelect: () => {
          const trigger = rowRef.current?.querySelector<HTMLElement>("[aria-haspopup=listbox]");
          if (trigger?.getAttribute("aria-expanded") !== "true") trigger?.click();
        },
      },
      { label: "Hide", icon: <HideIcon />, tip: HIDE_TIP, disabled: off("hide"), onSelect: onHide },
    ],
  }));
  const options = useMemo(
    () =>
      rankProjectsFor(item.name, projects).map(({ project, suggested }) => ({
        value: project.id,
        label: project.name,
        detail: `${STATUS_LABEL[project.status]}, ${plural(project.sources.sessions.length + project.sources.repos.length, "source")}`,
        badge: suggested ? "Same name" : undefined,
      })),
    [item.name, projects],
  );
  return (
    <motion.li
      ref={rowRef}
      data-untracked={rowKey}
      className={styles.item}
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, x: 12, transition: { duration: MOTION.fast } }}
      transition={{ duration: MOTION.base, ease: MOTION.easeOut }}
      {...menu}
    >
      <div className={styles.head}>
        <KindIcon kind={item.kind} />
        <span className={styles.name} dir="auto" title={item.name}>
          {item.name !== name ? <span className={styles.owner}>{item.name.slice(0, item.name.length - name.length)}</span> : null}
          {name}
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon={<HideIcon />}
          className={styles.hide}
          onClick={onHide}
          loading={busy === "hide"}
          disabled={!!busy && busy !== "hide"}
          aria-label={`Hide ${name} from projects and charts`}
          tip={busy && busy !== "hide" ? BUSY_TIP : HIDE_TIP}
        />
      </div>
      <p className={styles.facts}>
        {detectedFacts(item)}
        {item.lastSeen ? <span className={styles.seen}>, last seen {seenText(item.lastSeen, new Date())}</span> : null}
      </p>
      <div className={styles.actions}>
        <Button
          size="sm"
          icon={<TrackIcon />}
          data-part="track"
          onClick={onTrack}
          loading={busy === "track"}
          loadingLabel="Tracking"
          disabled={!!busy && busy !== "track"}
          aria-label={`Track ${name} as a new project`}
          tip={busy && busy !== "track" ? BUSY_TIP : TRACK_TIP}
        >
          Track
        </Button>
        <Picker
          label="Add to project"
          ariaLabel={`Add to project: ${name}`}
          icon={<FoldIcon />}
          searchLabel="Find a project"
          tip={busy && busy !== "add" ? BUSY_TIP : ADD_TIP}
          options={options}
          empty="No projects yet. Use Track to start one."
          onPick={(id) => {
            const p = projects.find((x) => x.id === id);
            if (p) onAdd(p);
          }}
          loading={busy === "add"}
          disabled={!!busy && busy !== "add"}
        />
      </div>
    </motion.li>
  );
}

/** One hidden name with its Unhide button; right-click offers Unhide too. */
function HiddenItem({ name, onUnhide }: { name: string; onUnhide: () => void }) {
  const rowRef = useRef<HTMLLIElement>(null);
  /** The row leaves (and the whole list when it was the last one): keep focus nearby. */
  const unhide = () => {
    const row = rowRef.current;
    const sibling = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector<HTMLElement>("[data-part=unhide]");
    const tray = row?.closest("section");
    handOffFocus(row, sibling ?? tray?.querySelector<HTMLElement>("[data-part=track]") ?? document.getElementById("main"));
    onUnhide();
  };
  const menu = useMenuRegion(() => ({
    title: displayName(name),
    items: [{ label: "Unhide", tip: UNHIDE_TIP, onSelect: unhide }],
  }));
  return (
    <li ref={rowRef} className={styles.hiddenItem} {...menu}>
      <span className={styles.hiddenName} dir="auto" title={name}>
        {name}
      </span>
      <Button size="sm" variant="ghost" data-part="unhide" aria-label={`Unhide ${displayName(name)}`} tip={UNHIDE_TIP} onClick={unhide}>
        Unhide
      </Button>
    </li>
  );
}

function HiddenList({ names, onUnhide }: { names: readonly string[]; onUnhide: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const listId = `hidden-${useId().replace(/:/g, "")}`;
  if (names.length === 0) return null;
  const sorted = [...names].sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" }));
  return (
    <div className={styles.hidden}>
      <button
        type="button"
        className={styles.hiddenToggle}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        data-tip={open ? "Hides the list of hidden names." : "Shows the names you hid, each with an Unhide button."}
      >
        <span className={styles.chevron} data-open={open || undefined}>
          <ChevronIcon />
        </span>
        Hidden <span className={styles.count}>{names.length}</span>
      </button>
      <ul id={listId} className={styles.hiddenList} hidden={!open}>
        {sorted.map((n) => (
          <HiddenItem key={n} name={n} onUnhide={() => onUnhide(n)} />
        ))}
      </ul>
      {open ? <p className={styles.hiddenHint}>Hidden names stay out of Untracked, the time bars and the life map.</p> : null}
    </div>
  );
}
