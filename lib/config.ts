/**
 * pi-smart-fold — config persistence.
 *
 * The config lives next to the extension entry (`smart-fold.config.json`).
 * Every read/write is best-effort: a missing or broken file simply falls
 * back to defaults instead of breaking pi startup.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ThinkingMode = "smart" | "tail" | "full" | "off";
export type WriteCollapsedStyle = "header" | "preview";

export interface SmartFoldConfig {
  /** Collapse tool output at every session start. Default: true */
  toolsFold: boolean;
  /**
   * Thinking display strategy:
   * - "smart": while the model thinks, show one live line with the elapsed
   *   time and the scrolling tail of the thinking text; once the message is
   *   finished, collapse to a single `Thinking… (Xs)` line. Clicking the line
   *   twice (through pi's native hidden state) reveals the full text.
   * - "tail":  always fold thinking to a single tail line (plus duration).
   * - "full":  leave finished thinking unfolded (full markdown).
   * - "off":   no thinking transformation at all.
   * Default: "smart"
   */
  thinking: ThinkingMode;
  /** Append `+N -M` line-diff stats to the write tool header. Default: true */
  writeStat: boolean;
  /**
   * Collapsed write tool rows:
   * - "header": only the `write <path> +N -M` line (fully collapsed).
   * - "preview": keep pi's default content preview (10 lines).
   * Default: "header"
   */
  writeCollapsed: WriteCollapsedStyle;
}

export const defaultConfig: SmartFoldConfig = {
  toolsFold: true,
  thinking: "smart",
  writeStat: true,
  writeCollapsed: "header",
};

const THINKING_MODES: readonly ThinkingMode[] = ["smart", "tail", "full", "off"];
const WRITE_STYLES: readonly WriteCollapsedStyle[] = ["header", "preview"];

export function configFilePath(extensionDir: string): string {
  return join(extensionDir, "smart-fold.config.json");
}

/** Load config merged over defaults; never throws. */
export function loadConfig(extensionDir: string): SmartFoldConfig {
  try {
    const file = configFilePath(extensionDir);
    if (!existsSync(file)) return { ...defaultConfig };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      toolsFold:
        typeof parsed.toolsFold === "boolean" ? parsed.toolsFold : defaultConfig.toolsFold,
      thinking: migrateThinking(parsed),
      writeStat:
        typeof parsed.writeStat === "boolean" ? parsed.writeStat : defaultConfig.writeStat,
      writeCollapsed:
        typeof parsed.writeCollapsed === "string" &&
        WRITE_STYLES.includes(parsed.writeCollapsed as WriteCollapsedStyle)
          ? (parsed.writeCollapsed as WriteCollapsedStyle)
          : defaultConfig.writeCollapsed,
    };
  } catch {
    return { ...defaultConfig };
  }
}

/** Accepts the new string form plus the legacy `thinkingFold: boolean`. */
function migrateThinking(parsed: Record<string, unknown>): ThinkingMode {
  if (
    typeof parsed.thinking === "string" &&
    THINKING_MODES.includes(parsed.thinking as ThinkingMode)
  ) {
    return parsed.thinking as ThinkingMode;
  }
  if (typeof parsed.thinkingFold === "boolean") {
    return parsed.thinkingFold ? "smart" : "off";
  }
  return defaultConfig.thinking;
}

/** Persist config best-effort. Returns true on success. */
export function saveConfig(extensionDir: string, config: SmartFoldConfig): boolean {
  try {
    writeFileSync(configFilePath(extensionDir), JSON.stringify(config, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}
