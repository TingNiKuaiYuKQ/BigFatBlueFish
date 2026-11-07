# pet-bridge（DSH 插件）

版本 1.0.0。宿主契约见 [docs/DSH-API.md](docs/DSH-API.md)。

## 结构

| 文件 | 说明 |
| --- | --- |
| `lib/index.js` | 插件主体：状态投影、3s 轮询、`pet` 工具、预设、投递确认 |
| `docs/DSH-API.md` | DSH 宿主契约（v4 消息形状、事件、工具） |
| `cordis.patch.yml` | 宿主补丁配置 |
| `data/` | 运行数据：`poll-state.json` / `session-titles.json` / `presets.json` |

## 开发与安装

从仓库根：

```bash
node plugins/install.mjs --apply
```

联合开发时，插件根目录下的 `pet-bridge` 是指向本目录的 junction，改代码即时生效。运行数据因此也落在本目录 `data/`。

## 排障

- 插件没加载：`~/.dsh/live2d/bridge-error.log`
- 桌宠没开：读 `~/.dsh/live2d/endpoint.json` 报错，属预期降级
- 状态不跟随：确认 `~/.dsh/live2d/status.json` 在更新
