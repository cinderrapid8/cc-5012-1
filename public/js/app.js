import * as Engine from './layout-engine.js';
import { diagnoseTrace } from './break-diagnostics.js';

const $ = (selector) => document.querySelector(selector);
const state = {
  source: null,
  sourceMeta: null,
  project: null,
  projectMeta: null,
  activeGroupId: null,
  time: 1,
  fps: 25,
  playing: false,
  zoom: 0.52,
  guides: false,
  layout: null,
  dirty: false,
  saveInFlight: false,
  fonts: null,
  renders: [],
  diagnostics: null,
  trace: null,
  focus: null,
  coverage: null,
};

const els = {
  sourceTitle: $('#source-title'),
  sourceBadge: $('#source-badge'),
  sourceMeta: $('#source-meta'),
  sourceGroups: $('#source-groups'),
  projects: $('#projects'),
  revisionLine: $('#revision-line'),
  fonts: $('#fonts'),
  stageShell: $('#stage-shell'),
  video: $('#video'),
  overlay: $('#overlay'),
  scrub: $('#scrub'),
  timecode: $('#timecode'),
  play: $('#play'),
  stepBack: $('#step-back'),
  stepFwd: $('#step-fwd'),
  guides: $('#guides'),
  showFrame: $('#show-frame'),
  zoom: $('#zoom'),
  zoomLabel: $('#zoom-label'),
  liveIssues: $('#live-issues'),
  save: $('#btn-save'),
  saveStatus: $('#save-status'),
  groupTabs: $('#group-tabs'),
  editor: $('#editor'),
  diagnostics: $('#diagnostics'),
  renders: $('#renders'),
};

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败 ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

async function boot() {
  try {
    const { sources } = await api('/api/sources');
    const meta = sources[0];
    state.sourceMeta = meta;
    const raw = await api(`/api/sources/${meta.id}/raw`);
    state.source = raw.data;
    state.fps = Number(state.source.fps) || 25;
    els.scrub.max = String(raw.data.duration);
    const { projects } = await api('/api/projects');
    const existing = projects.find((project) => project.sourceId === meta.id && project.sourceHash === meta.hash)
      || projects.find((project) => project.sourceId === meta.id);
    if (existing) {
      await loadProject(existing.projectId);
    } else {
      state.project = null;
      const fontData = await api(`/api/fonts/status?sourceId=${encodeURIComponent(meta.id)}`);
      state.fonts = fontData.fonts;
      renderSource();
      renderProjects(projects);
      renderFonts();
      renderEditorPlaceholder();
      renderDiagnostics(null);
      setTime(1);
    }
    bind();
    registerPreviewFonts();
    await Engine.ensureFontsLoaded(state.source.settings, [40, state.source.settings.original.fontSize, state.source.settings.translation.fontSize]);
    await relayout();
  } catch (error) {
    toast(`启动失败：${error.message}`, 'bad');
    console.error(error);
  }
}

function allProjectGroups() {
  return state.project ? state.project.groups : [];
}

function sourceGroupFor(id) {
  return state.source.groups.find((group) => group.id === id) || null;
}

function editFor(id) {
  const group = allProjectGroups().find((item) => item.id === id);
  return group ? group.edit : null;
}

async function loadProject(projectId) {
  const data = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  state.project = data.project;
  state.projectMeta = { sourceHash: data.sourceHash, integrity: data.sourceIntegrity };
  state.activeGroupId = state.project.groups[0]?.id || null;
  state.fonts = await api(`/api/fonts/status?projectId=${encodeURIComponent(projectId)}`).then((data) => data.fonts);
  const { projects } = await api('/api/projects');
  renderSource();
  renderProjects(projects);
  renderFonts();
  renderGroupTabs();
  renderEditor();
  await Engine.ensureFontsLoaded(state.project.settings, [40, state.project.settings.original.fontSize, state.project.settings.translation.fontSize]);
  setTime(state.time);
  renderRenders();
  setDirty(false);
}

async function createProject() {
  if (state.project) {
    const ok = await confirmDialog('新建独立工程', '当前已存在工程。新建会从只读源生成另一份独立工程版本，不会修改源或现有工程。是否继续？');
    if (!ok) return;
  }
  try {
    const body = { sourceId: state.sourceMeta.id, actor: 'editor' };
    if (state.project) body.forceNew = true;
    const { project } = await api('/api/projects', { method: 'POST', body });
    await loadProject(project.projectId);
    toast('已创建独立工程，源字幕保持只读', 'good');
  } catch (error) {
    toast(`创建失败：${error.message}`, 'bad');
  }
}

function setDirty(dirty) {
  state.dirty = dirty;
  els.saveStatus.className = dirty ? 'status warn' : 'status good';
  els.saveStatus.textContent = dirty ? '有未保存修改' : '已保存';
}

