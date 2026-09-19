/**
 * Dependency-free tests for pi-smart-fold's pure helpers.
 * Run: npm test   (needs Node >= 22.18 for native .ts type stripping)
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  codePointWidth,
  displayWidth,
  tailFit,
  lastNonEmptyLine,
  lastMeaningfulLine,
  stripBlockMarkers,
  collapseThinking,
  closeOpenFences,
  formatDuration,
  hashText,
  countLineDiff,
  countEditsLineDiff,
  expandedThinkingSuffix,
  foldedThinkingLine,
  liveExpandedSuffix,
  liveThinkingLine,
} from "../lib/fold.ts";
import { defaultConfig, loadConfig, saveConfig } from "../lib/config.ts";
import { ThinkingTracker, trailingThinkingText } from "../lib/thinking.ts";

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
};

// ---------------------------------------------------------------- width ----
check("codePointWidth: ascii is 1", () => {
  assert.equal(codePointWidth("a".codePointAt(0)), 1);
});
check("codePointWidth: CJK is 2", () => {
  assert.equal(codePointWidth("中".codePointAt(0)), 2);
  assert.equal(codePointWidth("あ".codePointAt(0)), 2);
  assert.equal(codePointWidth("한".codePointAt(0)), 2);
});
check("codePointWidth: emoji is 2", () => {
  assert.equal(codePointWidth("😀".codePointAt(0)), 2);
});
check("codePointWidth: stopwatch emoji is 2", () => {
  assert.equal(codePointWidth("⏱".codePointAt(0)), 2);
  assert.equal(displayWidth("⏱ 8s"), 5); // 2 + 1 + 2
});
check("codePointWidth: combining mark is 0", () => {
  assert.equal(codePointWidth(0x0301), 0);
});
check("displayWidth: mixed CJK/ascii", () => {
  assert.equal(displayWidth("abc中de"), 7); // 3 + 2 + 2
});
check("displayWidth: ignores ANSI escapes", () => {
  assert.equal(displayWidth("\u001b[31mabc\u001b[0m"), 3);
});

// ------------------------------------------------------------- tailFit ----
check("tailFit: fits → unchanged", () => {
  assert.equal(tailFit("hello", 10), "hello");
});
check("tailFit: exact fit → unchanged", () => {
  assert.equal(tailFit("hello", 5), "hello");
});
check("tailFit: keeps the tail with ellipsis", () => {
  assert.equal(tailFit("abcdefghij", 5), "…ghij");
});
check("tailFit: CJK truncation counts columns", () => {
  assert.equal(tailFit("一二三四五", 7), "…三四五");
  assert.equal(displayWidth(tailFit("一二三四五", 7)), 7);
});
check("tailFit: never splits a wide char", () => {
  const out = tailFit("一二三四五", 6);
  assert.equal(displayWidth(out) <= 6, true);
  assert.equal(out.startsWith("…"), true);
});
check("tailFit: maxWidth < 1 → empty", () => {
  assert.equal(tailFit("abc", 0), "");
});
check("tailFit: non-finite width passes through", () => {
  assert.equal(tailFit("hello", Number.NaN), "hello");
});

// ----------------------------------------------------- lastNonEmptyLine ----
check("lastNonEmptyLine: picks last non-empty", () => {
  assert.equal(lastNonEmptyLine("first\nsecond\n\n"), "second");
});
check("lastNonEmptyLine: skips whitespace lines", () => {
  assert.equal(lastNonEmptyLine("a\n   \n  b  \n\t\n"), "  b  ");
});
check("lastNonEmptyLine: all empty → empty string", () => {
  assert.equal(lastNonEmptyLine("\n \n"), "");
});

// ---------------------------------------------------- lastMeaningfulLine ----
check("lastMeaningfulLine: picks last strippable non-empty line", () => {
  assert.equal(lastMeaningfulLine("first\nsecond\n\n"), "second");
  assert.equal(lastMeaningfulLine("plan:\n- [ ] do it", ), "[ ] do it");
});
check("lastMeaningfulLine: skips bare code fences (no fold flicker)", () => {
  assert.equal(lastMeaningfulLine("thinking text\n```"), "thinking text");
  assert.equal(lastMeaningfulLine("```js\ncode()\n```"), "code()");
  assert.equal(lastMeaningfulLine("~~~\nquoted\n~~~"), "quoted");
});
check("lastMeaningfulLine: only structural lines → empty", () => {
  assert.equal(lastMeaningfulLine("```"), "");
  assert.equal(lastMeaningfulLine("```js"), "");
  assert.equal(lastMeaningfulLine("\n \n"), "");
});

// ---------------------------------------------------- stripBlockMarkers ----
check("stripBlockMarkers: heading", () => {
  assert.equal(stripBlockMarkers("## Heading"), "Heading");
});
check("stripBlockMarkers: blockquote", () => {
  assert.equal(stripBlockMarkers("> quoted text"), "quoted text");
});
check("stripBlockMarkers: bullet", () => {
  assert.equal(stripBlockMarkers("- item"), "item");
  assert.equal(stripBlockMarkers("* item"), "item");
});
check("stripBlockMarkers: ordered list", () => {
  assert.equal(stripBlockMarkers("12. step"), "step");
});
check("stripBlockMarkers: nested markers", () => {
  assert.equal(stripBlockMarkers("> - nested"), "nested");
});
check("stripBlockMarkers: removes code fences", () => {
  assert.equal(stripBlockMarkers("```ts"), "ts");
});
check("stripBlockMarkers: leaves math-ish '>' alone", () => {
  assert.equal(stripBlockMarkers(">= 5"), ">= 5");
});

// ---------------------------------------------------- collapseThinking ----
check("collapseThinking: folds to last line", () => {
  assert.equal(collapseThinking("first thought\nsecond thought\nthird", 80), "third");
});
check("collapseThinking: strips block markers", () => {
  assert.equal(collapseThinking("plan:\n- [ ] do the thing", 80), "[ ] do the thing");
});
check("collapseThinking: empty input passes through", () => {
  assert.equal(collapseThinking("", 80), "");
  assert.equal(collapseThinking("\n \n", 80), "\n \n");
});
check("collapseThinking: truncates to width, keeping the tail", () => {
  const out = collapseThinking("start\n" + "x".repeat(200), 21);
  assert.equal(displayWidth(out) <= 21, true);
  assert.equal(out.startsWith("…"), true);
  assert.equal(out.endsWith("xxxxxxxxxxxxxxxxxx"), true);
});
check("collapseThinking: CJK line truncated by display columns", () => {
  const out = collapseThinking("思考开始\n这是一段很长很长的思考内容", 11);
  assert.equal(displayWidth(out) <= 11, true);
  assert.equal(out.startsWith("…"), true);
});
check("collapseThinking: clamps tiny widths", () => {
  assert.equal(typeof collapseThinking("a\nb", 0), "string");
});
check("collapseThinking: non-finite width degrades to default 80", () => {
  assert.equal(collapseThinking("a\nb", Number.NaN), "b");
  assert.equal(collapseThinking("a\nb", undefined), "b");
});

// --------------------------------------------------------- formatDuration ----
check("formatDuration: live style uses whole seconds", () => {
  assert.equal(formatDuration(0, "live"), "0s");
  assert.equal(formatDuration(8_400, "live"), "8s");
  assert.equal(formatDuration(91_000, "live"), "1m31s");
  assert.equal(formatDuration(3_723_000, "live"), "1h02m");
});
check("formatDuration: final style uses one decimal under a minute", () => {
  assert.equal(formatDuration(12_350), "12.3s"); // toFixed(1) rounds
  assert.equal(formatDuration(940), "0.9s");
  assert.equal(formatDuration(59_999), "60.0s"); // just under the boundary
});
check("formatDuration: final style switches to m/h", () => {
  assert.equal(formatDuration(61_500), "1m01s");
  assert.equal(formatDuration(3_723_000), "1h02m");
});
check("formatDuration: tolerates garbage", () => {
  assert.equal(formatDuration(Number.NaN), "0.0s");
  assert.equal(formatDuration(-5, "live"), "0s");
});

// -------------------------------------------------------------- hashText ----
check("hashText: deterministic and distinguishing", () => {
  assert.equal(hashText("hello"), hashText("hello"));
  assert.notEqual(hashText("hello"), hashText("hello!"));
  assert.notEqual(hashText("ab"), hashText("ba")); // same length, different hash
});
check("hashText: encodes length", () => {
  assert.equal(hashText(""), "0:811c9dc5"); // FNV offset basis, length 0
});

// ---------------------------------------------------------- countLineDiff ----
check("countLineDiff: new file → all added", () => {
  assert.deepEqual(countLineDiff(undefined, "a\nb\nc"), { added: 3, removed: 0 });
});
check("countLineDiff: identical → zeros (trailing newline tolerant)", () => {
  assert.deepEqual(countLineDiff("a\nb\n", "a\nb\n"), { added: 0, removed: 0 });
  assert.deepEqual(countLineDiff("a\nb", "a\nb\n"), { added: 0, removed: 0 });
});
check("countLineDiff: pure append", () => {
  assert.deepEqual(countLineDiff("a\nb", "a\nb\nc\nd"), { added: 2, removed: 0 });
});
check("countLineDiff: pure removal", () => {
  assert.deepEqual(countLineDiff("a\nb\nc", "a"), { added: 0, removed: 2 });
});
check("countLineDiff: modify one middle line", () => {
  assert.deepEqual(countLineDiff("a\nb\nc", "a\nX\nc"), { added: 1, removed: 1 });
});
check("countLineDiff: full rewrite", () => {
  assert.deepEqual(countLineDiff("a\nb\nc", "x\ny\nz"), { added: 3, removed: 3 });
});
check("countLineDiff: LCS detects moved/matching middle lines", () => {
  // "b" is kept as a common subsequence
  assert.deepEqual(countLineDiff("a\nb\nc", "x\nb\nz"), { added: 2, removed: 2 });
});
check("countLineDiff: oversized middle falls back to replacement", () => {
  const a = Array.from({ length: 100 }, (_, i) => `old-${i}`);
  const b = Array.from({ length: 100 }, (_, i) => `new-${i}`);
  // maxCells=1 forces the fallback path instead of LCS
  assert.deepEqual(countLineDiff(a.join("\n"), b.join("\n"), 1), {
    added: 100,
    removed: 100,
  });
});
check("countLineDiff: prefix/suffix trim keeps LCS small", () => {
  const head = Array.from({ length: 500 }, (_, i) => `h${i}`);
  const tail = Array.from({ length: 500 }, (_, i) => `t${i}`);
  const oldText = [...head, "MID", ...tail].join("\n");
  const newText = [...head, "NEW", ...tail].join("\n");
  assert.deepEqual(countLineDiff(oldText, newText), { added: 1, removed: 1 });
});

// -------------------------------------------------- countEditsLineDiff ----
check("countEditsLineDiff: sums over the edits array", () => {
  const stat = countEditsLineDiff({
    edits: [
      { oldText: "a\nb\nc", newText: "a\nX\nc" }, // +1 -1
      { oldText: "tail", newText: "tail\nextra" }, // +1 -0
    ],
  });
  assert.deepEqual(stat, { added: 2, removed: 1 });
});
check("countEditsLineDiff: legacy single oldText/newText shape", () => {
  assert.deepEqual(countEditsLineDiff({ oldText: "x", newText: "y\nz" }), { added: 2, removed: 1 });
});
check("countEditsLineDiff: garbage input yields undefined", () => {
  assert.equal(countEditsLineDiff(undefined), undefined);
  assert.equal(countEditsLineDiff({}), undefined);
  assert.equal(countEditsLineDiff({ edits: "nope" }), undefined);
  assert.equal(countEditsLineDiff({ edits: [{ oldText: 5 }] }), undefined);
});
check("countEditsLineDiff: new-content-only edit counts as additions", () => {
  assert.deepEqual(countEditsLineDiff({ edits: [{ newText: "a\nb" }] }), { added: 2, removed: 0 });
});

// -------------------------------------------------- thinking line renderers ----
check("liveThinkingLine: bold label line above the tail", () => {
  assert.equal(
    liveThinkingLine("first\nlast line", 8_000, 80),
    "**Thinking… (8s)**\n\nlast line",
  );
});
check("liveThinkingLine: unknown duration → bare tail", () => {
  assert.equal(liveThinkingLine("first\nlast line", undefined, 80), "last line");
});
check("liveThinkingLine: truncates tail to width", () => {
  const out = liveThinkingLine("short\n" + "x".repeat(100), 5_000, 20);
  const [label, , tail] = out.split("\n");
  assert.equal(label, "**Thinking… (5s)**");
  assert.equal(displayWidth(tail) <= 20, true);
  assert.equal(tail.startsWith("…"), true);
});
check("liveThinkingLine: empty content passes through", () => {
  assert.equal(liveThinkingLine("\n \n", 1_000, 80), "\n \n");
});
check("liveThinkingLine: bare fence last → label only, never the full text", () => {
  // While a code block streams, the last non-empty line is often the bare
  // fence — the fold must not flash open (the old fallback returned the full
  // markdown, causing the flicker).
  assert.equal(
    liveThinkingLine("thought about code\n```", 8_000, 80),
    "**Thinking… (8s)**\n\nthought about code",
  );
  assert.equal(liveThinkingLine("```", 8_000, 80), "**Thinking… (8s)**");
  assert.equal(liveThinkingLine("```", undefined, 80), "");
});
check("liveThinkingLine: fence with info string is structural", () => {
  assert.equal(
    liveThinkingLine("before block\n```python", 3_000, 80),
    "**Thinking… (3s)**\n\nbefore block",
  );
});
check("foldedThinkingLine: smart shows bold Thought-for line", () => {
  assert.equal(
    foldedThinkingLine("anything at all", 12_340, 80, "smart"),
    "**Thought for 12.3s**",
  );
});
check("foldedThinkingLine: smart without duration", () => {
  assert.equal(foldedThinkingLine("anything", undefined, 80, "smart"), "**Thought…**");
});
check("foldedThinkingLine: tail keeps the tail + bold duration", () => {
  assert.equal(
    foldedThinkingLine("first\nlast line", 12_340, 80, "tail"),
    "**12.3s** · last line",
  );
});
check("foldedThinkingLine: tail ending at a fence folds to the code line", () => {
  // Thinking that ends with a code block ends with the closing fence —
  // the fold must show the last code line, not unfold the whole block.
  assert.equal(
    foldedThinkingLine("intro\n```js\ncode()\n```", 12_340, 80, "tail"),
    "**12.3s** · code()",
  );
  assert.equal(foldedThinkingLine("```", 12_340, 80, "tail"), "**Thought for 12.3s**");
  assert.equal(foldedThinkingLine("```", undefined, 80, "tail"), "**Thought…**");
});
check("expandedThinkingSuffix: bold footer or empty", () => {
  assert.equal(expandedThinkingSuffix(61_500), "\n\n**Thought for 1m01s**");
  assert.equal(expandedThinkingSuffix(undefined), "");
});
check("liveExpandedSuffix: bold ticking footer at the bottom", () => {
  assert.equal(liveExpandedSuffix(8_000), "\n\n**Thinking… (8s)**");
  assert.equal(liveExpandedSuffix(91_000), "\n\n**Thinking… (1m31s)**");
  assert.equal(liveExpandedSuffix(undefined), "");
  // appended after the full text, the timing line ends up as the last line
  const view = "first thought\nsecond thought" + liveExpandedSuffix(8_000);
  assert.equal(view.split("\n").at(-1), "**Thinking… (8s)**");
});

// ---------------------------------------------------------- closeOpenFences ----
check("closeOpenFences: balanced fences pass through unchanged", () => {
  assert.equal(closeOpenFences("text\n```js\ncode()\n```"), "text\n```js\ncode()\n```");
  assert.equal(closeOpenFences("plain thinking"), "plain thinking");
  assert.equal(closeOpenFences(""), "");
});
check("closeOpenFences: unclosed fence gets a matching close", () => {
  assert.equal(closeOpenFences("text\n```js\ncode("), "text\n```js\ncode(\n```");
  // longer opening fence needs an equally long close
  assert.equal(closeOpenFences("````\ncode"), "````\ncode\n````");
});
check("closeOpenFences: tilde fences tracked separately", () => {
  assert.equal(closeOpenFences("~~~\nquoted"), "~~~\nquoted\n~~~");
  // a ``` line does not close a ~~~ fence (it is content), and vice versa
  assert.equal(closeOpenFences("~~~\n```\nq"), "~~~\n```\nq\n~~~");
});
check("closeOpenFences: closing fence with info string does not close", () => {
  assert.equal(closeOpenFences("```\ncode\n```js"), "```\ncode\n```js\n```");
});
check("closeOpenFences: footer appended after the close renders as bold", () => {
  const view = closeOpenFences("thinking\n```js\ncode(") + "\n\n**Thinking… (8s)**";
  assert.equal(view.split("\n").at(-1), "**Thinking… (8s)**");
  assert.match(view, /```js\ncode\(\n```\n\n\*\*Thinking/);
});

// ------------------------------------------------------------ config ----
check("config: defaults when file missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    assert.deepEqual(loadConfig(dir), defaultConfig);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("config: save/load roundtrip with new fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    const next = {
      toolsFold: false,
      thinking: "tail",
      writeStat: false,
      writeCollapsed: "preview",
    };
    assert.equal(saveConfig(dir, next), true);
    assert.deepEqual(loadConfig(dir), next);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("config: migrates legacy thinkingFold boolean", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    writeFileSync(join(dir, "smart-fold.config.json"), '{"thinkingFold": false}', "utf8");
    assert.deepEqual(loadConfig(dir).thinking, "off");
    writeFileSync(join(dir, "smart-fold.config.json"), '{"thinkingFold": true}', "utf8");
    assert.deepEqual(loadConfig(dir).thinking, "smart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("config: invalid values fall back to defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    writeFileSync(
      join(dir, "smart-fold.config.json"),
      '{"thinking": "bogus", "writeCollapsed": 42, "writeStat": "yes", "toolsFold": 1}',
      "utf8",
    );
    const loaded = loadConfig(dir);
    assert.deepEqual(loaded.thinking, "smart");
    assert.deepEqual(loaded.writeCollapsed, "header");
    assert.deepEqual(loaded.writeStat, true);
    assert.deepEqual(loaded.toolsFold, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("config: broken JSON falls back to defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    writeFileSync(join(dir, "smart-fold.config.json"), "{oops", "utf8");
    assert.deepEqual(loadConfig(dir), defaultConfig);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ config ----
check("config: defaults when file missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    assert.deepEqual(loadConfig(dir), defaultConfig);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("config: save/load roundtrip with new fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    const next = {
      toolsFold: false,
      thinking: "tail",
      writeStat: false,
      writeCollapsed: "preview",
    };
    assert.equal(saveConfig(dir, next), true);
    assert.deepEqual(loadConfig(dir), next);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("config: migrates legacy thinkingFold boolean", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    writeFileSync(join(dir, "smart-fold.config.json"), '{"thinkingFold": false}', "utf8");
    assert.deepEqual(loadConfig(dir).thinking, "off");
    writeFileSync(join(dir, "smart-fold.config.json"), '{"thinkingFold": true}', "utf8");
    assert.deepEqual(loadConfig(dir).thinking, "smart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("config: invalid values fall back to defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    writeFileSync(
      join(dir, "smart-fold.config.json"),
      '{"thinking": "bogus", "writeCollapsed": 42, "writeStat": "yes", "toolsFold": 1}',
      "utf8",
    );
    const loaded = loadConfig(dir);
    assert.deepEqual(loaded.thinking, "smart");
    assert.deepEqual(loaded.writeCollapsed, "header");
    assert.deepEqual(loaded.writeStat, true);
    assert.deepEqual(loaded.toolsFold, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("config: broken JSON falls back to defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    writeFileSync(join(dir, "smart-fold.config.json"), "{oops", "utf8");
    assert.deepEqual(loadConfig(dir), defaultConfig);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ ThinkingTracker ----
const msg = (content) => ({ content });

check("ThinkingTracker: single run lifecycle", () => {
  let t = 1_000;
  const tracker = new ThinkingTracker(() => t);
  tracker.handleUpdate({ type: "thinking_start", contentIndex: 0, partial: msg([]) });
  t = 3_000;
  tracker.handleUpdate({ type: "thinking_delta", contentIndex: 0, delta: "hmm ", partial: msg([{ type: "thinking", thinking: "hmm " }]) });
  t = 5_200;
  tracker.handleUpdate({
    type: "thinking_end",
    contentIndex: 0,
    partial: msg([{ type: "thinking", thinking: "hmm let me think" }]),
  });
  // live elapsed while open
  t = 6_000;
  assert.equal(tracker.liveElapsedMs(), 5_000);
  // text followed → closes the run
  t = 7_000;
  tracker.handleUpdate({
    type: "text_start",
    contentIndex: 1,
    partial: msg([{ type: "thinking", thinking: "hmm let me think" }, { type: "text", text: "" }]),
  });
  assert.equal(tracker.liveElapsedMs(), undefined);
  const hash = hashText("hmm let me think");
  assert.equal(tracker.finalizedMs(hash), 4_200); // 5200 - 1000
  const runs = tracker.drainPending();
  assert.deepEqual(runs, [{ hash, ms: 4_200 }]);
  assert.deepEqual(tracker.drainPending(), []);
});

check("ThinkingTracker: consecutive thinking blocks form one group", () => {
  let t = 100;
  const tracker = new ThinkingTracker(() => t);
  tracker.handleUpdate({ type: "thinking_start", contentIndex: 0, partial: msg([]) });
  t = 200;
  tracker.handleUpdate({ type: "thinking_delta", contentIndex: 0, delta: "part one", partial: msg([{ type: "thinking", thinking: "part one" }]) });
  t = 300;
  tracker.handleUpdate({
    type: "thinking_end",
    contentIndex: 0,
    partial: msg([{ type: "thinking", thinking: "part one" }]),
  });
  // second thinking block immediately after → same group, no close
  tracker.handleUpdate({
    type: "thinking_start",
    contentIndex: 1,
    partial: msg([{ type: "thinking", thinking: "part one" }]),
  });
  t = 400;
  tracker.handleUpdate({
    type: "thinking_end",
    contentIndex: 1,
    partial: msg([{ type: "thinking", thinking: "part one" }, { type: "thinking", thinking: "part two" }]),
  });
  const runs = tracker.handleMessageEnd(
    msg([{ type: "thinking", thinking: "part one" }, { type: "thinking", thinking: "part two" }]),
  );
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], { hash: hashText("part one\n\npart two"), ms: 300 }); // 400 - 100
});

check("ThinkingTracker: tool call between thinking blocks splits groups", () => {
  let t = 0;
  const tracker = new ThinkingTracker(() => t);
  t = 100;
  tracker.handleUpdate({ type: "thinking_start", contentIndex: 0, partial: msg([]) });
  t = 200;
  tracker.handleUpdate({
    type: "thinking_end",
    contentIndex: 0,
    partial: msg([{ type: "thinking", thinking: "before tool" }]),
  });
  t = 900;
  tracker.handleUpdate({
    type: "toolcall_start",
    contentIndex: 1,
    partial: msg([{ type: "thinking", thinking: "before tool" }, { type: "toolCall" }]),
  });
  // group 1's thinking ended at its last activity (t=200) → 100ms of thinking
  assert.equal(tracker.finalizedMs(hashText("before tool")), 100);
  // second group after the tool
  tracker.handleUpdate({
    type: "thinking_start",
    contentIndex: 2,
    partial: msg([{ type: "toolCall" }]),
  });
  t = 1_500;
  const runs = tracker.handleMessageEnd(msg([{ type: "toolCall" }, { type: "thinking", thinking: "after tool" }]));
  // both runs of the message are drained together
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], { hash: hashText("before tool"), ms: 100 });
  assert.deepEqual(runs[1], { hash: hashText("after tool"), ms: 600 }); // 1500 - 900
  assert.equal(tracker.finalizedMs(hashText("after tool")), 600);
});

check("ThinkingTracker: finalizeIfMatches closes on exact text", () => {
  let t = 10_000;
  const tracker = new ThinkingTracker(() => t);
  tracker.handleUpdate({ type: "thinking_start", contentIndex: 0, partial: msg([]) });
  t = 12_500;
  tracker.handleUpdate({
    type: "thinking_end",
    contentIndex: 0,
    partial: msg([{ type: "thinking", thinking: "exact text" }]),
  });
  assert.equal(tracker.finalizeIfMatches("exact text"), 2_500);
  assert.equal(tracker.liveElapsedMs(), undefined);
  assert.equal(tracker.finalizeIfMatches("exact text"), undefined); // already closed
  assert.equal(tracker.finalizedMs(hashText("exact text")), 2_500);
});

check("ThinkingTracker: restore merges persisted durations", () => {
  const tracker = new ThinkingTracker(() => 0);
  const hash = hashText("restored thought");
  tracker.restore([{ hash, ms: 3_000 }]);
  assert.equal(tracker.finalizedMs(hash), 3_000);
  // invalid entries are ignored
  tracker.restore([{ hash: 42, ms: "x" }, { hash: "ok", ms: 5 }]);
  assert.equal(tracker.finalizedMs("ok"), 5);
});

check("ThinkingTracker: delta-only fallback when no thinking_end seen", () => {
  let t = 0;
  const tracker = new ThinkingTracker(() => t);
  t = 100;
  tracker.handleUpdate({ type: "thinking_start", contentIndex: 0, partial: msg([]) });
  t = 250;
  tracker.handleUpdate({ type: "thinking_delta", contentIndex: 0, delta: "partial", partial: msg([]) });
  const runs = tracker.handleMessageEnd(undefined);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], { hash: hashText("partial"), ms: 150 });
});

// ------------------------------------------------------ trailingThinkingText ----
check("trailingThinkingText: joins and trims trailing thinking blocks", () => {
  assert.equal(
    trailingThinkingText(
      msg([{ type: "text", text: "hi" }, { type: "thinking", thinking: " one " }, { type: "thinking", thinking: "two" }]),
    ),
    "one\n\ntwo",
  );
});
check("trailingThinkingText: stops at non-thinking block", () => {
  assert.equal(
    trailingThinkingText(msg([{ type: "thinking", thinking: "x" }, { type: "text", text: "hi" }])),
    null,
  );
});
check("trailingThinkingText: skips empty thinking blocks at the end", () => {
  assert.equal(
    trailingThinkingText(msg([{ type: "thinking", thinking: "x" }, { type: "thinking", thinking: "  " }])),
    "x",
  );
});

console.log(`✓ ${passed} test groups passed`);
