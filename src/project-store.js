const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCES_DIR = path.join(ROOT, 'sources');
const PROJECTS_DIR = process.env.BENCH_PROJECTS_DIR
  ? path.resolve(process.env.BENCH_PROJECTS_DIR)
  : path.join(ROOT, 'data/projects');
const RENDERS_DIR = process.env.BENCH_RENDERS_DIR
  ? path.resolve(process.env.BENCH_RENDERS_DIR)
  : path.join(ROOT, 'renders');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function safeId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value)) {
    throw new Error('非法工程标识');
  }
  return value;
}

function listSources() {
  return fs.readdirSync(SOURCES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const raw = fs.readFileSync(path.join(SOURCES_DIR, name));
      const data = JSON.parse(raw.toString('utf8'));
      return {
        file: name,
        id: data.sourceId,
        title: data.title,
        hash: sha256(raw),
        fps: data.fps,
        duration: data.duration,
        groups: data.groups.length,
        canvas: data.canvas,
      };
    });
}

function loadSource(id) {
  const file = path.join(SOURCES_DIR, `${safeId(id)}.json`);
  if (!fs.existsSync(file)) throw new Error('源字幕不存在');
  const raw = fs.readFileSync(file);
  const data = JSON.parse(raw.toString('utf8'));
  if (data.sourceId !== id) throw new Error('源标识与文件名不一致');
  return { data, raw, hash: sha256(raw), file };
}

function projectPath(projectId) {
  return path.join(PROJECTS_DIR, `${safeId(projectId)}.json`);
}

function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = path.join(PROJECTS_DIR, name);
      const data = readJSON(file);
      let sourceMatches = null;
      try {
        sourceMatches = loadSource(data.sourceId).hash === data.sourceHash;
      } catch {
        sourceMatches = false;
      }
      return {
        projectId: data.projectId,
        name: data.name,
        sourceId: data.sourceId,
        sourceHash: data.sourceHash,
        sourceMatches,
        revision: data.revision,
        updatedAt: data.updatedAt,
        createdAt: data.createdAt,
        groupCount: data.groups.length,
        renderCount: (data.renders || []).length,
      };
    });
}

function findProjectForSource(sourceId, sourceHash) {
  return listProjects().find((project) => project.sourceId === sourceId
    && (!sourceHash || project.sourceHash === sourceHash)) || null;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'project';
}

function createProject({ sourceId, name, actor, forceNew }) {
  const source = loadSource(sourceId);
  const existing = findProjectForSource(sourceId, source.hash);
  if (existing && !forceNew) return readProject(existing.projectId);
  const now = new Date().toISOString();
  const base = slug(sourceId);
  let projectId = `${base}-p1`;
  let counter = 1;
  while (fs.existsSync(projectPath(projectId)) || fs.existsSync(path.join(PROJECTS_DIR, projectId))) {
    counter += 1;
    projectId = `${base}-p${counter}`;
  }
  const settings = JSON.parse(JSON.stringify(source.data.settings));
  const groups = source.data.groups.map((group) => ({
    id: group.id,
    source: { original: group.original, translation: group.translation, start: group.start, end: group.end },
    edit: {
      original: group.original,
      translation: group.translation,
      start: group.start,
      end: group.end,
      originalOverride: null,
      translationOverride: null,
      boxWidthPx: null,
    },
  }));
  const project = {
    schemaVersion: 1,
    projectId,
    name: name || `${source.data.title} · 人工调整版${counter > 1 ? ` #${counter}` : ''}`,
    sourceId,
    sourceHash: source.hash,
    sourceSnapshotAt: now,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    settings,
    groups,
    audit: [{ at: now, actor: actor || 'editor', action: 'create-project', detail: { sourceHash: source.hash, groups: groups.length } }],
    renders: [],
  };
  writeJSON(projectPath(projectId), project);
  return project;
}

function readProject(projectId) {
  const file = projectPath(projectId);
  if (!fs.existsSync(file)) throw new Error('工程不存在');
  return readJSON(file);
}

