# 快捷指令写法示例

> 这份文档配合 `main/config/commands.json` 用。仓库自带的默认值是 4 条**通用示例**
> （记事本 / 列下载目录 / 取当前时间 / 开临时文件夹），可以直接改成你自己要的。
>
> 也可以完全不动 JSON：设置 → 指令 → ＋ 新建，界面上的字段和下面这张表一一对应。

---

## 1. 五种 type 各一条

`type` 决定「怎么启动」（`main/modules/commands/commands.mjs` 的 `buildSpawn()`）：

| type | 实际启动的东西 | 备注 |
| --- | --- | --- |
| `exe` | `cmd` 字段直接当可执行文件，`args` 逐项传 | 只适合普通 Win32 程序；商店版/文件夹见 §4 |
| `cmd` | `cmd.exe /d /s /c <cmd> <args...>` | `%VAR%` 会被展开；`cmd` 字段只能是一个 token（内置命令或 exe 名） |
| `powershell` | `powershell.exe -NoProfile -File <cmd> <args...>` | `exec` 模式下 `cmd` 必须是**真实 .ps1 的绝对路径**；想直接写一行命令就配 `mode:"shell"`（见下） |
| `bat` | `cmd.exe /d /c <cmd> <args...>` | `cmd` 是 .bat / .cmd 的绝对路径 |
| `shortcut` | 用 Electron 的 `shell.openPath(cmd)` 交给系统打开 | 文件夹 / .lnk / 商店版程序 / 任意文件都行；会展开 `%VAR%`；只能在桌宠进程里跑 |

### exe · 打开控制面板

```json
{
  "id": "open_control",
  "label": "打开控制面板",
  "type": "exe",
  "cmd": "control.exe",
  "args": [],
  "cwd": null,
  "mode": "exec",
  "capture": false,
  "visible": true,
  "timeoutMs": 30000,
  "allowArgs": false
}
```

`visible: true` 才会显示窗口；GUI 程序**不要**开 `capture`（它不会退出，等不到输出）。
不开 `capture` 的指令有 1.2 秒观察窗：那一刻还活着就算启动成功、立刻返回，不会卡到超时。

### cmd · 列出下载文件夹

```json
{
  "id": "list_downloads",
  "label": "列出下载文件夹",
  "type": "cmd",
  "cmd": "dir",
  "args": ["%USERPROFILE%\\Downloads"],
  "cwd": null,
  "mode": "exec",
  "capture": true,
  "visible": false,
  "timeoutMs": 30000,
  "allowArgs": false
}
```

`%USERPROFILE%` / `%TEMP%` 这类变量在 `cmd` / `bat` 类型下由 cmd.exe 自己展开，
所以换台机器也能用。路径里有空格时给参数自己加引号：`"\"%USERPROFILE%\\My Documents\""`。

### powershell · 现在几点（shell 模式）

```json
{
  "id": "current_time",
  "label": "现在几点",
  "type": "powershell",
  "cmd": "powershell -NoProfile -Command \"Get-Date -Format 'yyyy-MM-dd HH:mm:ss'\"",
  "args": [],
  "cwd": null,
  "mode": "shell",
  "capture": true,
  "visible": false,
  "timeoutMs": 30000,
  "allowArgs": false
}
```

**为什么要 `mode: "shell"`**：`powershell` 类型的 `exec` 是 `-File <脚本路径>`，必须指向真实的
`.ps1` 文件，没法直接在 JSON 里写一句话。`shell` 模式把 `cmd` 整串交给 shell，
一行命令就能跑 —— 代价是 `shell` 模式**不接受任何运行时参数**（`allowArgs` 会被强制 false）。

如果你更喜欢 .ps1 文件：

```json
{
  "id": "ps_script",
  "label": "跑我的脚本",
  "type": "powershell",
  "cmd": "D:\\tools\\hello.ps1",
  "args": ["-Name", "world"],
  "mode": "exec",
  "capture": true,
  "visible": false,
  "timeoutMs": 60000,
  "allowArgs": false
}
```

### bat · 跑一个批处理

```json
{
  "id": "run_backup",
  "label": "跑备份脚本",
  "type": "bat",
  "cmd": "D:\\tools\\backup.bat",
  "args": ["daily"],
  "cwd": "D:\\tools",
  "mode": "exec",
  "capture": true,
  "visible": false,
  "timeoutMs": 300000,
  "allowArgs": false
}
```

### shortcut · 打开临时文件夹（也能打开 .lnk / 任意文件）

