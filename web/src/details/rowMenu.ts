import { createContext, useCallback, useContext } from "react";
import type { MenuAction } from "../lib/contextMenu";
import { copyText, openItem, safeLink } from "../panels/linkMenu";

// Right-click items for rows in the detail views that link out (a Jira issue, a pull request, a CI
// run, an event, an email): open it where the row's link goes, or copy that link.
//
// Copying gives no visible change by itself, so the detail overlay provides `say` through
// CopyNotice: it shows the result for a moment (rowMenu.module.css) and reads it out to screen readers.

export const CopyNotice = createContext<(text: string, ok: boolean) => void>(() => undefined);

const COPY_TIP = "Copies the link to the clipboard, ready to paste into a chat or a note.";

/** Builds "Open in ..." and "Copy link" for a row's link. Empty when the row has no safe link. */
export function useLinkItems(): (url: string | null | undefined, openTip?: string) => MenuAction[] {
  const say = useContext(CopyNotice);
  return useCallback(
    (url, openTip) => {
      const safe = safeLink(url);
      const open = openItem(safe, openTip);
      if (!safe || !open || safe.startsWith("#")) return open ? [open] : [];
      return [
        open,
        {
          label: "Copy link",
          onSelect: () =>
            void copyText(safe).then((ok) =>
              say(ok ? "Link copied" : "Couldn't copy the link. Shift + right-click it to copy instead.", ok),
            ),
          tip: COPY_TIP,
        },
      ];
    },
    [say],
  );
}
