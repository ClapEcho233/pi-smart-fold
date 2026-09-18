/**
 * pi-smart-fold — pure folding / formatting helpers.
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
  // Wide: keycap-base misc-technical emoji (⏱ ⏳ ⏰ …) with emoji presentation
  if (cp >= 0x23e9 && cp <= 0x23f3) {
    return 2;
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

/** Clamp a renderer-provided width to something sane for one-line folding. */
export function sanitizeWidth(availableWidth: number, fallback = 80): number {
  return Number.isFinite(availableWidth) && availableWidth >= 8
    ? Math.floor(availableWidth)
    : fallback;
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
  return tailFit(line, sanitizeWidth(availableWidth));
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Human-readable duration.
 * - "live": whole seconds, for the ticking badge while the model thinks.
 * - "final": one decimal below a minute, then `XmYYs` / `XhYYm`.
 */
export function formatDuration(ms: number, style: "live" | "final" = "final"): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  if (style === "live") {
    if (totalSeconds < 60) return `${totalSeconds}s`;
    if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m${pad2(totalSeconds % 60)}s`;
    return `${Math.floor(totalSeconds / 3600)}h${pad2(Math.floor((totalSeconds % 3600) / 60))}m`;
  }
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m${pad2(totalSeconds % 60)}s`;
  return `${Math.floor(totalSeconds / 3600)}h${pad2(Math.floor((totalSeconds % 3600) / 60))}m`;
}

// ---------------------------------------------------------------------------
// Content hashing (stable identity for a thinking block across renders)
// ---------------------------------------------------------------------------

/** 32-bit FNV-1a of a string (UTF-16 code units). */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Cheap, stable content hash: `<length>:<fnv1a-hex>`.
 * Used to match a rendered thinking block back to its recorded duration.
 */
export function hashText(text: string): string {
  return `${text.length.toString(36)}:${fnv1a(text).toString(16)}`;
}

// ---------------------------------------------------------------------------
// Line diff (for the write tool's `+N -M` stat)
// ---------------------------------------------------------------------------

export interface LineDiffStat {
  added: number;
  removed: number;
}

function splitLines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}

/**
 * Line-level added/removed counts between two file contents, git-diff style.
 *
 * Common prefix/suffix lines are trimmed first (cheap), then the middle is
 * measured with an LCS table. When the middle is too large for the LCS
 * budget (`maxCells`), it is treated as a full replacement.
 * `oldText === undefined` means the file did not exist yet (everything added).
 */
export function countLineDiff(
  oldText: string | undefined,
  newText: string,
  maxCells = 1_500_000,
): LineDiffStat {
  const next = splitLines(newText);
  if (oldText === undefined) return { added: next.length, removed: 0 };
  const prev = splitLines(oldText);
  if (prev.join("\n") === next.join("\n")) return { added: 0, removed: 0 };

  // Trim common prefix/suffix (without letting them overlap).
  let prefix = 0;
  while (prefix < prev.length && prefix < next.length && prev[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < prev.length - prefix &&
    suffix < next.length - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }
  const a = prev.slice(prefix, prev.length - suffix);
  const b = next.slice(prefix, next.length - suffix);
  if (a.length === 0) return { added: b.length, removed: 0 };
  if (b.length === 0) return { added: 0, removed: a.length };
  if (a.length * b.length > maxCells) return { added: b.length, removed: a.length };

  // LCS length over the middle sections (classic DP, row-major Uint32 table).
  const n = a.length;
  const m = b.length;
  const stride = m + 1;
  const dp = new Uint32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * stride;
    const nextRow = (i + 1) * stride;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] =
        a[i] === b[j]
          ? dp[nextRow + j + 1] + 1
          : Math.max(dp[nextRow + j], dp[row + j + 1]);
    }
  }
  const common = dp[0];
  return { added: b.length - common, removed: a.length - common };
}

/**
 * Line-level added/removed counts summed over an edit tool's edits array
 * (supports the legacy single oldText/newText shape). Returns undefined when
 * there is nothing renderable.
 */
export function countEditsLineDiff(
  input: { edits?: unknown; oldText?: unknown; newText?: unknown } | undefined,
): LineDiffStat | undefined {
  if (!input || typeof input !== "object") return undefined;
  const edits = Array.isArray(input.edits)
    ? input.edits
    : typeof input.oldText === "string" && typeof input.newText === "string"
      ? [{ oldText: input.oldText, newText: input.newText }]
      : [];
  let added = 0;
  let removed = 0;
  let seen = false;
  for (const edit of edits as Array<{ oldText?: unknown; newText?: unknown }>) {
    if (!edit || typeof edit !== "object") continue;
    const oldText = typeof edit.oldText === "string" ? edit.oldText : undefined;
    const newText = typeof edit.newText === "string" ? edit.newText : undefined;
    if (oldText === undefined && newText === undefined) continue;
    const stat = countLineDiff(oldText, newText ?? "");
    added += stat.added;
    removed += stat.removed;
    seen = true;
  }
  return seen ? { added, removed } : undefined;
}

// ---------------------------------------------------------------------------
// Thinking line renderers (display-only, used by the markdown transformer)
// ---------------------------------------------------------------------------

/**
 * The live two-line view shown while the model is thinking:
 * ```
 * Thinking… (8s)      ← bold label line
 * <scrolling tail>     ← newest thinking text, tail-truncated
 * ```
 * Without a known elapsed time only the tail line is shown.
 */
export function liveThinkingLine(
  markdown: string,
  elapsedMs: number | undefined,
  width: number,
): string {
  const tail = stripBlockMarkers(lastNonEmptyLine(markdown));
  if (!tail) return markdown;
  const fitted = tailFit(tail, sanitizeWidth(width));
  if (elapsedMs === undefined) return fitted;
  return `**Thinking… (${formatDuration(elapsedMs, "live")})**\n\n${fitted}`;
}

/**
 * The single collapsed line shown once a thinking run has finished.
 * - "smart": `Thought for 12.4s` (bold) — pi's native hidden-label look plus time.
 * - "tail":  bold duration prefix + the last line (legacy one-line tail fold).
 */
export function foldedThinkingLine(
  markdown: string,
  ms: number | undefined,
  width: number,
  style: "smart" | "tail",
): string {
  const w = sanitizeWidth(width);
  if (style === "tail") {
    const tail = stripBlockMarkers(lastNonEmptyLine(markdown));
    if (!tail) return markdown;
    const prefix = ms === undefined ? "" : `**${formatDuration(ms, "final")}** · `;
    return tailFit(prefix + tail, w);
  }
  return tailFit(
    ms === undefined ? "**Thought…**" : `**Thought for ${formatDuration(ms, "final")}**`,
    w,
  );
}

/**
 * Bold live-timing footer appended below fully-expanded thinking text while
 * the run is still streaming (`\n\n**Thinking… (8s)**`), or an empty string
 * when the elapsed time is unknown. Keeps updating at the bottom of the
 * block while the full text grows.
 */
export function liveExpandedSuffix(ms: number | undefined): string {
  return ms === undefined ? "" : `\n\n**Thinking… (${formatDuration(ms, "live")})**`;
}

/**
 * Bold duration footer appended below fully-expanded thinking text
 * (`\n\n**Thought for 12.4s**`), or an empty string when unknown.
 */
export function expandedThinkingSuffix(ms: number | undefined): string {
  return ms === undefined ? "" : `\n\n**Thought for ${formatDuration(ms, "final")}**`;
}

