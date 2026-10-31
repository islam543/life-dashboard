// Full file paths for the Notes view's "Copy path" actions (tree folder block, editor footer and the
// right-click menus). The server sends the notes folder as an absolute path in the PC's own style
// (C:\Users\...\notes on Windows) and note and section paths relative to it with "/" separators.

/**
 * The absolute path of `relative` (a section or note path, "/" separated) inside the notes folder `dir`,
 * written with `dir`'s own separator so it pastes straight into File Explorer. "" gives `dir` itself.
 */
export function fullPath(dir: string, relative: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const parts = relative.split("/").filter(Boolean);
  if (!parts.length) return dir;
  const base = dir.replace(/[\\/]+$/, "");
  return `${base}${sep}${parts.join(sep)}`;
}

/** Copies text to the clipboard. Resolves false when the browser refuses or has no clipboard. */
export function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}
