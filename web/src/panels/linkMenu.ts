import type { MenuAction } from "../lib/contextMenu";

// Links in right-click menus: what to call "open this", the hover help for it, and how to follow or
// copy it. Shared by the Home panels, the header and the detail views. Every link offered here is one
// the page already shows as an <a>, so a menu never opens anything the page itself could not.

/** Readable names for the sites links go to. Anything else shows its host name. */
const SITE_NAMES: readonly [RegExp, string][] = [
  [/(^|\.)github\.com$/, "GitHub"],
  [/(^|\.)atlassian\.net$/, "Jira"],
  [/(^|\.)gitlab\.com$/, "GitLab"],
  [/^calendar\.google\.com$/, "Google Calendar"],
  [/^mail\.google\.com$/, "Gmail"],
];

/** A link a menu may follow: an in-app route ("#/..."), or an http(s) address. Null for anything else. */
export function safeLink(url: string | null | undefined): string | null {
  const u = url?.trim();
  if (!u) return null;
  if (u.startsWith("#/")) return u;
  try {
    const { protocol } = new URL(u);
    return protocol === "https:" || protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/** "GitHub", "Jira", or the host name for an outside link. Null for in-app links and bad addresses. */
export function siteName(url: string): string | null {
  if (url.startsWith("#")) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return SITE_NAMES.find(([re]) => re.test(host))?.[1] ?? (host || null);
  } catch {
    return null;
  }
}

/**
 * Hover help for a link to a source item, without the full stop: "Opens it on GitHub in a new tab",
 * "Opens it on the Projects page of this dashboard". Shared by Needs you, Next moves and the menus.
 */
export function opensIn(url: string): string {
  if (url.startsWith("#")) {
    if (url.startsWith("#/projects")) return "Opens it on the Projects page of this dashboard";
    if (url.startsWith("#/notes")) return "Opens the note in the Notes view of this dashboard";
    return "Opens it here in the dashboard";
  }
  const site = siteName(url);
  return site ? `Opens it on ${site} in a new tab` : "Opens it in a new tab";
}

/** Menu label for following a link: "Open in Jira", "Open project", "Open note", "Open". */
export function openLabel(url: string): string {
  if (url.startsWith("#/projects/")) return "Open project";
  if (url.startsWith("#/notes/")) return "Open note";
  if (url.startsWith("#")) return "Open";
  const site = siteName(url);
  return site ? `Open in ${site}` : "Open link";
}

/** Follows a link the way its <a> does: in-app routes here, outside sites in a new tab. */
export function followLink(url: string): void {
  const safe = safeLink(url);
  if (!safe) return;
  if (safe.startsWith("#")) window.location.hash = safe;
  else window.open(safe, "_blank", "noopener,noreferrer");
}

/** Puts text on the clipboard. Resolves false when the browser refuses (no permission, no clipboard). */
export function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}

/** The menu item that follows a link, or null when there is no link (or not a safe one). */
export function openItem(url: string | null | undefined, tip?: string): MenuAction | null {
  const safe = safeLink(url);
  if (!safe) return null;
  return { label: openLabel(safe), onSelect: () => followLink(safe), tip: tip ?? `${opensIn(safe)}.` };
}