```json
{
  "id": "open_temp",
  "label": "打开临时文件夹",
  "type": "shortcut",
  "cmd": "%TEMP%",
  "args": [],
  "mode": "exec",
  "capture": false,
  "visible": false,
  "timeoutMs": 30000,
  "allowArgs": false
}
```

`shortcut` 忽略 `args` / `mode`，只把 `cmd` 交给系统 shell「打开」（`shell.openPath`）。
它会展开 `%VAR%`，所以 `%TEMP%`、`%USERPROFILE%\Downloads` 这类写法换台机器也能用。
它只能由桌宠进程执行，从别的进程调会直接报错。

---

## 2. 字段速查

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `id` | 字母/数字/`_`/`-`，≤40 | 唯一。菜单、模型、审计日志都按它引用，改了等于换一条 |
| `label` | 任意文本 | 菜单里显示的名字 |
| `type` | `exe` / `cmd` / `powershell` / `bat` / `shortcut` | 见上表 |
| `cmd` | 字符串 | exe 名或绝对路径；`cmd` / `powershell` / `bat` 的 `mode:"shell"` 时是整串命令 |
| `args` | 字符串数组 | **逐项传，不拼 shell 字符串**，这是防注入的关键 |
| `cwd` | 绝对路径 / `null` | `null` = 仓库根 `main/` |
| `mode` | `exec` / `shell` | 默认 `exec`；`shell` 只能用于 `cmd` / `powershell` / `bat`，且禁止附加参数 |
| `capture` | 布尔 | 捕获 stdout/stderr 并等退出码；查询类开，GUI 程序不要开 |
| `visible` | 布尔 | 是否显示控制台窗口（`windowsHide`） |
| `timeoutMs` | 1000–600000 | 超时杀子进程 |
| `allowArgs` | 布尔 | 是否允许调用方追加 argv（模型只能用 `allowArgs:true` 的指令带参数） |

约束：一个库最多 **20 条**；`id` 不能重复；写盘走「临时文件 + rename」并留 `.bak`。

---

## 3. 三条容易踩的坑

1. **`%VAR%` 只在 `cmd` / `bat` 里展开**。`exe` 类型走的是直接 spawn，`"%USERPROFILE%\\x"`
   会原样当成路径 —— 要么改用 `cmd` 类型，要么在 Node 侧先展开（本仓库没有做这件事）。
2. **`powershell` 想写一行命令就用 `mode:"shell"`**。`exec` 模式的 `-File` 只认真实 `.ps1`，
   写一句话会得到「文件不存在」。
3. **不要把密码、token 写进参数**。指令库是明文 JSON，还会进审计日志
   （`main/runtime/audit/commands-audit.jsonl`）。

---

## 4. 为什么有的程序点了没反应（0xC0000142 / 0xC0000409）

实测（Windows 11，2026-11）：**从桌宠（Electron 主进程）直接 CreateProcess 启动下面两类程序会失败**，
换 `type:"shortcut"` 立刻就好：

| 程序 | 直连 `exe` / `cmd` 的结果 | 原因 |
| --- | --- | --- |
| `explorer.exe`（打开文件夹） | `0xC0000142` DLL 初始化失败 | 它是 autoElevate 程序；Electron/Chromium 会把自己放进 Job 对象，提权启动这条路走不通 |
| `taskmgr.exe` | 同上 | 同上 |
| `notepad.exe`、`mspaint.exe` 等**商店版**（WindowsApps） | `0xC0000409` 启动后立即崩溃 | 应用包（MSIX）激活要 shell 参与，直连拿不到包标识 |

**规则**：打开「文件夹 / 商店版程序 / .lnk / 已有文件」一律用 `type:"shortcut"`；
`exe` 类型留给普通 Win32 程序（`control.exe`、`winver.exe` 这类）。

其余退出码（`main/modules/commands/commands.mjs: explainExitCode()`）：

| 退出码 | 含义 |
| --- | --- |
| `0xC0000142` | 程序拒绝启动（DLL 初始化失败）—— 多半是提权程序，改用 `shortcut` |
| `0xC0000409` | 启动后立即崩溃 —— 多半是商店版程序，改用 `shortcut` |
| `0xC0000135` | 缺少依赖 DLL |
| `0xC0000005` | 访问冲突（程序自己崩了） |

不开 `capture` 的指令只要在 1.2 秒内没退出就算成功；**退出码 ≥ 0xC0000000 一律当失败**，
桌宠会以「⚠ 执行失败：…」冒出气泡 —— 不再出现「点了完全没反应」。
