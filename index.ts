/**
 * pi-smart-fold
 * =============
 * A pi (https://github.com/earendil-works/pi-mono) coding-agent extension that
 * keeps the transcript compact:
 *
 *   1. Thinking blocks:
 *      - While the model thinks, the block shows a bold `Thinking… (8s)`
 *        label line, then the scrolling tail of the thinking text below it.
 *      - Once the message finishes, the block collapses to a single bold
 *        `Thought for 12.4s` line.
 *      - Expansion is driven by ONE reliable switch: the `alt+t` shortcut
 *        (and /fold expand) toggles every finished thinking block between
 *        collapsed and full text (with the duration footer at the bottom).
 *        Clicking a collapsed block only toggles pi's internal hidden state;
 *        the extension owns that state's label text, so the native
 *        "Thinking..." never appears — it shows our own hint instead.
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
 *   alt+t                          expand / collapse all finished thinking
 *   /fold                          open the /config-style settings list
 *   /fold thinking smart|tail|full|off
 *   /fold expand on|off
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
import { createWriteToolDefinition, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
import type { Component, SettingItem } from "@earendil-works/pi-tui";

import {
  countLineDiff,
  displayWidth,
  expandedThinkingSuffix,
  foldedThinkingLine,
  hashText,
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
/** Shortcut that toggles all finished thinking blocks (collapsed ↔ full). */
const EXPAND_SHORTCUT = "alt+t";

