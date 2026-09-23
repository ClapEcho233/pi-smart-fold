/**
 * pi-smart-fold
 * =============
 * A pi (https://github.com/earendil-works/pi-mono) coding-agent extension that
 * keeps the transcript compact:
 *
 *   1. Thinking blocks:
 *      - While the model thinks, the block shows a bold `Thinking… (8s)`
 *        label line, then the scrolling tail of the thinking text below it.
 *      - Clicking the live block toggles directly between that scrolling
 *        tail and the full text so far — no intermediate label state. In
 *        full view the ticking bold `Thinking… (8s)` line stays pinned at
 *        the bottom of the block while the text grows above it.
 *      - Once the message finishes, the block collapses to a single bold
 *        `Thought for 12.4s` line.
 *      - Click a collapsed block once — that single block expands to its
 *        full text (with the duration footer at the bottom); click once more
 *        to collapse it again. Finished thinking starts in pi's hidden state
 *        (the prototype patch seeds it and writes the per-message label
 *        `Thought for 12.4s`), so each click lands directly on the expanded
 *        rendering — no intermediate state.
 *      - Click detection is exact, not heuristic: pi's click handler mutates
 *        the component's internal `thinkingVisibilityOverrides` map before
 *        re-rendering. The extension observes that mutation through a small
 *        idempotent prototype patch on the (publicly exported)
 *        AssistantMessageComponent, so global re-renders (theme change,
 *        resize, ctrl+t) never fake a click.
 *      - The extension owns pi's hidden-thinking label text, so the native
 *        "Thinking..." never appears — clicks and ctrl+t show our hint.
 *      - Durations are measured per thinking run and persisted in the
 *        session, so restored sessions keep showing them.
 *   2. Tool output is collapsed on every session start (`session_start`
 *      covers startup, /reload, /new, /resume and /fork).
 *   3. The `write` tool gets git-style stats in its header line —
 *      `write path +12 -3` (green additions, red deletions) — computed by
 *      diffing the file content before the write executes. Collapsed write
 *      rows show only that header line (the content preview appears when
 *      expanded).
 *
 * Thinking text is never modified on disk or in the LLM context: folding is
 * display-only, applied through pi's markdown-transformer hook. The write
 * override delegates to pi's own write tool implementation; only the TUI
 * rendering is customized.
 *
 * Runtime control:
 *   /fold                          open the /config-style settings list
 *   /fold thinking smart|tail|full|off
 *   /fold expand on|off            expand-all fallback (per-block clicks are primary)
 *   /fold tools on|off
 *   /fold writestat on|off
 *   /fold writecollapsed header|preview
 *
 * Config file: `smart-fold.config.json` next to this entry file.
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, SettingItem } from "@earendil-works/pi-tui";

import {
  closeOpenFences,
  countEditsLineDiff,
  countLineDiff,
  displayWidth,
  formatDuration,
  expandedThinkingSuffix,
  foldedThinkingLine,
  hashText,
  liveExpandedSuffix,
  liveThinkingLine,
} from "./lib/fold.ts";
import {
  defaultConfig,
  loadConfig,
  saveConfig,
  type SmartFoldConfig,
  type ThinkingMode,
  type WriteCollapsedStyle,
} from "./lib/config.ts";
import { ThinkingTracker } from "./lib/thinking.ts";

/** Best-effort resolve of this extension's directory (for the config file). */
function resolveExtensionDir(): string | undefined {
  try {
    // jiti (pi's TS loader) shims import.meta.url for extension modules.
    const url = import.meta.url;
    if (typeof url === "string" && url.startsWith("file:")) {
      return dirname(fileURLToPath(url));
    }
  } catch {
    // fall through
  }
  try {
    // jiti CJS interop fallback
    if (typeof __filename === "string") return dirname(__filename);
  } catch {
    // ignore
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Thinking display state (exact, not heuristic): single-click expand
// ---------------------------------------------------------------------------
//
// pi's thinking click handler does:
//     this.thinkingVisibilityOverrides.set(runIndex, !hidden);
//     this.updateContent(this.lastMessage);
// and ctrl+t / the settings toggle do:
//     this.thinkingVisibilityOverrides.clear();
//     this.updateContent(...)
//
// A block renders "hidden" (pi's native label state) when
//     overrides.get(runIndex) ?? hideThinkingBlock
// is true. We patch AssistantMessageComponent.prototype.updateContent
// (idempotently, shared across extension reloads via Symbol.for keys) to:
//
//   1. SEED every thinking run of a FINALIZED message with a hidden override
//      when it has none yet (runs a streaming-era redirect left visible but
//      folded are normalized into the seeded state as well). Finished
//      thinking therefore starts collapsed in the hidden state — and since we
//      also set the component's label text per message (`Thought for 12.4s`),
//      the collapsed line keeps its duration. One click then flips the run to
//      expanded (our transformer renders the full text), one click flips it
//      back. Single click.
//   2. CLEAR the overrides when expand-all is requested (mode "full" or the
//      expand toggle), so every run renders expanded.
//   3. DIFF the overrides map against a per-component snapshot to observe
//      clicks exactly (seeding performed in the same pass is excluded, and
//      clears are ignored) and record which block (content hash) was clicked
//      plus a monotonic click sequence.
//   4. REDIRECT clicks on any thinking run of a STILL-STREAMING message.
//      pi's handler just toggled that run to the hidden-label state; we flip
//      the override straight back to visible and toggle our own mode
//      instead. For the run still being written that switches between the
//      scrolling tail and the full text (timing line pinned at the bottom);
//      for a run that already finished while the message keeps streaming it
//      switches between the folded duration line and the full text with its
//      footer. The MouseRegion click closure is rebuilt from the corrected
//      map on every render, so each later click hits the same redirect and
//      the hidden middle state (the global `Thought…` label) never shows.
//
// The markdown transformer uses that click signal only to mark a block as
// user-revealed (add-only), so unflagged re-renders of expanded blocks keep
// showing the full text and global re-renders never fake a click.

const SF_STATE = Symbol.for("pi-smart-fold.state");
const OVERRIDE_SNAPSHOT = Symbol.for("pi-smart-fold.overrideSnapshot");

interface SmartFoldGlobalState {
  /** "smart" | "tail" => seed hidden; "full" => clear; "off" => inert. */
  behavior: "seed" | "clear" | "inert";
  /** Look up (or finalize) the duration of a thinking run's joined text. */
  durationFor(runText: string): number | undefined;
  /**
   * True when a run has no finalized duration yet, i.e. it is the run still
   * being written and currently renders in live mode. Pure — never closes
   * the tracker's open group (unlike `durationFor`).
   */
  isLiveRun(runText: string): boolean;
  /**
   * True when a FINISHED run of a still-streaming message currently renders
   * expanded (revealed by a click, or matched by the streaming open prefix,
   * or expand-all/full mode) — mirrors the transformer's `open` condition.
   */
  isFinishedRunOpen(runText: string): boolean;
  /** Called when the user collapses a live run back to the scrolling tail. */
  onLiveCollapse?(runText: string): void;
  /**
   * Called when the user collapses a finished run of a still-streaming
   * message back to its folded duration line.
   */
  onFinishedCollapse?(runText: string): void;
}

type SmartFoldGlobal = typeof globalThis & { [SF_STATE]?: SmartFoldGlobalState };

function smartFoldState(): SmartFoldGlobalState | undefined {
  return (globalThis as SmartFoldGlobal)[SF_STATE];
}

function sameOverrideEntries(
  a: Array<[number, boolean]>,
  b: Array<[number, boolean]>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

/** The run index whose override entry changed between snapshots (or null). */
function firstChangedRun(
  previous: Array<[number, boolean]>,
  current: Array<[number, boolean]>,
  ignore: Set<number>,
): number | null {
  const currentMap = new Map(current);
  for (const [run, value] of previous) {
    if (ignore.has(run)) continue;
    if (currentMap.get(run) !== value) return run; // value flipped
  }
  for (const [run] of current) {
    if (ignore.has(run)) continue;
    if (!previous.some(([pRun]) => pRun === run)) return run; // newly added
  }
  return null;
}

function installThinkingDisplayPatch(): void {
  const proto = (
    AssistantMessageComponent as unknown as {
      prototype?: { updateContent?: (...args: unknown[]) => unknown };
    }
  ).prototype;
  const original = proto?.updateContent;
  if (!proto || typeof original !== "function") return;
  if ("__smartFoldPatched" in original) return; // already installed by a previous load
  try {
    const patched = function (this: unknown, message: unknown, isStreaming?: boolean) {
      const self = this as {
        thinkingVisibilityOverrides?: Map<number, boolean>;
        hiddenThinkingLabel?: string;
        isStreaming?: boolean;
        lastMessage?: unknown;
        [key: symbol]: Array<[number, boolean]> | undefined;
      };
      try {
        const state = smartFoldState();
        const overrides = self.thinkingVisibilityOverrides;
        if (state && state.behavior !== "inert" && overrides instanceof Map) {
          const previous = self[OVERRIDE_SNAPSHOT];
          const previousMap = previous === undefined ? undefined : new Map(previous);
          const seeded = new Set<number>();
          const finalized =
            (isStreaming === undefined ? self.isStreaming !== true : isStreaming === false);

          if (finalized) {
            const runs = thinkingRuns(self.lastMessage ?? message);
            if (state.behavior === "clear") {
              if (overrides.size > 0) overrides.clear();
            } else if (runs.length > 0) {
              // Seed finished thinking runs as hidden (single-click expand),
              // and refresh the per-message hidden label with its duration.
              for (let run = 0; run < runs.length; run++) {
                if (!overrides.has(run)) {
                  overrides.set(run, true);
                  seeded.add(run);
                } else if (
                  overrides.get(run) === false &&
                  previousMap?.get(run) === false && // leftover, not a fresh click
                  runs[run] !== undefined &&
                  state.isFinishedRunOpen?.(runs[run]) !== true
                ) {
                  // A streaming-era redirect left this run visible but folded
                  // (the user collapsed it again, or it was never opened).
                  // Normalize it into the seeded hidden state — the folded
                  // line and the per-message label read the same, so without
                  // this the next click would appear to change nothing.
                  // Marked seeded so the diff below does not mistake the
                  // normalization for a click.
                  overrides.set(run, true);
                  seeded.add(run);
                }
              }
              self.hiddenThinkingLabel = collapsedLabelText(runs, state);
            }
          }
          // (While streaming, the live run is kept visible by the redirect
          // below, so it never renders the hidden label.)

          let current = Array.from(overrides.entries());
          if (
            previous !== undefined &&
            previous.length + current.length > 0 &&
            !(current.length === 0 && previous.length > 0) && // clear = ctrl+t/settings/expand-all
            !sameOverrideEntries(previous, current)
          ) {
            const changedRun = firstChangedRun(previous, current, seeded);
            if (changedRun !== null) {
              const runText = thinkingRunText(self.lastMessage ?? message, changedRun);
              const clickedHidden = new Map(current).get(changedRun) === true;
              if (clickedHidden && !finalized && runText !== null) {
                // A click on a thinking run of a still-streaming message just
                // flipped it to pi's hidden-label state — which would show the
                // global `Thought…` label (per-message labels are only set
                // once finalized). Redirect: keep the run visible and toggle
                // our own mode instead. The click closure is rebuilt from the
                // corrected map, so every later click lands here again — one
                // click per state change, no hidden middle state.
                if (state.isLiveRun?.(runText) === true) {
                  // Run still being written: scrolling tail ↔ full text so
                  // far, timing line pinned at the bottom of the full view.
                  const openPrefix = openStreamingPrefix();
                  if (openPrefix !== null && runText.startsWith(openPrefix)) {
                    state.onLiveCollapse?.(runText); // drop any stale reveal mark
                    setStreamingOpenPrefix(null); // full → scrolling tail
                  } else {
                    recordRevealClick(runText); // tail → full text so far
                    setStreamingOpenPrefix(runText);
                  }
                } else if (state.isFinishedRunOpen?.(runText) === true) {
                  // Run already finished while the message keeps streaming:
                  // full text → folded duration line.
                  state.onFinishedCollapse?.(runText);
                } else {
                  // Finished run, currently folded: → full text + footer.
                  recordRevealClick(runText);
                }
                overrides.set(changedRun, false);
                current = Array.from(overrides.entries());
              } else if (!clickedHidden) {
                // Click that opened a finished run: mark it revealed.
                recordRevealClick(runText);
              }
            }
          }
          self[OVERRIDE_SNAPSHOT] = current;
        }
      } catch {
        // Display customization is best-effort; never break pi rendering.
      }
      return (original as (this: unknown, m: unknown, s?: boolean) => unknown).call(
        this,
        message,
        isStreaming,
      );
    };
    Object.defineProperty(patched, "__smartFoldPatched", { value: true });
    proto.updateContent = patched as typeof original;
  } catch {
    // Best-effort: without the patch, thinking falls back to native behavior.
  }
}

/** Joined texts of every thinking run in a message, in run order. */
function thinkingRuns(message: unknown): string[] {
  const content = (message as { content?: Array<{ type?: string; thinking?: string }> })
    ?.content;
  if (!Array.isArray(content)) return [];
  const runs: string[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i]?.type !== "thinking") continue;
    const blocks: string[] = [];
    for (; i < content.length; i++) {
      const block = content[i];
      if (block?.type !== "thinking") break;
      const text = typeof block.thinking === "string" ? block.thinking.trim() : "";
      if (text) blocks.push(text);
    }
    i--;
    if (blocks.length > 0) runs.push(blocks.join("\n\n"));
  }
  return runs;
}

/**
 * Joined text of the `wantedRunIndex`-th thinking run of a message — mirrors
 * exactly how pi's AssistantMessageComponent groups consecutive thinking
 * blocks into runs (blocks trimmed, non-empty only, joined with a blank line).
 */
function thinkingRunText(message: unknown, wantedRunIndex: number): string | null {
  return thinkingRuns(message)[wantedRunIndex] ?? null;
}

/** Collapsed label text for a message's thinking runs (bold via SGR). */
function collapsedLabelText(runs: string[], state: SmartFoldGlobalState): string {
  let text: string;
  if (runs.length === 1) {
    const ms = state.durationFor(runs[0]);
    text = ms === undefined ? "Thought…" : `Thought for ${formatDuration(ms, "final")}`;
  } else {
    text = "Thought…";
  }
  return `\u001b[1m${text}\u001b[22m`;
}

// Click recording ------------------------------------------------------------

const CLICK_AT = Symbol.for("pi-smart-fold.clickAt");
const CLICK_HASH = Symbol.for("pi-smart-fold.clickHash");
const CLICK_OPEN_PREFIX = Symbol.for("pi-smart-fold.clickOpenPrefix");
type ClickGlobal = typeof globalThis & {
  [CLICK_AT]?: number;
  [CLICK_HASH]?: string;
  [CLICK_OPEN_PREFIX]?: string | null;
};

/**
 * Record a thinking click that opens a block: stamps the time and the
 * block's content hash so the transformer's re-render (within the click
 * window) marks it user-revealed (add-only).
 */
function recordRevealClick(runText: string | null): void {
  const clickGlobal = globalThis as ClickGlobal;
  clickGlobal[CLICK_AT] = Date.now();
  clickGlobal[CLICK_HASH] = runText !== null ? hashText(runText) : undefined;
}

/**
 * Set (or clear) the streaming run the user clicked open. Thinking text
 * only grows, so every later render of the same run starts with this prefix
 * and stays expanded until toggled back. Only live-run clicks manage this;
 * clicks on finished runs never clobber it.
 */
function setStreamingOpenPrefix(runText: string | null): void {
  (globalThis as ClickGlobal)[CLICK_OPEN_PREFIX] = runText;
}

/** Prefix of the streaming run the user clicked open, if any. */
function openStreamingPrefix(): string | null {
  return (globalThis as ClickGlobal)[CLICK_OPEN_PREFIX] ?? null;
}

function clearOpenStreamingPrefix(): void {
  (globalThis as ClickGlobal)[CLICK_OPEN_PREFIX] = null;
}

/**
 * Forget the last recorded click so a re-render inside the click window
 * cannot re-reveal a block the user just collapsed.
 */
function clearRevealClick(): void {
  const clickGlobal = globalThis as ClickGlobal;
  clickGlobal[CLICK_AT] = undefined;
  clickGlobal[CLICK_HASH] = undefined;
}

/** How long after a click its re-render is expected (generous for slow frames). */
const CLICK_WINDOW_MS = 250;

/** Info about the most recent thinking-click, if it identified a block. */
function lastClickInfo(): { at: number; hash: string | undefined } | undefined {
  const clickGlobal = globalThis as ClickGlobal;
  if (clickGlobal[CLICK_AT] === undefined) return undefined;
  return { at: clickGlobal[CLICK_AT]!, hash: clickGlobal[CLICK_HASH] };
}

/** Renderer-facing theme subset (avoids coupling to the full Theme type). */
interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Structural copy of the context pi passes to tool renderCall slots. */
interface ToolRenderContextLike {
  toolCallId: string;
  invalidate(): void;
  lastComponent?: unknown;
  cwd?: string;
  executionStarted?: boolean;
  argsComplete?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
  showImages?: boolean;
  isError?: boolean;
  [key: string]: unknown;
}

interface CtxLike {
  mode?: string;
  hasUI: boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setToolsExpanded?(expanded: boolean): void;
    setHiddenThinkingLabel?(label?: string): void;
    custom?: unknown;
    theme?: ThemeLike;
  };
  cwd?: string;
  sessionManager: {
    getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
  };
}

