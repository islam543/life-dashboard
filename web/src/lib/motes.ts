// The data-mote field behind the page (ui/Backdrop.tsx): plain math, no DOM, so it can be tested.
// Motes drift slowly, wrap at the edges, and a pair closer than `link` px gets a faint line.

export interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radius in px. */
  r: number;
  /** Twinkle phase, radians. */
  phase: number;
}

/** About one mote per 36 000 px of window, kept between 24 and 90 so tiny and huge windows both look right. */
export function moteCount(width: number, height: number): number {
  return Math.max(24, Math.min(90, Math.round((width * height) / 36_000)));
}

/** A deterministic field for a window size: same seed, same motes (stable across re-renders and tests). */
export function makeMotes(width: number, height: number, seed = 7): Mote[] {
  let s = seed >>> 0 || 1;
  const rand = () => {
    // xorshift32: small, fast and good enough for scattering dots.
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  return Array.from({ length: moteCount(width, height) }, () => {
    const angle = rand() * Math.PI * 2;
    const speed = 4 + rand() * 10; // px per second: slow on purpose
    return {
      x: rand() * width,
      y: rand() * height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3, // a gentle upward drift overall
      r: 0.6 + rand() * 1.4,
      phase: rand() * Math.PI * 2,
    };
  });
}

/** Moves every mote by `dt` seconds and wraps it around the edges (with a margin so it never pops in). */
export function stepMotes(motes: Mote[], dt: number, width: number, height: number, margin = 20): void {
  for (const m of motes) {
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    if (m.x < -margin) m.x += width + 2 * margin;
    else if (m.x > width + margin) m.x -= width + 2 * margin;
    if (m.y < -margin) m.y += height + 2 * margin;
    else if (m.y > height + margin) m.y -= height + 2 * margin;
  }
}

/** Pairs closer than `link` px, with a strength from 1 (touching) down to 0 (at the limit). */
export function moteLinks(motes: readonly Mote[], link: number): { a: number; b: number; strength: number }[] {
  const out: { a: number; b: number; strength: number }[] = [];
  const max2 = link * link;
  for (let i = 0; i < motes.length; i++) {
    for (let j = i + 1; j < motes.length; j++) {
      const dx = motes[i].x - motes[j].x;
      const dy = motes[i].y - motes[j].y;
      const d2 = dx * dx + dy * dy;
      if (d2 < max2) out.push({ a: i, b: j, strength: 1 - Math.sqrt(d2) / link });
    }
  }
  return out;
}

/** How much the pointer lights a point: 1 on top of it, fading to 0 at `radius` px. */
export function pointerGlow(x: number, y: number, px: number | null, py: number | null, radius: number): number {
  if (px === null || py === null) return 0;
  const d = Math.hypot(x - px, y - py);
  return d >= radius ? 0 : 1 - d / radius;
}
