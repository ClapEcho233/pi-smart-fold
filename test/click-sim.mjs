/**
 * Click-cycle simulation against the REAL pi AssistantMessageComponent.
 *
 * Drives the patched updateContent + pi's exact MouseRegion click semantics
 (copied from pi's assistant-message.js) and asserts the user-facing toggle:
 *
 *   streaming:  tail →(click)→ full →(click)→ tail →(click)→ full …
 *               full view keeps the ticking `Thinking… (Ns)` line at the
 *               BOTTOM of the block; the hidden-label middle state never
 *               appears. Same one-click toggle for a run that already
 *               finished while the message keeps streaming (folded duration
 *               line ↔ full text with footer).
 *   finalized:  seeded hidden `Thought for …` label →(click)→ full+footer
 *               →(click)→ label …
 *
 * Requires ./node_modules/@earendil-works symlinks to the installed pi
 * packages (see README dev section). Not part of `npm test`.
 */
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import smartFold from "../index.ts";

initTheme("default", false); // headless: the component's render path needs a theme

// ---- mock pi ExtensionAPI --------------------------------------------------
let transformer;
const handlers = {};
const mockPi = {
  registerMarkdownTransformer: (fn) => {
    transformer = fn;
  },
  on: (name, fn) => {
    (handlers[name] ??= []).push(fn);
  },
  registerTool: () => {},
  registerCommand: () => {},
  appendEntry: () => {},
};
smartFold(mockPi);
assert.equal(typeof transformer, "function", "transformer registered");

const fire = (name, event) => {
  let done = Promise.resolve();
  for (const fn of handlers[name] ?? []) done = done.then(() => fn(event));
  return done;
};

/** Invoke the transformer the way pi's Markdown component would. */
const render = (markdown, isStreaming) =>
  transformer(markdown, {
    messageType: "assistant-thinking",
    isStreaming,
    availableWidth: 100,
  });

/** pi's MouseRegion click handler, verbatim semantics. */
const click = (comp, runIndex) => {
  const hidden = comp.thinkingVisibilityOverrides.get(runIndex) ?? comp.hideThinkingBlock;
  comp.thinkingVisibilityOverrides.set(runIndex, !hidden);
  comp.updateContent(comp.lastMessage);
};

const msg = (thinking) => ({
  content: [{ type: "thinking", thinking }],
  stopReason: undefined,
});
const update = (partial, delta) =>
  fire("message_update", {
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial },
  });

// ---- streaming: tail ↔ full with a single click -----------------------------
await fire("message_update", {
  message: { role: "assistant" },
  assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: msg("") },
});
await update(msg("alpha thoughts"), "alpha thoughts");

const comp = new AssistantMessageComponent();
comp.updateContent(msg("alpha thoughts"), true);
assert.equal(comp.thinkingVisibilityOverrides.size, 0, "no overrides before any click");

// default: scrolling tail — label line on TOP, only the last text line
assert.match(
  render("alpha thoughts", true),
  /^\*\*Thinking… \(\d+[smh][0-9]*\)\*\*\n\nalpha thoughts$/,
  "default streaming view is the live tail",
);

// click 1 → full text so far, timing line pinned at the BOTTOM
click(comp, 0);
assert.equal(comp.thinkingVisibilityOverrides.get(0), false, "click redirected to visible");
assert.match(
  render("alpha thoughts", true),
  /^alpha thoughts\n\n\*\*Thinking… \(\d+[smh][0-9]*\)\*\*$/,
  "first click expands to full view with the timing line last",
);

// text keeps growing while open → full view follows, timing stays at the bottom
await update(msg("alpha thoughts\nbeta continues"), "beta continues");
comp.updateContent(msg("alpha thoughts\nbeta continues"), true);
assert.match(
  render("alpha thoughts\nbeta continues", true),
  /^alpha thoughts\nbeta continues\n\n\*\*Thinking… \(\d+[smh][0-9]*\)\*\*$/,
  "full view follows growth",
);