export default function smartFold(pi: ExtensionAPI): void {
  const extensionDir = resolveExtensionDir();
  const config: SmartFoldConfig = extensionDir
    ? loadConfig(extensionDir)
    : { ...defaultConfig };

  const persist = (): void => {
    if (extensionDir) saveConfig(extensionDir, config);
  };

  // Runtime state -----------------------------------------------------------

  /** Thinking-run timing (live elapsed + finalized durations by content hash). */
  const tracker = new ThinkingTracker();

  /**
   * Runtime switch for the alt+t toggle: when true, every finished thinking
   * block renders its full text (with duration footer) instead of the folded
   * `Thought for …` line. Deliberately not persisted — sessions start compact.
   */
  let expandAllThinking = false;

  /**
   * Text shown by pi's internal hidden-thinking state. We own it so the
   * native "Thinking..." label never appears anywhere (click toggles and the
   * built-in ctrl+t alike show our hint instead).
   */
  const hiddenThinkingLabelText = (): string | undefined => {
    if (config.thinking === "off") return undefined; // restore pi's default
    return expandAllThinking
      ? `Thought… · 按 ${EXPAND_SHORTCUT} 折叠全部思考`
      : `Thought… · 按 ${EXPAND_SHORTCUT} 展开全部思考`;
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
  const writeRows = new Map<string, WriteCallWrapper>();

  // -------------------------------------------------------------------------
  // 1) Thinking: live tail while streaming, folded line with duration after.
  // -------------------------------------------------------------------------
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "assistant-thinking") return markdown;
    const mode = config.thinking;
    if (mode === "off") return markdown;

    const width = context.availableWidth - 1; // renderer padding slack
    const key = hashText(markdown);

    if (context.isStreaming) {
      // Earlier thinking groups in the same (still streaming) message are
      // already finished — show them in their folded, finalized form.
      const done = tracker.finalizedMs(key);
      if (done !== undefined) {
        return foldedThinkingLine(markdown, done, width, "smart");
      }
      return liveThinkingLine(markdown, tracker.liveElapsedMs(), width);
    }

    let ms = tracker.finalizedMs(key);
    if (ms === undefined) ms = tracker.finalizeIfMatches(markdown);

    if (mode === "full" || expandAllThinking) {
      // Fully expanded: original text, with the duration footer at the bottom.
      return markdown.replace(/\s+$/, "") + expandedThinkingSuffix(ms);
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
    if (runs.length > 0) {
      try {
        pi.appendEntry("smart-fold-thinking", { runs });
      } catch {
        // Persistence is best-effort; display still works in-session.
      }
    }
  });

  const restoreFromBranch = (ctx: CtxLike): void => {
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== "smart-fold-thinking") continue;
        const data = entry.data as { runs?: Array<{ hash?: unknown; ms?: unknown }> } | undefined;
        if (!Array.isArray(data?.runs)) continue;
        tracker.restore(
          data.runs.filter(
            (run): run is { hash: string; ms: number } =>
              typeof run?.hash === "string" && typeof run?.ms === "number",
          ),
        );
      }
    } catch {
      // Best-effort restore.
    }
    writeStats.clear();
    writeRows.clear();
  };

  // -------------------------------------------------------------------------
  // 2) Tool output: collapse on session start.
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    const scoped = ctx as unknown as CtxLike;
    restoreFromBranch(scoped);
    expandAllThinking = false; // sessions start compact
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
  // 3) write tool: `+N -M` diff stats + fully collapsed rows.
  // -------------------------------------------------------------------------
  class WriteCallWrapper implements Component {
    inner: Component;
    readonly toolCallId: string;
    expanded = false;
    theme: ThemeLike | undefined;
    invalidateRef: (() => void) | undefined;

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
      const collapsed = !this.expanded;
      const out =
        collapsed && config.writeCollapsed === "header" ? [lines[0]] : lines.slice();
      const stat = config.writeStat ? writeStats.get(this.toolCallId) : undefined;
      if (stat && this.theme) {
        const suffix =
          ` ${this.theme.fg("success", `+${stat.added}`)}` +
          ` ${this.theme.fg("error", `-${stat.removed}`)}`;
        if (displayWidth(lines[0]) + displayWidth(suffix) <= width) {
          out[0] = lines[0] + suffix;
        } else {
          out.splice(1, 0, suffix.trim());
        }
      }
      return out;
    }
  }

  // pi's own write tool implementation — only the rendering is wrapped.
  const baseWrite = createWriteToolDefinition(process.cwd());

  pi.registerTool({
    ...baseWrite,
    renderCall(
      args: unknown,
      theme: ThemeLike,
      context: ToolRenderContextLike,
    ): Component {
      let wrapper =
        context.lastComponent instanceof WriteCallWrapper
          ? (context.lastComponent as WriteCallWrapper)
          : undefined;
      const inner = (baseWrite.renderCall as (
        a: unknown,
        t: ThemeLike,
        c: ToolRenderContextLike,
      ) => Component)(args, theme, { ...context, lastComponent: wrapper?.inner });
      if (!wrapper) {
        wrapper = new WriteCallWrapper(String(context.toolCallId ?? ""), inner);
      } else {
        wrapper.inner = inner;
      }
      wrapper.theme = theme;
      wrapper.expanded = Boolean(context.expanded);
      wrapper.invalidateRef = context.invalidate;
      if (wrapper.toolCallId) writeRows.set(wrapper.toolCallId, wrapper);
      return wrapper;
    },
  });

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

  // -------------------------------------------------------------------------
  // 4) alt+t — expand / collapse all finished thinking blocks.
  // -------------------------------------------------------------------------
  const applyExpandAll = (on: boolean, ctx: CtxLike): void => {
    if (expandAllThinking === on) return;
    expandAllThinking = on;
    applyHiddenLabel(ctx); // also re-renders every message through the transformer
  };

  pi.registerShortcut(EXPAND_SHORTCUT, {
    description: "smart-fold: 展开/折叠全部已完成的思考",
    handler: async (ctx) => {
      applyExpandAll(!expandAllThinking, ctx as unknown as CtxLike);
    },
  });

  // -------------------------------------------------------------------------
  // 5) /fold — /config-style settings list.
  // -------------------------------------------------------------------------
  const applyThinking = (mode: ThinkingMode, ctx: CtxLike): void => {
    config.thinking = mode;
    persist();
    applyHiddenLabel(ctx);
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
    `smart-fold — thinking: ${config.thinking} · 思考展开: ${
      expandAllThinking ? "开" : "关"
    } · 工具输出: ${config.toolsFold ? "启动时折叠" : "启动时展开"} · write统计: ${
      config.writeStat ? "开" : "关"
    } · write折叠: ${config.writeCollapsed === "header" ? "仅首行" : "保留预览"}`;

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
            "smart: 思考中显示 Thinking…(时长)+滚动结尾；结束后折叠为 Thought for 时长",
        },
        {
          id: "expand",
          label: "展开全部思考",
          currentValue: expandAllThinking ? "on" : "off",
          values: ["on", "off"],
          description: `等同于 ${EXPAND_SHORTCUT} 快捷键：临时展开/折叠全部已完成的思考（不持久化）`,
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
          label: "Write 增删统计",
          currentValue: config.writeStat ? "on" : "off",
          values: ["on", "off"],
          description: "write 首行追加绿色 +新增 / 红色 -删除 行数（与写入前内容对比）",
        },
        {
          id: "writeCollapsed",
          label: "Write 折叠样式",
          currentValue: config.writeCollapsed,
          values: ["header", "preview"],
          description: "header: 折叠时只显示首行；preview: 保留内容预览（pi 默认）",
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
          ctx.ui.notify(`用法: /fold expand on|off（或按 ${EXPAND_SHORTCUT}）`, "warning");
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

      if (target === "writestat" || target === "write-stat") {
        if (value !== "on" && value !== "off") {
          ctx.ui.notify("用法: /fold writestat on|off", "warning");
          return;
        }
        applyWriteStat(value === "on");
        ctx.ui.notify(`write 增删统计: ${value === "on" ? "开" : "关"} — 已保存`, "info");
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
