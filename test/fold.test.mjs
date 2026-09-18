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
  stripBlockMarkers,
  collapseThinking,
} from "../lib/fold.ts";
import { defaultConfig, loadConfig, saveConfig } from "../lib/config.ts";

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

// -------------------------------------------------------------- config ----
check("config: defaults when file missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    assert.deepEqual(loadConfig(dir), defaultConfig);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("config: save/load roundtrip and partial merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "smart-fold-"));
  try {
    assert.equal(saveConfig(dir, { toolsFold: false, thinkingFold: true }), true);
    assert.deepEqual(loadConfig(dir), { toolsFold: false, thinkingFold: true });
    // partial file merges over defaults
    writeFileSync(join(dir, "smart-fold.config.json"), '{"thinkingFold": false}', "utf8");
    assert.deepEqual(loadConfig(dir), { toolsFold: true, thinkingFold: false });
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

console.log(`✓ ${passed} test groups passed`);
