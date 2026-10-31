# Connecting Jira, Calendar and Email

Checked on 2026-10-31.

## Short answer

**You don't need any API keys.** You are already signed in to all three through your claude.ai account. Connectors (claude.ai's sign-in links to other services) are:

| Service | Connector | Status on this PC |
|---|---|---|
| Jira (`qicbizdev.atlassian.net`) | Atlassian | Connected. A test search returned your 8 open issues. |
| Work calendar | Google Calendar | Connected |
| Work email | Gmail | Connected |

Your work address (`bd.qatarinsurance.com`) runs on Google Workspace, so your work mail and calendar are Gmail and Google Calendar. A DNS check of the domain's mail servers (MX records) confirmed this.

**What's missing is on the dashboard side.** Today the dashboard reads Jira only with an API token from `.env`, and Calendar and Email are empty placeholders. It needs one new data collector (a piece of code that fetches data on a schedule) that asks Claude to read these services through your connectors. Claude already uses your login the same way for the "Next moves" suggestions.

## Option A (recommended): through your Claude connectors, no keys

How it would work:
1. Every 30 to 60 minutes, while the dashboard is running, it starts a background Claude run (`claude -p`).
2. That run may only use **read** tools:
   - Jira: search your open issues.
   - Calendar: list today's and tomorrow's events.
   - Gmail: list recent unread or important mail. It reads the sender and subject only, not the full message.
3. Claude returns plain data (JSON). The dashboard checks it and shows it in the Jira, Calendar and Email panels.

What you need to do: nothing new. If a connector ever signs out, reconnect it at claude.ai, then Settings, then Connectors.

Trade-offs:
- Each refresh takes about 30 to 90 seconds and counts toward your Claude usage. That is why it runs every 30 to 60 minutes, not every minute.
- It only works while your Claude login is valid. If the login expires, the panels show "not connected" again.
- Safety: an email could contain text that tries to give Claude instructions. Three things guard against it:
  - The run has no tools that can send, edit, delete or run commands.
  - It sees only senders and subjects.
  - The dashboard treats whatever comes back as data, never as commands.

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
