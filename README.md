# pi-smart-fold

[pi](https://github.com/earendil-works/pi-mono) coding-agent 插件：保持会话记录紧凑，同时不丢失关键信息。

## 功能

### 1. Thinking 折叠 + 计时（`smart` 默认）

- **思考中**：首行显示加粗的 **`Thinking… (8s)`**，换行后滚动显示思考文本的**结尾**（如 `tail -f`）：

  ```text
  Thinking… (8s)
  …正在进行的思考最新一行
  ```

- **思考结束后**：完全折叠为一行加粗的 **`Thought for 12.4s`**。
- **点击展开/收起单个思考块**：点击折叠行（会短暂显示提示行）后再点一次 → **该块展开为完整思考全文**，底部保留加粗的 `Thought for 12.4s` 时长行（与斜体思考正文风格稍作区分）；同样的两击手势再把它收起。只影响被点击的块，同一消息里的其它思考块不受干扰。
- **完全接管原生折叠**：pi 内置的思考隐藏标签（`Thinking...`）被替换为本插件的提示文本（`Thought… · 再次点击展开 / 收起`），点击思考块时出现的也是我们的提示，而不是原生的 `Thinking...`。
- **点击识别是精确的**：通过对 pi 公开导出的 `AssistantMessageComponent` 打一个幂等的原型补丁，观测其内部可见性映射的点击写入（区分 ctrl+t 的清空操作），主题切换 / 窗口缩放 / 布局重绘等全局重渲染绝不会误判为点击；若未来版本无法安装补丁，点击展开自动降级为不可用（可用 `/fold expand` 兜底）。
- **时长持久化**：每段思考的时长按内容哈希记录进会话文件（`smart-fold-thinking` 自定义条目，不进入 LLM 上下文），`/resume` 恢复会话后依旧显示；同一条消息内多段思考（工具调用之间）分别计时。
- 截断按**终端显示宽度**计算（中文 / emoji 等宽字符占 2 列），超宽时保留行尾并加 `…` 前缀。
- 折叠仅影响 TUI 显示，不改动会话文件中的原文与发送给模型的上下文。

其它模式：`tail`（始终单行显示结尾 + 加粗时长前缀）、`full`（结束后直接显示全文，底部同样附时长行）、`off`（关闭，并恢复 pi 默认的思考显示）。

备用：`/fold expand on|off`（或设置面板中的"展开全部思考"）临时展开/折叠全部思考块 —— 日常操作直接点击单个思考块即可，新会话默认全部折叠。

### 2. 工具输出折叠

每次 `session_start`（启动 / `/reload` / `/new` / `/resume` / `/fork`）自动调用 `ctx.ui.setToolsExpanded(false)`，工具输出保持折叠，`ctrl+o` 手动展开。

### 3. Write 增删统计 + 完全折叠

- write 工具执行**前**读取原文件内容，与写入内容做行级 diff（公共前后缀裁剪 + LCS），在 `write <path>` 首行后追加 **绿色 `+新增` / 红色 `-删除`** 行数，如 `write src/index.ts +12 -3`；新文件显示 `+N -0`。
- 折叠的 write 行**只显示首行**（完全折叠），点击 / `ctrl+o` 展开后才显示带语法高亮的内容预览。
- 实现方式为对 pi 内置 write 工具的渲染包装（执行逻辑完全复用 `createWriteToolDefinition`），超大文件（>8MB）跳过统计。

## 设置界面

```
/fold        打开 /config 样式的选择式设置（Enter/Space 切换值，Esc 关闭）
```

也可带参数直接修改（含自动补全）：

```text
/fold thinking smart|tail|full|off   # on=smart, off=off 兼容旧写法
/fold tools on|off                   # 启动时是否折叠工具输出
/fold writestat on|off               # write 增删统计开关
/fold writecollapsed header|preview  # write 折叠时仅首行 / 保留预览
```

配置文件 `smart-fold.config.json`（位于插件目录，可手工编辑；旧的 `thinkingFold` 布尔值会自动迁移）：

```json
{
  "toolsFold": true,
  "thinking": "smart",
  "writeStat": true,
  "writeCollapsed": "header"
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
index.ts           插件入口（transformer / 事件 / write 渲染包装 / /fold 设置界面）
lib/fold.ts        纯函数：显示宽度、行尾截断、时长格式化、行级 diff
lib/thinking.ts    思考计时状态机（按内容哈希记录各段思考时长）
lib/config.ts      配置读写（含旧配置迁移；缺失/损坏时回退默认值）
test/fold.test.mjs 单元测试
```

## 已知边界

- 点击展开需要两次物理点击（折叠行 → 提示行 → 全文）：pi 的思考块在结构上只有"展开渲染 ↔ 隐藏标签"两态，第一次点击必然先切到隐藏态（显示本插件的提示文本），第二次点击才回到展开渲染 —— 这是 pi 公开 API 下能达到的最接近"点击即展开"的行为。
- 点击展开状态为运行时状态，新会话/重载后恢复折叠；窗口缩放不会收起你已展开的块。
- write 增删统计只对当前会话中的写入生效（恢复的旧会话没有执行前快照可对比）。
- 与 pi 原生 "Hide thinking blocks"（`ctrl+t` 切换）叠加时，若隐藏了思考块，思考中不会显示滚动行 —— 建议保持默认的显示状态，由本插件负责折叠。

## 兼容性

基于 pi `0.85.1` 的公开扩展 API（`registerMarkdownTransformer`、`ctx.ui.setToolsExpanded`、`createWriteToolDefinition`、`registerCommand`、`appendEntry`、`SettingsList`）。
