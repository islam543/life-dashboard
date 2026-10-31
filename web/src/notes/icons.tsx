// 16px line icons for the Notes view. Decorative: always next to text or inside a labelled control.

const base = {
  viewBox: "0 0 16 16",
  width: 16,
  height: 16,
  "aria-hidden": true,
  focusable: false,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function ChevronIcon() {
  return (
    <svg {...base}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg {...base}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg {...base}>
      <path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg {...base}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg {...base}>
      <path d="M9.5 3.5L5 8l4.5 4.5" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...base}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg {...base}>
      <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

export function WarnIcon() {
  return (
    <svg {...base}>
      <path d="M8 2.5l6 10.5H2z" />
      <path d="M8 6.75v2.75M8 11.25v.01" />
    </svg>
  );
}

export function TaskIcon() {
  return (
    <svg {...base} width={12} height={12}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg {...base}>
      <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function StackIcon() {
  return (
    <svg {...base}>
      <path d="M2.5 5.5L8 3l5.5 2.5L8 8z" />
      <path d="M2.5 8.5L8 11l5.5-2.5" />
      <path d="M2.5 11.25L8 13.75l5.5-2.5" />
    </svg>
  );
}
