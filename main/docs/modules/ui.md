# ui 模块

目录：`main/modules/ui/`

| 文件 | 职责 |
| --- | --- |
| `index.html` / `style.css` | 桌宠渲染页 |
| `renderer.js` | 渲染进程源码：帧序、优先级仲裁、气泡、状态表情 |
| `engine.js` | Live2D 引擎封装（唯一直接碰引擎的地方） |
| `interact.js` | 鼠标手势、点击区域、输入胶囊 |
| `preload.cjs` | 主窗口 preload |
| `bubble.html` / `bubble-preload.cjs` | 气泡窗口（`focusable:false` + 忽略鼠标，只能显示文字） |
| `build/renderer.bundle.js` | esbuild 产物，页面实际加载的文件 |
| `assets/tray.png` | 托盘图标（由 `main/scripts/make-tray-icon.mjs` 生成） |

## 构建

```bash
cd main/deps
npm run build
```

`renderer.js` 里 import `../behavior/cues.mjs`，由 `/behavior/` 静态路由提供。Cubism Core 走 `/vendor/live2dcubismcore.min.js`。

改完渲染侧代码必须重新 build，否则页面加载的还是旧 bundle —— 这是「改了没生效」的头号原因。

## 动画分层与交接（1.0.0）

四层往同一批参数上写，**顺序即优先级**（`onBeforeUpdate` 内）：

```text
applyModelParams()   姿势绝对值 → cue/表情目标 → tweenParam 平滑写入
applyMotion()        动作关键帧：增量，加在当前值上
animRestore          原生动画播完：从当帧真值补间回基准
```

三条必须守住的不变量（1.0.0 动画审计后加的，改这块前先读）：

1. **动作残差要收回，不能丢弃。** `endMotion()` 把上一帧真实写入的增量登记成
   `motionRel`（170ms smoothstep 收 0）；下一段动作起手时两者**相加**，形成交叉过渡。
   旧行为是「曲线消失的那一帧增量归零」—— 一次 step 边界、一次动作顶替，肉眼就是闪一下。
2. **动作首帧从 `p=0` 起步。** `playMotion()` 在帧外调用，第一帧 `elapsed` 等于这一帧的 dt
   （抖到 40ms 时 240ms 的动作一上来就吃掉 17% 行程），所以第一次 `applyMotion` 才把
   `t0` 对齐到当前帧（`armed` 标记）。
3. **参数快照只能在帧内取。** `startAnimRestore` / `settleSwitch` 由 `setInterval` 与引擎
   回调触发，帧外 `stage.param.get` 读到的是引擎已还原的值（脱捕的 `Param11` 末值 8 会读成 0），
   于是「补间还原」退化成「下一帧直接跳」。所以它们只登记 `pending`，
   由 `resolveAnimRestore()` 在下一帧帧内解析。

自测：`/api/debug/frames`（调试 token）= 每帧 `dt` / `act` / `mx` / `arg` / `pose` / `expr` / `mot`。
`mx` 突然高出前后帧 5 倍就是一次跳变，`arg` 指出是哪个参数。人设作者的视角见
`main/persona/README.md` §4。
