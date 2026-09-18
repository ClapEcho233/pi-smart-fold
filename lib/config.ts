/**
 * pi-smart-fold — config persistence.
 *
 * The config lives next to the extension entry (`smart-fold.config.json`).
 * Every read/write is best-effort: a missing or broken file simply falls
 * back to defaults instead of breaking pi startup.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SmartFoldConfig {
  /** Collapse tool output at every session start. Default: true */
  toolsFold: boolean;
  /** Fold each thinking block down to its (live) last line. Default: true */
  thinkingFold: boolean;
}

export const defaultConfig: SmartFoldConfig = {
  toolsFold: true,
  thinkingFold: true,
};

export function configFilePath(extensionDir: string): string {
  return join(extensionDir, "smart-fold.config.json");
}

/** Load config merged over defaults; never throws. */
export function loadConfig(extensionDir: string): SmartFoldConfig {
  try {
    const file = configFilePath(extensionDir);
    if (!existsSync(file)) return { ...defaultConfig };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SmartFoldConfig>;
    return {
      toolsFold: typeof parsed.toolsFold === "boolean" ? parsed.toolsFold : defaultConfig.toolsFold,
      thinkingFold:
        typeof parsed.thinkingFold === "boolean" ? parsed.thinkingFold : defaultConfig.thinkingFold,
    };
  } catch {
    return { ...defaultConfig };
  }
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
