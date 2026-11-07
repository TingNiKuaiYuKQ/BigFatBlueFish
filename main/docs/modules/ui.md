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
