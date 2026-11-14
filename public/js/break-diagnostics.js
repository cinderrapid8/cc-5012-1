// Attributes a wrong subtitle line to the stage that caused it. The deliberate
// rule is: never answer "the box is too narrow" unless the trace shows that the
// box width was actually the binding constraint. Every classification names an
// owning stage plus the fields that justify it, so a reviewer can replay it.

export const CLASSIFIER_VERSION = 'break-diagnostics/1';

export const PHASES = {
  shape: 'text-shaping',
  measure: 'width-measurement',
  geometry: 'width-measurement',
  candidates: 'kinsoku',
  solve: 'line-decision',
  'line-box': 'framing',
  mount: 'framing',
  bind: 'language-binding',
};

const CAUSE_TEXT = {
  'fit': '该行在可用宽度内，无需归因',
  'box-width-is-binding': '行框宽度确实是唯一未满足的约束',
  'unbreakable-token': '超长词在禁则与词边界下没有可断点',
  'kinsoku-blocked-break': '禁则挡住了本来可以容纳的断点',
  'solve-overflow-fallback': '求解器在行数上限内无解，退化为自然溢出布局',
  'shape-marks-split': '组合符被拆到不同字素簇',
  'max-lines-binding': '行数上限迫使内容溢出或加高',
  'measure-wide-scaled': '测量尺度不是 1，宽度与画布像素不一致',
  'measure-tracking-missing': 'CSS 不支持 letterSpacing，字间距未进入测量',
  'font-fallback-width': '字体回退改变了实测宽度',
  'language-binding-mismatch': '断行结果没有绑定回当时的原文/译文修订',
  'language-length-gap': '两种语言的行数与宽度分布差异过大',
  'no-line': '该角色没有任何行',
  'no-role': '该组没有任何角色',
};

export function describeCause(cause) {
  return CAUSE_TEXT[cause] || cause;
}

export function roleScope(role) {
  return {
    groupId: role?.groupId ?? null,
    role: role?.role ?? null,
    language: role?.stages?.bind?.language ?? null,
  };
}

export function traceBinding(trace) {
  const roles = trace?.roles || [];
  return {
    revision: trace?.revision ?? null,
    languages: trace?.languages ?? null,
    digest: trace?.digest ?? null,
    roles: roles.map((role) => ({
      groupId: role.groupId,
      role: role.role,
      textHash: role.stages?.bind?.textHash ?? null,
      text: role.stages?.bind?.text ?? null,
      lines: role.stages?.bind?.lines ?? null,
    })),
  };
}

