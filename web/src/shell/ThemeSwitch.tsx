import { setTheme, useTheme } from "../lib/theme";
import { Button } from "../ui/Button";

// Header button that flips between the dark and light themes (lib/theme.ts). The icon shows the theme
// you switch to, and the label names it.

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ThemeSwitch() {
  const theme = useTheme();
  const toLight = theme === "dark";
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={toLight ? <SunIcon /> : <MoonIcon />}
      onClick={() => setTheme(toLight ? "light" : "dark")}
      tip={
        toLight
          ? "Switches to the light theme for bright rooms. Remembered in this browser."
          : "Switches back to the dark navy theme. Remembered in this browser."
      }
    >
      {toLight ? "Light theme" : "Dark theme"}
    </Button>
  );
}
