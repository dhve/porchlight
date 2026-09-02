// semver.js - minimal, dependency-free version comparison for the
// vulnerable-library check. Handles the common "1.2.3" / "1.2" / "1" shapes.

/** Returns -1, 0, or 1 comparing dotted numeric versions a and b. */
export function cmp(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
export const lt = (a, b) => cmp(a, b) < 0;
export const gte = (a, b) => cmp(a, b) >= 0;

/** True if version is inside [atLeast, below). atLeast optional. */
export function inRange(version, { atLeast, below }) {
  if (atLeast && lt(version, atLeast)) return false;
  if (below && !lt(version, below)) return false;
  return true;
}
