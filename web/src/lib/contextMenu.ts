// Right-click menus: the data model and the pure helpers behind ui/ContextMenu.tsx.
//
// A region of the page offers a *section* of actions. Right-clicking collects the sections of every
// region under the pointer, innermost first (a project card, then its lane, then the board), and the
// app adds a last "everywhere" section (refresh, check in, theme). Every action in a menu must also be
// reachable another way: the menu is a shortcut, never the only route.

export interface MenuAction {
  /** Short verb phrase: "Add idea", "Move to Paused". */
  label: string;
  onSelect: () => void;
  /** 16px inline SVG, aria-hidden. */
  icon?: React.ReactNode;
  /** Right-aligned hint, e.g. a keyboard shortcut. */
  hint?: string;
  /** Hover help: what happens, as in the rest of the app. */
  tip?: string;
  /** Red text; for actions that delete or can't be undone. */
  danger?: boolean;
  /** True, or the reason it is off (shown as its tip). Disabled items stay visible. */
  disabled?: boolean | string;
}

export interface MenuSection {
  /** Small caps heading, e.g. the project's name. Optional. */
  title?: string;
  items: (MenuAction | null | false | undefined)[];
}

/** A section with its empty slots removed, ready to draw. */
export interface CleanSection {
  title?: string;
  items: MenuAction[];
}

/** Drops empty slots and empty sections, keeping order. Returns [] when there is nothing to show. */
export function cleanSections(sections: readonly (MenuSection | null | undefined)[]): CleanSection[] {
  const out: CleanSection[] = [];
  for (const s of sections) {
    if (!s) continue;
    const items = s.items.filter((i): i is MenuAction => !!i && typeof i === "object");
    if (items.length) out.push({ title: s.title, items });
  }
  return out;
}

/**
 * Where to draw a menu of `size` opened at `at`, kept `edge` px inside a `view`-sized window.
 * It opens down and right from the point, and flips up or left when it would run off the edge.
 */
export function placeMenu(
  at: { x: number; y: number },
  size: { w: number; h: number },
  view: { w: number; h: number },
  edge = 8,
): { left: number; top: number } {
  let left = at.x;
  let top = at.y;
  if (left + size.w > view.w - edge) left = Math.max(edge, at.x - size.w);
  if (top + size.h > view.h - edge) top = Math.max(edge, at.y - size.h);
  return {
    left: Math.min(Math.max(edge, left), Math.max(edge, view.w - edge - size.w)),
    top: Math.min(Math.max(edge, top), Math.max(edge, view.h - edge - size.h)),
  };
}

/** Next enabled item index when moving by `step` (+1 down, -1 up), wrapping around. -1 if none. */
export function nextEnabled(disabled: readonly boolean[], from: number, step: 1 | -1): number {
  const n = disabled.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return -1;
}
