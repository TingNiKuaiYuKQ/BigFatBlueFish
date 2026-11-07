# 插件侧文件

| 目录/文件 | 说明 |
| --- | --- |
| `install.mjs` | 把 `dsh/` 挂进 DSH desktop profile（目录联接） |
| `dsh/` | 已实现的 `pet-bridge` 插件（lib / docs / data） |
| `workbuddy/` | 空实现占位 |
| `qodercn/` | 空实现占位 |

## 安装

```bash
node plugins/install.mjs          # 预览
node plugins/install.mjs --apply  # 落盘
```

然后按提示在 profile 目录 `pnpm install`，重启 DSH。

## 运行数据

**跟随插件安装位置**，不放进 `main/runtime/`：

- 开发时：`plugins/dsh/data/`
- 安装后：插件根目录下的 `pet-bridge\data\`（联接指向同一目录；根目录默认 `%LOCALAPPDATA%\BigFatBlueFish\Plugin`，可用 `PET_PLUGIN_ROOT` 覆盖）

这样插件脱离仓库也能独立工作，卸载插件时数据一起走。
