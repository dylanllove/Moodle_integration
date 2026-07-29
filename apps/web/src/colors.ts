// Deterministic, accessible palette keyed by course id — stable across renders
// without needing to persist a colour per course.
//
// Mid-tone and muted so a row of them reads as one family beside the apricot
// accent, while staying far enough apart in hue to tell courses apart at a
// glance. Hues are spread ~340/315/268/215/188/160/95/37 degrees.
const PALETTE = [
  "#b03a5b", // raspberry
  "#a6478a", // magenta
  "#6b4a9e", // violet
  "#2f6fb3", // blue
  "#2e8894", // teal
  "#3f8a6e", // green
  "#5f7355", // sage
  "#c4842f", // ochre
];

export function courseColor(courseId: string | null | undefined): string {
  if (!courseId) return "#8a8a80"; // warm neutral grey for unlinked events
  let h = 0;
  for (let i = 0; i < courseId.length; i++) h = (h * 31 + courseId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
