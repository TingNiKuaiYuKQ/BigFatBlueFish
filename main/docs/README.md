# 文档索引

> 1.0.0 目录结构：`main/` 主体、`plugins/` 插件。所有运行路径以 `main/modules/core/paths.cjs` 为准。

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [technical.md](technical.md) | 维护者 | 完整技术事实：进程/协议/启动链/渲染/交互/省电/测试 |
| [design-notes.md](design-notes.md) | 维护者 | 0.6.0 前的设计长文与踩坑记录（路径为旧布局） |
| [ui-design.md](ui-design.md) | 设计者 / 前端 | 视觉与交互设计语言（不含代码实现） |
| [tutorial.md](tutorial.md) | 用户 | 教程窗口的唯一内容源（重写为可发布手册） |
| [install-agent.md](install-agent.md) | 用户 / 自动化助手 | 让 AI 助手装：每步带成功信号与失败处理 |
| [commands-examples.md](commands-examples.md) | 用户 | 五种快捷指令类型的完整 JSON 模板 |
| [images/](images/README.md) | 用户 / 维护者 | 教程配图与截图清单 |
| [media/](media/) | 用户 | 演示 GIF（README 首屏用）；成片 mp4 在仓库根目录 |
| [persona-guide.md](persona-guide.md) | 人设作者 | 人设卡与行为规划怎么写 |
| [config-reference.md](config-reference.md) | 维护者 | `config.json` / `commands.json` 字段说明 |
| [dsh-api.md](dsh-api.md) | 插件开发者 | DSH 宿主契约的入口索引 |
| [modules/core.md](modules/core.md) | 维护者 | 入口、窗口、服务、IPC、路径契约 |
| [modules/ui.md](modules/ui.md) | 维护者 | renderer / engine / interact / 气泡 |
| [modules/menu.md](modules/menu.md) | 维护者 | 菜单树、三级、滚动、收场 |
| [modules/settings.md](modules/settings.md) | 维护者 | 设置页与设置存储 |
| [modules/behavior.md](modules/behavior.md) | 维护者 | 行为状态机、cues、sequence、人设 |
| [modules/commands.md](modules/commands.md) | 维护者 | 指令执行器、校验、审计、驾驶员接口 |
| [modules/low-power.md](modules/low-power.md) | 维护者 | 省电模式与全屏观察器 |
| [modules/tutorial.md](modules/tutorial.md) | 维护者 | 教程窗口与首次引导 |

## 构建渲染包

```bash
cd main/deps
npm run build
```

产物：`main/modules/ui/build/renderer.bundle.js`（随仓库保留，保证拷过去就能跑）。
