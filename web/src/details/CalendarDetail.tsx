import { useMemo, type ReactNode } from "react";
import type { CalendarEvent, EmailItem } from "../../../shared/types";
import type { DetailProps } from "../context/DetailContext";
import { useSnapshot, type SnapshotResult } from "../hooks/useSnapshot";
import { groupEventsByDay, isAllDay, parseDay } from "../lib/detailRows";
import { dayKey, formatClock, formatMinutes, plural, relativeTime } from "../lib/format";
import { Panel, panelFromSource, type PanelStatus } from "../ui/Panel";
import { StatusDot } from "../ui/StatusDot";
import { DataTable, Stagger, StaggerItem, TruncText, type Column } from "./WorkDetail";
import styles from "./CalendarDetail.module.css";

// Calendar and email explore view (areas "calendar" and "email" share it; "email" puts email first).
// Neither source is connected in v1, so both panels show the exact steps to connect them in
// claude.ai. Once data arrives: a day-by-day agenda and a sortable list of emails waiting on you.
// Never shows sample events.

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");
const dayHeading = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });

function ConnectSteps({ service }: { service: string }) {
  return (
    <span className={styles.connectSteps}>
      <span className={styles.connectStep}>
        <span className={cx(styles.stepNum, "num")}>1</span>
        Open claude.ai and go to Settings, then Connectors.
      </span>
      <span className={styles.connectStep}>
        <span className={cx(styles.stepNum, "num")}>2</span>
        Select Connect next to {service}.
      </span>
      <span className={styles.connectStep}>
        <span className={cx(styles.stepNum, "num")}>3</span>
        Sign in to Google and allow access.
      </span>
    </span>
  );
}

/** panelFromSource, with the exact claude.ai steps in place of the collector's short not-connected line. */
function statusWithSteps(
  snap: SnapshotResult,
  source: "calendar" | "email",
  service: string,
  purpose: string,
  opts: { isEmpty: Parameters<typeof panelFromSource>[2]["isEmpty"]; empty: string; emptyHint: string },
): Omit<PanelStatus, "hint"> & { hint?: ReactNode } {
  const status = panelFromSource(snap, source, opts);
  if (status.state !== "not_connected") return status;
  return { ...status, message: `Connect ${service} in claude.ai to see ${purpose} here.`, hint: <ConnectSteps service={service} /> };
}

/* ------------------------------------------------------------------ agenda */

function dayTitle(key: string, now: Date): string {
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  if (key === today) return "Today";
  if (key === tomorrow) return "Tomorrow";
  return dayHeading.format(parseDay(key));
}

function Agenda({ events, now }: { events: CalendarEvent[]; now: Date }) {
  const days = useMemo(() => groupEventsByDay(events, now), [events, now]);
  if (days.length === 0) {
    return <p className={styles.quiet}>Nothing on your calendar from today on.</p>;
  }
  return (
    <Stagger className={styles.agenda}>
      {days.map((day) => (
        <StaggerItem key={day.day} className={styles.day}>
          <h3 className={styles.dayHead}>
            <span>{dayTitle(day.day, now)}</span>
            <span className={cx(styles.dayCount, "num")}>{plural(day.items.length, "event")}</span>
          </h3>
          <ol className={styles.events}>
            {day.items.map((e) => {
              const allDay = isAllDay(e);
              const start = new Date(e.start);
              const end = new Date(e.end);
              const live = !allDay && start <= now && now < end;
              const past = !allDay && end <= now;
              const minutes = (end.getTime() - start.getTime()) / 60_000;
              return (
                <li key={e.id} className={cx(styles.event, live && styles.live, past && styles.past)}>
                  <span className={cx(styles.time, "num")}>
                    {allDay ? "All day" : formatClock(start)}
                    {!allDay && Number.isFinite(minutes) && minutes > 0 ? <span className={styles.duration}>{formatMinutes(minutes)}</span> : null}
                  </span>
                  <span className={styles.rail} aria-hidden="true">
                    <StatusDot tone={live ? "ok" : past ? "idle" : "ok"} size={9} glow={live} pulse={live} />
                  </span>
                  <span className={styles.eventMain}>
                    {live ? <span className={styles.nowTag}>Now</span> : null}
                    {e.url ? <TruncText href={e.url} text={e.title} className={styles.eventTitle} /> : <TruncText text={e.title} className={styles.eventTitle} />}
                  </span>
                </li>
              );
            })}
          </ol>
        </StaggerItem>
      ))}
    </Stagger>
  );
}

/* ------------------------------------------------------------------- email */

function EmailTable({ emails, now }: { emails: EmailItem[]; now: Date }) {
  const columns: Column<EmailItem>[] = [
    {
      id: "from",
      header: "From",
      width: "28%",
      sort: { value: (r) => r.from, firstDir: "asc" },
      cell: (r) => <TruncText text={r.from} className={styles.from} />,
    },
    {
      id: "subject",
      header: "Subject",
      width: "52%",
      sort: { value: (r) => r.subject, firstDir: "asc" },
      cell: (r) => (r.url ? <TruncText href={r.url} text={r.subject || "(no subject)"} /> : <TruncText text={r.subject || "(no subject)"} />),
    },
    {
      id: "received",
      header: "Received",
      width: "20%",
      align: "end",
      sort: { value: (r) => r.receivedAt, firstDir: "desc" },
      cell: (r) => <span className={cx(styles.muted, "num")}>{relativeTime(r.receivedAt, now)}</span>,
    },
  ];
  return (
    <DataTable
      caption="Emails waiting for a reply"
      noun="emails"
      columns={columns}
      rows={emails}
      rowKey={(r) => r.id}
      defaultSort={{ column: "received", dir: "desc" }}
      minWidth={380}
    />
  );
}

/* -------------------------------------------------------------------- view */

export function CalendarDetail({ area }: DetailProps) {
  const snap = useSnapshot();
  const generatedAt = snap.data?.generatedAt;
  const now = useMemo(() => new Date(), [generatedAt]);
  const events = useMemo(() => snap.data?.calendar ?? [], [snap.data]);
  const emails = useMemo(() => snap.data?.email ?? [], [snap.data]);

  const calendarStatus = statusWithSteps(snap, "calendar", "Google Calendar", "your meetings", {
    isEmpty: (s) => s.calendar.length === 0,
    empty: "No meetings coming up.",
    emptyHint: "Your calendar is clear from today on.",
  });
  const emailStatus = statusWithSteps(snap, "email", "Gmail", "emails that need a reply", {
    isEmpty: (s) => s.email.length === 0,
    empty: "No emails waiting for a reply.",
    emptyHint: "New ones show up here after the next refresh.",
  });

  const calendarPanel = (
    <StaggerItem key="calendar" className={styles.calendarCell}>
      <Panel title="Agenda" {...calendarStatus} meta={events.length > 0 ? plural(events.length, "event") : undefined} skeleton="rows">
        <Agenda events={events} now={now} />
      </Panel>
    </StaggerItem>
  );
  const emailPanel = (
    <StaggerItem key="email" className={styles.emailCell}>
      <Panel title="Emails waiting on you" {...emailStatus} meta={emails.length > 0 ? plural(emails.length, "email") : undefined} skeleton="rows">
        <EmailTable emails={emails} now={now} />
      </Panel>
    </StaggerItem>
  );

  return <Stagger className={cx(styles.grid, area === "email" && styles.emailFirst)}>{area === "email" ? [emailPanel, calendarPanel] : [calendarPanel, emailPanel]}</Stagger>;
}