async function save() {
  if (!state.project || state.saveInFlight) return;
  state.saveInFlight = true;
  els.saveStatus.textContent = '保存中…';
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.project.projectId)}`, {
      method: 'PUT',
      body: {
        project: { ...state.project, revision: state.project.revision },
        expectedRevision: state.project.revision,
        actor: 'editor',
      },
    });
    state.project = result.project;
    setDirty(false);
    await refreshProjectLists();
    toast(result.changed ? `已保存 v${result.project.revision}` : '无变化', 'good');
  } catch (error) {
    if (error.status === 409) {
      toast('保存冲突：工程已在别处更新。请重新载入后再保存。', 'bad');
    } else {
      toast(`保存失败：${error.message}`, 'bad');
    }
  } finally {
    state.saveInFlight = false;
  }
}

async function refreshProjectLists() {
  const { projects } = await api('/api/projects');
  renderProjects(projects);
  renderRenders();
}

function renderSource() {
  els.sourceTitle.textContent = state.source.title;
  const meta = state.sourceMeta;
  els.sourceMeta.innerHTML = `
    <span class="k">sourceId</span><span class="v">${escapeHtml(state.source.sourceId)}</span>
    <span class="k">SHA-256</span><span class="v">${escapeHtml(meta.hash.slice(0, 16))}…</span>
    <span class="k">视频</span><span class="v">${escapeHtml(state.source.video)}</span>
    <span class="k">帧率/时长</span><span class="v">${state.source.fps} fps · ${state.source.duration}s</span>
    <span class="k">画布</span><span class="v">${state.source.canvas.width}×${state.source.canvas.height}</span>`;
  els.sourceGroups.innerHTML = state.source.groups.map((group) => `
    <div class="source-item locked" title="只读：渲染与工程均不会修改此处原文/译文">
      <div class="sid">${escapeHtml(group.id)} <span class="lock-tag">READ-ONLY</span> · ${formatRange(group.start, group.end)}</div>
      <div class="sline">${escapeHtml(group.original)}</div>
      <div class="sline tr">${escapeHtml(group.translation)}</div>
    </div>`).join('');
  const integrity = state.projectMeta?.integrity;
  els.sourceBadge.className = integrity === false ? 'source-badge bad' : 'source-badge';
  els.sourceBadge.textContent = integrity === false ? '源哈希不一致（禁止渲染）' : '源：只读';
}

function renderProjects(projects) {
  els.projects.innerHTML = projects.length
    ? projects.map((project) => `
      <div class="project-item ${state.project?.projectId === project.projectId ? 'active' : ''}" data-project="${escapeHtml(project.projectId)}">
        <div class="pname">${escapeHtml(project.name)}${project.sourceMatches === false ? ' <span class="lock-tag">源已变更</span>' : ''}</div>
        <div class="pmeta">v${project.revision} · ${project.groupCount} 组 · 渲染 ${project.renderCount} 次</div>
      </div>`).join('')
    : '<div class="muted small">尚无工程。点击“新建工程”从只读源创建独立版本。</div>';
  els.projects.querySelectorAll('[data-project]').forEach((node) => {
    node.addEventListener('click', async () => {
      if (node.dataset.project === state.project?.projectId) return;
      if (state.dirty && !(await confirmDialog('切换工程', '当前工程有未保存修改。切换会丢失这些修改，是否继续？'))) return;
      await loadProject(node.dataset.project);
    });
  });
  els.revisionLine.textContent = state.project
    ? `当前 ${state.project.projectId} · r${state.project.revision} · ${state.project.groups.length} 组`
    : '';
}

function renderFonts() {
  const report = state.fonts?.families || [];
  els.fonts.innerHTML = report.map((font) => {
    const missing = font.status === 'missing-file';
    return `<div class="font-item ${missing ? 'missing' : ''}">
      <div class="fname"><strong>${escapeHtml(font.family)}</strong>
        <span class="fbadge" style="color:${missing ? 'var(--bad)' : 'var(--good)'}">${missing ? '缺失' : '可用'}</span></div>
      <div class="fdetail">${escapeHtml(font.file)}${font.glyphs ? ` · ${font.glyphs} glyphs` : ''}${font.note ? `<br>${escapeHtml(font.note)}` : ''}</div>
    </div>`;
  }).join('') + `
    <div class="font-item">
      <div class="fname"><strong>实际回退</strong><span class="fbadge" style="color:var(--accent-2)">按字形</span></div>
      <div class="fdetail" id="fallback-detail">正在从渲染结果统计实际字形来源…</div>
    </div>`;
  updateFallbackDetail();
}

async function updateFallbackDetail() {
  const node = $('#fallback-detail');
  if (!node) return;
  if (!state.layout || !state.layout.blocks.length) {
    node.textContent = '当前帧无活动字幕。';
    return;
  }
  const requested = state.fonts?.families || [];
  const missing = requested.filter((font) => font.status === 'missing-file').map((font) => font.family);
  const lines = [];
  const byGlyph = state.coverage?.byGlyph || {};
  for (const block of state.layout.blocks) {
    for (const role of block.roles) {
      const runs = new Map();
      const unresolved = new Set();
      for (const grapheme of Engine.segmentGraphemes(role.text || '')) {
        if (/^\s$/u.test(grapheme)) continue;
        const record = byGlyph[grapheme];
        if (!record) continue;
        const name = record.family;
        runs.set(name, (runs.get(name) || 0) + 1);
        if (record.fallback) unresolved.add(grapheme);
      }
      const used = [...runs.entries()].map(([family, count]) => `${family}(${count})`).join(' + ');
      lines.push(`${block.groupId}/${role.role === 'original' ? '原文' : '译文'} → ${used || '无'}`);
      if (unresolved.size) lines.push(`  ⚠ 无字体覆盖：${[...unresolved].join(' ')}`);
    }
  }
  const measured = await measureActualFonts();
  const aliasOf = new Map();
  for (const font of requested) {
    if (font.internalFamily) aliasOf.set(font.internalFamily, font.family);
  }
  const measuredLine = measured.length
    ? measured.map((item) => `<div>实测 ${escapeHtml(item.key)} → ${escapeHtml(item.families.map((font) => {
      const alias = aliasOf.get(font.family);
      return `${alias ? `${alias} ⇒ ` : ''}${font.family}（字形 ${font.glyphs}）`;
    }).join(' + '))}</div>`).join('')
    : '';
  const missingLine = missing.length ? `请求但缺失：${missing.join('、')}（实际按字形回退到后续字体）` : '声明的字体文件均已请求成功';
  node.innerHTML = `<div>${escapeHtml(missingLine)}</div>${lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}${measuredLine}
    <div class="small" style="margin-top:4px;color:#8a9aab">“预排”按 cmap 覆盖；“实测”由服务端用真实浏览器排版后回读平台字体。平台回读给出字体文件内部名与命名实例，声明别名以 ⇒ 对应；可变字体的字重由 CSS font-weight 实时选取。</div>`;
}

async function measureActualFonts() {
  try {
    const active = activeGroupsAt(state.time);
    if (!active.length || !state.project) return [];
    const result = await api('/api/fonts/measured', {
      method: 'POST',
      body: {
        projectId: state.project.projectId,
        groups: active.map((group) => ({ id: group.id, original: group.original, translation: group.translation })),
      },
    });
    return result.summary || [];
  } catch (error) {
    return [];
  }
}

function summarizeRuns(runs) {
  const byFamily = new Map();
  for (const run of runs) byFamily.set(run.family, (byFamily.get(run.family) || 0) + Array.from(run.text).length);
  return [...byFamily.entries()].map(([family, count]) => `${family}(${count})`).join(' + ');
}

function renderGroupTabs() {
  if (!state.project) {
    els.groupTabs.innerHTML = '';
    return;
  }
  const overlapping = computeOverlaps();
  els.groupTabs.innerHTML = state.project.groups.map((group) => `
    <button class="gtab ${state.activeGroupId === group.id ? 'active' : ''}" data-group="${escapeHtml(group.id)}">
      ${escapeHtml(group.id)}${overlapping.has(group.id) ? '<span class="ov">↯</span>' : ''}
    </button>`).join('');
  els.groupTabs.querySelectorAll('[data-group]').forEach((node) => {
    node.addEventListener('click', () => {
      state.activeGroupId = node.dataset.group;
      renderGroupTabs();
      renderEditor();
      setTime(groupMidpoint(node.dataset.group));
    });
  });
}

function computeOverlaps() {
  const set = new Set();
  const groups = allProjectGroups();
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const a = groups[i].edit;
      const b = groups[j].edit;
      if (Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0) {
        set.add(groups[i].id);
        set.add(groups[j].id);
      }
    }
  }
  return set;
}

function groupMidpoint(id) {
  const edit = editFor(id);
  return edit ? (edit.start + edit.end) / 2 : state.time;
}

function renderEditorPlaceholder() {
  els.editor.innerHTML = `<div class="muted small">尚未创建工程。源字幕只读；点击“新建工程”后可编辑并形成独立版本。</div>`;
}

function renderEditor() {
  if (!state.project) return renderEditorPlaceholder();
  const group = allProjectGroups().find((item) => item.id === state.activeGroupId) || allProjectGroups()[0];
  if (!group) {
    els.editor.innerHTML = '<div class="muted small">无字幕组。</div>';
    return;
  }
  state.activeGroupId = group.id;
  const edit = group.edit;
  const source = group.source;
  const roles = state.layout?.blocks?.find((block) => block.groupId === group.id)?.roles || [];
  const settings = state.project.settings;

  els.editor.innerHTML = `
    <div class="editor-head">
      <h2>${escapeHtml(group.id)}</h2>
      <span class="hint">源保持只读 · 修改写入工程</span>
    </div>
    <div class="row2">
      <label class="field">开始 (s)
        <input type="number" step="0.01" min="0" data-field="start" value="${edit.start}" />
      </label>
      <label class="field">结束 (s)
        <input type="number" step="0.01" min="0" data-field="end" value="${edit.end}" />
      </label>
    </div>
    <div class="origin-note">源时间 ${formatRange(source.start, source.end)} · 帧 ${Math.round(edit.start * state.fps)}–${Math.round(edit.end * state.fps)}（结束帧独占）</div>
    <div class="block-title">原文 ORIGINAL · 源语言 ${escapeHtml(state.source.languages.original)}</div>
    <label class="field">
      <textarea class="orig" data-field="original" spellcheck="false">${escapeHtml(edit.original)}</textarea>
      <span class="hint">源原文：${escapeHtml(source.original)}</span>
    </label>
    <div class="block-title">译文 TRANSLATION · ${escapeHtml(state.source.languages.translation)}</div>
    <label class="field">
      <textarea class="trans" data-field="translation" spellcheck="false">${escapeHtml(edit.translation)}</textarea>
      <span class="hint">源译文：${escapeHtml(source.translation)}</span>
    </label>
    <div class="block-title">本组框宽（双语断行内核驱动）</div>
    <div class="row2">
      <label class="field">框宽 px
        <input type="number" step="10" min="${Engine.MIN_BOX_WIDTH_PX}" max="1920" data-group-box value="${edit.boxWidthPx ?? ''}" placeholder="跟随文本最大宽度" />
      </label>
      <label class="field">框宽来源
        <span class="hint" data-box-source>${edit.boxWidthPx == null ? '跟随设置的最大宽度' : '拖动/输入的本组框宽'}</span>
      </label>
    </div>
    <div class="hint">拖动预览中的橙色手柄，或在此输入框宽；两者都写入工程并按当前修订重新断行。清空则回落到文本最大宽度。</div>
    <div class="block-title">版式（作用于全片，作为独立工程设置保存）</div>
    <div class="row4">
      ${roleControls('original', '原文字号', settings.original)}
      ${roleControls('translation', '译文字号', settings.translation)}
    </div>
    <div class="row4">
      <label class="field">安全边距 <input type="number" step="1" min="24" max="320" data-setting="safeMarginPx" value="${settings.safeMarginPx}" /></label>
      <label class="field">文本最大宽度 <input type="number" step="10" min="240" max="1920" data-setting="maxTextWidthPx" value="${settings.maxTextWidthPx}" /></label>
      <label class="field">行高倍率 <input type="number" step="0.02" min="1" max="2.4" data-setting="lineHeight" value="${settings.lineHeight}" /></label>
      <label class="field">段间距 <input type="number" step="1" min="0" max="120" data-setting="blockGap" value="${settings.blockGap}" /></label>
    </div>
    <div class="row4">
      <label class="field">原文行数 <input type="number" step="1" min="1" max="6" data-setting="original.maxLines" value="${settings.original.maxLines}" /></label>
      <label class="field">译文行数 <input type="number" step="1" min="1" max="6" data-setting="translation.maxLines" value="${settings.translation.maxLines}" /></label>
      <label class="field">面板内边距 <input type="number" step="1" min="0" max="80" data-setting="panelPadding" value="${settings.panelPadding}" /></label>
      <label class="field">角色间距 <input type="number" step="1" min="0" max="80" data-setting="roleGap" value="${settings.roleGap}" /></label>
    </div>
    <label class="toggle"><input type="checkbox" data-setting="emergencyBreak" ${settings.emergencyBreak ? 'checked' : ''}/> 允许超长词应急断行（默认关闭；关闭时只报告溢出，不切分词）</label>
    <div class="hint">预览缩放只改变查看比例，最终画布始终为 ${state.source.canvas.width}×${state.source.canvas.height}，字号与安全边界按像素计。</div>
  `;

  els.editor.querySelectorAll('[data-field]').forEach((node) => {
    node.addEventListener('input', () => {
      const field = node.dataset.field;
      const value = field === 'original' || field === 'translation' ? node.value : Number(node.value);
      if ((field === 'start' || field === 'end') && !Number.isFinite(value)) return;
      group.edit[field] = value;
      if (field !== 'start' && field !== 'end') {
        group.edit[`${field}Override`] = node.value;
      }
      setDirty(true);
      markGroupEdited(group.id);
      if (field === 'start' || field === 'end') setTime(state.time, { silent: true });
      scheduleRelayout();
    });
  });
  els.editor.querySelectorAll('[data-setting]').forEach((node) => {
    node.addEventListener('input', () => {
      const path = node.dataset.setting;
      const raw = node.type === 'checkbox' ? node.checked : Number(node.value);
      if (node.type === 'checkbox') setSetting(path, raw);
      else if (Number.isFinite(raw)) setSetting(path, raw);
      setDirty(true);
      scheduleRelayout();
    });
  });
  const boxInput = els.editor.querySelector('[data-group-box]');
  if (boxInput) {
    boxInput.addEventListener('input', () => {
      const raw = boxInput.value.trim();
      const value = raw === '' ? null : Number(raw);
      if (raw !== '' && !Number.isFinite(value)) return;
      group.edit.boxWidthPx = value == null ? null : Math.round(value);
      const sourceNode = els.editor.querySelector('[data-box-source]');
      if (sourceNode) sourceNode.textContent = value == null ? '跟随设置的最大宽度' : '拖动/输入的本组框宽';
      setDirty(true);
      scheduleRelayout();
    });
  }
  els.editor.querySelectorAll('[data-role-setting]').forEach((node) => {
    node.addEventListener('input', () => {
      const [role, key] = node.dataset.roleSetting.split('.');
      const value = Number(node.value);
      if (!Number.isFinite(value)) return;
      state.project.settings[role][key] = value;
      setDirty(true);
      scheduleRelayout();
    });
  });
}

function roleControls(role, label, settings) {
  return `
    <label class="field">${label}
      <input type="number" step="1" min="12" max="160" data-role-setting="${role}.fontSize" value="${settings.fontSize}" />
    </label>
    <label class="field">行数
      <input type="number" step="1" min="1" max="6" data-role-setting="${role}.maxLines" value="${settings.maxLines}" />
    </label>`;
}

function setSetting(path, value) {
  const parts = path.split('.');
  let target = state.project.settings;
  for (let i = 0; i < parts.length - 1; i += 1) target = target[parts[i]];
  target[parts[parts.length - 1]] = value;
}

function markGroupEdited(id) {
  const override = state.project.groups.find((group) => group.id === id)?.edit;
  if (!override) return;
  const source = sourceGroupFor(id);
  state.project.groups.find((group) => group.id === id).edit.originalOverride = override.original !== source.original ? override.original : null;
  state.project.groups.find((group) => group.id === id).edit.translationOverride = override.translation !== source.translation ? override.translation : null;
}

let layoutTimer = null;
function scheduleRelayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => relayout(), 90);
}

function activeGroupsAt(time) {
  return allProjectGroups()
    .filter((group) => time >= group.edit.start && time < group.edit.end)
    .sort((a, b) => a.edit.start - b.edit.start)
    .map((group) => ({
      id: group.id,
      original: group.edit.original,
      translation: group.edit.translation,
      start: group.edit.start,
      end: group.edit.end,
      boxWidthPx: group.edit.boxWidthPx,
    }));
}

function activeGroupsForLayout(time) {
  return activeGroupsAt(time);
}

async function relayout() {
  if (!state.project) return;
  const active = activeGroupsForLayout(state.time);
  const trace = {
    revision: state.project.revision,
    languages: state.source.languages,
    coverage: state.coverage || undefined,
  };
  try {
    state.coverage = await loadCoverage(active);
  } catch {
    // Coverage is advisory; a failed lookup must not abort the layout. The trace
    // still records that shaping had no coverage map.
  }
  if (state.coverage) trace.coverage = state.coverage;
  const layout = Engine.buildLayout({ activeGroups: active, settings: state.project.settings, canvas: state.source.canvas, trace });
  state.layout = layout;
  state.trace = layout.trace || null;
  state.diagnostics = state.trace ? diagnoseTrace(state.trace) : null;
  await paintOverlay(layout);
  renderDiagnostics(layout);
  syncBoxControl();
  updateLiveIssues(layout);
  await updateFallbackDetail();
}

// Keeps the editor's box-width field in step with a drag without re-rendering the
// editor (which would drop the caret while the user is typing).
function syncBoxControl() {
  const input = els.editor.querySelector('[data-group-box]');
  if (!input || input === document.activeElement) return;
  const group = allProjectGroups().find((item) => item.id === state.activeGroupId);
  const next = group?.edit?.boxWidthPx ?? '';
  if (String(input.value) !== String(next)) input.value = next;
  const sourceNode = els.editor.querySelector('[data-box-source]');
  if (sourceNode) sourceNode.textContent = group?.edit?.boxWidthPx == null ? '跟随设置的最大宽度' : '拖动/输入的本组框宽';
}

const coverageCache = new Map();
async function loadCoverage(active) {
  const text = active.map((group) => `${group.original}\u0000${group.translation}`).join('\u0000');
  if (!text) return null;
  const key = `${state.project.revision}|${text}`;
  if (coverageCache.has(key)) return coverageCache.get(key);
  if (!state.project) return null;
  const report = await api('/api/font-coverage', {
    method: 'POST',
    body: { text: active.map((group) => `${group.original}\n${group.translation}`).join('\n'), settings: state.project.settings },
  });
  const coverage = { byGlyph: report.byGlyph || {}, families: report.families || [] };
  coverageCache.set(key, coverage);
  return coverage;
}

async function paintOverlay(layout) {
  const scale = state.zoom;
  const shell = els.stageShell;
  shell.style.width = `${state.source.canvas.width * scale}px`;
  shell.style.height = `${state.source.canvas.height * scale}px`;
  els.video.style.width = `${state.source.canvas.width * scale}px`;
  els.video.style.height = `${state.source.canvas.height * scale}px`;
  const inner = document.createElement('div');
  inner.style.position = 'absolute';
  inner.style.left = '0';
  inner.style.top = '0';
  inner.style.width = `${state.source.canvas.width}px`;
  inner.style.height = `${state.source.canvas.height}px`;
  inner.style.transform = `scale(${scale})`;
  inner.style.transformOrigin = 'top left';
  inner.innerHTML = Engine.renderOverlayHTML(layout, state.project.settings, { guides: state.guides, draggable: true });
  els.overlay.innerHTML = '';
  els.overlay.appendChild(inner);
  wireBoxDrag(inner);
}

// Box width is driven by the bilingual break kernel: the drag sets boxWidthPx,
// the kernel re-breaks, and any resulting failure is fed back into the same
// diagnostics panel rather than being visually smoothed over.
function wireBoxDrag(root) {
  root.querySelectorAll('[data-box-handle]').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const groupId = handle.dataset.boxHandle;
      const block = state.layout?.blocks?.find((item) => item.groupId === groupId);
      if (!block) return;
      const scale = state.zoom || 1;
      const startX = event.clientX;
      const startWidth = block.availableWidth;
      const canvasLimit = block.canvasTextLimit;
      handle.setPointerCapture(event.pointerId);
      let lastWidth = startWidth;
      const onMove = (moveEvent) => {
        const delta = (moveEvent.clientX - startX) / scale;
        const next = Math.max(Engine.MIN_BOX_WIDTH_PX, Math.min(canvasLimit, Math.round(startWidth + delta * 2)));
        if (next === lastWidth) return;
        lastWidth = next;
        setGroupBoxWidth(groupId, next);
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        relayout();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  });
}

function setGroupBoxWidth(groupId, width) {
  const group = allProjectGroups().find((item) => item.id === groupId);
  if (!group) return;
  group.edit.boxWidthPx = width;
  setDirty(true);
  scheduleRelayout();
}

function updateLiveIssues(layout) {
  const issues = layout.issues || [];
  const errors = issues.filter((issue) => ['line-overflow', 'unbreakable-token', 'max-lines-exceeded', 'text-integrity', 'punctuation-boundary', 'vertical-overflow', 'safe-margin', 'safe-margin-vertical'].includes(issue.type));
  const overlap = issues.filter((issue) => issue.type === 'time-overlap');
  const parts = [];
  if (errors.length) parts.push(`排版问题 ${errors.length}`);
  if (overlap.length) parts.push(`时间交叠 ${overlap.length}`);
  if (!parts.length) parts.push('排版通过');
  els.liveIssues.textContent = `${parts.join(' · ')} · ${layout.blocks.length} 层活动`;
  els.liveIssues.className = `status ${errors.length ? 'bad' : overlap.length ? 'warn' : 'good'}`;
}

function renderDiagnostics(layout) {
  if (!layout) {
    els.diagnostics.innerHTML = '<div class="muted small">创建工程后开始实时诊断。</div>';
    return;
  }
  const blocks = layout.blocks || [];
  const issues = layout.issues || [];
  const suggestions = layout.suggestions || [];
  if (!blocks.length) {
    els.diagnostics.innerHTML = '<div class="muted small">当前时间点无字幕。</div>';
    return;
  }
  const html = blocks.map((block) => {
    const blockIssues = issues.filter((issue) => issue.groupId === block.groupId);
    const blockSugg = suggestions.filter((suggestion) => suggestion.groupId === block.groupId);
    const roleHtml = block.roles.map((role) => {
      const integrity = role.integrity?.ok
        ? '<span style="color:var(--good)">字符完整</span>'
        : '<span style="color:var(--bad)">字符不一致</span>';
      const rows = role.lines.map((line, index) => `
        <tr>
          <td class="w">${index + 1}</td>
          <td class="t">${escapeHtml(line.text)}</td>
          <td class="w ${line.over > 0 ? 'over' : ''}">${line.width.toFixed(1)}${line.over > 0 ? ` (+${line.over.toFixed(1)})` : ''}px</td>
        </tr>`).join('');
      const boundary = (role.boundaryViolations || []).length
        ? `<tr><td colspan="3" style="color:var(--bad)">标点禁则：${(role.boundaryViolations || []).map((v) => `${v.position === 'start' ? '行首' : '行尾'}「${v.grapheme}」`).join('，')}</td></tr>`
        : '';
      return `
        <div class="diag ${role.issues?.length ? 'warn' : 'good'}">
          <div class="dtitle"><span>${role.role === 'original' ? '原文' : '译文'} · ${role.lines.length} 行 / 上限 ${role.maxLines}</span>${integrity}</div>
          <div class="dmeta">字号 ${role.fontSize}px · 行高 ${role.lineHeightPx}px · 盒宽 ${role.width.toFixed(1)}px</div>
          <table class="lines-table">
            ${rows}
            ${boundary}
          </table>
        </div>`;
    }).join('');
    const issueHtml = blockIssues.map((issue) => `<div class="diag error"><div class="dtitle">${escapeHtml(issueLabel(issue))}</div><div class="dmeta">${escapeHtml(issueMeta(issue))}</div></div>`).join('');
    const suggHtml = blockSugg.map((group) => `
      <div class="diag">
        <div class="dtitle"><span>可调整项 · ${group.role === 'original' ? '原文' : '译文'}</span></div>
        <ul class="sugg">
          ${group.suggestions.map((suggestion, index) => `<li><button data-suggest="${escapeHtml(group.groupId)}|${escapeHtml(group.role)}|${index}" ${suggestion.possible === false ? 'disabled' : ''}>${escapeHtml(suggestion.label)}</button></li>`).join('')}
        </ul>
      </div>`).join('');
    return `${roleHtml}${issueHtml}${suggHtml}`;
  }).join('');
  const globalIssues = issues.filter((issue) => !issue.groupId);
  const globalHtml = globalIssues.map((issue) => `<div class="diag error"><div class="dtitle">${escapeHtml(issueLabel(issue))}</div><div class="dmeta">${escapeHtml(issueMeta(issue))}</div></div>`).join('');
  const traceHtml = renderTracePanel(state.diagnostics, layout);
  els.diagnostics.innerHTML = traceHtml + html + globalHtml || '<div class="diag good"><div class="dtitle">排版通过</div></div>';
  els.diagnostics.querySelectorAll('[data-suggest]').forEach((node) => {
    node.addEventListener('click', () => { applySuggestion(node.dataset.suggest).catch((error) => toast(`应用建议失败：${error.message}`, 'bad')); });
  });
  els.diagnostics.querySelectorAll('[data-locate]').forEach((node) => {
    node.addEventListener('click', () => locateGroup(node.dataset.locate));
  });
}

// The trace panel is the UI half of the break kernel: it shows which stage owns
// each wrong line, the language pair, and the exact project revision the trace
// was computed against. Every failure is reported, never defaulted away.
function renderTracePanel(diagnostics, layout) {
  if (!diagnostics) {
    return `<div class="diag warn"><div class="dtitle"><span>断行追踪</span><span class="fbadge">无 trace</span></div>
      <div class="dmeta">当前排版未附带追踪数据。</div></div>`;
  }
  const trace = state.trace;
  const binding = diagnostics.binding;
  if (!trace) {
    return `<div class="diag warn"><div class="dtitle"><span>断行追踪</span><span class="fbadge">无 trace</span></div>
      <div class="dmeta">当前排版未附带追踪数据。</div></div>`;
  }
  const problems = diagnostics.completeness?.problems || [];
  const roleById = new Map();
  for (const role of trace?.roles || []) roleById.set(`${role.groupId}|${role.role}`, role);
  const attributions = (diagnostics.attributions || []).filter((item) => item.cause !== 'fit');
  // One role-level cause (a line budget or a dragged box) applies to every line.
  // Group those so the panel shows the cause once with the affected line range,
  // instead of repeating an identical card per line.
  const groups = new Map();
  for (const item of attributions) {
    const key = `${item.scope.groupId}|${item.scope.role}|${item.cause}|${item.stage}`;
    if (!groups.has(key)) groups.set(key, { ...item, lines: [] });
    if (item.line) groups.get(key).lines.push(item.line);
  }
  const rows = [...groups.values()].map((item) => {
    const role = roleById.get(`${item.scope.groupId}|${item.scope.role}`);
    const stage = item.stage || '—';
    const phase = item.phase || '—';
    const lineList = item.lines || [];
    const lineLabel = lineList.length
      ? (lineList.length === 1
        ? `行 ${lineList[0].lineIndex + 1} · ${lineList[0].width}px${lineList[0].over > 0 ? ` (+${lineList[0].over})` : ''}`
        : `行 ${lineList[0].lineIndex + 1}–${lineList[lineList.length - 1].lineIndex + 1} · 最宽 ${Math.max(...lineList.map((line) => line.width))}px`)
      : '';
    const evidence = item.evidence ? Object.entries(item.evidence)
      .filter(([, value]) => value != null)
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join(' ') : '';
    const text = lineList.length === 1 ? (lineList[0].text || '') : '';
    return `<div class="cause bad">
      <div class="ctitle"><code>${escapeHtml(item.cause)}</code><span class="stage-tag">${escapeHtml(stage)} · ${escapeHtml(phase)}</span></div>
      <div class="cmeta">${escapeHtml(item.scope.groupId)}/${item.scope.role === 'original' ? '原文' : '译文'}${lineLabel ? ` · ${escapeHtml(lineLabel)}` : ''}${role?.stages?.bind?.language ? ` · ${escapeHtml(role.stages.bind.language)}` : ''}</div>
      ${text ? `<div class="ctext">${escapeHtml(text)}</div>` : ''}
      <div class="cwhy">${escapeHtml(item.text)}</div>
      ${evidence ? `<div class="cmeta">${escapeHtml(evidence)}</div>` : ''}
      <div class="cmeta">画面 ${groupFrameLabel(item.scope.groupId)} <button class="btn small subtle" data-locate="${escapeHtml(item.scope.groupId)}">定位</button></div>
    </div>`;
  }).join('');
  const gaps = (diagnostics.languageGaps || []).map((gap) => `
    <div class="cause warn">
      <div class="ctitle"><code>language-length-gap</code><span class="stage-tag">bind · language-binding</span></div>
      <div class="cmeta">${escapeHtml(gap.groupId)} · 原文 ${gap.lines.original} 行 / 译文 ${gap.lines.translation} 行 · 宽度比 ${gap.widthRatio ?? '—'}</div>
      <div class="cmeta">画面 ${groupFrameLabel(gap.groupId)} <button class="btn small subtle" data-locate="${escapeHtml(gap.groupId)}">定位</button></div>
    </div>`).join('');
  const bindingProblems = diagnostics.bindings || [];
  const completeness = diagnostics.completeness?.ok
    ? '<span style="color:var(--good)">8 阶段齐全</span>'
    : `<span style="color:var(--bad)">${escapeHtml(problems.join(', '))}</span>`;
  return `
    <div class="diag ${problems.length || bindingProblems.length ? 'error' : 'good'}">
      <div class="dtitle"><span>断行追踪 · 修订 r${escapeHtml(String(binding.revision ?? '—'))}</span>${completeness}</div>
      <div class="dmeta">语言 ${escapeHtml(binding.languages?.original ?? '?')} → ${escapeHtml(binding.languages?.translation ?? '?')} · digest ${escapeHtml((binding.digest || '').slice(0, 12))}</div>
      <div class="dmeta">${(trace?.roles || []).map((role) => `${escapeHtml(role.groupId)}/${role.role} ${escapeHtml((role.digest || '').slice(0, 8))}`).join(' · ')}</div>
      ${bindingProblems.length ? `<div class="cwhy" style="color:var(--bad)">绑定问题：${escapeHtml(bindingProblems.map((item) => item.reason).join(', '))}</div>` : ''}
      <div class="dmeta">把鼠标放到字幕框右缘拖动可改框宽；每行归因如下。</div>
    </div>
    ${rows || '<div class="diag good"><div class="dtitle">所有行在可用宽度内，无需归因</div></div>'}
    ${gaps}`;
}

function groupFrameLabel(groupId) {
  const group = allProjectGroups().find((item) => item.id === groupId);
  if (!group) return '—';
  const start = Math.round(group.edit.start * state.fps);
  const end = Math.round(group.edit.end * state.fps);
  return `F${start}–F${end}（结束帧独占）· ${group.edit.start.toFixed(2)}–${group.edit.end.toFixed(2)}s`;
}

function locateGroup(groupId) {
  const group = allProjectGroups().find((item) => item.id === groupId);
  if (!group) return;
  state.activeGroupId = groupId;
  renderGroupTabs();
  renderEditor();
  setTime(groupMidpoint(groupId));
}

function issueLabel(issue) {
  const labels = {
    'line-overflow': '行溢出',
    'unbreakable-token': '不可断超长词',
    'max-lines-exceeded': '超出配置行数',
    'text-integrity': '文本完整性',
    'punctuation-boundary': '标点禁则',
    'vertical-overflow': '纵向溢出',
    'safe-margin': '安全边距',
    'safe-margin-vertical': '垂直安全边距',
    'time-overlap': '时间区间交叠',
    'too-many-active-groups': '同刻活动层过多',
  };
  const role = issue.role ? (issue.role === 'original' ? '原文' : '译文') : '';
  return `${labels[issue.type] || issue.type}${role ? ` · ${role}` : ''}${issue.groupId ? ` · ${issue.groupId}` : ''}`;
}

function issueMeta(issue) {
  if (issue.type === 'line-overflow') return `「${issue.text}」宽 ${issue.width}px，可用 ${issue.available}px，超出 ${issue.overflowPx}px`;
  if (issue.type === 'unbreakable-token') return `「${issue.text}」宽 ${issue.width}px，超出 ${issue.overflowPx}px；未拆分、未删词`;
  if (issue.type === 'max-lines-exceeded') return `需要 ${issue.needed} 行，上限 ${issue.maxLines} 行`;
  if (issue.type === 'vertical-overflow') return `内容高 ${issue.totalHeight}px，可用 ${issue.availableHeight}px，超出 ${issue.overflowPx}px`;
  if (issue.type === 'time-overlap') return `${issue.groupIds.join(' ↔ ')} 交叠 ${issue.overlapSeconds}s`;
  if (issue.type === 'too-many-active-groups') return `同刻 ${issue.activeCount} 层：${issue.groupIds.join(', ')}`;
  if (issue.type === 'text-integrity') return issue.message;
  if (issue.type === 'punctuation-boundary') return (issue.violations || []).map((v) => `${v.position}「${v.grapheme}」`).join('，');
  return issue.message || issue.label || '';
}

async function applySuggestion(key) {
  const [groupId, role, index] = key.split('|');
  const group = state.layout?.suggestions?.find((item) => item.groupId === groupId && item.role === role);
  const suggestion = group?.suggestions?.[Number(index)];
  if (!suggestion) return;
  const settings = state.project.settings;
  switch (suggestion.kind) {
    case 'increase-max-width':
      settings.maxTextWidthPx = suggestion.value;
      break;
    case 'decrease-font-size':
      if (role === '*') {
        settings.original.fontSize = suggestion.value;
        settings.translation.fontSize = Math.max(12, Math.round(suggestion.value * 0.72));
      } else {
        settings[role].fontSize = suggestion.value;
      }
      break;
    case 'increase-max-lines':
      settings[role].maxLines = suggestion.value;
      break;
    case 'allow-emergency-break':
      settings.emergencyBreak = true;
      break;
    default:
      toast('此建议需要人工处理（将在工程中记录）');
      return;
  }
  setDirty(true);
  renderEditor();
  relayout();
  toast('已应用版式调整，可撤销请重新载入工程');
}

function registerPreviewFonts() {
  const style = document.createElement('style');
  style.textContent = Engine.fontFaceCSS(state.source.settings);
  document.head.appendChild(style);
}

function setTime(time, options = {}) {
  const duration = Number(state.source?.duration) || 15;
  state.time = Math.max(0, Math.min(duration - 0.001, Number(time) || 0));
  if (!options.silent) {
    els.scrub.value = String(state.time);
    els.video.currentTime = state.time;
  }
  const frame = Math.round(state.time * state.fps);
  els.timecode.textContent = `${formatTime(state.time)} · F${frame}`;
  if (!state.playing) relayout();
}

function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
}

function formatRange(start, end) {
  return `${formatTime(start)}–${formatTime(end)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bind() {
  els.scrub.addEventListener('input', () => {
    els.video.pause();
    state.playing = false;
    els.play.textContent = '播放';
    setTime(Number(els.scrub.value));
  });
  els.play.addEventListener('click', () => {
    if (state.playing) {
      els.video.pause();
      state.playing = false;
      els.play.textContent = '播放';
    } else {
      state.playing = true;
      els.play.textContent = '暂停';
      els.video.play().catch(() => {});
    }
  });
  els.video.addEventListener('timeupdate', () => {
    if (!state.playing) return;
    state.time = els.video.currentTime;
    els.scrub.value = String(state.time);
    const frame = Math.round(state.time * state.fps);
    els.timecode.textContent = `${formatTime(state.time)} · F${frame}`;
    relayout();
  });
  els.video.addEventListener('ended', () => {
    state.playing = false;
    els.play.textContent = '播放';
  });
  els.stepBack.addEventListener('click', () => { els.video.pause(); state.playing = false; els.play.textContent = '播放'; setTime(state.time - 1 / state.fps); });
  els.stepFwd.addEventListener('click', () => { els.video.pause(); state.playing = false; els.play.textContent = '播放'; setTime(state.time + 1 / state.fps); });
  els.guides.addEventListener('change', () => { state.guides = els.guides.checked; relayout(); });
  els.showFrame.addEventListener('change', () => { els.video.style.visibility = els.showFrame.checked ? 'visible' : 'hidden'; });
  els.zoom.addEventListener('input', () => {
    state.zoom = Number(els.zoom.value) / 100;
    els.zoomLabel.textContent = `${els.zoom.value}%`;
    if (state.layout) paintOverlay(state.layout);
  });
  $('#btn-new-project').addEventListener('click', createProject);
  els.save.addEventListener('click', save);
  $('#btn-render').addEventListener('click', () => triggerRender('burn'));
  $('#btn-mask').addEventListener('click', () => triggerRender('preview-mask'));
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
    if (event.key === 'ArrowLeft' && event.target === document.body) { event.preventDefault(); setTime(state.time - 1 / state.fps); }
    if (event.key === 'ArrowRight' && event.target === document.body) { event.preventDefault(); setTime(state.time + 1 / state.fps); }
  });
  window.addEventListener('beforeunload', (event) => {
    if (state.dirty) { event.preventDefault(); event.returnValue = ''; }
  });
}

