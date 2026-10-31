// Builds the Earth data drawn behind the dashboard (web/src/ui/figures.ts):
//   web/src/assets/landDots.json     an even grid of [lon, lat] points that fall on land
//   web/src/assets/landOutline.json  coastlines as rings of [lon, lat], thinned to about 1 degree
// Run once after changing it: node scripts/build-land-dots.mjs
// Land shapes: Natural Earth 1:110m (public domain) via the world-atlas package (ISC).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { geoContains } from "d3";
import { feature } from "topojson-client";

const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve("world-atlas/land-110m.json"), "utf8"));
const land = feature(topo, topo.objects.land);
const round = (n) => Math.round(n * 10) / 10;

const STEP = 2.4; // degrees between rows; columns widen toward the poles so dots stay evenly spaced
const dots = [];
for (let lat = -84; lat <= 84; lat += STEP) {
  const step = STEP / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  for (let lon = -180; lon < 180; lon += step) {
    if (geoContains(land, [lon, lat])) dots.push([round(lon), round(lat)]);
  }
}
writeFileSync(new URL("../web/src/assets/landDots.json", import.meta.url), JSON.stringify(dots));
console.log(`${dots.length} land dots`);

// Coastlines: every outer ring of every land polygon, keeping a point only when it is at least
// MIN_GAP degrees from the last kept one. Tiny islands (under 5 kept points) are dropped.
const MIN_GAP = 1;
const rings = [];
const polygons = land.features.flatMap((f) =>
  f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates,
);
for (const polygon of polygons) {
  const ring = polygon[0];
  const kept = [];
  for (const [lon, lat] of ring) {
    const last = kept[kept.length - 1];
    if (!last || Math.hypot(lon - last[0], lat - last[1]) >= MIN_GAP) kept.push([round(lon), round(lat)]);
  }
  if (kept.length >= 5) {
    kept.push(kept[0]);
    rings.push(kept);
  }
}
writeFileSync(new URL("../web/src/assets/landOutline.json", import.meta.url), JSON.stringify(rings));
console.log(`${rings.length} coastline rings, ${rings.reduce((n, r) => n + r.length, 0)} points`);