// click 2 → back to the scrolling tail (no hidden-label middle state)
click(comp, 0);
assert.equal(comp.thinkingVisibilityOverrides.get(0), false, "still visible after collapse");
assert.match(
  render("alpha thoughts\nbeta continues", true),
  /^\*\*Thinking… \(\d+[smh][0-9]*\)\*\*\n\nbeta continues$/,
  "second click returns to the live tail",
);

// click 3 → full again — a clean two-state toggle
click(comp, 0);
assert.equal(comp.thinkingVisibilityOverrides.get(0), false);
assert.match(
  render("alpha thoughts\nbeta continues", true),
  /^alpha thoughts\nbeta continues\n\n\*\*Thinking… \(\d+[smh][0-9]*\)\*\*$/,
  "third click expands again",
);

// ---- message end: open run keeps full text, now with the final footer -------
await fire("message_end", {
  message: { role: "assistant", content: msg("alpha thoughts\nbeta continues").content, stopReason: "stop" },
});
comp.updateContent(msg("alpha thoughts\nbeta continues"), false); // finalized render
assert.match(
  render("alpha thoughts\nbeta continues", false),
  /^alpha thoughts\nbeta continues\n\n\*\*Thought for [\d.]+s\*\*$/,
  "run left open at message end shows full text + Thought-for footer",
);

// ---- fresh message: seeded hidden label, single click expands ---------------
const comp2 = new AssistantMessageComponent();
comp2.updateContent(msg("alpha thoughts\nbeta continues"), false);
assert.equal(comp2.thinkingVisibilityOverrides.get(0), true, "finalized runs seeded hidden");
assert.match(comp2.hiddenThinkingLabel, /Thought for /, "hidden label carries the duration");

click(comp2, 0);
assert.equal(comp2.thinkingVisibilityOverrides.get(0), false, "one click expands");
assert.match(
  render("alpha thoughts\nbeta continues", false),
  /\n\n\*\*Thought for [\d.]+s\*\*$/,
  "expanded finalized run shows the footer",
);
click(comp2, 0);
assert.equal(comp2.thinkingVisibilityOverrides.get(0), true, "one more click collapses");

console.log("✓ scenario A: tail ↔ full while streaming; seeded toggle after");

// ---- scenario B: finished run + live run in one streaming message ----------
// Clicks on the finished run must not disturb the live run's open state.
const fireB = fire; // same handlers
const mk = (a, b) => ({
  content: [
    { type: "thinking", thinking: a },
    { type: "toolCall", id: "t1", name: "bash", arguments: {} },
    { type: "thinking", thinking: b },
  ],
  stopReason: undefined,
});
/** Partial as it exists at run A's thinking_end: just the thinking block. */
const endPartial = (a) => ({ content: [{ type: "thinking", thinking: a }], stopReason: undefined });
/** Partial at run B's thinking_start: run A's block followed by the tool call. */
const toolPartial = (a) => ({
  content: [
    { type: "thinking", thinking: a },
    { type: "toolCall", id: "t1", name: "bash", arguments: {} },
  ],
  stopReason: undefined,
});
await fireB("message_update", {
  message: { role: "assistant" },
  assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: mk("", "") },
});
await fireB("message_update", {
  message: { role: "assistant" },
  assistantMessageEvent: { type: "thinking_end", contentIndex: 0, partial: endPartial("first run") },
});
await fireB("message_update", {
  message: { role: "assistant" },
  assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: toolPartial("first run") },
});
await fireB("message_update", {
  message: { role: "assistant" },
  assistantMessageEvent: { type: "thinking_start", contentIndex: 2, partial: toolPartial("first run") },
});
await fireB("message_update", {
  message: { role: "assistant" },
  assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "second run", partial: mk("first run", "second run") },
});

const compB = new AssistantMessageComponent();
compB.updateContent(mk("first run", "second run"), true);
// run 0 finished → folded duration line; run 1 live → tail
assert.match(render("first run", true), /^\*\*Thought for /, "finished run folds while message streams");
assert.match(render("second run", true), /^\*\*Thinking… /, "live run shows the tail");

