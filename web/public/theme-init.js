// Runs before the app so saved choices show on first paint. Same keys as web/src/lib/theme.ts and
// web/src/lib/motionPref.ts.
try {
  if (localStorage.getItem("life-dashboard:theme") === "light") document.documentElement.dataset.theme = "light";
  if (localStorage.getItem("life-dashboard:backdrop-motion") === "off") document.documentElement.dataset.still = "true";
} catch (e) {
  // Storage blocked: dark theme, motion on.
}
