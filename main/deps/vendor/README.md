# vendor

- `live2dcubismcore.min.js`：Live2D Cubism Core，浏览器通过 `/vendor/live2dcubismcore.min.js` 加载。版本与许可以 Cubism SDK 发布说明为准，升级时直接替换本文件。
- 其它第三方依赖（pixi.js / untitled-pixi-live2d-engine / electron / esbuild）在上级 `node_modules/`，由 `package.json` 管理。
- `renderer.bundle.js` 不是 vendor：它是 `modules/ui/build/` 里的构建产物。
