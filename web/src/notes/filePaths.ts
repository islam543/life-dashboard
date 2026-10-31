import type { NoteVault } from "../../../shared/types";
import { splitVaultPath } from "../lib/notes";

// Full file paths for the Notes view's "Copy path" actions (tree folder block, editor footer and the
// right-click menus). The server sends each folder as an absolute path in the PC's own style
// (C:\Users\...\notes on Windows) and note and section paths relative to it with "/" separators.
// v1.4: a path in another vault starts with its prefix ("@learning/wiki/x.md") and lives under that
// vault's own folder, so placePath() strips the prefix and joins the rest onto the vault's dir.

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

/**
 * The absolute path of a note or folder path in whichever vault it belongs to. `notesDir` (the
 * default notes folder) is used without vaults, or when a vault came without its folder.
 */
export function placePath(path: string, vaults: readonly NoteVault[] | null, notesDir: string): string {
  const { vault, inner } = splitVaultPath(path, vaults);
  if (!vault) return fullPath(notesDir, path);
  return fullPath(vault.dir || notesDir, vault.dir ? inner : path);
}

/** Copies text to the clipboard. Resolves false when the browser refuses or has no clipboard. */
export function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}
