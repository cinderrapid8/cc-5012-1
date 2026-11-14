#!/usr/bin/env node
// Break-decision trace tool. Runs the shared layout engine inside the real
// browser, records a stage-by-stage trace for a subtitle revision, classifies
// each overflow, and can replay a saved trace to prove the result is identical.
//
// usage:
//   node scripts/break-trace.js --group g02 [--project <id>] [--box 720] [--json out.json]
//   node scripts/break-trace.js --case narrow-box --json runs/narrow.json
//   node scripts/break-trace.js --replay runs/narrow.json
//   node scripts/break-trace.js --case all --assert

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { launchBrowser } = require('../src/browser');
const store = require('../src/project-store');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.BENCH_TRACE_PORT || 4313);
const CASES = require('./break-trace-cases');

function usage() {
  console.error(`usage: node scripts/break-trace.js [--group ID] [--project ID] [--box PX] [--case NAME|all] [--json FILE] [--replay FILE] [--assert]`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { assert: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key === 'assert') { opts.assert = true; continue; }
    opts[key] = next && !next.startsWith('--') ? (i += 1, next) : true;
  }
  return opts;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = spawn('node', ['src/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout.on('data', (data) => {
      out += data.toString();
      if (out.includes('listening')) resolve(server);
    });
    server.stderr.on('data', (data) => { out += data.toString(); });
    server.on('error', reject);
    setTimeout(() => (out.includes('listening') ? null : reject(new Error(`server timeout: ${out}`))), 12000);
  });
}

function projectGroups(projectId) {
  const id = projectId || process.env.BENCH_PROJECT_ID || 'trench-signals-p2';
  try {
    return { project: store.readProject(id), sourceId: id };
  } catch (error) {
    const source = store.loadSource('trench-signals');
    return {
      project: {
        projectId: 'source-trench-signals',
        revision: 0,
        settings: source.data.settings,
        languages: source.data.languages,
        groups: source.data.groups.map((group) => ({ id: group.id, edit: group })),
      },
      sourceId: 'trench-signals',
    };
  }
}

async function runInBrowser(page, payload) {
  return page.evaluate(async (input) => {
    const Engine = await import('/public/js/layout-engine.js');
    const Diagnostics = await import('/public/js/break-diagnostics.js');
    const trace = {
      revision: input.revision,
      languages: input.languages,
      limits: input.limits || undefined,
      coverage: input.coverage || undefined,
    };
    const activeGroups = input.groups.map((group) => ({
      id: group.id,
      original: group.original,
      translation: group.translation,
      start: 0,
      end: 1,
      boxWidthPx: group.boxWidthPx,
    }));
    const layout = Engine.buildLayout({ activeGroups, settings: input.settings, canvas: input.canvas, trace });
    return {
      summary: Engine.layoutSummary(layout),
      issues: layout.issues,
      trace: layout.trace,
      diagnostics: Diagnostics.diagnoseTrace(layout.trace),
    };
  }, payload);
}

function digestShape(trace) {
  return {
    digest: trace.digest,
    schema: trace.schema,
    roles: (trace.roles || []).map((role) => ({
      groupId: role.groupId,
      role: role.role,
      digest: role.digest,
      stages: Object.fromEntries(Object.entries(role.stages).map(([name, stage]) => [name, stage?.digest || null])),
    })),
  };
}

async function traceCase(page, testCase, project) {
  const settings = JSON.parse(JSON.stringify(project.settings));
  if (testCase.settings) Object.assign(settings, testCase.settings);
  if (testCase.settings?.original) settings.original = { ...project.settings.original, ...testCase.settings.original };
  if (testCase.settings?.translation) settings.translation = { ...project.settings.translation, ...testCase.settings.translation };
  const groups = testCase.groups.map((group) => ({
    ...group,
    boxWidthPx: group.boxWidthPx != null ? group.boxWidthPx : testCase.boxWidthPx,
  }));
  const texts = groups.flatMap((group) => [group.original, group.translation]);
  const coverage = CASES.coverageFor(settings, texts);
  const payload = {
    settings,
    canvas: { width: 1920, height: 1080 },
    revision: project.revision,
    languages: project.languages || { original: 'en', translation: 'zh-Hans' },
    groups,
    coverage,
    limits: { maxUnits: 200 },
  };
  const result = await runInBrowser(page, payload);
  return {
    case: testCase.id,
    description: testCase.description,
    assertions: testCase.asserts || [],
    expect: testCase.expect || null,
    settings,
    groups,
    coverage,
    limits: payload.limits,
    trace: result.trace,
    issues: result.issues,
    diagnostics: result.diagnostics,
    summary: result.summary,
  };
}

function readPath(role, field) {
  if (!field) return role;
  const parts = field.split('.');
  if (parts[0] === 'title') parts.shift();
  const stages = role.stages || {};
  let value = { ...stages, ...role };
  for (const part of parts) {
    if (value == null) return undefined;
    value = value[part];
  }
  return value;
}

function roleMatches(role, assertion) {
  if (assertion.role && role.role !== assertion.role) return false;
  if (assertion.groupId && role.groupId !== assertion.groupId) return false;
  return true;
}