async function triggerRender(mode) {
  if (!state.project) return toast('请先创建工程', 'bad');
  if (state.dirty) {
    const ok = await confirmDialog('先保存再渲染', '有未保存修改。渲染会使用已保存的工程版本，是否先保存？');
    if (ok) await save();
  }
  const button = mode === 'burn' ? $('#btn-render') : $('#btn-mask');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = mode === 'burn' ? '渲染中…' : '生成中…';
  try {
    const { result } = await api(`/api/projects/${encodeURIComponent(state.project.projectId)}/render`, {
      method: 'POST',
      body: { mode, actor: 'editor' },
    });
    toast(`已生成 ${result.output}（${(result.bytes / 1024 / 1024).toFixed(1)} MB）`, 'good');
    await refreshProjectLists();
    renderRenders();
  } catch (error) {
    toast(`渲染失败：${error.message}`, 'bad');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function renderRenders() {
  const renders = state.project?.renders || [];
  els.renders.innerHTML = renders.slice().reverse().map((render) => `
    <div class="render-item">
      <div class="rtitle"><a href="${escapeHtml(render.outputUrl)}" target="_blank" rel="noopener">${escapeHtml(render.output)}</a>
        <span class="muted small">${render.mode === 'preview-mask' ? '遮罩' : '烧录'}</span></div>
      <div class="rmeta">${escapeHtml(render.generatedAt || '')} · r${render.projectRevision ?? '?'} · ${render.issueCount ?? 0} 个排版问题</div>
      <div class="rmeta">清单 ${escapeHtml(render.manifest || '')}</div>
    </div>`).join('') || '<div class="muted small">尚无渲染记录。</div>';
}

function confirmDialog(title, text) {
  return new Promise((resolve) => {
    const dialog = $('#confirm-dialog');
    $('#dialog-title').textContent = title;
    $('#dialog-text').textContent = text;
    dialog.returnValue = '';
    dialog.showModal();
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

boot();
