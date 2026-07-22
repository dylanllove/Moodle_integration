// Deterministic, accessible palette keyed by course id — stable across renders
// without needing to persist a colour per course.
const PALETTE = [
  "#2563eb", // blue
  "#059669", // emerald
  "#d97706", // amber
  "#dc2626", // red
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
];

export function courseColor(courseId: string | null | undefined): string {
  if (!courseId) return "#6b7280"; // neutral grey for unlinked events
  let h = 0;
  for (let i = 0; i < courseId.length; i++) h = (h * 31 + courseId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
