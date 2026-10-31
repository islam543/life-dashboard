# Life dashboard: thinking it through

Status: draft for discussion, 2026-10-30. Nothing built yet.

## 1. The idea in one line

One screen that answers two questions in under 10 seconds:

1. **What needs me right now?** (the things you cannot miss)
2. **How is my life going?** (trends across work, money, learning, health)

Everything else is detail you open only when you want it ("drill down", meaning click a tile to see what is behind it).

## 2. Prior art (what already exists)

| Option | What it is | Why it is not enough for you |
|---|---|---|
| Exist.io / Gyroscope | Apps that pull phone, health and calendar data and show life trends | No Jira, no GitHub, no trading, no Claude sessions. Personal only |
| Notion "Life OS" templates | Pages you fill in by hand | Mostly text and tables, manual, the opposite of what you asked for |
| Grafana / Obsidian Homepage | DIY dashboard tools | Grafana is built for servers, ugly for life data. Obsidian stays text-first |
| Your own `/morning` skill | A styled daily brief Claude writes as an HTML page | Good "today" summary, but static text, no history, no interaction |

**Verdict:** nothing combines your real sources (QIC Jira, ~15 GitHub repos, trading research, Claude sessions, learning). Worth building, and the `/morning` brief logic can become the dashboard's daily summary instead of a separate page.

## 3. What goes in it, and where the data comes from

| Life area | What you would see | Data source | Can Claude reach it today? |
|---|---|---|---|
| **Work: tickets** | Open Jira issues, due dates, blocked items, sprint progress | Atlassian (Jira, Confluence) | Yes, connected |
| **Work: code** | PRs waiting on you, failing CI, commits per repo (FastBind, NPS, Claims Copilot, risk-console, trades-recon...) | GitHub via `gh` | Yes |
| **Work: what I worked on** | Which projects got your time this week, per day | Claude Code session history (`~/.claude/projects`) | Yes, local files |
| **Calendar and email** | Meetings today, emails that need a reply | Google Calendar, Gmail | No. The plugins exist but are not configured |
| **Trading** | Prop-firm challenge: profit vs target, drawdown vs the 5% daily and 10% total limits, EA research status | Your `Trading/` folders, broker export | Partly. Depends on what files you have |
| **Learning** | Courses in progress, hours per week | `MD Files/Learning`, Coursera | Partly, mostly manual |
| **Side projects** | TeaNJuice, islamic-si, NFC, your site | GitHub | Yes |
| **Personal** | Sleep, exercise, money, habits, mood | Phone health export, bank CSV, or a 30-second daily check-in form | No. Needs either an export or you typing it in |

## 4. The heart of it: the "Needs you" engine

The most valuable part is not the charts, it is a strip at the top that ranks what you cannot miss. Simple rules decide what lands there, for example:

- A Jira ticket due in the next 48 hours, or overdue
- A PR waiting for your review for more than 1 day
- A failing CI build on a repo you own
- Trading drawdown above 70% of a limit (red above 85%)
- A meeting in the next 2 hours
- A bill or personal deadline you added

Each item shows **red** (act today), **amber** (this week) or nothing. Color is a second cue, not the only one (about 8% of men are color-blind), so each item also gets an icon and text.

On top of that, Claude writes 3 lines each morning, like: "Big week: FastBind release Thursday. 2 PRs are waiting on you. Trading drawdown is 3.1% of 10%, comfortable."

## 5. How it looks and moves

