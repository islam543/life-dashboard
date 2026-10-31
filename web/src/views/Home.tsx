import type { CSSProperties } from "react";
import { DoNowPanel } from "../panels/DoNowPanel";
import { KpiTiles } from "../panels/KpiTiles";
import { NeedsYouStrip } from "../panels/NeedsYouStrip";
import { NextMovesPanel } from "../panels/NextMovesPanel";
import { ProjectTimeBars } from "../panels/ProjectTimeBars";
import { SchedulePanel } from "../panels/SchedulePanel";
import { WeekTimeline } from "../panels/WeekTimeline";
import { YearHeatmap } from "../panels/YearHeatmap";
import styles from "./Home.module.css";

// Glance mode. Reading order = importance: what needs me, what to do next, today's schedule, the key
// numbers, then where the week and the year went. Grid areas live in Home.module.css; each panel fills
// its cell (height 100%), so panels must not set their own outer width or margin.
//
// `act` holds Needs you, Next moves and Schedule. Below 1920px it is display: contents, so all three
// stay plain grid cells and Schedule comes straight after Next moves. On ultrawide screens it is the
// left column: one stack whose three panels share the screen height and scroll inside themselves.
// `side` does the same on the right for Time by project (this week or month) and Do now under it
// (the tasks to do now, with AI steps), which takes the larger share. The DOM order is the same at
// every size.

const order = (i: number) => ({ "--i": i }) as CSSProperties;

export function Home() {
  return (
    <div className={styles.grid}>
      <div className={styles.act}>
        <div className={`${styles.cell} ${styles.needs}`} style={order(0)}>
          <NeedsYouStrip />
        </div>
        <div className={`${styles.cell} ${styles.moves}`} style={order(1)}>
          <NextMovesPanel />
        </div>
        <div className={`${styles.cell} ${styles.sched}`} style={order(2)}>
          <SchedulePanel />
        </div>
      </div>
      <div className={`${styles.cell} ${styles.kpis}`} style={order(3)}>
        <KpiTiles />
      </div>
      <div className={`${styles.cell} ${styles.week}`} style={order(4)}>
        <WeekTimeline />
      </div>
      <div className={styles.side}>
        <div className={`${styles.cell} ${styles.bars}`} style={order(5)}>
          <ProjectTimeBars />
        </div>
        <div className={`${styles.cell} ${styles.donow}`} style={order(6)}>
          <DoNowPanel />
        </div>
      </div>
      <div className={`${styles.cell} ${styles.heat}`} style={order(7)}>
        <YearHeatmap />
      </div>
    </div>
  );
}
