# core 模块

目录：`main/modules/core/`

| 文件 | 职责 |
| --- | --- |
| `main.cjs` | Electron 主进程：单实例锁、窗口、托盘、设置/菜单/教程/气泡窗口、IPC、日志、快捷方式（目标 `wscript.exe` + 生成的 `main/launcher.vbs`） |
| `server.mjs` | 本地 HTTP 服务：静态托管 + `/api/*`（token 鉴权）+ endpoint 握手 |
| `paths.cjs` | 唯一路径契约（CJS；ESM 用默认导入） |

## 路径契约

所有路径从 `paths.cjs` 取，不要在别的文件里用 `../..` 猜层级：

```js
const paths = require('./paths.cjs')
paths.MAIN_ROOT      // main/
paths.MODULES_DIR    // main/modules
paths.RUNTIME_APP    // main/runtime/app
paths.NODE_MODULES   // main/deps/node_modules
paths.TUTORIAL_FILE  // main/docs/tutorial.md
```

握手常量（`paths.DIR/STATUS/ENDPOINT/SHORTCUTS`）与插件侧 `plugins/dsh/lib/index.js` 必须同步。

## 静态路由

| URL | 目录 |
| --- | --- |
| `/` | `modules/ui/index.html` |
| `/ui/` | `modules/ui/` |
| `/menu/` `/settings/` `/tutorial/` `/behavior/` | 对应模块目录 |
| `/node_modules/` | `deps/node_modules/` |
| `/vendor/` | `deps/vendor/` |
| `/model/` | `model/runtime/` |

## 运行数据

- `runtime/app/`：settings / window / pet-events / tutorial-state / presets-user / endpoint 镜像
- `runtime/audit/`：指令审计
- `runtime/logs/`：run / launch / crash / shortcut-helper / install-agent；调试截图也在这里
- `runtime/chromium/`：Chromium user-data-dir

`main.cjs` 0.6.0 只搬家、不拆函数；后续 0.6.x 再按 window/tray/menu 拆。
