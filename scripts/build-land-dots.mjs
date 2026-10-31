// Builds web/src/assets/landDots.json: an even grid of [lon, lat] points that fall on land, for the
// dotted Earth behind the dashboard (web/src/ui/Backdrop.tsx). Run once: node scripts/build-land-dots.mjs
// Land shapes: Natural Earth 1:110m (public domain) via the world-atlas package (ISC).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { geoContains } from "d3";
import { feature } from "topojson-client";

const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve("world-atlas/land-110m.json"), "utf8"));
const land = feature(topo, topo.objects.land);

const STEP = 2.4; // degrees between rows; columns widen toward the poles so dots stay evenly spaced
const dots = [];
for (let lat = -84; lat <= 84; lat += STEP) {
  const step = STEP / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  for (let lon = -180; lon < 180; lon += step) {
    if (geoContains(land, [lon, lat])) dots.push([Math.round(lon * 10) / 10, Math.round(lat * 10) / 10]);
  }
}
writeFileSync(new URL("../web/src/assets/landDots.json", import.meta.url), JSON.stringify(dots));
console.log(`${dots.length} land dots`);
