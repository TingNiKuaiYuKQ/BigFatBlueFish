# tutorial 模块

目录：`main/modules/tutorial/`

- `tutorial.html` / `tutorial-preload.cjs`：独立不透明窗口，能读、能拉大
- 内容唯一来源：`main/docs/tutorial.md`（窗口通过 `/api/tutorial` 取）

## 首次引导

- 状态文件：`main/runtime/app/tutorial-state.json`（`seen` / `step` / `version`）
- 首次启动 4s 后自动打开；关窗即视为已读
- 菜单入口：做点什么…… → 其他 → 使用教程 / 重置引导
- 启动参数：`--tutorial` 强制打开，`--no-tutorial` 静默

改教程内容只改 Markdown，不用动窗口代码。

## 渲染能力（1.0.0）

`mdToHtml()` 是手写迷你 Markdown，支持的语法：

- **块级**：`#`/`##`/`###`、无序/有序列表、代码块（```）、引用（`>`）、**表格**、独占一行的图片、**原始 HTML 块**
- **行内**：`` `code` ``、`**粗体**`、`[文字](链接)`

两条扩展是为了「样式不够用」时不必换框架：

1. **表格**：`| a | b |` 后面紧跟 `|---|---|` 分隔行即可，否则当普通段落（正文里的竖线不会被误判）。
   窄窗时整表横向滚动，不撑破正文。
2. **原始 HTML 块**：某一行以 `<` 开头就整段直通，直到空行为止。可以拿来写 `<details>`、
   `<kbd>`、并排图文等 md 表达不了的版式。**md 仍是主源，HTML 是逃生门**，两种写法可以混排。
   内容只在本机窗口渲染、由本仓库作者维护，因此不做消毒（不要往教程里粘外部来源的 HTML）。

图片：

- 写法 `![说明](images/xx.png)`，独占一行才解析；`说明` 渲染成 `<figcaption>`。
- 地址归一：文档里写 `images/xx.svg`，`imgSrc()` 自动改写成 `/docs/images/xx.svg`
  —— 窗口在 `/tutorial/` 下，直接相对解析会跑到 `/tutorial/images/`（404）。
- 服务端把 `main/docs/images` 挂成只读静态目录（`/docs/images/*`），边界由 `safeJoin()` 收口，
  `../` 与 `%2e%2e` 都会被折叠掉、越界返回 404。
- 素材规矩见 `main/docs/images/README.md`（示意图入仓，真机截图做视频时补）。


