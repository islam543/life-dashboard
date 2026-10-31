// Small inline icons for the project tracker. 16px grid, stroke = currentColor, always aria-hidden:
// every control that shows one also has a text label or an aria-label.

const base = { viewBox: "0 0 16 16", "aria-hidden": true, focusable: false } as const;
const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function PlusIcon() {
  return (
    <svg {...base}>
      <path d="M8 3.5v9M3.5 8h9" {...line} strokeWidth={1.6} />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg {...base}>
      <path d="M9.5 3.5 5 8l4.5 4.5M5.5 8H13" {...line} strokeWidth={1.6} />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg {...base}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v3.8M9 7v3.8" {...line} />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg {...base}>
      <path d="M10.6 2.9 13.1 5.4 6 12.5 3 13l.5-3z" {...line} />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...base}>
      <path d="M4 4l8 8M12 4l-8 8" {...line} />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg {...base}>
      <path d="M5 6.5 8 9.5l3-3" {...line} />
    </svg>
  );
}

/** A Claude Code session: a terminal prompt. */
export function SessionIcon() {
  return (
    <svg {...base}>
      <rect x="2" y="3" width="12" height="10" rx="2" {...line} />
      <path d="M4.8 6.4 6.6 8 4.8 9.6M8 10h3" {...line} />
    </svg>
  );
}

/** A GitHub repo: a branch. */
export function RepoIcon() {
  return (
    <svg {...base}>
      <circle cx="5" cy="4" r="1.5" {...line} />
      <circle cx="5" cy="12" r="1.5" {...line} />
      <circle cx="11" cy="6" r="1.5" {...line} />
      <path d="M5 5.5v5M11 7.5c0 2-2 2.5-4.6 3.4" {...line} />
    </svg>
  );
}

export function NoteIcon() {
  return (
    <svg {...base}>
      <path d="M4 2.5h5.5L12 5v8.5H4z M9.5 2.5V5H12M6 8h4M6 10.5h3" {...line} />
    </svg>
  );
}

export function HideIcon() {
  return (
    <svg {...base}>
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM3 13 13 3" {...line} />
    </svg>
  );
}

export function TrackIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="5" {...line} />
      <path d="M8 5.5v5M5.5 8h5" {...line} />
    </svg>
  );
}

export function FoldIcon() {
  return (
    <svg {...base}>
      <path d="M3 8h7M7.5 5 10.5 8 7.5 11M13 3.5v9" {...line} />
    </svg>
  );
}

export function FlagIcon() {
  return (
    <svg {...base}>
      <path d="M4 14V2.5M4 3h7.5l-1.5 2.8 1.5 2.7H4" {...line} />
    </svg>
  );
}
