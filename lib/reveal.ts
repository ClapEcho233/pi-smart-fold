/**
 * pi-smart-fold — click-to-reveal state for folded thinking blocks.
 *
 * pi renders a finalized thinking block in exactly two states: the expanded
 * markdown (our transformer runs) and the native hidden label (it does not).
 * A click toggles between them, so "the transformer ran again for this block
 * right after its hidden state was shown" means the user clicked to expand.
 *
 * We cannot observe clicks directly (pi's fullscreen renderer consumes mouse
 * input before extension input listeners), so we count expanded renders per
 * block and treat a second render as a reveal — while distinguishing clicks
 * from global re-renders (theme change, layout, settings) via burst sizes:
 * a click re-renders ONE assistant message (a few transforms), while a global
 * invalidation re-renders the whole transcript (many transforms in the same
 * synchronous pass). Oversized bursts have their increments rolled back and
 * trigger a forced re-render, so accidental unfolds heal themselves.
 *
 * Pure logic, no pi imports: unit-testable with plain `node`.
 */

export interface RevealEntry {
  count: number;
  width: number;
}

export interface RevealControllerOptions {
  now?: () => number;
  schedule?: (cb: () => void) => void;
  /** Called after an invalidation burst was rolled back (force a re-render). */
  onInvalidation?: () => void;
  maxEntries?: number;
  /** Transform calls in one synchronous pass above this = global re-render. */
  threshold?: number;
}

const SUPPRESS_MS = 250;

export class RevealController {
  private readonly entries = new Map<string, RevealEntry>();
  private readonly now: () => number;
  private readonly schedule: (cb: () => void) => void;
  private readonly onInvalidation: () => void;
  private readonly maxEntries: number;
  private readonly threshold: number;
  private burstActive = false;
  private burstCount = 0;
  private burstIncrements: RevealEntry[] = [];
  private suppressUntil = 0;

  constructor(options: RevealControllerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((cb) => queueMicrotask(cb));
    this.onInvalidation = options.onInvalidation ?? (() => {});
    this.maxEntries = options.maxEntries ?? 2000;
    this.threshold = options.threshold ?? 8;
  }

  /**
   * Call once per markdown-transform invocation, for EVERY message type
   * (user text and assistant text re-render on global invalidations too,
   * which is what makes those bursts large).
   */
  noteTransform(): void {
    if (!this.burstActive) {
      this.burstActive = true;
      this.burstCount = 0;
      this.burstIncrements = [];
      this.schedule(() => {
        const invalidation = this.burstCount > this.threshold;
        const increments = this.burstIncrements;
        this.burstActive = false;
        this.burstCount = 0;
        this.burstIncrements = [];
        if (invalidation && increments.length > 0) {
          for (const entry of increments) entry.count = Math.max(0, entry.count - 1);
          this.suppressUntil = this.now() + SUPPRESS_MS;
          try {
            this.onInvalidation();
          } catch {
            // Forcing a re-render is best-effort.
          }
        }
      });
    }
    this.burstCount += 1;
  }

  /**
   * Decide whether a finalized thinking block should render fully expanded.
   * - First render at a given width → folded (count 0).
   * - Later renders (i.e. after the user clicked through the hidden state)
   *   → revealed.
   * - A width change means a re-layout, not a click: the entry resets.
   */
  shouldReveal(key: string, width: number): boolean {
    let entry = this.entries.get(key);
    if (!entry || entry.width !== width) {
      if (this.entries.size > this.maxEntries) this.entries.clear();
      entry = { count: 0, width };
      this.entries.set(key, entry);
      return false; // first render at this width → folded
    }
    if (this.now() >= this.suppressUntil) {
      entry.count += 1;
      if (this.burstActive) this.burstIncrements.push(entry);
    }
    return entry.count >= 1;
  }

  /** Forget all reveal state (config change, session switch). */
  clear(): void {
    this.entries.clear();
  }
}