// open the live run (run 1) to full view
compB.thinkingVisibilityOverrides.set(1, true); // pi click handler for run 1
compB.updateContent(compB.lastMessage);
assert.equal(compB.thinkingVisibilityOverrides.get(1), false, "live-run click redirected");
assert.match(render("second run", true), /^second run\n\n\*\*Thinking… /, "live run expanded");

// clicking the finished run while the message still streams: ONE click
// expands it directly — the global `Thought…` hidden-label middle state
// must never appear (this was the reported bug)
compB.thinkingVisibilityOverrides.set(0, true); // pi click handler for run 0
compB.updateContent(compB.lastMessage);
assert.equal(compB.thinkingVisibilityOverrides.get(0), false, "finished-run click redirected to visible");
assert.match(
  render("first run", true),
  /^first run\n\n\*\*Thought for /,
  "one click expands the finished run with the footer",
);
assert.match(
  render("second run", true),
  /^second run\n\n\*\*Thinking… /,
  "finished-run click does not clobber the live run's open state",
);

// clicking it again folds the finished run back to the duration line
compB.thinkingVisibilityOverrides.set(0, true);
compB.updateContent(compB.lastMessage);
assert.equal(compB.thinkingVisibilityOverrides.get(0), false, "still visible after collapse");
assert.match(
  render("first run", true),
  /^\*\*Thought for /,
  "second click re-folds the finished run (no label middle state)",
);
assert.match(
  render("second run", true),
  /^second run\n\n\*\*Thinking… /,
  "live run still expanded",
);

// third click expands again — a clean two-state toggle
compB.thinkingVisibilityOverrides.set(0, true);
compB.updateContent(compB.lastMessage);
assert.match(
  render("first run", true),
  /^first run\n\n\*\*Thought for /,
  "third click expands again",
);

console.log("✓ scenario B: finished-run clicks leave the live run's toggle intact");

// ---- scenario C: the reported regression — single run finished, answer
// text still streaming. `Thought for …` → click → full text, click → folded
// again. Never the global `Thought…` label. --------------------------------
const fireC = fire; // same handlers
const msgC = (thinking, text) => ({
  content: [
    { type: "thinking", thinking },
    { type: "text", text },
  ],
  stopReason: undefined,
});
const thinkOnly = (t) => ({ content: [{ type: "thinking", thinking: t }], stopReason: undefined });
await fireC("message_update", {
  message: { role: "assistant" },
  assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: thinkOnly("") },
});
await fireC("message_update", {
  message: { role: "assistant" },
  assistantMessageEvent: {
    type: "thinking_delta",
    contentIndex: 0,
    delta: "plan the answer",
    partial: thinkOnly("plan the answer"),
  },
});
await fireC("message_update", {
  message: { role: "assistant" },
  assistantMessageEvent: { type: "thinking_end", contentIndex: 0, partial: thinkOnly("plan the answer") },
});
// the following text block closes the thinking run: it now has a finalized
// duration while the message itself is still streaming
await fireC("message_update", {
  message: { role: "assistant" },
  assistantMessageEvent: {
    type: "text_start",
    contentIndex: 1,
    partial: msgC("plan the answer", ""),
  },
});

const compC = new AssistantMessageComponent();
compC.updateContent(msgC("plan the answer", "answering…"), true);
assert.match(
  render("plan the answer", true),
  /^\*\*Thought for /,
  "finished run folds while the answer still streams",
);

// click 1 → full text + footer (NOT the global `Thought…` label)
compC.thinkingVisibilityOverrides.set(0, true);
compC.updateContent(compC.lastMessage);
assert.equal(compC.thinkingVisibilityOverrides.get(0), false, "click redirected to visible");
assert.match(
  render("plan the answer", true),
  /^plan the answer\n\n\*\*Thought for /,
  "one click expands to full text with the footer",
);

// click 2 → folded duration line again
compC.thinkingVisibilityOverrides.set(0, true);
compC.updateContent(compC.lastMessage);
assert.equal(compC.thinkingVisibilityOverrides.get(0), false, "still visible after collapse");
assert.match(
  render("plan the answer", true),
  /^\*\*Thought for /,
  "second click re-folds to the duration line",
);