// A trace is only replayable if every stage exists. A missing stage or a
// defaulted box width is reported, never filled with a neutral default.
export function traceCompleteness(trace) {
  const problems = [];
  if (!trace) return { ok: false, problems: ['no-trace'] };
  if (!['subtitle-break-trace/1'].includes(trace.schema)) problems.push(`schema:${trace.schema || 'missing'}`);
  if (trace.emptyScene) problems.push('empty-scene');
  const roles = trace.roles || [];
  if (!roles.length) problems.push('no-roles');
  for (const role of roles) {
    const label = `${role.groupId}/${role.role}`;
    for (const stage of ['shape', 'measure', 'geometry', 'candidates', 'solve', 'line-box', 'mount', 'bind']) {
      if (!role.stages?.[stage]) problems.push(`missing-stage:${label}:${stage}`);
    }
    if (role.partial) problems.push(`partial-trace:${label}`);
    const mount = role.stages?.mount;
    if (mount && mount.boxWidthPx == null && mount.boxWidthSource !== 'settings.maxTextWidthPx') {
      problems.push(`box-width-defaulted:${label}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export function bindingProblems(diagnostics, role) {
  const problems = [];
  const bind = role.stages?.bind;
  const shape = role.stages?.shape;
  const measure = role.stages?.measure;
  if (!bind) return [{ reason: 'no-bind-stage', scope: roleScope(role) }];
  if (diagnostics.revision != null && role.revision != null && diagnostics.revision !== role.revision) {
    problems.push({ reason: 'revision-mismatch', expected: diagnostics.revision, got: role.revision, scope: roleScope(role) });
  }
  const expectedPair = diagnostics.languages ? pairKey(diagnostics.languages) : null;
  const actualPair = bind.languagePair ? pairKey(bind.languagePair) : null;
  if (expectedPair && actualPair !== expectedPair) {
    problems.push({ reason: 'language-pair-mismatch', expected: expectedPair, got: actualPair, scope: roleScope(role) });
  }
  if (bind.role !== role.role || bind.groupId !== role.groupId) {
    problems.push({ reason: 'cross-bound-role', scope: roleScope(role) });
  }
  if (shape?.text != null && bind.text != null && shape.text !== bind.text) {
    problems.push({ reason: 'text-drift-across-stages', scope: roleScope(role) });
  }
  if (measure?.availableWidth && !(measure.availableWidth > 0)) {
    problems.push({ reason: 'non-positive-width', scope: roleScope(role) });
  }
  return problems;
}

function pairKey(pair) {
  return `${pair.original || '?'}->${pair.translation || '?'}`;
}

// A fallback glyph is a shaping-stage fact worth reporting on its own. It is
// only a cause when the line actually carries one, so a plain narrow box is
// never relabelled as a font problem.
export function fallbackGlyphs(role, line) {
  // Only glyphs inside this line count. Falling back to the whole role would
  // blame every line for a fallback glyph that sits on a different line.
  if (line && Array.isArray(line.fontFallback?.entries)) {
    return line.fontFallback.entries.filter((entry) => entry.fallback);
  }
  return [];
}

export function isWideMeasure(role) {
  const m = role.stages?.measure;
  return Boolean(m && Number.isFinite(m.scale) && m.scale !== 1);
}

export function trackingMissing(role) {
  const m = role.stages?.measure;
  return Boolean(m && m.tracking !== 0 && m.letterSpacingSupported === false);
}

function boxIsBinding(role, line, lines) {
  const mount = role.stages?.mount;
  if (!mount || line?.over <= 0) return false;
  // A box verdict is only admissible when the box width was an explicit input.
  // The caller must also prove it with a counterfactual solve.
  if (mount.boxWidthSource !== 'dragged-group-box' && mount.boxWidthSource !== 'settings.boxWidthPx') return false;
  const widest = Math.max(0, ...(lines || []).map((item) => item.width));
  return widest > (mount.availableWidth ?? Infinity) && widest <= (mount.canvasTextLimit ?? Infinity);
}

function widerSolvesFor(role) {
  const solve = role.stages?.solve;
  const counterfactual = solve?.counterfactual || null;
  if (!counterfactual || !counterfactual.solved) return false;
  return counterfactual.overflowPx === 0 && counterfactual.lineCount <= (solve.maxLines ?? counterfactual.lineCount);
}

// "The box is too narrow" is only admissible when the box was an explicit input
// (a dragged frame or a project boxWidthPx). The default maxTextWidthPx is a
// configured safe width, so hitting it is a max-lines/width budget outcome, not
// a box verdict; attributing it to the mount stage would be blaming the wrong
// control.
function explicitBox(role) {
  const source = role.stages?.mount?.boxWidthSource;
  return source === 'dragged-group-box' || source === 'settings.boxWidthPx';
}

function rotateLineCount(lines) {
  return lines.length;
}

// Decides the owning stage for a single overflowing line. Order matters: shaping
// and measurement errors override a wide box, because they would mis-place text
// even if the box were widened.
export function attributeLine(trace, roleIndex, lineIndex) {
  const role = trace?.roles?.[roleIndex];
  if (!role) return { cause: 'no-role', stage: null, scope: null, line: null };
  const lines = role.stages?.['line-box']?.lines || [];
  const line = lines[lineIndex] || lines.find((item) => item.over > 0) || lines[0] || null;
  if (!line) return { cause: 'no-line', stage: 'line-box', scope: roleScope(role), line: null };

  const shape = role.stages?.shape;
  const candidates = role.stages?.candidates;
  const solve = role.stages?.solve;
  const mount = role.stages?.mount;

  if (shape && shape.ok === false) {
    return result('shape-marks-split', 'shape', roleScope(role), line, { graphemes: shape.graphemeCount });
  }
  if (isWideMeasure(role)) {
    return result('measure-wide-scaled', 'measure', roleScope(role), line, { scale: role.stages.measure.scale });
  }
  if (trackingMissing(role)) {
    return result('measure-tracking-missing', 'measure', roleScope(role), line, { tracking: role.stages.measure.tracking });
  }
  // A glyph drawn by a font the project never declared is a shaping-stage fact,
  // reported even when the line happens to fit: the metric belongs to a face the
  // project did not choose. Widening the box cannot repair it, so this must not
  // wait for an overflow to surface.
  const fallback = fallbackGlyphs(role, line);
  if (fallback.length) {
    return result('font-fallback-width', 'shape', roleScope(role), line, {
      glyphs: fallback.map((entry) => ({ glyph: entry.glyph, family: entry.family, missing: entry.missing })),
      families: [...new Set(fallback.map((entry) => entry.family))],
      fallbackCount: line.fontFallback?.fallbackCount ?? fallback.length,
      measuredWidth: line.width,
      overflowPx: line.over,
    });
  }

  // The line fits, but the role still exceeds its line budget. That is either a
  // box-width consequence (proved by the counterfactual) or a genuine max-lines
  // limit; it is never silently reported as "fit".
  if (line.over <= 0 && solve && lines.length > (solve.maxLines ?? Infinity)) {
    if (widerSolvesFor(role) && explicitBox(role)) {
      return result('box-width-is-binding', 'mount', roleScope(role), line, {
        boxWidthPx: mount?.boxWidthPx ?? null,
        boxWidthSource: mount?.boxWidthSource ?? null,
        chosenLineCount: rotateLineCount(lines),
        maxLines: solve.maxLines,
        counterfactual: solve.counterfactual || null,
      });
    }
    return result('max-lines-binding', 'solve', roleScope(role), line, {
      chosenLineCount: lines.length,
      maxLines: solve.maxLines,
    });
  }
  if (line.over <= 0) {
    return result('fit', null, roleScope(role), line, null);
  }

  // A token that the engine could not break at all is a tokenizer/kinsoku
  // outcome. It must not be reported as a solve fallback or a narrow box.
  const token = lineBelongsToUnbreakableToken(line, candidates);
  if (token) {
    return result('unbreakable-token', 'candidates', roleScope(role), line, {
      token: token.text,
      tokenWidth: token.width,
      availableWidth: role.stages?.measure?.availableWidth ?? null,
      rejectedKinds: candidates.rejectedKinds,
    });
  }
  const kinsokuOnly = candidates && (candidates.admittedCount === 0) && (candidates.rejectedCount || 0) > 0;
  if (kinsokuOnly) {
    return result('kinsoku-blocked-break', 'candidates', roleScope(role), line, {
      rejectedKinds: candidates.rejectedKinds,
    });
  }
  // The honest test for "the box was the constraint" is the counterfactual: rerun
  // the solver at the canvas limit and see whether the overflow disappears. If it
  // still overflows, the box is not the cause and must not be blamed.
  const counterfactual = solve?.counterfactual || null;
  const widerSolves = widerSolvesFor(role) && explicitBox(role);
  if (solve && solve.choice === 'natural-overflow') {
    if (widerSolves) {
      return result('box-width-is-binding', 'mount', roleScope(role), line, {
        boxWidthPx: mount?.boxWidthPx ?? null,
        boxWidthSource: mount?.boxWidthSource ?? null,
        widestLine: Math.max(...lines.map((item) => item.width)),
        counterfactual,
      });
    }
    return result('solve-overflow-fallback', 'solve', roleScope(role), line, {
      cleanLineCount: solve.cleanLineCount,
      cleanOverflowPx: solve.cleanOverflowPx,
      counterfactual,
    });
  }
  if (boxIsBinding(role, line, lines) && widerSolves) {
    return result('box-width-is-binding', 'mount', roleScope(role), line, {
      boxWidthPx: role.stages.mount.boxWidthPx,
      source: role.stages.mount.boxWidthSource,
      widestLine: Math.max(...lines.map((item) => item.width)),
      counterfactual,
    });
  }
  return result('line-overflow-unattributed', 'line-box', roleScope(role), line, {
    width: line.width,
    available: role.stages?.measure?.availableWidth ?? null,
  });
}

function lineBelongsToUnbreakableToken(line, candidates) {
  const tokens = candidates?.unbreakableTokens || [];
  return tokens.find((token) => line.text && (line.text.includes(token.text) || token.text.includes(line.text))) || null;
}

function result(cause, stage, scope, line, evidence) {
  return {
    cause,
    text: describeCause(cause),
    stage,
    phase: stage ? PHASES[stage] : null,
    scope,
    line: line ? { lineIndex: line.lineIndex, text: line.text, width: line.width, over: line.over } : null,
    evidence: evidence || null,
  };
}

// Cross-role check: a bilingual pair is suspicious when one language needs
// strictly more lines than the other at the same box width, even though both fit.
export function languageGap(trace) {
  const roles = trace?.roles || [];
  const byGroup = new Map();
  for (const role of roles) {
    if (!byGroup.has(role.groupId)) byGroup.set(role.groupId, {});
    byGroup.get(role.groupId)[role.role] = role;
  }
  const findings = [];
  for (const [groupId, pair] of byGroup) {
    const a = pair.original;
    const b = pair.translation;
    if (!a || !b) continue;
    const aLines = a.stages?.['line-box']?.lines || [];
    const bLines = b.stages?.['line-box']?.lines || [];
    const aOverflow = a.stages?.['line-box']?.overflowLines || 0;
    const bOverflow = b.stages?.['line-box']?.overflowLines || 0;
    // Overflow is already attributed per line; the language gap is only about
    // pairs that both fit. Mixing the two would hide the real cause.
    if (aOverflow || bOverflow) continue;
    const aWidth = Math.max(0, ...aLines.map((line) => line.width));
    const bWidth = Math.max(0, ...bLines.map((line) => line.width));
    const widthRatio = bWidth > 0 ? aWidth / bWidth : null;
    if (Math.abs(aLines.length - bLines.length) >= 2 || (widthRatio != null && widthRatio > 1.9)) {
      findings.push({
        groupId,
        reason: 'language-length-gap',
        languages: { original: a.stages?.bind?.language ?? null, translation: b.stages?.bind?.language ?? null },
        lines: { original: aLines.length, translation: bLines.length },
        widest: { original: round(aWidth), translation: round(bWidth) },
        widthRatio: widthRatio == null ? null : round(widthRatio),
      });
    }
  }
  return findings;
}

export function diagnoseTrace(trace) {
  const completeness = traceCompleteness(trace);
  const roles = trace?.roles || [];
  const bindings = [];
  const attributions = [];
  for (let roleIndex = 0; roleIndex < roles.length; roleIndex += 1) {
    const role = roles[roleIndex];
    bindings.push(...bindingProblems(trace, role));
    const lines = role.stages?.['line-box']?.lines || [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      attributions.push({ roleIndex, ...attributeLine(trace, roleIndex, lineIndex) });
    }
    if (!lines.length) attributions.push({ roleIndex, ...attributeLine(trace, roleIndex, -1) });
  }
  return {
    version: CLASSIFIER_VERSION,
    completeness,
    bindings,
    attributions,
    languageGaps: languageGap(trace),
    binding: traceBinding(trace),
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}
