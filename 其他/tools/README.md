# 工具

| 文件 | 说明 |
| --- | --- |
| `readlog.mjs` | 读/过滤运行日志的小工具 |
| `probes/` | 0.5.x 技术探针（Electron 探针、像素采样、全屏观察器、快捷方式参数长度等） |

> `probes/` 是**历史探针**：内部的 Electron / bridge 路径写死在迁移前的布局（`pet/stage`、`pet/bridge`），
> 0.6.0 后没有跟随更新。复用时先把路径改到 `main/deps` 与 `plugins/dsh`。
> 探针结论已并入 `main/docs/technical.md` 与 `其他/notes/plans/v0.5-plan.md`。
