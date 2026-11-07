# 模型目录 · 怎么拿到模型

> ✦ **模型信息**
>
> 模型名称：DeepSeek免费公皮<br>
> 原画及拆分：神宫凉子<br>
> Live2D 建模：霓虹猫_NeonNeko<br>
> 模型来源：神宫凉子免费配布模型
>
> 模型版权归原作者所有，本程序不附带模型，请到原作者处获取。

## 一句话

**本仓库不含 Live2D 模型。** 模型版权归原作者，请勿从本仓库获取。

## 为什么仓库不带

模型是别人的美术作品，作者没有转授权，打包进仓库就是二次分发。
顺带也是体积问题：运行模型 64 MB、源素材 149 MB，进 git 会拖死所有人。

## 四步拿到能跑的模型

1. 模型叫 **「DeepSeek免费公皮」**：原画及拆分是 **神宫凉子**，Live2D 建模是 **霓虹猫_NeonNeko**，
   由神宫凉子免费配布。到 B 站搜这两个 ID，看她发布的模型相关视频、简介或置顶评论里写的
   获取方式（这里不写死链接 —— 视频会动，搜 ID 永远找得到）。
2. 拿到的是一个压缩包，解压后应该能看到这几样东西：

   ```text
   <名字>.model3.json      ← 入口，config.json 里 model.file 指的就是它
   <名字>.moc3             ← 模型本体
   *.png                   ← 贴图（可能有多张）
   Exp3/                   ← 表情
   motions/ 或 Animation/  ← 动作
   ```

3. 整个目录放进 `main/model/runtime/`（就放在这一层，不要再套一层同名文件夹）。
4. 文件夹里的文件名和默认配置不一致时，改 `main/config/config.json`：

   ```json
   "model": { "dir": "model/runtime", "file": "你的模型.model3.json" }
   ```

   `dir` 一般不用动。改完重启桌宠生效。

## 启动时提示「没有找到模型」

说明第 3 步没做对，或者 `model.file` 写的文件名和实际不符。点提示窗里的
「打开说明」会跳到这份文件。检查两件事：

- `main/model/runtime/` 里**直接**有 `.model3.json`，而不是 `runtime/某个文件夹/...`；
- `config.json` 的 `model.file` 与那个文件名**逐字符**一致（含大小写与扩展名）。

## 目录里原本有什么

| 目录 | 内容 | 是否入仓 |
| --- | --- | --- |
| `runtime/` | 运行模型：`*.model3.json`、`moc3`、贴图、`Exp3`、`Animation` | 否（gitignore） |
| `source/` | 源素材：分层 PSD、表情动作参考截图 | 否（gitignore） |

贴图压缩（`*_opt2048`）由 `main/scripts/prepare-model.mjs` 在首次启动时自动生成，
不需要手动跑。模型自带的文件名不要改 —— `model3.json` 内部按这些名字引用。
