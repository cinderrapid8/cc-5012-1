# 双语纪录片字幕制作台

导入给定的原文/译文/时间区间，在浏览器里编辑，并把两层字幕真实烧录进测试视频。
源字幕只读；所有人工调整写入独立工程版本。

## 运行

```bash
npm install
npm start            # http://127.0.0.1:4310
npm test             # 自动化验收（隔离临时工程目录，含真实渲染与逐帧像素核对）
npm run test:ui      # 浏览器端验收（缩放不变性、保存/重开、溢出可调整项）
npm run make:video   # 重新生成测试视频（Chromium 逐帧 + ffmpeg 编码）
node scripts/render-cli.js <projectId> [--mask]   # 命令行渲染
```

依赖已内置在 `vendor/`（静态 ffmpeg/ffprobe、Chromium 运行库），本机无需 root。

## 关键设计

- **共享排版引擎** `public/js/layout-engine.js`：预览与导出使用同一套测量与几何，先按 canvas
  `measureText` 实测宽度，再用动态规划选行；不以字符数均分。禁则：行首不出现收尾标点/省略号/
  破折号，行尾不出现开括号；空格在断点处保留，重拼校验逐字符一致（不删词）。
- **溢出**：超出行数上限或单词无法整行容纳时，报告 `max-lines-exceeded` / `unbreakable-token` /
  `line-overflow` 并给出可点选调整项（加宽、缩字号、增加行数）。默认不拆分、不删词；应急断行需显式开启。
- **字形处理**：`Intl.Segmenter` 按字素簇切分，组合音标、ZWJ 表情、肤色修饰不会被拆开。
- **时间映射**：`frameForTime = Math.round(seconds * fps)`，区间半开 `[startFrame, endFrame)`；
  渲染按活动组集合切段生成透明 PNG 叠层，再用 ffmpeg 的 `enable=between(...)` 精确落帧。
- **确定性画布**：字幕始终在固定 1920×1080 画布上按像素排版；预览只对容器做 CSS `scale`，
  字号与安全边界不随缩放变化。
- **字体回退**：缺失文件按 404 记录；渲染后通过 CDP `CSS.getPlatformFontsForNode` 回读每行实际
  平台字体（含字重、字形的来源与数量），面板同时显示声明别名 `⇒` 文件内部名。
- **只读源与工程版本**：源 JSON 记录 SHA-256；工程保存前校验源哈希，源被改动则拒绝渲染/保存。
  保存采用乐观并发（`expectedRevision`，冲突返回 409），审计日志留痕；多份工程各自独立。

## 交付核对

- 最终烧录片：`renders/trench-signals-p2-burn-1794608349624.mp4`（1920×1080 / 25fps / 375 帧）
- 核对遮罩：`renders/trench-signals-p2-mask-1794609322204.mp4`（行框、REVIEW HUD、原/译标记）
- 渲染清单：`data/projects/trench-signals-p2/sheets/<render>/manifest.json`
  （逐段行文/宽度/坐标/完整性/禁则、字体 HTTP 状态、平台字体实测、审计帧违规）
- `npm test` 结果写入 `data/selftest-report.json`

`npm test` 覆盖：源只读、保存/重开、409 冲突、长英文单词、连续中文标点、组合音标、交叠两组、
行数/宽度溢出与调整项、帧映射边界，以及输出帧上的字幕出现区间、原译归属均可见、90px 安全边距。
