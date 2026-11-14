const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { launchBrowser } = require('./browser');
const store = require('./project-store');
const { buildActiveSegments, frameForTime } = require('./timecode');
const { platformFontsFor } = require('./font-audit');
const { fontCoverageReport } = require('./font-coverage');

function ffmpegPath() {
  const local = path.resolve(__dirname, '../vendor/ffmpeg');
  if (fs.existsSync(local)) return local;
  const mod = require('ffmpeg-static');
  if (mod && fs.existsSync(mod)) return mod;
  throw new Error('找不到 ffmpeg');
}

function ffprobePath() {
  const local = path.resolve(__dirname, '../vendor/ffprobe');
  return fs.existsSync(local) ? local : null;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(`ffmpeg exited ${code}\n${stderr.slice(-5000)}`);
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function inspectVideo(videoPath) {
  const probe = ffprobePath();
  if (!probe) return { fps: null, duration: null, width: null, height: null, probed: false };
  const out = await run(probe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', videoPath]);
  const data = JSON.parse(out.stdout);
  const stream = data.streams?.[0] || {};
  const [num, den] = String(stream.r_frame_rate || '0/1').split('/').map(Number);
  return {
    fps: den ? num / den : num,
    duration: Number(data.format?.duration) || null,
    width: stream.width || null,
    height: stream.height || null,
    probed: true,
  };
}

function projectCues(project) {
  return project.groups.map((group) => ({
    id: group.id,
    start: group.edit.start,
    end: group.edit.end,
    original: group.edit.original,
    translation: group.edit.translation,
  }));
}

async function renderProject({ projectId, baseUrl, mode = 'burn', actor, fps: requestedFps }) {
  const project = store.readProject(projectId);
  const source = store.loadSource(project.sourceId);
  if (source.hash !== project.sourceHash) throw new Error('源字幕哈希不一致：只读源被修改，拒绝渲染');
  const videoPath = path.resolve(store.ROOT, source.data.video);  if (!fs.existsSync(videoPath)) throw new Error(`测试视频缺失: ${videoPath}`);
  const info = await inspectVideo(videoPath);
  const fps = Number(requestedFps) || info.fps || source.data.fps;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('无法确定视频帧率');
  const duration = info.duration || source.data.duration;
  const totalFrames = Math.round(duration * fps);
  const cues = projectCues(project);
  const segments = buildActiveSegments(cues, fps, totalFrames);
  const activeSegments = segments.filter((segment) => segment.cueIds.length);
  const workDir = path.resolve(store.PROJECTS_DIR, `${project.projectId}-work-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  try {
    await page.goto(`${baseUrl}/render.html`, { waitUntil: 'load' });
    const fontStatus = await page.evaluate(async (payload) => {
      return await window.RenderPage.init(payload);
    }, { settings: project.settings, canvas: { width: 1920, height: 1080 } });

    const sheets = [];
    const fontAudit = [];
    for (const segment of activeSegments) {
      const activeGroups = project.groups
        .filter((group) => segment.cueIds.includes(group.id))
        .map((group) => ({ id: group.id, original: group.edit.original, translation: group.edit.translation, start: group.edit.start, end: group.edit.end }));
      const review = mode === 'preview-mask' ? { frame: segment.startFrame, fps } : null;
      const coverageReport = fontCoverageReport(project.settings, activeGroups.map((group) => `${group.original}\n${group.translation}`).join('\n'));
      const trace = {
        revision: project.revision,
        languages: source.data.languages,
        coverage: { byGlyph: coverageReport.byGlyph || {}, families: coverageReport.families || [] },
      };
      const layout = await page.evaluate(async (payload) => window.RenderPage.render(payload), { activeGroups, review, trace });
      const fonts = await platformFontsFor(page, '[data-line]');
      fontAudit.push({ startFrame: segment.startFrame, cueIds: segment.cueIds, lines: fonts });
      const png = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
      const pngFile = path.join(workDir, `sheet-${String(segment.startFrame).padStart(6, '0')}.png`);
      fs.writeFileSync(pngFile, png);
      sheets.push({ segment, pngFile, layout: layout.layout, trace: layout.layout?.trace || null, diagnostics: layout.diagnostics || null });
    }

    const auditFrames = collectAuditFrames(project, fps, totalFrames);
    const audit = await page.evaluate(async (payload) => window.RenderPage.inspect(payload), {
      settings: project.settings,
      canvas: { width: 1920, height: 1080 },
      cues,
      fps,
      frames: auditFrames,
      allowedBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    await browser.close();

    const outputName = `${project.projectId}-${mode === 'preview-mask' ? 'mask' : 'burn'}-${Date.now()}.mp4`;
    const outputPath = path.resolve(store.RENDERS_DIR, outputName);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const filter = buildOverlayFilter({ sheets, fps, totalFrames, mode });
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, ...filter.inputs, '-filter_complex', filter.graph, '-map', '[vout]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', outputPath];
    await run(ffmpegPath(), args);
    const stat = fs.statSync(outputPath);

    const keptDir = path.resolve(store.PROJECTS_DIR, project.projectId, 'sheets', outputName.replace(/\.mp4$/, ''));
    fs.mkdirSync(keptDir, { recursive: true });
    const manifest = {
      output: outputName,
      mode,
      fps,
      totalFrames,
      duration,
      video: source.data.video,
      projectId: project.projectId,
      revision: project.revision,
      sourceId: project.sourceId,
      sourceHash: project.sourceHash,
      createdAt: new Date().toISOString(),
      actor: actor || 'editor',
      fontStatus,
      fontAudit,
      sheets: sheets.map(({ segment, pngFile, layout, trace, diagnostics }) => ({
        file: path.basename(pngFile),
        startFrame: segment.startFrame,
        endFrame: segment.endFrame,
        timecode: `${(segment.startFrame / fps).toFixed(3)}s`,
        cueIds: segment.cueIds,
        trace: trace ? { digest: trace.digest, schema: trace.schema, revision: trace.revision, languages: trace.languages } : null,
        diagnostics: diagnostics ? { version: diagnostics.version, completeness: diagnostics.completeness, bindings: diagnostics.bindings, causes: (diagnostics.attributions || []).filter((item) => item.cause !== 'fit').map((item) => ({ cause: item.cause, stage: item.stage, phase: item.phase, scope: item.scope, line: item.line })), languageGaps: diagnostics.languageGaps } : null,
        blocks: layout.blocks.map((block) => ({
          groupId: block.groupId,
          panel: block.panel,
          roles: block.roles.map((role) => ({
            role: role.role,
            text: role.text,
            fontSize: role.fontSize,
            lines: role.lines,
            integrity: role.integrity,
          })),
        })),
        issues: layout.issues,
      })),
      audit,
    };
    fs.writeFileSync(path.join(keptDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    for (const sheet of sheets) fs.copyFileSync(sheet.pngFile, path.join(keptDir, path.basename(sheet.pngFile)));
    fs.rmSync(workDir, { recursive: true, force: true });

    const record = {
      mode,
      output: outputName,
      outputPath,
      outputUrl: `/renders/${outputName}`,
      bytes: stat.size,
      fps,
      totalFrames,
      duration,
      generatedAt: new Date().toISOString(),
      actor: actor || 'editor',
      projectRevision: project.revision,
      sourceHash: project.sourceHash,
      sheetDir: path.relative(store.ROOT, keptDir),
      manifest: path.relative(store.ROOT, path.join(keptDir, 'manifest.json')),
      issueCount: sheets.reduce((sum, sheet) => sum + (sheet.layout.issues?.length || 0), 0),
    };
    store.recordRender(project.projectId, record);
    return { ...record, manifest, audit };
  } finally {
    await browser.close().catch(() => {});
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function collectAuditFrames(project, fps, totalFrames) {
  const frames = new Set();
  for (const group of project.groups) {
    const startFrame = frameForTime(group.edit.start, fps);
    const endFrame = frameForTime(group.edit.end, fps);
    frames.add(startFrame);
    frames.add(Math.max(startFrame, endFrame - 1));
    frames.add(Math.floor((startFrame + endFrame) / 2));
  }
  return [...frames].filter((frame) => frame >= 0 && frame < totalFrames).sort((a, b) => a - b);
}

function buildOverlayFilter({ sheets, fps, totalFrames, mode, canvas = { width: 1920, height: 1080 } }) {
  const inputs = [];
  const parts = [];
  parts.push(`[0:v]scale=${canvas.width}:${canvas.height}:flags=lanczos,setsar=1[base]`);
  let last = '[base]';
  sheets.forEach((sheet, index) => {
    const { segment } = sheet;
    const start = segment.startFrame / fps;
    const end = Math.min(segment.endFrame, totalFrames) / fps;
    const durationFrames = segment.endFrame - segment.startFrame;
    inputs.push('-loop', '1', '-framerate', String(fps), '-t', (durationFrames / fps).toFixed(6), '-i', sheet.pngFile);
    parts.push(`[${index + 1}:v]setpts=PTS-STARTPTS+${start.toFixed(6)}/TB,format=rgba[ov${index}]`);
    const enable = `between(t,${start.toFixed(6)},${(end - 1 / fps / 2).toFixed(6)})`;
    parts.push(`${last}[ov${index}]overlay=0:0:format=auto:eof_action=pass:enable='${enable}'[v${index}]`);
    last = `[v${index}]`;
  });
  const graph = parts.join(';') + `;${last}null[vout]`;
  return { inputs, graph };
}

module.exports = { renderProject, inspectVideo, buildOverlayFilter };
