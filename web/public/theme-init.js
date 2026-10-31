// Runs before the app so a saved light theme shows on first paint. Same key as web/src/lib/theme.ts.
try {
  if (localStorage.getItem("life-dashboard:theme") === "light") document.documentElement.dataset.theme = "light";
} catch (e) {
  // Storage blocked: dark theme.
}
