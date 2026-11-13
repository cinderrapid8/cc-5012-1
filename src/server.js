const express = require('express');
const path = require('path');
const fs = require('fs');
const store = require('./project-store');
const { renderProject } = require('./render');
const { fontCoverageReport } = require('./font-coverage');
const { launchBrowser } = require('./browser');
const { platformFontsFor, summarizeFallback } = require('./font-audit');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 4310);
const ROOT = store.ROOT;

app.use('/assets', express.static(path.join(ROOT, 'assets')));
app.use('/public', express.static(path.join(ROOT, 'public')));
app.use('/media', express.static(path.join(ROOT, 'media')));
app.use('/renders', express.static(path.join(ROOT, 'renders')));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));

app.get('/render.html', (req, res) => res.sendFile(path.join(ROOT, 'public/render.html')));

app.get('/api/sources', (req, res) => {
  try {
    res.json({ sources: store.listSources() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sources/:id/raw', (req, res) => {
  try {
    const source = store.loadSource(req.params.id);
    res.json({ hash: source.hash, readOnly: true, data: source.data });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get('/api/projects', (req, res) => {
  try {
    res.json({ projects: store.listProjects() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    const project = store.createProject({
      sourceId: req.body?.sourceId,
      name: req.body?.name,
      actor: req.body?.actor,
      forceNew: Boolean(req.body?.forceNew),
    });
    res.status(201).json({ project });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const project = store.readProject(req.params.id);
    const source = store.loadSource(project.sourceId);
    res.json({ project, sourceHash: source.hash, sourceIntegrity: source.hash === project.sourceHash, sourceReadOnly: true, source: source.data });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    const result = store.updateProject(req.params.id, req.body?.project || req.body, {
      actor: req.body?.actor,
      expectedRevision: req.body?.expectedRevision,
    });
    res.json(result);
  } catch (error) {
    res.status(error.code === 'REVISION_CONFLICT' ? 409 : 400).json({ error: error.message });
  }
});

app.get('/api/fonts/status', (req, res) => {
  try {
    const projectId = req.query.projectId;
    const sourceId = req.query.sourceId;
    let settings;
    if (projectId) settings = store.readProject(projectId).settings;
    else settings = store.loadSource(sourceId || 'trench-signals').data.settings;
    res.json({ fonts: fontCoverageReport(settings) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/font-coverage', (req, res) => {
  try {
    const text = String(req.body?.text || '').slice(0, 5000);
    const settings = req.body?.settings;
    if (!settings?.fonts?.declared) return res.status(400).json({ error: '缺少字体声明' });
    const report = fontCoverageReport(settings, text);
    res.json(report);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/fonts/measured', async (req, res) => {
  try {
    const projectId = req.body?.projectId;
    const project = store.readProject(projectId);
    const groups = (req.body?.groups || []).slice(0, 8);
    const result = await measurePlatformFonts(project.settings, groups, PORT);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

let renderQueue = Promise.resolve();
app.post('/api/projects/:id/render', (req, res) => {
  const job = () => renderProject({
    projectId: req.params.id,
    baseUrl: `http://127.0.0.1:${PORT}`,
    mode: req.body?.mode === 'preview-mask' ? 'preview-mask' : 'burn',
    actor: req.body?.actor,
    fps: req.body?.fps,
  });
  const run = renderQueue.then(job, job);
  renderQueue = run.catch(() => {});
  run.then((result) => res.json({ ok: true, result })).catch((error) => res.status(500).json({ error: error.message, stack: error.stack?.split('\n').slice(0, 8) }));
});

app.get('/api/projects/:id/renders', (req, res) => {
  try {
    const project = store.readProject(req.params.id);
    res.json({ renders: project.renders || [] });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`subtitle bench listening on http://127.0.0.1:${PORT}`);
  const ready = path.join(ROOT, 'data', 'server-ready');
  fs.mkdirSync(path.dirname(ready), { recursive: true });
  fs.writeFileSync(ready, String(PORT));
});

async function measurePlatformFonts(settings, groups, port) {
  if (!groups.length) return { summary: [], lines: [] };
  const activeGroups = groups.map((group) => ({
    id: group.id,
    original: group.original,
    translation: group.translation,
    start: 0,
    end: 1,
  }));
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  try {
    await page.goto(`http://127.0.0.1:${port}/render.html`, { waitUntil: 'load' });
    await page.evaluate(async (payload) => window.RenderPage.init(payload), { settings, canvas: { width: 1920, height: 1080 } });
    await page.evaluate(async (payload) => window.RenderPage.render(payload), { activeGroups });
    const lines = await platformFontsFor(page, '[data-line]');
    return { lines, summary: summarizeFallback(lines) };
  } finally {
    await browser.close();
  }
}
