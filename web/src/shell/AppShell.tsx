import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckinDialog } from "../checkin/CheckinDialog";
import { useDetail } from "../context/DetailContext";
import { useSnapshot } from "../hooks/useSnapshot";
import { formatClock } from "../lib/format";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import { DetailOverlay } from "./DetailOverlay";
import { Header, type Route } from "./Header";
import styles from "./AppShell.module.css";

// Page frame: skip link, header, offline banner, the current view, then the layers on top
// (detail overlay, check-in dialog). While the overlay is open the page behind is inert.

function OfflineBanner() {
  const snap = useSnapshot();
  const [retrying, setRetrying] = useState(false);
  if (!snap.error) return null;

  const retry = async () => {
    setRetrying(true);
    await snap.refresh();
    setRetrying(false);
  };

  // The time the data on screen was generated, same clock as the header's "Updated ... ago".
  const since = snap.data ? formatClock(snap.data.generatedAt) : null;
  const title = snap.offline ? "Can't reach the dashboard server." : "Couldn't update the dashboard.";
  const body = snap.offline
    ? since
      ? `Showing data from ${since}. Check that npm run dev is still running.`
      : "Start it with npm run dev in the project folder, then retry."
    : since
      ? `${snap.error} Showing data from ${since}.`
      : snap.error;

  return (
    <div className={styles.banner} role="alert" data-tone={snap.offline ? "danger" : "warn"}>
      <StatusDot tone={snap.offline ? "danger" : "warn"} size={10} />
      <p className={styles.bannerText}>
        <strong>{title}</strong> <span>{body}</span>
      </p>
      <Button size="sm" onClick={() => void retry()} loading={retrying} loadingLabel="Retrying">
        Retry
      </Button>
    </div>
  );
}

export function AppShell({ route, children }: { route: Route; children: ReactNode }) {
  const { openArea, closeDetail } = useDetail();
  const pageRef = useRef<HTMLDivElement>(null);
  const firstRoute = useRef(true);

  // The page behind the detail overlay can't be focused or clicked.
  useEffect(() => {
    pageRef.current?.toggleAttribute("inert", openArea !== null);
  }, [openArea]);

  // A view switch closes any open detail and moves focus to the new view (not on first load).
  useEffect(() => {
    document.title = route === "map" ? "Life map | Life dashboard" : "Life dashboard";
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    closeDetail();
    document.getElementById("main")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [route, closeDetail]);

  return (
    <>
      <div ref={pageRef} className={styles.page}>
        <a
          className={styles.skip}
          href="#main"
          onClick={(e) => {
            // The hash is the router, so move focus without touching it.
            e.preventDefault();
            document.getElementById("main")?.focus();
          }}
        >
          Skip to content
        </a>
        <Header route={route} />
        <OfflineBanner />
        <main id="main" tabIndex={-1} className={styles.main}>
          {children}
        </main>
      </div>
      <DetailOverlay />
      <CheckinDialog />
    </>
  );
}
