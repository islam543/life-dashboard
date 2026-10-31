import { setBackdropMotion, useBackdropMotion } from "../lib/motionPref";
import { Button } from "../ui/Button";

// Header button that pauses or resumes the animated background (ui/Backdrop.tsx and the Life map
// radar). Charts and buttons keep their own short animations either way.

function WaveIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M1.5 8c1.6-3 3.2-3 4.8 0s3.2 3 4.8 0 2.4-2.2 3.4-.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MotionSwitch() {
  const on = useBackdropMotion();
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<WaveIcon />}
      aria-pressed={on}
      onClick={() => setBackdropMotion(!on)}
      tip={
        on
          ? "Pauses the moving background and the Life map radar. Remembered in this browser."
          : "Starts the moving background and the Life map radar again."
      }
    >
      {on ? "Motion on" : "Motion off"}
    </Button>
  );
}
