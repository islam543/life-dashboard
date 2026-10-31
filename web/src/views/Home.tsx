import type { CSSProperties } from "react";
import { KpiTiles } from "../panels/KpiTiles";
import { NeedsYouStrip } from "../panels/NeedsYouStrip";
import { NextMovesPanel } from "../panels/NextMovesPanel";
import { ProjectTimeBars } from "../panels/ProjectTimeBars";
import { WeekTimeline } from "../panels/WeekTimeline";
import { YearHeatmap } from "../panels/YearHeatmap";
import styles from "./Home.module.css";

// Glance mode. Reading order = importance: what needs me, what to do next, the key numbers,
// then where the week and the year went. Grid areas live in Home.module.css; each panel fills its
// cell (height 100%), so panels must not set their own outer width or margin.

const order = (i: number) => ({ "--i": i }) as CSSProperties;

export function Home() {
  return (
    <div className={styles.grid}>
      <div className={`${styles.cell} ${styles.needs}`} style={order(0)}>
        <NeedsYouStrip />
      </div>
      <div className={`${styles.cell} ${styles.moves}`} style={order(1)}>
        <NextMovesPanel />
      </div>
      <div className={`${styles.cell} ${styles.kpis}`} style={order(2)}>
        <KpiTiles />
      </div>
      <div className={`${styles.cell} ${styles.week}`} style={order(3)}>
        <WeekTimeline />
      </div>
      <div className={`${styles.cell} ${styles.bars}`} style={order(4)}>
        <ProjectTimeBars />
      </div>
      <div className={`${styles.cell} ${styles.heat}`} style={order(5)}>
        <YearHeatmap />
      </div>
    </div>
  );
}