function evaluateAssertion(traced, assertion) {
  const roles = (traced.trace?.roles || []).filter((role) => roleMatches(role, assertion));
  const label = [
    assertion.groupId ? `${assertion.groupId}/` : '',
    assertion.role || '*',
    assertion.cause ? `cause=${assertion.cause}` : '',
    assertion.absentCause ? `absent=${assertion.absentCause}` : '',
    assertion.field ? `${assertion.field}${assertion.equals !== undefined ? `=${JSON.stringify(assertion.equals)}` : ''}` : '',
  ].filter(Boolean).join(' ');

  if (!roles.length) return { ok: false, label: `${label} (no matching role)` };

  if (assertion.cause || assertion.absentCause) {
    const causes = traced.diagnostics.attributions
      .filter((attribution) => attribution.scope.role === (assertion.role || attribution.scope.role))
      .filter((attribution) => !assertion.groupId || attribution.scope.groupId === assertion.groupId)
      .map((attribution) => attribution.cause);
    if (assertion.cause) {
      const hit = traced.diagnostics.attributions.find((attribution) => (
        attribution.cause === assertion.cause
        && (!assertion.role || attribution.scope.role === assertion.role)
        && (!assertion.groupId || attribution.scope.groupId === assertion.groupId)
        && (!assertion.stage || attribution.stage === assertion.stage)
      ));
      return hit
        ? { ok: true, label: `${label} -> ${hit.stage}` }
        : { ok: false, label: `${label} (got ${causes.join('|') || 'none'})` };
    }
    return causes.includes(assertion.absentCause)
      ? { ok: false, label: `${label} (found ${assertion.absentCause})` }
      : { ok: true, label };
  }

  for (const role of roles) {
    const got = readPath(role, assertion.field);
    if (assertion.equals !== undefined) {
      const ok = JSON.stringify(got) === JSON.stringify(assertion.equals);
      if (!ok) return { ok: false, label: `${label} (got ${JSON.stringify(got)})` };
    }
    if (assertion.atLeast !== undefined && !(typeof got === 'number' && got >= assertion.atLeast)) {
      return { ok: false, label: `${label} (got ${JSON.stringify(got)})` };
    }
    if (assertion.isTrue && got !== true) return { ok: false, label: `${label} (got ${JSON.stringify(got)})` };
  }
  return { ok: true, label };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.replay) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(opts.replay), 'utf8'));
    const saved = raw.trace ? raw : (raw.cases?.[0] || null);
    if (!saved || !saved.trace) {
      console.error(`replay file has no trace: ${opts.replay}`);
      process.exitCode = 2;
      return;
    }
    const before = digestShape(saved.trace);
    const server = await startServer();
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.goto(`http://127.0.0.1:${PORT}/render.html`, { waitUntil: 'load' });
      const result = await runInBrowser(page, {
        settings: saved.settings,
        canvas: { width: 1920, height: 1080 },
        revision: saved.trace.revision,
        languages: saved.trace.languages,
        groups: saved.groups,
        coverage: saved.coverage || undefined,
        limits: saved.limits || saved.trace.limits,
      });
      const after = digestShape(result.trace);
      const same = JSON.stringify(before) === JSON.stringify(after);
      const report = { replay: path.resolve(opts.replay), identical: same, before, after };
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = same ? 0 : 1;
    } finally {
      await browser.close();
      server.kill('SIGTERM');
    }
    return;
  }

  if (!opts.group && !opts.case) usage();

  const { project } = projectGroups(opts.project);
  const server = await startServer();
  const browser = await launchBrowser();
  const written = [];
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`http://127.0.0.1:${PORT}/render.html`, { waitUntil: 'load' });

    let cases;
    if (opts.case === 'all') cases = CASES.all();
    else if (opts.case) cases = [CASES.byId(opts.case)];
    else {
      const groups = project.groups
        .filter((group) => !opts.group || group.id === opts.group)
        .map((group) => ({ id: group.id, original: group.edit.original, translation: group.edit.translation, boxWidthPx: opts.box ? Number(opts.box) : undefined }));
      cases = [{ id: opts.group || 'selection', description: 'project subtitle revision', groups, boxWidthPx: opts.box ? Number(opts.box) : undefined }];
    }
    if (cases.some((item) => !item)) usage();

    for (const testCase of cases) {
      const traced = await traceCase(page, testCase, project);
      written.push(traced);
      const causes = traced.diagnostics.attributions
        .filter((attribution) => attribution.cause !== 'fit')
        .map((attribution) => `${attribution.scope.groupId}/${attribution.scope.role}:${attribution.cause}@${attribution.stage}`);
      const incomplete = traced.diagnostics.completeness;
      const bindingIssues = traced.diagnostics.bindings;
      console.log(`[${traced.case}] ${traced.description}`);
      console.log(`  digest ${traced.trace.digest}`);
      console.log(`  lines ${traced.summary.blocks.map((block) => block.roles.map((role) => `${role.role}=${role.lines.length}`).join(' ')).join(' | ')}`);
      console.log(`  causes ${causes.length ? causes.join(', ') : 'none'}`);
      console.log(`  complete ${incomplete.ok}${incomplete.ok ? '' : `: ${incomplete.problems.join(',')}`}`);
      if (bindingIssues.length) console.log(`  binding issues ${JSON.stringify(bindingIssues)}`);
      for (const assertion of traced.assertions) {
        const outcome = evaluateAssertion(traced, assertion);
        if (!outcome.ok) failed = true;
        console.log(`  ${outcome.ok ? 'ASSERT' : 'FAIL'} ${outcome.label}`);
      }
      if (!incomplete.ok) failed = true;
      if (bindingIssues.length) failed = true;
    }

    if (opts.json) {
      const file = path.resolve(String(opts.json));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        tool: 'break-trace',
        generatedAt: new Date().toISOString(),
        project: project.projectId,
        revision: project.revision,
        cases: written,
      }, null, 2));
      console.log(`wrote ${path.relative(ROOT, file)}`);
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
  process.exitCode = failed && opts.assert ? 1 : process.exitCode;
}

main().catch((error) => {
  console.error(`break-trace failed: ${error.message}`);
  if (error.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(2);
});