// message ends: the run left folded normalizes into the seeded hidden state
// (label with duration) so the next click expands directly
await fireC("message_end", {
  message: { role: "assistant", ...msgC("plan the answer", "answering…"), stopReason: "stop" },
});
compC.updateContent(compC.lastMessage, false);
assert.equal(compC.thinkingVisibilityOverrides.get(0), true, "collapsed run normalized to seeded hidden");
assert.match(compC.hiddenThinkingLabel, /Thought for /, "label carries the duration");
compC.thinkingVisibilityOverrides.set(0, false);
compC.updateContent(compC.lastMessage);
assert.match(
  render("plan the answer", false),
  /^plan the answer\n\n\*\*Thought for /,
  "click after finalize expands in one step",
);

console.log("✓ scenario C: finished run in a streaming message toggles with one click");

// ---- scenario D: code blocks inside thinking -------------------------------
// Collapsed: when the last non-empty line is a bare code fence, the fold must
// NOT fall back to the full markdown (that flash-open was the flicker).
// Expanded: the footer must render OUTSIDE an unclosed fence — bold text, not
// literal `**` asterisks (verified through pi's real Markdown renderer).
import { Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";

const fireD = fire; // same handlers
const md = (t) => ({ content: [{ type: "thinking", thinking: t }], stopReason: undefined });
const streamD = (delta, partial) =>
  fireD("message_update", {
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: md(partial) },
  });

// stream up to the opening fence: last non-empty line is the bare-ish fence
await fireD("message_update", {
  message: { role: "assistant" },
  assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: md("") },
});
await streamD("consider the snippet\n```ts", "consider the snippet\n```ts");
const compD = new AssistantMessageComponent();
compD.updateContent(md("consider the snippet\n```ts"), true);
assert.match(
  render("consider the snippet\n```ts", true),
  /^\*\*Thinking… \(\d+s\)\*\*\n\nconsider the snippet$/,
  "bare fence as last line does not unfold the tail view",
);

// code content streams in: it becomes the tail line
await streamD("\nconst x = 1;", "consider the snippet\n```ts\nconst x = 1;");
compD.updateContent(md("consider the snippet\n```ts\nconst x = 1;"), true);
assert.match(
  render("consider the snippet\n```ts\nconst x = 1;", true),
  /^\*\*Thinking… \(\d+s\)\*\*\n\nconst x = 1;$/,
  "code content line shows as the tail",
);

// expand while the fence is still unclosed → fence closed, footer outside it
click(compD, 0);
const expandedD = render("consider the snippet\n```ts\nconst x = 1;", true);
assert.match(
  expandedD,
  /```ts\nconst x = 1;\n```\n\n\*\*Thinking… \(\d+s\)\*\*$/,
  "unclosed fence gets closed and the footer lands below it",
);

// render through pi's REAL Markdown component: the footer line must be bold
// "Thinking… (Ns)" — no literal asterisks from being swallowed by the fence
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
const renderedD = new Markdown(expandedD, 1, 0, getMarkdownTheme()).render(80).map(stripAnsi);
const lastLineD = [...renderedD].reverse().find((l) => l.trim() !== "");
assert.match(lastLineD.trim(), /^Thinking… \(\d+s\)$/, "footer renders bold without literal asterisks");
assert.equal(
  renderedD.some((l) => l.includes("**Thinking")),
  false,
  "no raw ** markers leak into the render",
);
assert.equal(
  renderedD.some((l) => l.includes("const x = 1;")),
  true,
  "code content still rendered",
);

// and the pre-fix behavior really did swallow the footer: sanity-check that
// an unclosed fence without our close would show literal asterisks
const unclosedView = "consider the snippet\n```ts\nconst x = 1;\n\n**Thinking… (8s)**";
const renderedU = new Markdown(unclosedView, 1, 0, getMarkdownTheme()).render(80).map(stripAnsi);
assert.equal(
  renderedU.some((l) => l.includes("**Thinking…")),
  true,
  "sanity: unclosed fence would have swallowed the footer (regression guard)",
);

console.log("✓ scenario D: code blocks — no fold flicker, footer renders outside the fence");
