# menu 模块

目录：`main/modules/menu/`

- `menu.html`：胶囊菜单页面（独立透明窗口）
- `menu-preload.cjs`
- `menu.mjs`：纯函数（归一化、动态填充、状态文案、行数计算），可离线测试

## 规则

- 菜单树来自 `config.interact.menu`，`normalizeMenu()` 兼容旧的扁平 `level:2` 写法。
- `source:"faces"` / `"commands"` 在每次打开时由 `fillDynamic()` 填充（表情来自模型扫描，指令来自 `commands.json`，上限 20）。
- 三级封顶；深层固定多一颗「返回」，占的就是「做点什么……」那一格。
- 窗口尺寸一次开到位（`menuH(rows)`），层级切换只显隐胶囊，绝不改窗口尺寸 —— 否则会闪。
- 收场动画由页面播完再发 `menu:close`；主进程只做 1.8s 兜底。
- 「表情和姿势」层 8 秒内没有选择就自动收场（`FACES_AUTO_CLOSE_MS`）。
- 「其他」里有「退下吧」，等价于退出桌宠。
