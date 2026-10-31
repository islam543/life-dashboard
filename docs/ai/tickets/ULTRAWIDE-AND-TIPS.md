# Shared brief for T20, T21, T22: ultrawide layout and hover help

Islam uses the dashboard mostly on a 21:9 monitor at 2560x1080 (100% scale). With browser chrome the
viewport is about **2560 x 940 CSS px**. It must also work at 3440x1440. Today `--page-max` is 1440px,
so half the monitor is empty and everything stacks downward into a short screen.

## Already done by the supervisor (do not edit these files; report if you need a change)
- `web/src/styles/tokens.css`: `@media (min-width: 1920px)` raises `--page-max` to `--page-max-wide` (3440px).
- `web/src/ui/TipLayer.tsx` + `.module.css`, `web/src/lib/tips.ts`: one app-wide hover help layer. Any element
  with `data-tip="..."` gets a tooltip (450ms hover delay, instant on keyboard focus, Esc closes, hoverable,
  sets aria-describedby). Header has a "Hover help on/off" switch.
- `web/src/ui/Button.tsx`: `Button` and `ButtonLink` take `tip="..."` (renders `data-tip`).

## Layout rules
1. Use exactly `@media (min-width: 1920px)` for ultrawide rules. Do not change any layout below 1920px.
2. Height is the scarce axis. Put regions side by side, not stacked. Long lists scroll inside their panel
   (`overflow: auto` with a max height tied to the viewport, e.g. `calc(100dvh - <header height>)`),
   not the page.
3. Keep reading text at 75ch or less; spend extra width on more columns, not longer lines.
4. Tokens only (spacing, colors, radii from `tokens.css`). No new px values off the spacing scale.
5. Most important content top-left. Keep the existing visual language (dark navy sci-fi).

## Hover help rules
1. Every interactive control in your files gets a tip: buttons (`tip` prop), links, icon buttons, toggles,
   chips, tabs, selects, inputs whose purpose is not obvious, clickable chart marks without their own tooltip.
2. Text: one sentence, present tense, starts with a verb, says what happens and any side effect or where it
   goes. 90 characters max. No em-dashes. No "Click to". Add information beyond the visible label.
   Good: "Moves the note to notes/.trash in your vault; nothing is erased." Bad: "Delete note".
3. Disabled controls: say why they are disabled when the code knows.
4. Replace native `title=` on controls with `data-tip` / `tip`. Elements that already show their own custom
   hover tooltip (chart hover cards, header source dots) get no data-tip, so there are never two tooltips.
5. Keep existing `aria-label`s; the tip is a description, not the name.

## Process
- Only edit the files your ticket lists. Do not commit. Do not run anything on port 4317 (the dashboard
  runs there). For a visual check run `npx vite web --port <your port> --strictPort` (it proxies /api to 4317)
  and view it at 2560x940 if you have a browser tool; stop it when done.
- Run `npx vitest run` and `npm run typecheck`; both must pass.
- Report back under 200 words: what changed, the ultrawide layout in one line per view, check results.
