/**
 * pi-smart-fold — pure folding helpers.
 *
 * No pi imports here: this module stays dependency-free and unit-testable
 * with plain `node` (Node >= 23 type stripping; no build step needed).
 */

/** Regex for CSI / OSC escape sequences — ignored when measuring width. */
const ANSI_PATTERN =
  /(?:\u001b\[[0-9;?]*[A-Za-z])|(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\))/g;

/**
 * Display width of a single code point.
 * East Asian wide/fullwidth characters and emoji count as 2 columns,
 * combining marks and zero-width characters count as 0.
 * Best-effort approximation — good enough for one-line truncation.
 */
export function codePointWidth(cp: number): number {
  // Zero-width: combining diacritics, ZWSP, BOM, variation selectors
  if (
    cp === 0x200b ||
    cp === 0xfeff ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) {
    return 0;
  }
  // Wide: Hangul Jamo, CJK radicals/symbols, kana, Yi, Hangul syllables,
  // CJK ideographs (incl. ext A/B+), compat ideographs/forms, fullwidth forms,
  // common emoji planes
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Terminal display width of a string, in columns (ANSI escapes ignored). */
export function displayWidth(input: string): number {
  let width = 0;
  for (const ch of input.replace(ANSI_PATTERN, "")) {
    width += codePointWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

/**
 * Keep only the tail of `input` that fits within `maxWidth` display columns.
 * When content is cut, an ellipsis `…` is prefixed (reserving 1 column).
 */
export function tailFit(input: string, maxWidth: number): string {
  if (!Number.isFinite(maxWidth)) return input;
  if (maxWidth < 1) return "";
  if (displayWidth(input) <= maxWidth) return input;

  const budget = maxWidth - 1; // reserve one column for the ellipsis
  if (budget < 1) return "…";

  const chars = Array.from(input);
  let used = 0;
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = codePointWidth(chars[i].codePointAt(0) ?? 0);
    if (used + w > budget) break;
    used += w;
    start = i;
  }
  return "…" + chars.slice(start).join("");
}

/** Last line of a markdown string whose trimmed content is non-empty. */
export function lastNonEmptyLine(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") return lines[i];
  }
  return "";
}

/**
 * Strip common block-level markdown markers (`#`, `>`, `-`, `*`, `1.`)
 * so the collapsed line reads like prose. Runs a few passes for nesting
 * like `> - item`. Code fence markers are removed since they cannot
 * render usefully on a single collapsed line.
 */
export function stripBlockMarkers(raw: string): string {
  let line = raw.trim();
  for (let pass = 0; pass < 3; pass++) {
    const next = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d{1,9}[.)]\s+/, "");
    if (next === line) break;
    line = next;
  }
  line = line.replace(/`{3,}/g, "");
  return line.trim();
}

/**
 * Collapse a thinking markdown block into a single line:
 * take its last non-empty line, strip block markers, and tail-truncate
 * to `availableWidth` display columns. Falls back to the original
 * markdown when there is nothing to show.
 */
export function collapseThinking(markdown: string, availableWidth: number): string {
  const line = stripBlockMarkers(lastNonEmptyLine(markdown));
  if (!line) return markdown;
  // Sanitize the width: renderers should always pass a positive number, but a
  // missing/NaN value must degrade to a sane default instead of leaking NaN.
  const width = Number.isFinite(availableWidth) && availableWidth >= 8
    ? Math.floor(availableWidth)
    : 80;
  return tailFit(line, width);
}
