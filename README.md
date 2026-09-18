# pi-smart-fold

[pi](https://github.com/earendil-works/pi-mono) coding-agent 插件：保持会话记录紧凑。

- **工具输出默认折叠** — 每次 `session_start`（启动 / `/reload` / `/new` / `/resume` / `/fork`）自动调用 `ctx.ui.setToolsExpanded(false)`，工具输出保持折叠，需要时用 `ctrl+o` 手动展开。
- **Thinking 折叠为单行、默认滚动显示最后一行** — 通过 pi 的 markdown transformer（`messageType: "assistant-thinking"`）把每个思考块折叠成一行，只显示**最后一行**内容；流式输出时该行随最新内容持续刷新，效果如同 `tail -f`。
  - 截断按**终端显示宽度**计算（中文/emoji 等宽字符占 2 列），超宽时保留行尾并加 `…` 前缀。
  - 折叠仅影响 TUI 显示，不改动会话文件与发送给模型的上下文。

## 使用

```text
/fold                  查看当前状态
/fold thinking on|off  开关 thinking 折叠（持久化到 smart-fold.config.json）
/fold tools on|off     开关启动时工具输出折叠（立即作用于当前会话，并持久化）
```

配置文件 `smart-fold.config.json`（位于插件目录，可手工编辑）：

```json
{
  "toolsFold": true,
  "thinkingFold": true
}
```

## 安装

任选其一：

```bash
# 方式 A：作为目录插件放入全局自动发现路径
git clone <this-repo> ~/.pi/agent/extensions/smart-fold

# 方式 B：通过 pi 包管理安装
pi install git:<repo-url>

# 方式 C：加入 settings.json
# ~/.pi/agent/settings.json → { "extensions": ["/path/to/pi-smart-fold"] }

# 临时测试
pi -e /path/to/pi-smart-fold/index.ts
```

> 插件无任何 npm 依赖，pi 通过 jiti 直接加载 TypeScript。

## 开发

```bash
npm test   # 纯函数单元测试（Node ≥ 22.18 原生 TS 类型剥离，无需构建）
```

结构：

```
index.ts          插件入口（事件 / transformer / /fold 命令）
lib/fold.ts       纯函数：显示宽度、行尾截断、思考折叠（无依赖、可单测）
lib/config.ts     配置读写（缺失/损坏时回退默认值）
test/fold.test.mjs 单元测试
```

## 兼容性

基于 pi `0.85.1` 的公开扩展 API（`registerMarkdownTransformer`、`ctx.ui.setToolsExpanded`、`registerCommand`）。
