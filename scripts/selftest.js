const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { launchBrowser } = require('../src/browser');
const { extractFrame, classifySubtitlePixels, checkSafe, probe } = require('./verify-output');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.BENCH_TEST_PORT || 4311);
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-projects-'));
const RENDERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-renders-'));
const SOURCE = path.join(ROOT, 'sources/trench-signals.json');
const sourceBefore = fs.readFileSync(SOURCE, 'utf8');

let server;
let browser;
let failures = 0;
const results = [];

function check(name, pass, detail) {
  results.push({ name, pass, detail });
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
}

async function api(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('node', ['src/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), BENCH_PROJECTS_DIR: PROJECT_DIR, BENCH_RENDERS_DIR: RENDERS_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout.on('data', (data) => {
      out += data.toString();
      if (out.includes('listening')) resolve();
    });
    server.stderr.on('data', (data) => { out += data.toString(); });
    server.on('error', reject);
    setTimeout(() => (out.includes('listening') ? null : reject(new Error(`server timeout: ${out}`))), 8000);
  });
}

async function loadRenderPage(settings) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`http://127.0.0.1:${PORT}/render.html`, { waitUntil: 'load' });
  await page.evaluate(async (payload) => window.RenderPage.init(payload), { settings, canvas: { width: 1920, height: 1080 } });
  return page;
}

