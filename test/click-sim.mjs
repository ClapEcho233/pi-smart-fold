/**
 * Click-cycle simulation against the REAL pi AssistantMessageComponent.
 *
 * Drives the patched updateContent + pi's exact MouseRegion click semantics
 (copied from pi's assistant-message.js) and asserts the user-facing toggle:
 *
 *   streaming:  tail →(click)→ full →(click)→ tail →(click)→ full …
 *               full view keeps the ticking `Thinking… (Ns)` line at the
 *               BOTTOM of the block; the hidden-label middle state never
 *               appears.
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

// clicking the finished run (hidden toggle) must not collapse the live run
compB.thinkingVisibilityOverrides.set(0, true);
compB.updateContent(compB.lastMessage);
assert.equal(compB.thinkingVisibilityOverrides.get(0), true, "finished run toggles natively");
assert.match(
  render("second run", true),
  /^second run\n\n\*\*Thinking… /,
  "finished-run click does not clobber the live run's open state",
);

// clicking it back open reveals the finished run, live run still untouched
compB.thinkingVisibilityOverrides.set(0, false);
compB.updateContent(compB.lastMessage);
assert.match(render("first run", true), /^first run\n\n\*\*Thought for /, "finished run expands with footer");
assert.match(render("second run", true), /^second run\n\n\*\*Thinking… /, "live run still expanded");

console.log("✓ scenario B: finished-run clicks leave the live run's toggle intact");