Two modes (from your vault's dashboard page):

- **Glance mode** (the home screen): few numbers, big, top-left is the most important. You should get the picture without clicking.
- **Explore mode**: click any tile, it expands into a full view with filters and history.

Visual pieces, each chosen because it reads fast, not because it looks fancy:

| Piece | Used for | Why this one |
|---|---|---|
| **Activity heatmap** (GitHub-style grid of squares, one per day) | Work hours, habits, workouts over the year | You see streaks and gaps instantly |
| **Sparklines** (tiny line chart inside a number tile) | Trend behind each number | Number plus direction in one glance |
| **Bullet bar** (a bar with a target line) | Trading drawdown vs limit, sprint progress vs plan | Reads more accurately than a round gauge |
| **Week timeline** | Meetings, deadlines, releases laid out on 7 days | Shows collisions and crunch days |
| **Sorted bars** | Time per project this week | Compare at a glance |
| **Life map** (interactive node graph: you in the center, life areas around, projects around those, size = attention, glow = needs you) | Explore mode, the "big picture of my life" view | This is the one that makes it feel alive |

Animation rules (from your vault's motion page): motion explains change, it is not decoration.

- Numbers count up to their value on load, charts draw themselves in.
- What changed since yesterday pulses once, then stays still.
- Tiles expand smoothly into their detail view (you keep your sense of place).
- Everything under 300ms, list items stagger under 50ms each, nothing loops forever.

## 6. Where it lives: three options

| | A. Claude Artifact (hosted page on claude.ai) | B. Local app on your PC | C. Hybrid |
|---|---|---|---|
| What it is | A private web page Claude publishes and refreshes | A small web app (React + charts + animation library) that runs on your laptop and opens in the browser | Local app for work, artifact for personal |
| Data refresh | A scheduled Claude task pulls new data a few times a day | Small scripts pull Jira, GitHub and files every 30 min, stored in a local database file | Both |
| Phone access | Yes | No, unless hosted | Personal part only |
| QIC data | Leaves your machine to claude.ai. **Check with QIC rules first** (ISO 27001 data handling) | Stays on your PC | Work data stays local |
| Visual ceiling | High | Highest, full control | High |

**My recommendation: B (local) for version 1.** Your work data is QIC data, and a local app keeps it on your laptop while still giving the richest visuals. If you want phone access later, add the personal half as an artifact (option C).

## 7. Build in steps (skateboard first)

| Step | What you get | Rough size |
|---|---|---|
| **1. Work skateboard** | Needs-you strip, Jira tiles, GitHub PRs and CI, time-per-project from Claude sessions, the morning summary. Real data, animations included | 1 to 2 sessions |
| **2. Calendar and trading** | Connect Gmail and Calendar, add the trading panel with drawdown bullets | 1 session plus your logins |
| **3. Personal life** | Daily check-in form, health or bank imports, the yearly heatmaps | 1 to 2 sessions |
| **4. Life map and phone** | The interactive node graph, phone layout, maybe the hosted personal half | 1 to 2 sessions |

**Success line for step 1:** you open it every morning for a week and it catches at least one thing you would otherwise have missed.

## 8. Decisions (Islam, 2026-10-30)

1. **Where:** local app on your PC (option B).
2. **Version 1 covers:** work (Jira, GitHub, Claude sessions), calendar and email, personal (health, money, habits), plus learning and an **AI "what next" layer** (below).
3. **Personal data:** a 30-second daily check-in form.
4. **Look:** dark navy sci-fi control room.

Because v1 is now wider than the work-only skateboard, the build order inside v1 becomes: work and AI layer first, then the check-in, then calendar and email once connected.

## 9. The AI "what next" layer

Not just showing tasks, but telling you which step to take next and why.

- **How it works:** every 30 minutes the collectors save fresh data (tickets, PRs, meetings, check-in, learning notes) to a local database. A few times a day a scheduled `claude -p` run (Claude Code in non-interactive mode, so no separate API key to manage) reads that snapshot and writes a short ranked list: "Next: review PR #42 on FastBind, it blocks Thursday's release. Then: the UAT checklist for risk-console."
- **Process awareness:** it uses your vault's procedures, for example the QIC release gates in `qic-engineering/`, so for a ticket heading to UAT it says which gate comes next (Architecture Committee, DevOps task, approvals) instead of a generic "do the ticket".
- **Learning:** it links what you are learning to what you are doing ("you have a Docker ticket this week, your Docker course module 4 covers it").
- **Shown as:** a "Next moves" panel beside the Needs-you strip, each item with a one-line reason and a link to the source. You can mark one done or dismiss it, and it learns from that.

## 10. What you need to do

- **Connect Gmail and Google Calendar** in claude.ai Settings, Connectors (they show as "not configured" in Claude Code right now). Until then that panel shows an empty state, no fake data.
