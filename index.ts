/**
 * pi-smart-fold
 * =============
 * A pi (https://github.com/earendil-works/pi-mono) coding-agent extension that
 * keeps the transcript compact:
 *
 *   1. Tool output is collapsed on every session start (`session_start` covers
 *      startup, /reload, /new, /resume and /fork).
 *   2. Every assistant *thinking* block is folded down to a single line that
 *      shows its LAST line. While the model streams, the folded line keeps
 *      updating to the newest text — an auto-scrolling "tail -f" effect.
 *
 * The full thinking text is never modified on disk or in the LLM context:
 * folding is display-only, applied through pi's markdown-transformer hook.
 *
 * Runtime control:
 *   /fold                  show current state
 *   /fold thinking on|off  fold / unfold thinking blocks (persisted)
 *   /fold tools on|off     collapse / expand tool output (persisted, and
 *                          applied to the current session immediately)
 *
 * Config file: `smart-fold.config.json` next to this entry file.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collapseThinking } from "./lib/fold.ts";
import { loadConfig, saveConfig, type SmartFoldConfig } from "./lib/config.ts";

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

export default function smartFold(pi: ExtensionAPI): void {
  const extensionDir = resolveExtensionDir();
  const config: SmartFoldConfig = extensionDir ? loadConfig(extensionDir) : { toolsFold: true, thinkingFold: true };

  // Runtime state (starts from persisted config; /fold mutates + persists).
  let thinkingFold = config.thinkingFold;

  // -------------------------------------------------------------------------
  // 1) Fold thinking blocks to their last line (display-only).
  // -------------------------------------------------------------------------
  // The transformer runs whenever an assistant message (re)renders — including
  // every streaming update — so the folded line automatically "scrolls" to the
  // latest thinking text while the model works.
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "assistant-thinking") return markdown;
    if (!thinkingFold) return markdown;
    // -1 gives the renderer a little slack for padding/borders; collapseThinking
    // sanitizes the width itself.
    return collapseThinking(markdown, context.availableWidth - 1);
  });

  // -------------------------------------------------------------------------
  // 2) Collapse tool output on session start.
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    if (!config.toolsFold) return;
    if (!ctx.hasUI) return; // no-op guard for print / json modes
    try {
      ctx.ui.setToolsExpanded(false);
    } catch {
      // Never let folding break a session start.
    }
  });

  // -------------------------------------------------------------------------
  // 3) /fold command — inspect and toggle at runtime.
  // -------------------------------------------------------------------------
  const persist = (next: SmartFoldConfig): void => {
    if (extensionDir) saveConfig(extensionDir, next);
  };

  const statusLine = (): string =>
    `smart-fold — thinking: ${thinkingFold ? "折叠(folded)" : "展开(full)"} · 工具输出: ${
      config.toolsFold ? "启动时折叠(collapsed)" : "启动时展开(expanded)"
    }`;

  pi.registerCommand("fold", {
    description: "smart-fold: 查看/切换 thinking 折叠与工具输出折叠 (on|off)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const target = parts[0]?.toLowerCase();
      const value = parts[1]?.toLowerCase();

      if (target === "thinking") {
        if (value !== "on" && value !== "off") {
          ctx.ui.notify("用法: /fold thinking on|off", "warning");
          return;
        }
        thinkingFold = value === "on";
        config.thinkingFold = thinkingFold;
        persist(config);
        if (ctx.mode === "tui") {
          try {
            // Force every rendered assistant message to rebuild through the
            // markdown transformer so the toggle applies to history too.
            // (Resets a custom hidden-thinking label to its default, if any.)
            ctx.ui.setHiddenThinkingLabel();
          } catch {
            // New content still picks the change up on next render.
          }
        }
        ctx.ui.notify(`thinking: ${thinkingFold ? "折叠(folded)" : "展开(full)"} — 已保存`, "info");
        return;
      }

      if (target === "tools") {
        if (value !== "on" && value !== "off") {
          ctx.ui.notify("用法: /fold tools on|off", "warning");
          return;
        }
        config.toolsFold = value === "on";
        persist(config);
        if (ctx.hasUI) {
          try {
            ctx.ui.setToolsExpanded(!config.toolsFold); // on => collapsed
          } catch {
            // Applied on next session_start anyway.
          }
        }
        ctx.ui.notify(
          `工具输出: ${config.toolsFold ? "折叠(collapsed)" : "展开(expanded)"} — 已保存`,
          "info",
        );
        return;
      }

      if (target !== undefined) {
        ctx.ui.notify("用法: /fold [thinking|tools] [on|off]", "warning");
        return;
      }

      ctx.ui.notify(statusLine(), "info");
    },
  });
}
