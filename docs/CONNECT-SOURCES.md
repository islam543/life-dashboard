# Connecting Jira, Calendar and Email

Checked on 2026-10-31.

## Short answer

**You don't need any API keys.** You are already signed in to all three through your claude.ai account. Connectors (claude.ai's sign-in links to other services) are:

| Service | Connector | Status on this PC |
|---|---|---|
| Jira (`qicbizdev.atlassian.net`) | Atlassian | Working. Read tool: `searchJiraIssuesUsingJql`. |
| Work calendar | Google Calendar | Working. Read tool: `list_events`. |
| Work email | Gmail | Working. Read tool: `search_threads` (sender and subject only). |

The first run with all three took 24 seconds. The run may call only these three tools: send, reply, forward, draft, label, trash, and creating, changing or answering events are never allowed.

Your work address (`bd.qatarinsurance.com`) runs on Google Workspace, so your work mail and calendar are Gmail and Google Calendar. A DNS check of the domain's mail servers (MX records) confirmed this.

## Option A (recommended, built): through your Claude connectors, no keys

How it works:
1. About a minute after the dashboard starts, and then every hour, it starts a background Claude run (`claude -p`). Pressing Refresh also starts one if the last run is more than 10 minutes old. The dashboard does not wait for it; the panels update when it finishes, usually within a minute.
2. That run may only use **read** tools:
   - Jira: search your open issues (up to 50).
   - Calendar: list your events from now to the end of tomorrow, skipping ones you declined (up to 30).
   - Gmail: list unread inbox mail from the last 2 days (up to 20). It reads the sender and subject only, never the message itself.
3. Claude returns plain data (JSON). The dashboard checks it and shows it in the Jira, Calendar and Email panels. Each panel says "Via Claude connector" and when the data was fetched.

What you need to do:
- **Jira:** nothing.
- **Calendar and Gmail:** done on 2026-10-31. Claude Code needs its own sign-in to them; being signed in at claude.ai is not enough for background runs. If a panel ever says "Sign in for Claude Code", sign in again:
  1. Open a terminal and type `claude`.
  2. Type `/mcp`.
  3. Pick **claude.ai Google Calendar** and sign in. Do the same for **claude.ai Gmail**.
- **Gmail detail:** the read tool gives sender and subject but no date or link, so the dashboard reads the time from the Gmail message id (it has the time built in) and builds the link from the thread id.
- **Optional:** to change how often it runs, add `CONNECTORS_EVERY_MIN=30` (any number of minutes, 15 or more) to `.env` and restart the dashboard.

Panel states:
- **Fresh data:** fetched within the last 2 runs (2 hours by default).
- **Stale:** older than that. The old data stays visible and the panel says when it was fetched.
- **Waiting for the first run:** right after the very first start.
- **Error:** the last run failed and there is no data yet. The message says why, for example "Run claude in a terminal and log in".

Trade-offs:
- Each run takes about 15 to 90 seconds and counts toward your Claude usage. That is why it runs once an hour, not every minute.
- It only works while your Claude login is valid. If the login expires, the panels keep the last data and show the error.
- If `JIRA_API_TOKEN` is in `.env`, Jira uses the token instead (Option B) and the Claude run skips Jira.
- Safety: an email or issue title could contain text that tries to give Claude instructions. Several things guard against it:
  - The run has no tools that can send, edit, delete or run commands. It can only load and call the listed read tools.
  - It sees only senders and subjects, never message bodies.
  - The dashboard checks everything that comes back: only known fields, length limits, real dates, and links only to Jira, Google Calendar or Gmail addresses.
  - The dashboard treats whatever comes back as text to show, never as commands.

## Option B: API keys, if you would rather not use Claude for this

### Jira API token (2 minutes, works with the code that exists today)
1. Go to `https://id.atlassian.com/manage-profile/security/api-tokens`. Sign in with the account you use for Jira.
2. Click **Create API token**. Choose the plain one, not "with scopes": the dashboard calls your Jira site address directly, and scoped tokens need a different address.
3. Give it a name, for example `life-dashboard`, and pick an expiry. Atlassian tokens expire after one year at most, so note the date.
4. Copy the token. It is shown only once.
5. Open the file `.env` in `C:\Users\ialab\Desktop\personal\life-dashboard` and create it if it is missing. Add these two lines:
   ```
   JIRA_EMAIL=<the email you sign in to Jira with>
   JIRA_API_TOKEN=<the token you copied>
   ```
   `JIRA_SITE` already defaults to `qicbizdev.atlassian.net`.
6. Restart the dashboard: sign out of Windows and back in, or double-click `scripts\life-dashboard-startup.vbs`.

Note: Atlassian org admins can block personal API tokens. If step 2 shows no "Create" button or an error, use Option A.

### Google Calendar and Gmail
Google does not use simple API keys for your own mail and calendar. Three routes:
- **OAuth app.** OAuth is the "Sign in with Google" permission flow. Steps:
  1. Create a Google Cloud project.
  2. Turn on the Gmail API and the Calendar API.
  3. Set up the consent screen as "Internal".
  4. Create an OAuth client of type "Desktop app" and download its `client_secret.json`.
  5. Sign in once in the browser.

  QIC's Google Workspace admin may not let you create projects or approve apps. This route needs new code.
- **Calendar only, a secret iCal link** (a private read-only web address for your calendar). In Google Calendar, go to Settings, then your calendar under "Settings for my calendars", then Integrate calendar, then "Secret address in iCal format". Workspace admins often hide this option. Treat the link like a password. This route needs a small new collector.
- **Email only, IMAP with an app password.** IMAP is the standard way mail apps read a mailbox, and an app password is a 16-letter password Google makes for one app. It needs 2-Step Verification turned on, and your Workspace admin can block it. This route needs new code.

## Recommendation
Use **Option A** for all three. It uses sign-ins that already work, it needs no keys stored on disk, and nothing to renew each year. Use the Jira API token only if you want Jira to refresh without using Claude.