(async () => {
  await startServer();
  browser = await launchBrowser();

  // --- source integrity -----------------------------------------------------
  const listing = await api('/api/sources');
  const meta = listing.sources.find((source) => source.id === 'trench-signals');
  const raw = await api('/api/sources/trench-signals/raw');
  check('source is exposed as read-only', raw.readOnly === true);
  check('source hash is stable', raw.hash === meta.hash && meta.hash.length === 64);

  // --- project creation, edit, save and reopen -------------------------------
  const { project } = await api('/api/projects', { method: 'POST', body: { sourceId: 'trench-signals' } });
  check('project is independent of source', project.projectId !== project.sourceId && project.sourceHash === meta.hash);
  const edited = JSON.parse(JSON.stringify(project));
  edited.groups[0].edit.translation = '船员把水听器放入海沟，那里只传来一声漫长的呼唤——';
  edited.groups[0].edit.originalOverride = null;
  edited.settings.translation.fontSize = 36;
  const saved = await api(`/api/projects/${project.projectId}`, {
    method: 'PUT',
    body: { project: edited, expectedRevision: project.revision },
  });
  check('save increments the engineering revision', saved.project.revision === project.revision + 1);
  check('save preserves per-group original/translation binding', saved.project.groups[0].edit.original === project.groups[0].edit.original);
  check('settings are persisted with the project', saved.project.settings.translation.fontSize === 36);
  const reopened = await api(`/api/projects/${project.projectId}`);
  check('reopening a saved project restores the edit', reopened.project.groups[0].edit.translation.startsWith('船员把水听器放入海沟'));
  check('source hash still matches after project save', reopened.sourceHash === raw.hash);
  const after = fs.readFileSync(SOURCE, 'utf8');
  check('source file bytes are untouched by editing', after === sourceBefore);

  // stale revision is rejected
  let conflict = null;
  try {
    await api(`/api/projects/${project.projectId}`, { method: 'PUT', body: { project: edited, expectedRevision: project.revision } });
  } catch (error) { conflict = error; }
  check('stale save is rejected with 409', conflict && conflict.status === 409);

  // --- layout engine: measured line breaks, kinsoku, integrity --------------
  const renderPage = await loadRenderPage(saved.project.settings);
  const cases = [
    {
      id: 'long-en',
      original: 'A single diagnosis — pneumonoultramicroscopicsilicovolcanoconiosis — was treated as impossible out there.',
      translation: '在那里，仅仅一个“尘肺病”的诊断都被视为不可能。',
    },
    {
      id: 'cjk-punct',
      original: 'He said, “... ‘Really? — No!’ ”—and the room fell silent.',
      translation: '他说：“……‘真的？——不！’”……现场一片沉默，久久不散，只有潮声回荡。',
    },
    {
      id: 'combining',
      original: 'IPA [kʰãˈnɐ] and crew badges: 🧑🏽‍🚀👩🏽‍💻',
      translation: '国际音标 [kʰãˈnɐ] 与乘组徽章：🧑🏽‍🚀👩🏽‍💻',
    },
  ];
  for (const testCase of cases) {
    const layout = await renderPage.evaluate(async (payload) => window.RenderPage.layOnly(payload), {
      activeGroups: [{ ...testCase, start: 0, end: 1 }],
    });
    const roles = layout.blocks[0].roles;
    const allLines = roles.flatMap((role) => role.lines);
    check(`[${testCase.id}] all roles reassemble without dropping text`, roles.every((role) => role.integrity.ok));
    check(`[${testCase.id}] no line violates kinsoku`, roles.every((role) => (role.boundaryViolations || []).length === 0));
    check(`[${testCase.id}] every line fits the measured width`, allLines.every((line) => line.over === 0) || layout.issues.some((issue) => issue.type === 'unbreakable-token'));
    check(`[${testCase.id}] glyph clusters are not split`, !allLines.some((line) => /[̀-ͯ]$/u.test(line.text)));
  }

  // long word must produce explicit overflow, not silent deletion/splitting
  const tight = JSON.parse(JSON.stringify(saved.project.settings));
  tight.original.fontSize = 68;
  tight.maxTextWidthPx = 900;
  const tightPage = await loadRenderPage(tight);
  const overflowLayout = await tightPage.evaluate(async (payload) => window.RenderPage.layOnly(payload), {
    activeGroups: [{ id: 'x', original: cases[0].original, translation: cases[0].translation, start: 0, end: 1 }],
  });
  const unbreakable = overflowLayout.issues.find((issue) => issue.type === 'unbreakable-token');
  check('unbreakable long word is reported', Boolean(unbreakable));
  check('unbreakable word keeps full text', unbreakable && unbreakable.text.includes('pneumonoultramicroscopicsilicovolcanoconiosis'));
  const tokenSuggestions = overflowLayout.suggestions.flatMap((group) => group.suggestions.map((suggestion) => suggestion.kind));
  check('overflow exposes adjustable options', tokenSuggestions.includes('decrease-font-size') || tokenSuggestions.includes('increase-max-width'));

  // two simultaneous groups stay separate
  const overlapLayout = await renderPage.evaluate(async (payload) => window.RenderPage.layOnly(payload), {
    activeGroups: [
      { id: 'g04', original: 'Overlap A original.', translation: '交叠甲译文。', start: 0, end: 2 },
      { id: 'g05', original: 'Overlap B original.', translation: '交叠乙译文。', start: 1, end: 3 },
    ],
  });
  check('two overlapping groups produce two distinct panels', overlapLayout.blocks.length === 2);
  const bindingsOk = overlapLayout.blocks.every((block) => {
    const expected = block.groupId === 'g04' ? ['Overlap A original.', '交叠甲译文。'] : ['Overlap B original.', '交叠乙译文。'];
    return block.roles[0].text === expected[0] && block.roles[1].text === expected[1];
  });
  check('overlapping groups never cross-bind original and translation', bindingsOk);
  check('overlap is flagged for review', overlapLayout.issues.some((issue) => issue.type === 'time-overlap'));

  // markers must keep their inline styles (regression: quoted font stack broke the style attribute)
  await renderPage.evaluate(async (payload) => window.RenderPage.render(payload), {
    activeGroups: [{ id: 'g01', original: 'Marker check original.', translation: '标记检查译文。', start: 0, end: 1 }],
  });
  const markers = await renderPage.evaluate(() => [...document.querySelectorAll('.role-mark')].map((node) => ({
    text: node.textContent,
    color: getComputedStyle(node).color,
    fontFamily: getComputedStyle(node).fontFamily,
  })));
  const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  check('role markers keep their configured colors', markers.length === 2
    && markers[0].color === rgb(saved.project.settings.original.color)
    && markers[1].color === rgb(saved.project.settings.translation.color), JSON.stringify(markers));
  check('role markers use the declared font stack', markers.every((marker) => marker.fontFamily.includes('Documentary Sans SC')));

  // --- deterministic frame mapping -----------------------------------------
  const timecode = await import('../src/timecode.js');
  check('cue start maps to exact frame', timecode.frameForTime(1.0, 25) === 25);
  check('mid-cue maps deterministically', timecode.frameForTime(4.6, 25) === 115);
  const segments = timecode.buildActiveSegments([
    { id: 'a', start: 1, end: 4 },
    { id: 'b', start: 2, end: 5 },
  ], 25, 150);
  check('overlapping timing yields a shared active segment', segments.some((segment) => segment.cueIds.join('|') === 'a|b'));

  // --- real burned render and frame audit ----------------------------------
  const rendered = await api(`/api/projects/${project.projectId}/render`, {
    method: 'POST',
    body: { mode: 'burn', actor: 'selftest' },
  });
  const result = rendered.result;
  check('render produced an mp4', fs.existsSync(result.outputPath) && fs.statSync(result.outputPath).size > 100000);
  const mediaInfo = await probe(result.outputPath);
  check('render timeline matches the source video', Number(mediaInfo.format.duration).toFixed(2) === '15.00' && mediaInfo.streams[0].nb_frames === '375');

  const manifest = typeof result.manifest === 'string'
    ? JSON.parse(fs.readFileSync(path.join(ROOT, result.manifest), 'utf8'))
    : result.manifest;
  check('manifest records requested font HTTP status', manifest.fontStatus.find((font) => font.family === 'Documentary Serif')?.requestFailed === true);
  check('manifest records measured platform fonts', manifest.fontAudit.some((entry) => entry.lines.some((line) => line.fonts.length > 0)));
  check('measured font audit records the rendered weight', manifest.fontAudit.some((entry) => entry.lines.some((line) => line.fontWeight === '400')));
  const emojiLine = manifest.fontAudit.flatMap((entry) => entry.lines).find((line) => line.role === 'original' && line.text?.includes('🧑'));
  const hasEmojiFont = manifest.fontAudit.flatMap((entry) => entry.lines).some((line) => line.fonts.some((font) => font.family === 'Noto Color Emoji'));
  check('emoji resolves to the color emoji font', hasEmojiFont);
  check('combining IPA line resolves through declared fonts', Boolean(emojiLine && emojiLine.fonts.length > 0));
  const auditFrames = manifest.audit.frames;
  check('no safe-margin violations at audited frames', auditFrames.every((frame) => frame.violations.length === 0));
  check('no original/translation binding mismatch at audited frames', auditFrames.every((frame) => frame.missingBindings.length === 0));
  const g02Sheet = manifest.sheets.find((sheet) => sheet.cueIds.join('|') === 'g02');
  check('long word occupies one unbroken measured line', g02Sheet && g02Sheet.blocks[0].roles[0].lines.some((line) => line.text.includes('pneumonoultramicroscopicsilicovolcanoconiosis')));

  // pixel-level: subtitle colors exist only inside cues and stay inside safe area
  const frameTimes = [
    { t: 0.5, expectText: false },
    { t: 2.0, expectText: true },
    { t: 5.0, expectText: true },
    { t: 9.0, expectText: true },
    { t: 12.6, expectText: true },
    { t: 14.6, expectText: false },
  ];
  for (const { t, expectText } of frameTimes) {
    const file = path.join(RENDERS_DIR, `check-${t}.png`);
    await extractFrame(result.outputPath, t, file);
    const { PNG } = require('pngjs');
    const png = PNG.sync.read(fs.readFileSync(file));
    const classified = classifySubtitlePixels(png, { palette: paletteOf(saved.project.settings) });
    const safe = checkSafe(classified.bounds, png.width, png.height, saved.project.settings.safeMarginPx);
    check(`frame ${t}s subtitle presence matches the cue schedule`, classified.active === expectText, `pixels o=${classified.counts.original} t=${classified.counts.translation}`);
    if (expectText) {
      check(`frame ${t}s text stays inside the ${saved.project.settings.safeMarginPx}px safe margin`, safe.withinSafeArea, JSON.stringify(safe.violations));
      check(`frame ${t}s carries both original and translation`, classified.counts.original > 200 && classified.counts.translation > 100);
    }
  }

  // --- mask render for visual review ---------------------------------------
  const masked = await api(`/api/projects/${project.projectId}/render`, {
    method: 'POST',
    body: { mode: 'preview-mask', actor: 'selftest' },
  });
  check('review mask render exists', fs.existsSync(masked.result.outputPath));

  const summary = { passed: results.filter((r) => r.pass).length, failed: failures, results };
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data/selftest-report.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${summary.passed} passed, ${failures} failed`);
  await browser.close();
  server.kill('SIGTERM');
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  fs.rmSync(RENDERS_DIR, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch(async (error) => {
  console.error('SELFTEST ERROR', error);
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
  process.exit(2);
});

function paletteOf(settings) {
  const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
  return { original: hex(settings.original.color), translation: hex(settings.translation.color), safeMarginPx: settings.safeMarginPx };
}