const MAX_WRITE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_REVEALED_BLOCKS = 2000;

/** Index of the first line with visible content (padding/blank lines skipped). */
function firstContentLine(lines: string[]): number {
  const plain = (line: string): string =>
    line
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "");
  for (let i = 0; i < lines.length; i++) {
    if (plain(lines[i]).trim() !== "") return i;
  }
  return 0;
}

/** Drop trailing filler padding (Box pads lines to the full width). */
function trimLineFiller(line: string): string {
  return line
    .replace(/[ \t]+(\u001b\[[0-9;]*[A-Za-z])$/, "$1")
    .replace(/[ \t]+$/, "");
}

/**
 * Insert text into a rendered line's trailing padding, eating an equal
 * number of padding columns so the line keeps its exact width (and thus its
 * full-width background bar). Returns null when there is not enough padding.
 */
function insertIntoLinePadding(line: string, insert: string): string | null {
  if (!insert) return line;
  const resetMatch = line.match(/(?:\u001b\[[0-9;]*m)+$/);
  const tail = resetMatch ? resetMatch[0] : "";
  const bodyEnd = line.length - tail.length;
  let end = bodyEnd;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  const insertWidth = displayWidth(insert);
  if (bodyEnd - end < insertWidth) return null; // not enough padding
  const keptPadding = " ".repeat(bodyEnd - end - insertWidth);
  return line.slice(0, end) + insert + keptPadding + tail;
}

export default function smartFold(pi: ExtensionAPI): void {
  const extensionDir = resolveExtensionDir();
  const config: SmartFoldConfig = extensionDir
    ? loadConfig(extensionDir)
    : { ...defaultConfig };

  const persist = (): void => {
    if (extensionDir) saveConfig(extensionDir, config);
  };

  installThinkingDisplayPatch();

  /** Publish the display behavior the prototype patch reads on every render. */
  const publishState = (): void => {
    (globalThis as SmartFoldGlobal)[SF_STATE] = {
      behavior:
        config.thinking === "off"
          ? "inert"
          : config.thinking === "full" || expandAllThinking
            ? "clear"
            : "seed",
      durationFor: (runText: string) =>
        tracker.finalizedMs(hashText(runText)) ?? tracker.finalizeIfMatches(runText),
      isLiveRun: (runText: string) => tracker.finalizedMs(hashText(runText)) === undefined,
      isFinishedRunOpen: (runText: string) => {
        if (revealedBlocks.has(hashText(runText))) return true;
        const prefix = openStreamingPrefix();
        if (prefix !== null && runText.startsWith(prefix)) return true;
        return config.thinking === "full" || expandAllThinking;
      },
      onLiveCollapse: (runText: string) => {
        revealedBlocks.delete(hashText(runText));
        clearRevealClick();
      },
      onFinishedCollapse: (runText: string) => {
        revealedBlocks.delete(hashText(runText));
        const prefix = openStreamingPrefix();
        if (prefix !== null && runText.startsWith(prefix)) {
          setStreamingOpenPrefix(null); // that prefix was this run's text
        }
        clearRevealClick();
      },
    };
  };

  // Runtime state -----------------------------------------------------------

  /** Thinking-run timing (live elapsed + finalized durations by content hash). */
  const tracker = new ThinkingTracker();
  let expandAllThinking = false;
  publishState(); // the initial chat build can render before session_start fires

  /**
   * Content hashes of finished thinking blocks the user expanded by clicking.
   * Toggled exactly once per observed click, so stray/global re-renders are
   * inert and resize keeps user intent.
   */
  const revealedBlocks = new Set<string>();

  /**
   * Expand-all fallback (settings item / /fold expand). Per-block clicks are
   * the primary interaction; this covers "show me everything".
   */
  /**
   * Text shown by pi's internal hidden-thinking state (first click of the
   * two-click gesture, and ctrl+t). We own it so the native "Thinking..."
   * never appears anywhere.
   */
  const hiddenThinkingLabelText = (): string | undefined => {
    if (config.thinking === "off") return undefined; // restore pi's default
    return "Thought…"; // per-message labels (with durations) come from the patch
  };

  /** Apply (or restore) the hidden-thinking label; re-renders all messages. */
  const applyHiddenLabel = (ctx: CtxLike): void => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setHiddenThinkingLabel?.(hiddenThinkingLabelText());
    } catch {
      // Best-effort.
    }
  };

  /** write tool line-diff stats by toolCallId (live sessions only). */
  const writeStats = new Map<string, { added: number; removed: number }>();

  /** Live write call rows, so a stat computed after render can force a rerender. */
  const writeRows = new Map<string, ToolCallWrapper>();

  // -------------------------------------------------------------------------
  // 1) Thinking: live tail while streaming, folded line with duration after,
  //    per-block click expansion.
  // -------------------------------------------------------------------------
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "assistant-thinking") return markdown;
    const mode = config.thinking;
    if (mode === "off") return markdown;

    const width = context.availableWidth - 1; // renderer padding slack
    const key = hashText(markdown);

    let ms = tracker.finalizedMs(key);
    if (ms === undefined && !context.isStreaming) ms = tracker.finalizeIfMatches(markdown);

    // A click on this block re-renders it right after the click handler
    // mutated that block's visibility override. The observer recorded exactly
    // which block (by content hash) — mark it revealed (add-only). Collapse
    // happens by clicking back to the hidden label, which never runs this
    // transformer.
    const click = lastClickInfo();
    if (
      click &&
      Date.now() - click.at <= CLICK_WINDOW_MS &&
      click.hash === key &&
      !revealedBlocks.has(key)
    ) {
      revealedBlocks.add(key);
      if (revealedBlocks.size > MAX_REVEALED_BLOCKS) revealedBlocks.clear();
    }

    if (context.isStreaming) {
      // Finished runs of the still-streaming message behave like finalized
      // blocks: folded duration line by default; full text with the footer
      // when clicked open — including one the user opened while it streamed
      // (identified by the open prefix) — or when expand-all is on.
      if (ms !== undefined) {
        const openPrefix = openStreamingPrefix();
        const open =
          revealedBlocks.has(key) ||
          (openPrefix !== null && markdown.startsWith(openPrefix)) ||
          mode === "full" ||
          expandAllThinking;
        if (open) {
          // Close any unclosed code fence so the footer renders below the
          // code block, not inside it as literal `**` characters.
          return (
            closeOpenFences(markdown.replace(/\s+$/, "")) + expandedThinkingSuffix(ms)
          );
        }
        return foldedThinkingLine(markdown, ms, width, mode === "tail" ? "tail" : "smart");
      }
      // The run that is still being written: live tail by default; the full
      // text so far when the user clicked it open (prefix identifies the
      // run), with the ticking `Thinking… (Ns)` line pinned at the bottom.
      const openPrefix = openStreamingPrefix();
      if (openPrefix !== null && markdown.startsWith(openPrefix)) {
        // Close any unclosed code fence so the ticking footer stays outside
        // the code block (otherwise it shows literal `**` asterisks).
        return (
          closeOpenFences(markdown.replace(/\s+$/, "")) +
          liveExpandedSuffix(tracker.liveElapsedMs())
        );
      }
      return liveThinkingLine(markdown, tracker.liveElapsedMs(), width);
    }

    if (mode === "full" || expandAllThinking || revealedBlocks.has(key)) {
      // Fully expanded: original text, with the duration footer at the bottom
      // (after closing any unclosed code fence so it renders as bold text).
      return closeOpenFences(markdown.replace(/\s+$/, "")) + expandedThinkingSuffix(ms);
    }
    return foldedThinkingLine(markdown, ms, width, mode);
  });

  // Thinking timing events --------------------------------------------------

  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;
    const streamEvent = (event as { assistantMessageEvent?: Parameters<
      typeof tracker.handleUpdate
    >[0] }).assistantMessageEvent;
    if (streamEvent) tracker.handleUpdate(streamEvent);
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    const runs = tracker.handleMessageEnd(
      event.message as Parameters<typeof tracker.handleMessageEnd>[0],
    );
    clearOpenStreamingPrefix(); // the streaming click no longer applies
    if (runs.length > 0) {
      try {
        pi.appendEntry("smart-fold-thinking", { runs });
      } catch {
        // Persistence is best-effort; display still works in-session.
      }
    }
  });

  const restoreFromBranch = (ctx: CtxLike): void => {
    writeStats.clear();
    writeRows.clear();
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === "smart-fold-thinking") {
          const data = entry.data as { runs?: Array<{ hash?: unknown; ms?: unknown }> } | undefined;
          if (Array.isArray(data?.runs)) {
            tracker.restore(
              data.runs.filter(
                (run): run is { hash: string; ms: number } =>
                  typeof run?.hash === "string" && typeof run?.ms === "number",
              ),
            );
          }
          continue;
        }
        // Rebuild persisted write stats so history keeps showing +N -M.
        if (entry.type === "message") {
          const message = (
            entry as {
              message?: {
                role?: string;
                toolName?: string;
                toolCallId?: string;
                details?: { smartFold?: { added?: unknown; removed?: unknown } };
              };
            }
          ).message;
          if (
            message?.role === "toolResult" &&
            message.toolName === "write" &&
            typeof message.toolCallId === "string"
          ) {
            const stat = message.details?.smartFold;
            if (typeof stat?.added === "number" && typeof stat.removed === "number") {
              writeStats.set(message.toolCallId, { added: stat.added, removed: stat.removed });
            }
          }
        }
      }
    } catch {
      // Best-effort restore.
    }
  };

  // -------------------------------------------------------------------------
  // 2) Tool output: collapse on session start.
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    const scoped = ctx as unknown as CtxLike;
    restoreFromBranch(scoped);
    revealedBlocks.clear(); // sessions start compact
    clearOpenStreamingPrefix();
    expandAllThinking = false;
    publishState();
    applyHiddenLabel(scoped);
    if (!config.toolsFold) return;
    if (!ctx.hasUI) return; // no-op guard for print / json modes
    try {
      ctx.ui.setToolsExpanded(false);
    } catch {
      // Never let folding break a session start.
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx as unknown as CtxLike);
  });

  // -------------------------------------------------------------------------
  // 3) Tool calls: collapsed lines truncated with an ellipsis; write/edit
  //    headers gain git-style `+N -M` stats.
  // -------------------------------------------------------------------------
  class ToolCallWrapper implements Component {
    inner: Component;
    readonly toolCallId: string;
    args: unknown;
    expanded = false;
    theme: ThemeLike | undefined;
    invalidateRef: (() => void) | undefined;
    /** Collapsed style: header-only (write/edit) vs truncated first line. */
    headerOnly = false;
    /** Stats computed straight from the call args (edit). */
    statFromArgs: ((args: unknown) => { added: number; removed: number } | undefined) | undefined;
    /** Stats computed from the pre-execution file snapshot (write). */
    statFromMap = false;

    constructor(toolCallId: string, inner: Component) {
      this.toolCallId = toolCallId;
      this.inner = inner;
    }

    invalidate(): void {
      this.inner.invalidate();
    }

    render(width: number): string[] {
      const lines = this.inner.render(width);
      if (lines.length === 0) return lines;
      const headerIndex = firstContentLine(lines);

      const stat = config.writeStat
        ? this.statFromMap
          ? writeStats.get(this.toolCallId)
          : this.statFromArgs?.(this.args)
        : undefined;
      const suffix =
        stat && this.theme
          ? ` ${this.theme.fg("success", `+${stat.added}`)}` +
            ` ${this.theme.fg("error", `-${stat.removed}`)}`
          : "";

      if (this.expanded) {
        // Expanded: everything, with the stat injected into the header line.
        const out = lines.slice();
        if (suffix) {
          out[headerIndex] =
            insertIntoLinePadding(out[headerIndex], suffix) ??
            trimLineFiller(out[headerIndex]) + suffix;
        }
        return out;
      }

      if (this.headerOnly && config.writeCollapsed === "header") {
        // Some tools render their own shell (edit: renderShell "self" — no
        // outer box). Keep their full-width background lines and inject the
        // stat into the header line's padding so the bar keeps its size.
        if (headerIndex > 0) {
          const header = suffix
            ? insertIntoLinePadding(lines[headerIndex], suffix) ??
              trimLineFiller(lines[headerIndex]) + suffix
            : lines[headerIndex];
          return [lines[headerIndex - 1], header, lines[lines.length - 1]];
        }
        // Plain inner (write): the outer box pads — trim, then append.
        const header = suffix ? trimLineFiller(lines[headerIndex]) : lines[headerIndex];
        const out = [header];
        if (suffix) {
          if (displayWidth(header) + displayWidth(suffix) <= width) {
            out[0] = header + suffix;
          } else {
            out.splice(1, 0, suffix.trim());
          }
        }
        return out;
      }

      // Collapsed: single first content line, truncated to the terminal width
      // with an ellipsis (an extra `…` marks hidden continuation lines).
      let line = trimLineFiller(lines[headerIndex]);
      if (suffix) line += suffix;
      if (lines.length > headerIndex + 1) line += " …";
      return [truncateToWidth(line, width, "…")];
    }
  }

  /**
   * Build a renderCall that delegates to pi's own renderer and wraps its
   * component in our ToolCallWrapper. Only the TUI rendering is customized;
   * execution stays pi's own implementation.
   */
  const wrapToolRenderCall = (
    base: { renderCall?: unknown } & Record<string, unknown>,
    opts: {
      headerOnly?: boolean;
      statFromArgs?: (args: unknown) => { added: number; removed: number } | undefined;
      statFromMap?: boolean;
    } = {},
  ) => {
    const baseRenderCall = base.renderCall as (
      args: unknown,
      theme: ThemeLike,
      context: ToolRenderContextLike,
    ) => Component;
    return (args: unknown, theme: ThemeLike, context: ToolRenderContextLike): Component => {
      let wrapper =
        context.lastComponent instanceof ToolCallWrapper
          ? (context.lastComponent as ToolCallWrapper)
          : undefined;
      const inner = baseRenderCall(args, theme, {
        ...context,
        lastComponent: wrapper?.inner,
      });
      if (!wrapper) {
        wrapper = new ToolCallWrapper(String(context.toolCallId ?? ""), inner);
        wrapper.headerOnly = Boolean(opts.headerOnly);
        wrapper.statFromArgs = opts.statFromArgs;
        wrapper.statFromMap = Boolean(opts.statFromMap);
      } else {
        wrapper.inner = inner;
      }
      wrapper.args = args;
      wrapper.theme = theme;
      wrapper.expanded = Boolean(context.expanded);
      wrapper.invalidateRef = context.invalidate;
      if (wrapper.statFromMap && wrapper.toolCallId) {
        writeRows.set(wrapper.toolCallId, wrapper);
      }
      return wrapper;
    };
  };

  /**
   * Build a renderResult wrapper for tools whose result area shows code
   * details (edit renders its full diff). Collapsed + header mode shows
   * nothing (errors stay visible); expanded delegates to pi's renderer.
   */
  const wrapToolRenderResult = (
    base: { renderResult?: unknown } & Record<string, unknown>,
  ) => {
    const baseRenderResult = base.renderResult as (
      result: unknown,
      options: { expanded?: boolean },
      theme: ThemeLike,
      context: ToolRenderContextLike & { isError?: boolean },
    ) => Component;
    if (typeof baseRenderResult !== "function") return undefined;
    return (
      result: unknown,
      options: { expanded?: boolean },
      theme: ThemeLike,
      context: ToolRenderContextLike & { isError?: boolean },
    ): Component => {
      if (!options.expanded && config.writeCollapsed === "header" && !context.isError) {
        // Fully collapsed: no code/diff details at all in the result area.
        return new Container();
      }
      return baseRenderResult(result, options, theme, context);
    };
  };

  // Register the overrides: shell/file tools get collapsed-line truncation;
  // write/edit additionally get `+N -M` stats, header-only collapse and a
  // detail-free collapsed result area.
  const toolOverrides: Array<[
    Record<string, unknown>,
    Parameters<typeof wrapToolRenderCall>[1] & { hideCollapsedResult?: boolean },
  ]> = [
    [createBashToolDefinition(process.cwd()) as unknown as Record<string, unknown>, {}],
    [createReadToolDefinition(process.cwd()) as unknown as Record<string, unknown>, {}],
    [createGrepToolDefinition(process.cwd()) as unknown as Record<string, unknown>, {}],
    [createFindToolDefinition(process.cwd()) as unknown as Record<string, unknown>, {}],
    [createLsToolDefinition(process.cwd()) as unknown as Record<string, unknown>, {}],
    [
      createEditToolDefinition(process.cwd()) as unknown as Record<string, unknown>,
      { headerOnly: true, statFromArgs: countEditsLineDiff, hideCollapsedResult: true },
    ],
    [
      createWriteToolDefinition(process.cwd()) as unknown as Record<string, unknown>,
      { headerOnly: true, statFromMap: true, hideCollapsedResult: true },
    ],
  ];
  for (const [baseTool, opts] of toolOverrides) {
    pi.registerTool({
      ...(baseTool as object),
      renderCall: wrapToolRenderCall(baseTool, opts),
      ...(opts.hideCollapsedResult
        ? { renderResult: wrapToolRenderResult(baseTool) }
        : {}),
    } as never);
  }

  // Read the previous file content right before the write executes, so the
  // header can show a git-style `+N -M` stat.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write") return;
    if (!config.writeStat) return;
    if (writeStats.has(event.toolCallId)) return;

    const input = event.input as { path?: unknown; file_path?: unknown; content?: unknown };
    const rawPath =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : undefined;
    if (typeof rawPath !== "string" || typeof input.content !== "string") return;

    let absolutePath: string;
    try {
      absolutePath = resolvePath(ctx.cwd ?? process.cwd(), rawPath);
    } catch {
      return;
    }

    let oldText: string | undefined;
    try {
      if (existsSync(absolutePath)) {
        if (statSync(absolutePath).size > MAX_WRITE_FILE_BYTES) return; // too big to diff
        oldText = await readFile(absolutePath, "utf8");
      }
    } catch {
      return;
    }

    writeStats.set(event.toolCallId, countLineDiff(oldText, input.content));
    const row = writeRows.get(event.toolCallId);
    try {
      row?.invalidateRef?.(); // rerender the header with the stat
    } catch {
      // The row will pick the stat up on its next natural render.
    }
  });

  // Persist the write stat into the tool result's details so restored
  // sessions keep showing `+N -M` in history (the pre-execution snapshot
  // only exists live).
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "write") return;
    const stat = writeStats.get(event.toolCallId);
    if (!stat) return;
    if (event.isError) {
      writeStats.delete(event.toolCallId); // nothing was changed
      return;
    }
    const details = (event.details ?? {}) as Record<string, unknown>;
    return { details: { ...details, smartFold: stat } };
  });

  // -------------------------------------------------------------------------
  // 4) /fold — /config-style settings list.
  // -------------------------------------------------------------------------
  const applyThinking = (mode: ThinkingMode, ctx: CtxLike): void => {
    config.thinking = mode;
    persist();
    publishState();
    applyHiddenLabel(ctx);
  };

  const applyExpandAll = (on: boolean, ctx: CtxLike): void => {
    expandAllThinking = on;
    publishState();
    applyHiddenLabel(ctx); // re-renders every message through the transformer
  };

  const applyToolsFold = (on: boolean, ctx: CtxLike): void => {
    config.toolsFold = on;
    persist();
    if (ctx.hasUI) {
      try {
        ctx.ui.setToolsExpanded?.(!on); // on => collapsed
      } catch {
        // Applied on next session_start anyway.
      }
    }
  };

  const applyWriteStat = (on: boolean): void => {
    config.writeStat = on;
    persist();
  };

  const applyWriteCollapsed = (style: WriteCollapsedStyle): void => {
    config.writeCollapsed = style;
    persist();
  };

  const statusLine = (): string =>
    `smart-fold — thinking: ${config.thinking} · 全部展开: ${
      expandAllThinking ? "开" : "关"
    } · 工具输出: ${config.toolsFold ? "启动时折叠" : "启动时展开"} · write/edit统计: ${
      config.writeStat ? "开" : "关"
    } · write/edit折叠: ${config.writeCollapsed === "header" ? "仅首行" : "保留预览"}`;

  const openSettings = async (ctx: CtxLike & {
    ui: CtxLike["ui"] & {
      custom<T>(
        factory: (
          tui: { requestRender(): void },
          theme: ThemeLike,
          keybindings: unknown,
          done: (result: T) => void,
        ) => Component & { handleInput?(data: string): void },
      ): Promise<T>;
    };
  }): Promise<void> => {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const items: SettingItem[] = [
        {
          id: "thinking",
          label: "Thinking 折叠",
          currentValue: config.thinking,
          values: ["smart", "tail", "full", "off"],
          description:
            "smart: 思考中显示 Thinking…(时长)+滚动结尾，点击在 滚动结尾↔完整全文 间切换（完整显示时计时行固定在底部）；结束后折叠为 Thought for 时长，点击一次展开/收起",
        },
        {
          id: "expand",
          label: "展开全部思考",
          currentValue: expandAllThinking ? "on" : "off",
          values: ["on", "off"],
          description: "临时展开/折叠全部已完成的思考（备用；日常用点击单块展开，不持久化）",
        },
        {
          id: "tools",
          label: "工具输出折叠",
          currentValue: config.toolsFold ? "on" : "off",
          values: ["on", "off"],
          description: "会话启动/恢复时自动折叠全部工具输出（ctrl+o 随时切换）",
        },
        {
          id: "writeStat",
          label: "Write/Edit 增删统计",
          currentValue: config.writeStat ? "on" : "off",
          values: ["on", "off"],
          description:
            "write/edit 首行追加绿色 +新增 / 红色 -删除 行数（write 与写入前文件对比，edit 与原文片段对比）",
        },
        {
          id: "writeCollapsed",
          label: "Write/Edit 折叠样式",
          currentValue: config.writeCollapsed,
          values: ["header", "preview"],
          description: "header: 折叠时只显示首行；preview: 保留内容/差异预览（pi 默认）",
        },
      ];

      const list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, value) => {
          if (id === "thinking") applyThinking(value as ThinkingMode, ctx);
          else if (id === "expand") applyExpandAll(value === "on", ctx);
          else if (id === "tools") applyToolsFold(value === "on", ctx);
          else if (id === "writeStat") applyWriteStat(value === "on");
          else if (id === "writeCollapsed") applyWriteCollapsed(value as WriteCollapsedStyle);
        },
        () => done(undefined),
      );

      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("smart-fold 设置")), 1, 1));
      container.addChild(list);

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput?.(data);
          tui.requestRender();
        },
      };
    });
  };

  pi.registerCommand("fold", {
    description: "smart-fold 设置（选择式界面）：thinking 折叠 / 展开 / 工具输出 / write 统计",
    getArgumentCompletions: (prefix: string) => {
      const make = (values: string[]) => values.map((value) => ({ value, label: value }));
      const trimmed = prefix.trimStart();
      const spaceIndex = trimmed.indexOf(" ");
      if (spaceIndex === -1) {
        const hits = ["thinking", "expand", "tools", "writestat", "writecollapsed"].filter(
          (option) => option.startsWith(trimmed.toLowerCase()),
        );
        return hits.length > 0 ? make(hits) : null;
      }
      const head = trimmed.slice(0, spaceIndex).toLowerCase();
      const sub = trimmed.slice(spaceIndex + 1).toLowerCase();
      const options: Record<string, string[]> = {
        thinking: ["smart", "tail", "full", "off"],
        expand: ["on", "off"],
        tools: ["on", "off"],
        writestat: ["on", "off"],
        writecollapsed: ["header", "preview"],
      };
      const hits = (options[head] ?? []).filter((value) => value.startsWith(sub));
      return hits.length > 0 ? make(hits) : null;
    },
    handler: async (args, ctx) => {
      const scoped = ctx as unknown as CtxLike;
      const parts = args.trim().split(/\s+/).filter(Boolean);

      if (parts.length === 0) {
        if (ctx.mode === "tui") {
          await openSettings(scoped as never);
          return;
        }
        ctx.ui.notify(statusLine(), "info");
        return;
      }

      const target = parts[0]?.toLowerCase();
      const value = parts[1]?.toLowerCase();

      if (target === "thinking") {
        let mode: ThinkingMode | undefined;
        if (value === "on" || value === "smart") mode = "smart";
        else if (value === "tail" || value === "fold") mode = "tail";
        else if (value === "full") mode = "full";
        else if (value === "off" || value === "none") mode = "off";
        if (!mode) {
          ctx.ui.notify("用法: /fold thinking smart|tail|full|off", "warning");
          return;
        }
        applyThinking(mode, scoped);
        ctx.ui.notify(`thinking: ${mode} — 已保存`, "info");
        return;
      }

      if (target === "expand") {
        if (value !== "on" && value !== "off") {
          ctx.ui.notify("用法: /fold expand on|off（备用；日常单击思考块切换展开/收起）", "warning");
          return;
        }
        applyExpandAll(value === "on", scoped);
        ctx.ui.notify(`展开全部思考: ${value === "on" ? "开" : "关"}`, "info");
        return;
      }

      if (target === "tools") {
        if (value !== "on" && value !== "off") {
          ctx.ui.notify("用法: /fold tools on|off", "warning");
          return;
        }
        applyToolsFold(value === "on", scoped);
        ctx.ui.notify(
          `工具输出: ${value === "on" ? "启动时折叠" : "启动时展开"} — 已保存`,
          "info",
        );
        return;
      }

      if (target === "writestat" || target === "write-stat" || target === "editstat") {
        if (value !== "on" && value !== "off") {
          ctx.ui.notify("用法: /fold writestat on|off", "warning");
          return;
        }
        applyWriteStat(value === "on");
        ctx.ui.notify(`write/edit 增删统计: ${value === "on" ? "开" : "关"} — 已保存`, "info");
        return;
      }

      if (target === "writecollapsed" || target === "write-collapsed") {
        const style: WriteCollapsedStyle | undefined =
          value === "header" || value === "on"
            ? "header"
            : value === "preview"
              ? "preview"
              : undefined;
        if (!style) {
          ctx.ui.notify("用法: /fold writecollapsed header|preview", "warning");
          return;
        }
        applyWriteCollapsed(style);
        ctx.ui.notify(`write 折叠样式: ${style} — 已保存`, "info");
        return;
      }

      ctx.ui.notify(
        "用法: /fold（打开设置）或 /fold [thinking|expand|tools|writestat|writecollapsed] <值>",
        "warning",
      );
    },
  });
}
