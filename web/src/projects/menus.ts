import type { ProjectStatus } from "../../../shared/types";
import { AREA_FILTERS, AREA_LABEL, STATUS_GROUP_LABEL, STATUS_ORDER, type AreaFilter } from "../lib/projects";

// Pure pieces of the Projects right-click menus (ui/ContextMenu.tsx draws them): which statuses a
// card can move to, what each status lane offers, the board's area choices, and the link Copy link
// puts on the clipboard. The components wire these to the handlers their visible controls use.

/** Statuses a project can move to from `status`, in board order, leaving out the one it has. */
export function moveTargets(status: ProjectStatus): ProjectStatus[] {
  return STATUS_ORDER.filter((s) => s !== status);
}

/** "Move to Ideas": the menu label for moving a project to `status` (named like the board lane). */
export function moveLabel(status: ProjectStatus): string {
  return `Move to ${STATUS_GROUP_LABEL[status]}`;
}

/** Hover help on each Move to item: where the card goes and what changes. */
export const MOVE_TIP: Record<ProjectStatus, string> = {
  active: "Sets it to Active: first on the board, and its deadline and due tasks reach Needs you.",
  paused: "Pauses it: moves the card to Paused and keeps its deadlines out of Needs you.",
  idea: "Parks it in Ideas, out of Needs you, until you set it to Active.",
  done: "Marks it Done: the card moves to the folded Done lane on the board.",
};

export interface LaneAdd {
  label: string;
  tip: string;
  /** The status the New project form starts on. */
  status: ProjectStatus;
}

/** What right-clicking a status lane adds, with that lane's status picked in the form. Null for Done. */
export function laneAdd(status: ProjectStatus): LaneAdd | null {
  switch (status) {
    case "active":
      return { label: "New project", status, tip: "Opens the New project form with Active picked." };
    case "idea":
      return { label: "Add idea", status, tip: "Opens the New project form with Idea picked, so it lands in Ideas." };
    case "paused":
      return { label: "Add paused project", status, tip: "Opens the New project form with Paused picked." };
    default:
      return null;
  }
}

export interface AreaChoice {
  value: AreaFilter;
  label: string;
  /** How many projects that filter shows. */
  hint: string;
  tip: string;
}

/** The board menu's area filter choices: every filter except the one already shown. */
export function areaChoices(current: AreaFilter, counts: Readonly<Record<AreaFilter, number>>): AreaChoice[] {
  return AREA_FILTERS.filter((v) => v !== current).map((value) => ({
    value,
    label: value === "all" ? "Show all areas" : `Show only ${AREA_LABEL[value]}`,
    hint: String(counts[value] ?? 0),
    tip:
      value === "all"
        ? "Shows projects in every area; this browser remembers the filter."
        : `Shows only ${AREA_LABEL[value]} projects; this browser remembers the filter.`,
  }));
}

/** The full address of a hash route on this page, for Copy link. */
export function absoluteLink(hash: string, at: { origin: string; pathname: string; search?: string }): string {
  return `${at.origin}${at.pathname}${at.search ?? ""}${hash.startsWith("#") ? hash : `#${hash}`}`;
}
