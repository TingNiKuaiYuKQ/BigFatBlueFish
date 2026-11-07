# 让 AI 助手帮你装（Agent 安装流程）

> 面向自动化助手，人不用逐条读。所有命令默认在**仓库根目录**执行；路径加引号；不需要管理员权限。
> **一次只做一步**，检查「成功信号」再继续；失败就停在原地并报告，不要连续猜。
> 建议把每步结果追加到 `main/runtime/logs/install-agent.log`，并在
> `main/runtime/app/install-state.json` 记录 `{step, ok, at, detail}`，让下一个 agent 能续跑。

| # | 步骤 | 命令 | 成功信号 | 失败处理 |
| --- | --- | --- | --- | --- |
| 0 | 前置检查 | `node -v`；`Test-Path main/config/config.json`；`Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\package.json"` | Node ≥ 22；配置文件存在；DSH profile 存在（不接 DSH 可跳过这条） | 缺 Node 就停并报告，不自动装系统组件 |
| 1 | 安装依赖 | `npm --prefix main/deps ci`（无 lock 时 `npm --prefix main/deps install`） | `main/deps/node_modules/electron/dist/electron.exe` 与 `pixi.js` 存在 | 停；检查网络/registry；不要手动拷 node_modules |
| 2 | 构建渲染包 | `npm --prefix main/deps run build` | `main/modules/ui/build/renderer.bundle.js` 存在且大于 1 MB | 停；检查 esbuild；不要把旧 bundle 当成功 |
| 3 | 放模型 | 按 `main/model/README.md` 把模型放进 `main/model/runtime/` | 该目录下直接有 `*.model3.json` | 没有模型时舞台会弹引导窗，不要绕过 |
| 4 | 首次启动（控制台） | `cmd /c start.cmd` | `main/runtime/app/endpoint.json` 与 `~/.dsh/live2d/endpoint.json` 出现且端口一致；`GET /api/health` 返回 `ok:true` | 读 `main/runtime/logs/launch.log`；停 |
| 5 | 生成快捷方式 | `cmd /c start.cmd install` | 根 `launcher.lnk`、桌面/开始菜单快捷方式存在；读回目标为 `C:\Windows\System32\wscript.exe`，参数指向 `main/launcher.vbs` 且 ≤259 字符 | 读 `main/runtime/logs/shortcut-helper.log`；停 |
| 6 | 安装 DSH 插件（可选） | `node plugins/install.mjs --apply`；按提示在 profile 目录 `pnpm install`；**询问用户后**重启 DSH | `<插件根目录>/pet-bridge` 指向 `plugins/dsh`（根目录默认 `%LOCALAPPDATA%\BigFatBlueFish\Plugin`）；profile 的 `dependencies` 有 `pet-bridge`；重启后 `~/.dsh/live2d/status.json` 出现 | 读 `~/.dsh/live2d/bridge-error.log`；不要删 DSH sessions |
| 7 | 人工验收 | 双击 `launcher.lnk`；打开菜单/设置/教程；跑一条指令；开省电模式 | 无黑框；托盘在；五个功能可用；无 404 | 停；读 `main/runtime/logs/` |
| 8 | 回滚 | 停桌宠/DSH；删掉本次新建的 `main/runtime/`、`launcher.lnk`、插件 junction | 删干净后重新从第 1 步开始 | 保留用户数据；删除只走回收站 |

## Agent 行为约束

- 一次只做一步；检查退出码与成功信号，失败就停。
- 不管理员运行；不杀 DSH/桌宠进程；重启 DSH 前先问用户。
- 不碰 `~/.dsh/sessions`；不删用户文件；删除只走回收站。
- 不手改 `main/model/source/` 与 `main/persona/` 内容，除非任务明确要求。
- 命令与路径加引号；中文路径用 PowerShell / Git Bash，不用 cmd 批处理。
- 不把 token 写进文档；端口/token 从 `main/runtime/app/endpoint.json` 读。
- 每步把命令与结果追加到 `main/runtime/logs/install-agent.log`。

## 装完之后

- 想知道每个功能怎么用：`main/docs/tutorial.md`（应用内「使用教程」渲染的就是它）。
- 想换人设 / 换模型 / 改配色：同上的第 8 节。
- 出了问题先看 `main/runtime/logs/`，对照教程第 9 节「排障」。
