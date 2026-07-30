// Deterministic, accessible palette keyed by course id — stable across renders
// without needing to persist a colour per course.
//
// Mid-tone and muted so a row of them reads as one family, while staying far
// enough apart in hue to tell courses apart at a glance.
//
// Two slots are deliberately pulled away from the accent colours: the blue is
// pushed to indigo so a course bar never reads as the sky accent, and the ochre
// is deepened so it doesn't mimic the sand highlight pills.
const PALETTE = [
  "#b03a5b", // raspberry
  "#a6478a", // magenta
  "#6b4a9e", // violet
  "#3b4f9e", // indigo — clear of the sky accent
  "#2f8a8f", // teal
  "#3f8a6e", // green
  "#5f7355", // sage
  "#a8712a", // ochre — deeper than the sand highlight
];

export function courseColor(courseId: string | null | undefined): string {
  if (!courseId) return "#8a8a80"; // warm neutral grey for unlinked events
  let h = 0;
  for (let i = 0; i < courseId.length; i++) h = (h * 31 + courseId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
