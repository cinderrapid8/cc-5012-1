# 双语纪录片字幕制作台

导入给定的原文/译文/时间区间，在浏览器里编辑，并把两层字幕真实烧录进测试视频。
源字幕只读；所有人工调整写入独立工程版本。

## 运行

```bash
npm install
npm start            # 打开 http://127.0.0.1:4310 （界面入口）
npm test             # 自动化验收（隔离临时工程目录，含真实渲染与逐帧像素核对）
npm run test:ui      # 浏览器端验收（缩放不变性、保存/重开、拖框断行与诊断归因）
npm run trace -- --case all --assert   # 断行追踪工具：反例 + 复跑一致性
npm run make:video   # 重新生成测试视频（Chromium 逐帧 + ffmpeg 编码）
node scripts/render-cli.js <projectId> [--mask]   # 命令行渲染
```

依赖已内置在 `vendor/`（静态 ffmpeg/ffprobe、Chromium 运行库），本机无需 root。

### 界面怎样启动（双语断行的实际操作）

1. 终端执行 `npm start`，浏览器打开 **http://127.0.0.1:4310**。
2. 首次进入若无工程，点右上角「新建工程」；已有工程会在左侧列表直接载入。
3. 右侧「字幕组」点选一组（如 `g02`）。中间预览就是 1920×1080 的最终画布，
   编辑原文/译文文本框后 90ms 内自动重排。
4. **拖动字幕框**：把鼠标移到预览中字幕面板右缘的橙色手柄，左右拖动即可改这一组的框宽；
   也可在编辑器「本组框宽」输入像素值，清空则回落到「文本最大宽度」。
5. 右侧「排版诊断」顶部是**断行追踪**卡片：显示绑定的工程修订号（`修订 rN`）、语言对
   （`en → zh-Hans`）、整体 digest 与每个角色的阶段 digest。
6. 每条原因卡片给出：原因码、**归属阶段与处理环节**（如 `mount · framing`、`candidates · kinsoku`、
   `solve · line-decision`、`bind · language-binding`）、具体行与实测宽度、证据字段，
   以及该组对应的**画面帧区间**（`画面 F115–F205`）和「定位」按钮（点击跳到该组时间中点）。
7. 框宽改动会立即以断行内核重排；失败原因写回同一张卡片，不会用默认值掩盖。
   点「保存」后框宽随工程修订持久化，重开工程仍然保留。

### 断行追踪工具（命令行）

```bash
node scripts/break-trace.js --group g02 [--project ID] [--box 720] [--json out.json]
node scripts/break-trace.js --case narrow-box --json runs/narrow.json
node scripts/break-trace.js --case all --assert --json runs/all.json
node scripts/break-trace.js --replay runs/narrow.json     # 复跑并逐摘要比对，不一致退出码 1
```

反例用例覆盖：同字数不同字形（`font-fallback`、`glyph-width`）、组合符（`combining-marks`）、
禁则（`kinsoku`）、测量尺度与字间距（`tracking-scale`）、不可断超长词（`unbreakable`）、
显式拖动窄框（`narrow-box`），以及旧双语样例 `old-samples`（从真实工程读入，必须全程跑通）。
每个用例都带 `--assert` 断言：原因必须落在正确阶段，且必须有反事实证据（例如
`box-width-is-binding` 只有在画布全宽下重解得 0 溢出时才成立）。

## 关键设计

- **共享排版引擎** `public/js/layout-engine.js`：预览与导出使用同一套测量与几何，先按 canvas
  `measureText` 实测宽度，再用动态规划选行；不以字符数均分。禁则：行首不出现收尾标点/省略号/
  破折号，行尾不出现开括号；空格在断点处保留，重拼校验逐字符一致（不删词）。
- **溢出**：超出行数上限或单词无法整行容纳时，报告 `max-lines-exceeded` / `unbreakable-token` /
  `line-overflow` 并给出可点选调整项（加宽、缩字号、增加行数）。默认不拆分、不删词；应急断行需显式开启。
- **断行追踪与诊断归因**：`public/js/trace-util.js` 对 `shape → measure → geometry → candidates →
  solve → line-box → mount → bind` 八个阶段做确定性摘要链，`public/js/break-diagnostics.js`
  把每条错误行归到某个阶段。归因顺序保证整形与测量问题优先于“框太窄”：
  组合符被拆（shape）→ 测量尺度/字间距（measure）→ 字体回退字形（shape）→
  不可断词（candidates）→ 禁则阻断（candidates）→ 求解退化（solve）→ 仅当**显式框宽**
  且反事实求解可容纳时才判 `box-width-is-binding`（mount）。默认 `maxTextWidthPx`
  是配置安全宽度，命中它一律记为行数预算问题，不会把配置宽度说成窄框。
  诊断数据绑定计算时的工程修订与语言对；渲染清单里每个 sheet 都带 `trace.digest` 与 `diagnostics`。
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
行数/宽度溢出与调整项、帧映射边界、输出帧上的字幕出现区间、原译归属均可见、90px 安全边距，
以及断行追踪：七类反例 + 旧双语样例全部 8 阶段齐全、逐用例复跑摘要一致、渲染清单每 sheet
的 trace 绑定到工程修订、已配置安全宽度不被误判为窄框。
