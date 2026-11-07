# 离线测试

```bash
node 其他/tests/run-all.mjs
```

| 套件 | 测什么 | 依赖 |
| --- | --- | --- |
| `syntax.test.mjs` | 页面内联脚本 + 主体/插件脚本可解析 | 无 |
| `menu.test.mjs` | 菜单纯函数（归一化/填充/行数/状态文案） | `main/modules/menu/menu.mjs` |
| `sequence.test.mjs` | 序列编排与派发 | `main/modules/behavior/sequence.mjs` |
| `projection.test.mjs` | 插件状态投影 + 会话标题 | `plugins/dsh/lib/index.js`（沙箱内运行） |
| `delivery.test.mjs` | 投递确认链路（假舞台 HTTP + 假 agent） | 同上 |

全部离线，不需要 DSH 或 Electron。`fake-stage.mjs` 是不开窗的协议联调舞台：

```bash
node 其他/tests/fake-stage.mjs
```
