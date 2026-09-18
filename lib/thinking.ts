/**
 * pi-smart-fold — thinking-run timing.
 *
 * Tracks when each "thinking run" (a maximal group of consecutive thinking
 * blocks inside one assistant message) starts and ends, so the UI can show a
 * live elapsed time while the model thinks and a total duration afterwards.
 * Durations are exposed by content hash and can be persisted/restored by the
 * extension via session entries.
 *
 * Pure logic, no pi imports: unit-testable with plain `node`.
 */
import { hashText } from "./fold.ts";

export interface ClosedThinkingRun {
  hash: string;
  ms: number;
}

/** Minimal structural types so tests can feed plain objects. */
interface ContentLike {
  type: string;
  thinking?: string;
}
interface MessageLike {
  content?: ContentLike[];
}
export interface AssistantMessageEventLike {
  type: string;
  contentIndex?: number;
  delta?: string;
  partial?: MessageLike;
}

interface OpenGroup {
  start: number;
  lastDelta: number;
  /** Delta-accumulated fallback text. */
  text: string;
  /** Exact joined text once a thinking_end event has been observed. */
  exact?: string;
  /** True once a thinking_end event was seen for this group. */
  ended?: boolean;
}

const MAX_TRACKED = 2000;

export class ThinkingTracker {
  private readonly now: () => number;
  private current: OpenGroup | null = null;
  private readonly finalized = new Map<string, number>();
  private pending: ClosedThinkingRun[] = [];

  constructor(nowFn: () => number = () => Date.now()) {
    this.now = nowFn;
  }

  /** Feed `message_update`'s assistantMessageEvent (assistant messages only). */
  handleUpdate(event: AssistantMessageEventLike): void {
    const now = this.now();
    switch (event.type) {
      case "thinking_start": {
        // The group continues when the content block right before this one is
        // also thinking; anything else starts a fresh group (and closes the
        // previous one).
        const prevType = lastTypeBefore(event.partial, event.contentIndex);
        if (!(this.current && prevType === "thinking")) {
          this.closeCurrent();
          this.current = { start: now, lastDelta: now, text: "" };
        }
        return;
      }
      case "thinking_delta": {
        if (!this.current) this.current = { start: now, lastDelta: now, text: "" };
        this.current.lastDelta = now;
        if (typeof event.delta === "string") this.current.text += event.delta;
        return;
      }
      case "thinking_end": {
        if (this.current) {
          const exact = trailingThinkingText(event.partial);
          if (exact !== null) this.current.exact = exact;
          this.current.lastDelta = now;
          this.current.ended = true;
        }
        return;
      }
      default: {
        // Any other content block starting (text, tool call, …) ends the run.
        this.closeCurrent();
      }
    }
  }

  /**
   * Close any open group for a finished assistant message and return the runs
   * recorded since the last drain (for session persistence).
   */
  handleMessageEnd(message: MessageLike | undefined): ClosedThinkingRun[] {
    if (this.current) {
      const exact = trailingThinkingText(message);
      if (exact !== null) this.current.exact = exact;
      // A run that never saw thinking_end was cut off mid-stream or missed
      // events: count up to the message end.
      if (!this.current.ended) this.current.lastDelta = this.now();
    }
    this.closeCurrent();
    return this.drainPending();
  }

  /** Live elapsed ms of the currently streaming thinking group, if any. */
  liveElapsedMs(): number | undefined {
    return this.current ? this.now() - this.current.start : undefined;
  }

  /** Duration of a finished group, keyed by its joined markdown hash. */
  finalizedMs(hash: string): number | undefined {
    return this.finalized.get(hash);
  }

  /**
   * Render-time safety net: the TUI may re-render a message as finalized
   * before our message_end handler runs. If the open group's text matches the
   * rendered markdown, close it now and return its duration.
   */
  finalizeIfMatches(markdown: string): number | undefined {
    if (!this.current) return undefined;
    const hash = hashText(markdown);
    if (hashText(this.current.exact ?? this.current.text) !== hash) return undefined;
    this.closeCurrent();
    return this.finalized.get(hash);
  }

  /** Merge durations restored from session entries. */
  restore(runs: ClosedThinkingRun[]): void {
    for (const run of runs) {
      if (run && typeof run.hash === "string" && Number.isFinite(run.ms)) {
        this.finalized.set(run.hash, Math.max(0, run.ms));
      }
    }
  }

  drainPending(): ClosedThinkingRun[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private closeCurrent(): void {
    const group = this.current;
    if (!group) return;
    this.current = null;
    const text = group.exact ?? group.text;
    if (!text.trim()) return;
    const ms = Math.max(0, group.lastDelta - group.start);
    const hash = hashText(text);
    this.finalized.delete(hash); // re-insert to refresh insertion order
    this.finalized.set(hash, ms);
    if (this.finalized.size > MAX_TRACKED) {
      let excess = this.finalized.size - MAX_TRACKED;
      for (const key of this.finalized.keys()) {
        if (excess-- <= 0) break;
        this.finalized.delete(key);
      }
    }
    this.pending.push({ hash, ms });
  }
}

function lastTypeBefore(
  message: MessageLike | undefined,
  contentIndex: number | undefined,
): string | undefined {
  const content = message?.content;
  if (!Array.isArray(content) || contentIndex === undefined) return undefined;
  return content[Math.max(0, contentIndex - 1)]?.type;
}

/**
 * Joined text of the trailing run of consecutive non-empty thinking blocks —
 * exactly what pi's AssistantMessageComponent renders as one Markdown group
 * (blocks are trimmed and joined with a blank line).
 */
export function trailingThinkingText(message: MessageLike | undefined): string | null {
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block?.type !== "thinking") break;
    const text = typeof block.thinking === "string" ? block.thinking.trim() : "";
    if (text) parts.unshift(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