function updateProject(projectId, incoming, { actor, expectedRevision } = {}) {
  const current = readProject(projectId);
  if (expectedRevision != null && current.revision !== expectedRevision) {
    const error = new Error('工程版本冲突：请重新载入后再保存');
    error.code = 'REVISION_CONFLICT';
    throw error;
  }
  const source = loadSource(current.sourceId);
  if (source.hash !== current.sourceHash) {
    throw new Error('源字幕在工程创建后发生变化，源应保持只读；请新建工程以对齐新源');
  }
  const now = new Date().toISOString();
  const diff = [];
  const nextGroups = current.groups.map((group) => {
    const patch = (incoming.groups || []).find((item) => item.id === group.id);
    if (!patch) return group;
    const edit = {
      original: typeof patch.edit?.original === 'string' ? patch.edit.original : group.edit.original,
      translation: typeof patch.edit?.translation === 'string' ? patch.edit.translation : group.edit.translation,
      start: Number.isFinite(patch.edit?.start) ? patch.edit.start : group.edit.start,
      end: Number.isFinite(patch.edit?.end) ? patch.edit.end : group.edit.end,
      originalOverride: typeof patch.edit?.originalOverride === 'string' ? patch.edit.originalOverride : group.edit.originalOverride,
      translationOverride: typeof patch.edit?.translationOverride === 'string' ? patch.edit.translationOverride : group.edit.translationOverride,
      boxWidthPx: Number.isFinite(patch.edit?.boxWidthPx) && patch.edit.boxWidthPx > 0
        ? Math.round(patch.edit.boxWidthPx)
        : (Number.isFinite(group.edit?.boxWidthPx) ? group.edit.boxWidthPx : null),
    };
    if (JSON.stringify(edit) !== JSON.stringify(group.edit)) {
      diff.push({ groupId: group.id, before: group.edit, after: edit });
    }
    return { ...group, edit };
  });
  const nextSettings = sanitizeSettings(incoming.settings || current.settings, current.settings);
  if (JSON.stringify(nextSettings) !== JSON.stringify(current.settings)) {
    diff.push({ setting: 'settings', before: current.settings, after: nextSettings });
  }
  if (!diff.length) return { project: current, changed: false };
  const next = {
    ...current,
    name: typeof incoming.name === 'string' && incoming.name.trim() ? incoming.name.trim().slice(0, 120) : current.name,
    settings: nextSettings,
    groups: nextGroups,
    revision: current.revision + 1,
    updatedAt: now,
    audit: [
      ...current.audit,
      { at: now, actor: actor || 'editor', action: 'save', detail: { fromRevision: current.revision, toRevision: current.revision + 1, changes: summarizeDiff(diff) } },
    ].slice(-500),
  };
  writeJSON(projectPath(projectId), next);
  return { project: next, changed: true };
}

function summarizeDiff(diff) {
  return diff.map((item) => item.setting ? { setting: item.setting } : { groupId: item.groupId });
}

function sanitizeSettings(incoming, fallback) {
  const clamp = (value, min, max, def) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : def);
  const inRole = (role, def) => ({
    fontSize: Math.round(clamp(role?.fontSize, 12, 160, def.fontSize)),
    fontWeight: [300, 400, 500, 600, 700].includes(role?.fontWeight) ? role.fontWeight : def.fontWeight,
    maxLines: Math.round(clamp(role?.maxLines, 1, 6, def.maxLines)),
    color: /^#[0-9a-f]{6}$/i.test(role?.color || '') ? role.color : def.color,
    tracking: clamp(role?.tracking, -4, 12, def.tracking),
  });
  return {
    fonts: fallback.fonts,
    original: inRole(incoming?.original, fallback.original),
    translation: inRole(incoming?.translation, fallback.translation),
    safeMarginPx: Math.round(clamp(incoming?.safeMarginPx, 24, 320, fallback.safeMarginPx)),
    maxTextWidthPx: Math.round(clamp(incoming?.maxTextWidthPx, 240, 1920, fallback.maxTextWidthPx)),
    lineHeight: clamp(incoming?.lineHeight, 1, 2.4, fallback.lineHeight),
    panelPadding: Math.round(clamp(incoming?.panelPadding, 0, 80, fallback.panelPadding)),
    roleGap: Math.round(clamp(incoming?.roleGap, 0, 80, fallback.roleGap)),
    blockGap: Math.round(clamp(incoming?.blockGap, 0, 120, fallback.blockGap)),
    panelAlpha: clamp(incoming?.panelAlpha, 0, 1, fallback.panelAlpha),
    emergencyBreak: Boolean(incoming?.emergencyBreak ?? fallback.emergencyBreak),
  };
}

function recordRender(projectId, record) {
  const project = readProject(projectId);
  const next = {
    ...project,
    renders: [...(project.renders || []), record].slice(-40),
    updatedAt: new Date().toISOString(),
  };
  writeJSON(projectPath(projectId), next);
  return next;
}

module.exports = {
  ROOT,
  SOURCES_DIR,
  PROJECTS_DIR,
  RENDERS_DIR,
  sha256,
  listSources,
  loadSource,
  listProjects,
  createProject,
  readProject,
  updateProject,
  recordRender,
  safeId,
};
