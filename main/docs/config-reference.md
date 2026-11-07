# 配置字段说明

## `main/config/config.json`

人手上手改的设计参数；改完重启桌宠生效。以 `_` 开头的键都是注释，程序忽略。

| 段 | 关键字段 | 说明 |
| --- | --- | --- |
| 顶层 | `serverPort` | 首选端口，从它开始试 10 个；实际端口以 `~/.dsh/live2d/endpoint.json` 为准。`0` = 随机 |
| 顶层 | `persona` | `main/persona/` 下的人设目录名 |
| `driver` | `enabled` / `stateFile` / `endpointFile` | 驾驶员通道；`enabled:false` = 纯独立桌宠，不读写任何外部文件 |
| `window` | `width` / `height` / `dpiScale` | 逻辑尺寸 × DPI = 物理像素；系统缩放 175% 就填 `1.75`（设置→外观里调 UI 缩放会写回这个值） |
| `window` | `alwaysOnTop` / `skipTaskbar` / `clickThrough` / `opacity` | 窗口行为 |
| `perf` | `fpsCap` / `textureMax` / `resolution` / `minimal` | 帧率、贴图压缩上限、渲染倍率、极简模式 |
| `model` | `dir` / `file` | `dir` 相对 `main/` 解析，默认 `model/runtime` |
| `poses` | 姿势名 → 参数表 | 切换姿势时 260ms 补间 |
| `stateMap` | 会话状态 → 表情/姿势 | `thinking` / `working` / `waiting` / `success` / `error` / `result` / `idle` |
| `idle` | `breath` / `sway` / `blink` / `gaze` / `headGain` | 引擎自带的待机动画 |
| `interact` | `longPressMs` / `sweepMs` / `regions` / `menu` | 右键手势、点击区域、菜单树 |
| `bubble` | `maxChars` / `defaultMs` / `fontSize` | 气泡 |
| `behavior` | `enabled` / `gazeMinMs` / `smallMin` / `smallMotions` | 行为状态机 |
| `motions` | 动作名 → `{ms, tracks}` | 关键帧动作；轨道的值是「加法增量」 |

`interact.menu` 里 `source: "faces"` / `"commands"` 是运行时填充的分类，不要在配置里写死表情或指令。

## `main/config/commands.json`

```json
{
  "version": 1,
  "groups": [
    {
      "id": "builtin",
      "label": "内置",
      "items": [
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
      ]
    }
  ]
}
```

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `type` | `cmd` / `powershell` / `bat` / `shortcut` / `exe` | 决定怎么 spawn |
| `mode` | `exec` / `shell` | `exec` 按 argv 传参（默认）；`shell` 是作者写死的整串，禁止附加参数 |
| `capture` | 布尔 | 捕获 stdout/stderr 回给调用方；GUI 程序不要开 |
| `visible` | 布尔 | 是否显示控制台窗口 |
| `allowArgs` | 布尔 | 是否允许驾驶员/调用方追加 argv（`shell` 模式强制 false） |
| `cwd` | 绝对路径或 `null` | `null` = 仓库根 `main/` |
| `timeoutMs` | 1000..600000 | 超时后杀子进程 |

限制：最多 20 条；`id` 只能字母/数字/下划线/短横线；写入走临时文件 + rename，并留 `.bak`。
审计写入 `main/runtime/audit/commands-audit.jsonl`。

> 默认值只放**通用示例**（控制面板 / 开临时文件夹 / 列目录 / 取时间），不放任何人的私有路径。
> 五种 type 各一条完整模板见 `main/docs/commands-examples.md`；`commands.json` 被删掉时会自动重建为空表，不会崩。
>
> 0.5 之前的 `shortcuts.legacy.json` 已在 0.6.x 删除 —— 它带的是作者本机路径，没有迁移价值。

## 运行时文件（`main/runtime/`）

| 文件 | 内容 |
| --- | --- |
| `app/settings.json` | 设置页偏好（主题/缩放/主动说话/频率/绑定会话/帧率/自动省电） |
| `app/window.json` | 上次窗口位置与尺寸 |
| `app/pet-events.json` | 上报给驾驶员的事件 outbox（最近 24 条） |
| `app/tutorial-state.json` | 教程是否已读、当前步骤 |
| `app/presets-user.json` | 用户对演出预设的增删改 |
| `app/endpoint.json` | 握手镜像（node 启动器复制到 `~/.dsh/live2d/`） |
| `audit/commands-audit.jsonl` | 指令执行审计 |
| `logs/` | run / launch / crash / shortcut-helper / install-agent 日志与调试截图 |
| `chromium/` | Chromium 的 `--user-data-dir`，可随时删除重建 |
