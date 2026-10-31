# Shared brief for T23, T24, T25: right-click menus

Islam wants right-click to open the dashboard's own menu with actions for the thing under the pointer
(example: right-click the Ideas lane, get "Add idea"), instead of the browser's menu.

## Already done by the supervisor (do not edit; report if you need a change)
- `web/src/lib/contextMenu.ts`: `MenuAction` (`label`, `onSelect`, `icon?`, `hint?`, `tip?`, `danger?`,
  `disabled?: boolean | "reason"`) and `MenuSection` (`title?`, `items`).
- `web/src/ui/ContextMenu.tsx`: `useMenuRegion(() => section)` returns `{ onContextMenu }`; spread it on
  the element that owns the actions. Nested regions stack innermost first (card, then lane, then board),
  and a last "everywhere" section (refresh, check in, theme, hover help) is always added. The layer
  handles positioning, keyboard (menu key, Shift+F10, arrows, Enter, Esc), focus return, dialogs.
- The browser menu still shows in inputs, textareas, over selected text and on Shift + right-click.

## Rules
1. **Every menu action must already be reachable another way** (a button, link or keyboard). The menu is
   a shortcut. If an action has no other route yet, either skip it or also add a visible control.
2. Reuse the handlers the visible controls already call, so behaviour stays identical (same confirm
   dialogs, same undo toasts, same API calls). Do not write new API logic.
3. Labels: short verb phrases, sentence case ("Add idea", "Move to Paused", "Copy link"). Each item gets
   a `tip` in the hover help style (one sentence, starts with a verb, says what happens, no em-dashes).
4. Destructive items (`danger: true`) go last in their section and must keep any existing confirm or undo.
5. Section `title` names the thing (the project's name, "Ideas", the note's title). Keep sections to
   about 7 items; put the most common action first.
6. Disabled items stay visible with the reason as the string value of `disabled`.
7. Items that only make sense on wide screens or in one state are left out, not disabled, when
   they could never apply.

## Process
- Only edit the files your ticket lists. Do not commit. Do not use port 4317 (the live dashboard with
  Islam's real projects and notes runs there; never create, edit or delete real data during checks).
  For a visual check run `npx vite web --port <your port> --strictPort`; it proxies /api to 4317, so
  only right-click and look, do not pick data-changing items. Stop the server when done.
- `npx vitest run` and `npm run typecheck` must pass. Add tests for any new pure helper.
- Tick the Definition of Done in your ticket. Report under 200 words: the menus you added (region:
  items), check results with counts, anything skipped and why.
