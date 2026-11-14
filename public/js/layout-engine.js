// Shared layout engine. Runs in the browser preview and in the headless
// export page, so preview geometry and burned geometry cannot diverge.

import { TRACE_SCHEMA, hashText, finalizeTrace, STAGE_ORDER } from './trace-util.js';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
const WORD = /[\p{L}\p{N}]/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const MARK = /^\p{M}+$/u;

// Break-decision tracing. Traces are opt-in: the default layout path allocates
// nothing and keeps the previous behaviour byte-for-byte.
export { TRACE_SCHEMA, hashText };
export const MIN_BOX_WIDTH_PX = 240;
export const DEFAULT_TRACE_LIMITS = {
  maxUnits: 120,
  maxCandidateSamples: 48,
  maxLines: 240,
  maxRejectedKinds: 16,
};

const CLOSING = new Set(Array.from('，。、；：？！）】》」』〕〉”’…—～·%,.;:!?)]}»'));
const OPENING = new Set(Array.from('（【《「『〔〈“‘([{«'));
const INSEPARABLE = new Set(Array.from('—…'));

function isSpace(g) {
  return g === ' ' || g === '\t' || g === '\r' || g === '\n';
}

function classify(text) {
  if (text === '\n') return 'hard';
  if (isSpace(text)) return 'space';
  if (CLOSING.has(text)) return 'close';
  if (OPENING.has(text)) return 'open';
  if (CJK.test(text)) return 'cjk';
  if (EMOJI.test(text)) return 'emoji';
  if (WORD.test(text)) return 'word';
  return 'punct';
}

export function segmentGraphemes(text) {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(seg.segment(text), (part) => part.segment);
}

function atomsOf(graphemes) {
  return graphemes.map((text) => ({ text, kind: classify(text) }));
}

// ---------------------------------------------------------------------------
// Break-decision trace. Every record names the stage that produced it, so a
// wrong line can be attributed to shaping, measured width, kinsoku filtering,
// the DP solve, or the final line box instead of a catch-all "box too narrow".
// ---------------------------------------------------------------------------

function countGraphemes(text) {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const _ of seg.segment(text)) count += 1;
  return count;
}

function describeGrapheme(grapheme, index) {
  return {
    index,
    glyph: grapheme,
    codePoints: Array.from(grapheme, (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase()}`),
    clusterLength: Array.from(grapheme).length,
    kind: classify(grapheme),
    hasMarks: Array.from(grapheme).some((ch) => MARK.test(ch)),
    emoji: EMOJI.test(grapheme),
  };
}

// Font resolution is a shaping-stage fact, not a width fact. The tracer accepts
// a coverage map computed from the declared font files so a fallback glyph can
// be priced separately from the box width.
function fallbackForGraphemes(graphemes, coverage) {
  if (!coverage || !coverage.byGlyph) return null;
  const entries = [];
  const seen = new Map();
  let fallbackCount = 0;
  let missingCount = 0;
  let total = 0;
  for (let i = 0; i < graphemes.length; i += 1) {
    const glyph = graphemes[i];
    if (/^\s+$/u.test(glyph)) continue;
    const record = coverage.byGlyph[glyph];
    if (!record) continue;
    total += 1;
    if (record.fallback) {
      fallbackCount += 1;
      if (record.missing) missingCount += 1;
    }
    if (!seen.has(glyph)) {
      seen.set(glyph, true);
      entries.push({
        index: i,
        glyph,
        codePoints: Array.from(glyph, (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase()}`),
        family: record.family,
        file: record.file || null,
        fallback: Boolean(record.fallback),
        missing: Boolean(record.missing),
        occurrences: 1,
      });
    } else {
      const entry = entries.find((item) => item.glyph === glyph);
      if (entry) entry.occurrences += 1;
    }
  }
  const declared = coverage.families || null;
  return {
    declared,
    entries,
    truncated: false,
    glyphCount: total,
    fallbackCount,
    missingCount,
    fallbackFamilies: [...new Set(entries.filter((entry) => entry.fallback).map((entry) => entry.family))],
  };
}

function canBreakReason(prev, next) {
  if (!prev || !next) return { allowed: false, rule: 'edge' };
  if (prev.kind === 'hard' || next.kind === 'hard') return { allowed: true, rule: 'hard-newline' };
  if (next.kind === 'space') return { allowed: false, rule: 'no-break-before-space' };
  if (prev.kind === 'space') return { allowed: true, rule: 'break-after-space' };
  if (prev.kind === 'open') return { allowed: false, rule: 'no-break-after-opening' };
  if (next.kind === 'close') return { allowed: false, rule: 'no-break-before-closing' };
  if (INSEPARABLE.has(next.text)) return { allowed: false, rule: 'no-break-before-inseparable' };
  if (prev.text === '-' && WORD.test(next.text)) return { allowed: true, rule: 'break-after-hyphen' };
  if (prev.text === '~' || next.text === '~') return { allowed: false, rule: 'no-break-around-tilde' };
  if (prev.kind === 'word' && next.kind === 'word') return { allowed: false, rule: 'inside-word' };
  return { allowed: true, rule: 'default' };
}

function describeBreaks(graphemes, atoms, candidates, emergencyBreak) {
  const admitted = new Set(candidates);
  const rejected = [];
  const rejectedKinds = new Map();
  for (let i = 1; i < graphemes.length; i += 1) {
    if (admitted.has(i)) continue;
    const info = canBreakReason(atoms[i - 1], atoms[i]);
    const rule = info.allowed ? (applyKinsoku(graphemes, i) || 'admitted') : info.rule;
    rejectedKinds.set(rule, (rejectedKinds.get(rule) || 0) + 1);
    if (rejected.length < 48) {
      rejected.push({
        index: i,
        before: describeGrapheme(graphemes[i - 1], i - 1),
        after: describeGrapheme(graphemes[i], i),
        rule,
        baseRule: info.rule,
      });
    }
  }
  return {
    admitted,
    rejected,
    rejectedKinds: [...rejectedKinds.entries()].map(([rule, count]) => ({ rule, count })),
    emergencyBreak: Boolean(emergencyBreak),
  };
}

export function canBreakBetween(prev, next) {
  if (!prev || !next) return false;
  if (prev.kind === 'hard' || next.kind === 'hard') return true;
  if (next.kind === 'space') return false;
  if (prev.kind === 'space') return true;
  if (prev.kind === 'open') return false;
  if (next.kind === 'close') return false;
  if (INSEPARABLE.has(next.text)) return false;
  if (prev.text === '-' && WORD.test(next.text)) return true;
  if (prev.text === '~' || next.text === '~') return false;
  if (prev.kind === 'word' && next.kind === 'word') return false;
  return true;
}

export function validateLineBoundaries(lines) {
  const violations = [];
  for (const line of lines) {
    const first = segmentGraphemes(line.text || '')[0];
    const last = segmentGraphemes(line.text || '').slice(-1)[0];
    if (first && (CLOSING.has(first) || INSEPARABLE.has(first))) {
      violations.push({ line: line.text, position: 'start', grapheme: first, type: 'no-break-before-closing' });
    }
    if (last && (OPENING.has(last) || last === '…')) {
      violations.push({ line: line.text, position: 'end', grapheme: last, type: 'no-break-after-opening' });
    }
  }
  return violations;
}

function makeMeasurer(fontSize, fontWeight, fontStack, tracking = 0, role = null) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontWeight} ${fontSize}px ${fontStack}`;
  const supportsLetterSpacing = 'letterSpacing' in ctx;
  if (supportsLetterSpacing) ctx.letterSpacing = `${tracking}px`;
  const appliedSpacing = supportsLetterSpacing ? ctx.letterSpacing : null;
  const transform = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const scale = transform ? Math.hypot(transform.a, transform.b) : 1;
  const cache = new Map();
  const samples = [];
  const measure = (text) => {
    if (cache.has(text)) return cache.get(text);
    const width = ctx.measureText(text).width;
    cache.set(text, width);
    samples.push({ text, width });
    return width;
  };
  measure.telemetry = () => ({
    font: ctx.font,
    fontSize,
    fontWeight,
    tracking,
    role,
    letterSpacingSupported: supportsLetterSpacing,
    letterSpacingRequested: `${tracking}px`,
    letterSpacingApplied: appliedSpacing,
    scale,
    calls: samples.length,
    unique: cache.size,
    samples,
  });
  return measure;
}

function lineGeometry(graphemes, start, end) {
  let a = start;
  let b = end;
  while (a < b && isSpace(graphemes[a])) a += 1;
  while (b > a && isSpace(graphemes[b - 1])) b -= 1;
  return { a, b, text: graphemes.slice(a, b).join('') };
}

// Shared by the solver and the tracer so a traced rule can never disagree with
// the rule that actually produced the break.
function applyKinsoku(graphemes, i) {
  if (CLOSING.has(graphemes[i]) || INSEPARABLE.has(graphemes[i])) return 'no-break-before-closing';
  if (OPENING.has(graphemes[i - 1])) return 'no-break-after-opening';
  return null;
}

function buildCandidates(graphemes, measure, availableWidth, emergencyBreak) {
  const atoms = atomsOf(graphemes);
  const candidates = [];
  for (let i = 1; i < graphemes.length; i += 1) {
    if (!canBreakBetween(atoms[i - 1], atoms[i])) continue;
    if (applyKinsoku(graphemes, i)) continue;
    candidates.push(i);
  }
  if (emergencyBreak) {
    let i = 0;
    while (i < graphemes.length) {
      if (atoms[i].kind !== 'word') { i += 1; continue; }
      let j = i;
      while (j < graphemes.length && atoms[j].kind === 'word') j += 1;
      const token = graphemes.slice(i, j).join('');
      if (measure(token) > availableWidth) {
        for (let k = i + 1; k < j; k += 1) candidates.push(k);
      }
      i = j;
    }
  }
  return candidates;
}

function unbreakableTokens(graphemes, measure, availableWidth) {
  const atoms = atomsOf(graphemes);
  const tokens = [];
  let i = 0;
  while (i < graphemes.length) {
    if (atoms[i].kind !== 'word') { i += 1; continue; }
    let j = i;
    while (j < graphemes.length && atoms[j].kind === 'word') j += 1;
    const token = graphemes.slice(i, j).join('');
    if (measure(token) > availableWidth) {
      tokens.push({ text: token, width: round(measure(token)) });
    }
    i = j;
  }
  return tokens;
}

// Dynamic programming over measured break candidates. Lines are chosen by measured
// width, never by character count. If a clean layout within the configured line
// count is impossible, the natural unclipped layout is returned with explicit
// overflow diagnostics; text is never dropped.
function layoutParagraph(graphemes, options) {
  const { measure, availableWidth, maxLines, emergencyBreak, trace } = options;
  const n = graphemes.length;
  if (n === 0) return { lines: [], lineCount: 0, issues: [] };
  const candidates = buildCandidates(graphemes, measure, availableWidth, emergencyBreak);
  const breakSet = new Set([0, n, ...candidates]);
  const breaks = [...breakSet].sort((a, b) => a - b);
  const atoms = trace ? atomsOf(graphemes) : null;

  const lineCache = new Map();
  const getLine = (a, b) => {
    const key = `${a}:${b}`;
    if (lineCache.has(key)) return lineCache.get(key);
    const geom = lineGeometry(graphemes, a, b);
    const width = geom.text ? measure(geom.text) : 0;
    const result = { ...geom, width, over: Math.max(0, width - availableWidth) };
    lineCache.set(key, result);
    return result;
  };

  const lineCost = (line, width) => {
    if (line.width > width) return 1e12 + (line.width - width) * 1e7;
    const slack = width - line.width;
    return slack * slack;
  };

  const solve = (lineLimit, width = availableWidth) => {
    const dp = Array.from({ length: lineLimit + 1 }, () => new Map());
    const parent = Array.from({ length: lineLimit + 1 }, () => new Map());
    dp[0].set(0, 0);
    for (let k = 1; k <= lineLimit; k += 1) {
      for (const end of breaks) {
        if (end === 0) continue;
        let best = Infinity;
        let bestStart = null;
        for (const start of breaks) {
          if (start >= end) break;
          if (!dp[k - 1].has(start)) continue;
          const line = getLine(start, end);
          if (!line.text && end !== n) continue;
          const cost = dp[k - 1].get(start) + lineCost(line, width);
          if (cost < best) { best = cost; bestStart = start; }
        }
        if (bestStart !== null) {
          dp[k].set(end, best);
          parent[k].set(end, bestStart);
        }
      }
    }
    let bestK = null;
    let bestCost = Infinity;
    for (let k = 1; k <= lineLimit; k += 1) {
      if (dp[k].has(n) && dp[k].get(n) < bestCost) { bestCost = dp[k].get(n); bestK = k; }
    }
    if (bestK === null) return null;
    const lines = [];
    let end = n;
    for (let k = bestK; k >= 1; k -= 1) {
      const start = parent[k].get(end);
      const line = getLine(start, end);
      lines.unshift({ ...line, start, end, visibleStart: line.a, visibleEnd: line.b });
      end = start;
    }
    return { lines, lineCount: bestK, cost: bestCost };
  };

  const clean = solve(maxLines);
  const naturalLimit = Math.min(n, Math.max(maxLines + 1, 24));
  const natural = solve(naturalLimit) || solve(maxLines);
  // Counterfactual: what would happen at the full canvas limit? This is the only
  // honest evidence for "the dragged box was the binding constraint".
  const alternativeWidth = trace?.alternativeWidth;
  const counterfactual = alternativeWidth && alternativeWidth > availableWidth
    ? (() => {
      const wide = solve(Math.min(n, 24), alternativeWidth);
      if (!wide) return { width: alternativeWidth, solved: false };
      return {
        width: alternativeWidth,
        solved: true,
        lineCount: wide.lineCount,
        overflowPx: round(wide.lines.reduce((sum, line) => sum + Math.max(0, line.width - alternativeWidth), 0)),
        widestLinePx: round(Math.max(0, ...wide.lines.map((line) => line.width))),
      };
    })()
    : null;
  const cleanHasOverflow = !clean || clean.lines.some((line) => line.over > 0);
  const chosen = cleanHasOverflow ? natural : clean;

  if (trace) {
    const breaksInfo = describeBreaks(graphemes, atoms, candidates, emergencyBreak);
    const limits = trace.limits || DEFAULT_TRACE_LIMITS;
    const firstA = chosen.lines[0]?.a;
    const lastVisibleEnd = chosen.lines.length ? chosen.lines[chosen.lines.length - 1].b : null;
    const telemetry = measure.telemetry();

    trace.stages.shape = {
      stage: 'shape',
      ok: true,
      graphemeCount: n,
      graphemes: graphemes.slice(0, limits.maxUnits).map((glyph, index) => describeGrapheme(glyph, index)),
      truncatedGraphemes: Math.max(0, n - limits.maxUnits),
      paragraphs: trace.paragraphCount || 1,
      paragraphOffset: trace.offset || 0,
    };
    trace.stages.measure = {
      stage: 'measure',
      ok: telemetry.tracking === 0 || telemetry.letterSpacingSupported,
      font: telemetry.font,
      fontSize: telemetry.fontSize,
      fontWeight: telemetry.fontWeight,
      tracking: telemetry.tracking,
      letterSpacingRequested: telemetry.letterSpacingRequested,
      letterSpacingApplied: telemetry.letterSpacingApplied,
      letterSpacingSupported: telemetry.letterSpacingSupported,
      scale: telemetry.scale,
      availableWidth: round(availableWidth),
      memoCalls: telemetry.calls,
      memoEntries: telemetry.unique,
      samples: telemetry.samples.slice(0, limits.maxCandidateSamples).map((sample) => ({
        text: sample.text,
        width: round(sample.width),
        chars: Array.from(sample.text).length,
      })),
    };
    trace.stages.geometry = {
      stage: 'geometry',
      ok: firstA === 0 && (lastVisibleEnd === n || lastVisibleEnd == null),
      graphemeCount: n,
      breakCandidateCount: candidates.length,
      breakCandidates: breaks.slice(0, limits.maxCandidateSamples),
      truncatedCandidates: Math.max(0, breaks.length - limits.maxCandidateSamples),
      firstVisibleStart: firstA,
      lastVisibleEnd,
      availableWidth: round(availableWidth),
      maxLines,
    };
    trace.stages.candidates = {
      stage: 'candidates',
      ok: true,
      emergencyBreak: Boolean(emergencyBreak),
      admittedCount: breaksInfo.admitted.size,
      admitted: [...breaksInfo.admitted].sort((a, b) => a - b).slice(0, limits.maxCandidateSamples),
      rejectedCount: breaksInfo.rejected.length,
      rejected: breaksInfo.rejected.slice(0, limits.maxCandidateSamples),
      rejectedKinds: breaksInfo.rejectedKinds.slice(0, limits.maxRejectedKinds),
      omittedRejected: Math.max(0, breaksInfo.rejected.length - limits.maxCandidateSamples),
      unbreakableTokens: emergencyBreak ? [] : unbreakableTokens(graphemes, measure, availableWidth),
    };
    trace.stages.solve = {
      stage: 'solve',
      ok: Boolean(chosen.lines.length),
      lineLimitTried: naturalLimit,
      cleanLineCount: clean ? clean.lineCount : null,
      cleanOverflowPx: clean ? round(clean.lines.reduce((sum, line) => sum + line.over, 0)) : null,
      chosenLineCount: chosen.lineCount,
      choice: cleanHasOverflow && natural !== clean ? 'natural-overflow' : 'clean',
      maxLines,
      cost: round(chosen.cost),
      counterfactual,
    };
  }

  const issues = [];
  for (const line of chosen.lines) {
    if (line.over > 0) {
      issues.push({
        type: 'line-overflow',
        text: line.text,
        width: round(line.width),
        available: round(availableWidth),
        overflowPx: round(line.over),
        unbreakable: !line.text.includes(' ') && !/\p{Script=Han}/u.test(line.text),
      });
    }
  }
  if (!emergencyBreak) {
    for (const token of unbreakableTokens(graphemes, measure, availableWidth)) {
      issues.push({
        type: 'unbreakable-token',
        text: token.text,
        width: token.width,
        available: round(availableWidth),
        overflowPx: round(token.width - availableWidth),
        message: '单词或连续字串在可用宽度内无法整体容纳，未自动拆分或删词',
      });
    }
  }
  if (chosen.lineCount > maxLines) {
    issues.push({ type: 'max-lines-exceeded', needed: chosen.lineCount, maxLines });
  }
  return { lines: chosen.lines, lineCount: chosen.lineCount, issues, availableWidth };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

export function normalizeForCompare(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

export function reassembleLines(lines, graphemes) {
  let out = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    out += line.text;
    if (i < lines.length - 1) {
      const from = line.visibleEnd ?? line.end;
      const to = lines[i + 1].visibleStart ?? lines[i + 1].start;
      out += graphemes.slice(from, to).join('');
    }
  }
  return out;
}

function findSuggestions(role, availableWidth, canvasLimit, layout, settings) {
  const suggestions = [];
  const widest = Math.max(0, ...layout.lines.map((line) => line.width));
  const widthNeed = Math.ceil(widest - availableWidth);
  if (widthNeed > 0) {
    const to = Math.min(canvasLimit, settings.maxTextWidthPx + widthNeed);
    suggestions.push({
      kind: 'increase-max-width',
      label: `把文本可用宽度增加到 ${to}px`,
      value: to,
      possible: to >= settings.maxTextWidthPx + widthNeed,
    });
    const ratio = availableWidth / widest;
    const fontSize = Math.max(12, Math.floor(settings[role].fontSize * ratio));
    suggestions.push({
      kind: 'decrease-font-size',
      label: `把${role === 'original' ? '原文' : '译文'}字号缩小到 ${fontSize}px`,
      value: fontSize,
      possible: fontSize >= 12,
    });
  }
  const lineIssue = layout.issues.find((issue) => issue.type === 'max-lines-exceeded');
  if (lineIssue) {
    suggestions.push({
      kind: 'increase-max-lines',
      label: `把${role === 'original' ? '原文' : '译文'}行数上限增加到 ${lineIssue.needed}`,
      value: lineIssue.needed,
      possible: true,
    });
  }
  const tokenIssue = layout.issues.find((issue) => issue.type === 'unbreakable-token');
  if (tokenIssue) {
    const fontSize = Math.max(12, Math.floor(settings[role].fontSize * (availableWidth / tokenIssue.width)));
    suggestions.push({
      kind: 'decrease-font-size',
      label: `把${role === 'original' ? '原文' : '译文'}字号至少缩到 ${fontSize}px 才能整体容纳该词`,
      value: fontSize,
      possible: fontSize >= 12,
    });
    suggestions.push({
      kind: 'widen-or-rebreak',
      label: '加宽可用文本区域，或人工改写该段并保留语义（引擎不自动删词）',
      value: null,
      possible: true,
    });
  }
  if (layout.issues.some((issue) => issue.type === 'line-overflow')) {
    suggestions.push({
      kind: 'allow-emergency-break',
      label: '开启“应急断行”后可按字形边界切分超长词（会破坏单词完整性，需人工确认）',
      value: true,
      possible: true,
    });
  }
  return suggestions;
}

export function fontStackFromSettings(settings) {
  const families = settings.fonts.declared.map((font) => `"${font.family}"`);
  return [...families, 'sans-serif'].join(', ');
}

// Same stack, but safe to place inside a double-quoted HTML style attribute:
// an embedded double quote would otherwise truncate the attribute.
function inlineFontStack(settings) {
  return fontStackFromSettings(settings).replace(/"/g, "'");
}

export function fontFaceCSS(settings) {
  return settings.fonts.declared.map((font) => `@font-face{font-family:"${font.family}";src:url("/${font.file}");font-weight:100 900;font-display:block;}`).join('\n');
}

export async function ensureFontsLoaded(settings, sizes) {
  const jobs = [];
  for (const font of settings.fonts.declared) {
    for (const size of sizes) {
      jobs.push(document.fonts.load(`400 ${size}px "${font.family}"`).catch(() => {}));
    }
  }
  await Promise.all(jobs);
  await document.fonts.ready;
}

export function fontFaceStatuses() {
  return [...document.fonts].map((face) => ({ family: face.family.replace(/^"|"$/g, ''), weight: face.weight, status: face.status }));
}

export async function verifyFontRequests(settings) {
  const results = [];
  for (const font of settings.fonts.declared) {
    let response = null;
    try {
      response = await fetch(`/${font.file}`, { method: 'HEAD' });
    } catch { response = null; }
    results.push({ family: font.family, file: font.file, httpStatus: response ? response.status : 0, requestFailed: !response || !response.ok });
  }
  return results;
}

// Renders the language pair into a comparable key so a bilingual trace can be
// replayed against the same pair instead of whatever the editor later holds.
function languagePair(languages) {
  if (!languages) return null;
  return { original: languages.original ?? null, translation: languages.translation ?? null };
}

function newRoleTrace(groupId, role, activeTrace) {
  return {
    schema: TRACE_SCHEMA,
    groupId,
    role,
    revision: activeTrace.revision || null,
    languages: languagePair(activeTrace.languages),
    stages: {},
    limits: { ...DEFAULT_TRACE_LIMITS, ...(activeTrace.limits || {}) },
    coverage: activeTrace.coverage || null,
  };
}

function completeRoleTrace(roleTrace, context) {
  const {
    groupId, role, text, graphemes, measure, roleSettings, availableWidth,
    lineHeightPx, textBoxes, boundaryViolations, integrityOk, lines, paragraphs,
    languages, boxWidthPx, boxWidthSource, canvasTextLimit, clamped,
  } = context;
  const telemetry = measure.telemetry();
  const stages = roleTrace.stages;
  const limits = roleTrace.limits;

  // Shaping always owns the cluster decision, even when no break ever reached
  // it. Without this the tracer could not tell shaping from measurement.
  stages.shape = {
    stage: 'shape',
    // A cluster that *contains* a combining mark is correct segmentation. Only
    // a cluster made entirely of marks means the base character was split away.
    ok: graphemes.every((glyph) => {
      const chars = Array.from(glyph);
      return chars.length === 0 || !chars.every((ch) => MARK.test(ch));
    }),
    graphemeCount: graphemes.length,
    graphemes: graphemes.slice(0, limits.maxUnits).map((glyph, index) => describeGrapheme(glyph, index)),
    truncatedGraphemes: Math.max(0, graphemes.length - limits.maxUnits),
    paragraphs: paragraphs.length,
    segmenter: 'Intl.Segmenter/grapheme',
    fontFallback: fallbackForGraphemes(graphemes, context.coverage),
  };
  stages.measure = {
    stage: 'measure',
    ok: (telemetry.tracking === 0 || Boolean(telemetry.letterSpacingSupported)) && telemetry.scale === 1,
    font: telemetry.font,
    fontSize: telemetry.fontSize,
    fontWeight: telemetry.fontWeight,
    tracking: telemetry.tracking,
    letterSpacingRequested: telemetry.letterSpacingRequested,
    letterSpacingApplied: telemetry.letterSpacingApplied,
    letterSpacingSupported: telemetry.letterSpacingSupported,
    scale: telemetry.scale,
    availableWidth: round(availableWidth),
    memoCalls: telemetry.calls,
    memoEntries: telemetry.unique,
    samples: telemetry.samples.slice(0, limits.maxCandidateSamples).map((sample) => ({
      text: sample.text,
      width: round(sample.width),
      chars: Array.from(sample.text).length,
      graphemes: countGraphemes(sample.text),
    })),
  };
  if (!stages.geometry) {
    stages.geometry = {
      stage: 'geometry',
      ok: true,
      emptyInput: graphemes.length === 0,
      note: 'no non-empty paragraph required geometry work',
    };
  }
  if (!stages.candidates) {
    stages.candidates = {
      stage: 'candidates',
      ok: true,
      admittedCount: 0,
      admitted: [],
      rejectedCount: 0,
      rejected: [],
      rejectedKinds: [],
      emptyInput: true,
    };
  }
  if (!stages.solve) {
    stages.solve = {
      stage: 'solve',
      ok: lines.length > 0 || graphemes.length === 0,
      chosenLineCount: lines.length,
      emptyInput: graphemes.length === 0,
    };
  }

  const measureSamples = new Map(telemetry.samples.map((sample) => [sample.text, sample.width]));
  stages['line-box'] = {
    stage: 'line-box',
    ok: integrityOk && boundaryViolations.length === 0 && textBoxes.every((box) => box.over === 0),
    lineHeightPx,
    framingNote: 'the framing stage consumes measured widths; it never re-measures text',
    lines: textBoxes.slice(0, limits.maxLines).map((box) => {
      const visible = graphemes.slice(box.start, box.end).join('');
      return {
        lineIndex: box.lineIndex,
        text: box.text,
        start: box.start,
        end: box.end,
        width: box.width,
        height: box.height,
        over: box.over,
        visibleSliceMatches: visible === box.text,
        widthSource: {
          measuredPx: round(measureSamples.get(box.text) ?? box.width),
          fromMemo: measureSamples.has(box.text),
          chars: Array.from(box.text).length,
          graphemes: countGraphemes(box.text),
        },
        fontFallback: fallbackForGraphemes(graphemes.slice(box.start, box.end), context.coverage),
      };
    }),
    truncatedLines: Math.max(0, textBoxes.length - limits.maxLines),
    overflowLines: textBoxes.filter((box) => box.over > 0).length,
    startsWithClosing: boundaryViolations.some((violation) => violation.position === 'start'),
    endsWithOpening: boundaryViolations.some((violation) => violation.position === 'end'),
    boundaryViolations,
    integrityOk,
  };
  stages.mount = {
    stage: 'mount',
    ok: true,
    boxWidthPx: boxWidthPx ?? null,
    boxWidthSource,
    clampedToCanvasLimit: Boolean(clamped),
    canvasTextLimit: round(canvasTextLimit),
    maxTextWidthPx: Number(roleSettings.maxTextWidthPx ?? 0) || null,
    availableWidth: round(availableWidth),
    letterSpacingAppliesToDom: Boolean(telemetry.letterSpacingSupported),
    spaceLeftPx: round(Math.max(0, availableWidth - Math.max(0, ...textBoxes.map((box) => box.width)))),
  };
  stages.bind = {
    stage: 'bind',
    ok: true,
    groupId,
    role,
    textHash: hashText(text),
    text,
    chars: Array.from(text).length,
    graphemes: graphemes.length,
    lines: textBoxes.length,
    language: languages?.[role] ?? null,
    languagePair: languagePair(languages),
  };

  roleTrace.paragraphs = paragraphs.length;
}

export function buildLayout({ activeGroups, settings, canvas, roleOrder = ['original', 'translation'], trace = null }) {
  if (!activeGroups.length) {
    if (trace) trace.emptyScene = true;
    return { blocks: [], issues: [], suggestions: [], canvas, availableWidth: 0, canvasTextLimit: 0, safeMarginPx: settings.safeMarginPx, fontStack: fontStackFromSettings(settings), totalHeight: 0 };
  }
  const W = canvas.width;
  const H = canvas.height;
  const safe = settings.safeMarginPx;
  const fontStack = fontStackFromSettings(settings);
  const markerGutter = 46;
  const panelPad = settings.panelPadding;
  const canvasTextLimit = W - 2 * safe - 2 * panelPad - markerGutter;
  // A per-group box width stands in for a dragged subtitle frame. It is clamped
  // to the same safe-area limit the canvas imposes and never silently widened.
  const defaultBox = Number(settings.boxWidthPx);
  const groupBox = (group) => {
    const value = Number(group.boxWidthPx);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  };
  const boxFor = (group) => {
    const requested = groupBox(group) ?? (Number.isFinite(defaultBox) && defaultBox > 0 ? Math.round(defaultBox) : null);
    return {
      requested,
      usable: requested != null ? Math.min(requested, canvasTextLimit) : Math.min(settings.maxTextWidthPx, canvasTextLimit),
      clamped: requested != null && requested > canvasTextLimit,
      source: requested == null ? 'settings.maxTextWidthPx' : (groupBox(group) != null ? 'dragged-group-box' : 'settings.boxWidthPx'),
    };
  };
  const availableWidth = Math.min(settings.maxTextWidthPx, canvasTextLimit);
  const activeTrace = trace;
  if (activeTrace) {
    activeTrace.scene = {
      groupCount: activeGroups.length,
      groups: activeGroups.map((group) => {
        const box = boxFor(group);
        return { id: group.id, start: group.start, end: group.end, boxWidthPx: box.requested, availableWidth: round(box.usable) };
      }),
      availableWidth: round(availableWidth),
      canvasTextLimit: round(canvasTextLimit),
    };
    if (!Array.isArray(activeTrace.roles)) activeTrace.roles = [];
  }

  const blocks = [];
  const issues = [];

  if (activeGroups.length > 2) {
    issues.push({
      type: 'too-many-active-groups',
      activeCount: activeGroups.length,
      groupIds: activeGroups.map((group) => group.id),
      message: '同一时刻有超过两层字幕组处于活动状态；@ 叠放属于异常时间重叠，请核对时间区间',
    });
  }
  for (let i = 0; i < activeGroups.length; i += 1) {
    for (let j = i + 1; j < activeGroups.length; j += 1) {
      const a = activeGroups[i];
      const b = activeGroups[j];
      if (a.start != null && b.start != null && a.end != null && b.end != null) {
        const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
        if (overlap > 0) {
          issues.push({
            type: 'time-overlap',
            groupIds: [a.id, b.id],
            overlapSeconds: round(overlap),
            message: '两个字幕组的时间区间交叠，将分别显示在独立面板中，绝不交叉拼接',
          });
        }
      }
    }
  }

  for (const group of activeGroups) {
    const box = boxFor(group);
    const groupAvailableWidth = box.usable;
    const roles = [];
    for (const role of roleOrder) {
      const roleSettings = settings[role];
      const text = group[role] ?? '';
      const graphemes = segmentGraphemes(text);
      const measure = makeMeasurer(roleSettings.fontSize, roleSettings.fontWeight, fontStack, roleSettings.tracking, role);
      const paragraphs = [];
      let cursor = 0;
      let buffer = [];
      for (const grapheme of graphemes) {
        if (grapheme === '\n') {
          paragraphs.push({ graphemes: buffer, offset: cursor });
          cursor += buffer.length + 1;
          buffer = [];
        } else buffer.push(grapheme);
      }
      paragraphs.push({ graphemes: buffer, offset: cursor });

      const lines = [];
      const roleIssues = [];
      const roleTrace = activeTrace ? newRoleTrace(group.id, role, activeTrace) : null;
      const paragraphCount = paragraphs.length;
      for (const paragraph of paragraphs) {
        const paragraphTrace = roleTrace && paragraphCount === 1
          ? {
            stages: roleTrace.stages,
            offset: paragraph.offset,
            limits: roleTrace.limits,
            paragraphCount,
            coverage: roleTrace.coverage,
            alternativeWidth: canvasTextLimit,
          }
          : null;
        if (roleTrace && paragraphCount > 1 && !roleTrace.partial) {
          roleTrace.partial = true;
          roleTrace.partialReason = 'hard-newline paragraphs reset the solver; stage detail recorded once';
        }
        const layout = layoutParagraph(paragraph.graphemes, {
          measure,
          availableWidth: groupAvailableWidth,
          maxLines: roleSettings.maxLines,
          emergencyBreak: Boolean(settings.emergencyBreak),
          trace: paragraphTrace,
        });
        for (const line of layout.lines) {
          lines.push({
            ...line,
            start: line.start + paragraph.offset,
            end: line.end + paragraph.offset,
            visibleStart: line.visibleStart + paragraph.offset,
            visibleEnd: line.visibleEnd + paragraph.offset,
          });
        }
        for (const issue of layout.issues) roleIssues.push({ ...issue, role, groupId: group.id });
      }

      const lineHeightPx = Math.round(roleSettings.fontSize * settings.lineHeight);
      const roleWidth = Math.max(0, ...lines.map((line) => line.width));
      const roleHeight = lines.length * lineHeightPx;
      const joined = reassembleLines(lines.map((line) => ({ ...line, text: line.text })), graphemes);

      const textBoxes = lines.map((line, index) => ({
        lineIndex: index,
        text: line.text,
        start: line.start,
        end: line.end,
        width: round(line.width),
        height: lineHeightPx,
        x: 0,
        y: 0,
        over: round(line.over),
      }));
      const boundaryViolations = validateLineBoundaries(textBoxes);
      const integrityOk = normalizeForCompare(joined) === normalizeForCompare(text);
      roles.push({
        role,
        groupId: group.id,
        text,
        fontSize: roleSettings.fontSize,
        fontWeight: roleSettings.fontWeight,
        tracking: roleSettings.tracking,
        maxLines: roleSettings.maxLines,
        lineHeightPx,
        lines: textBoxes,
        width: round(roleWidth),
        height: roleHeight,
        integrity: {
          ok: integrityOk,
          reassembled: joined,
          expected: text,
        },
        boundaryViolations,
        issues: roleIssues,
        trace: roleTrace || undefined,
      });
      for (const issue of roleIssues) issues.push(issue);
      if (!integrityOk) {
        issues.push({ type: 'text-integrity', groupId: group.id, role, message: '断行后文本与原文字符不一致（不允许删词）' });
      }
      if (boundaryViolations.length) {
        issues.push({ type: 'punctuation-boundary', groupId: group.id, role, violations: boundaryViolations });
      }
      if (roleTrace) {
        completeRoleTrace(roleTrace, {
          groupId: group.id,
          role,
          text,
          graphemes,
          measure,
          roleSettings,
          availableWidth: groupAvailableWidth,
          lineHeightPx,
          textBoxes,
          boundaryViolations,
          integrityOk,
          lines,
          paragraphs,
          languages: activeTrace.languages,
          boxWidthPx: box.requested,
          boxWidthSource: box.source,
          canvasTextLimit,
          clamped: box.clamped,
          coverage: activeTrace.coverage,
        });
        activeTrace.roles.push(roleTrace);
      }
    }

    const pad = panelPad;
    const contentWidth = Math.max(...roles.map((role) => role.width), 0);
    const panelWidth = Math.min(W - 2 * safe, Math.round(contentWidth + pad * 2 + markerGutter));
    const panelHeight = Math.round(pad * 2 + roles.reduce((sum, role) => sum + role.height, 0) + settings.roleGap * (roles.length - 1));
    blocks.push({
      groupId: group.id,
      start: group.start,
      end: group.end,
      boxWidthPx: box.requested,
      boxWidthSource: box.source,
      availableWidth: round(box.usable),
      canvasTextLimit: round(canvasTextLimit),
      panelWidth,
      panelHeight,
      panelPad: pad,
      markerGutter,
      roles,
      roleGap: settings.roleGap,
    });
  }

  blocks.sort((a, b) => (a.start - b.start) || String(a.groupId).localeCompare(String(b.groupId)));
  const totalHeight = blocks.reduce((sum, block) => sum + block.panelHeight, 0) + settings.blockGap * Math.max(0, blocks.length - 1);
  const availableHeight = H - 2 * safe;
  let y = H - safe - totalHeight;
  if (y < safe) {
    issues.push({
      type: 'vertical-overflow',
      overflowPx: round(safe - y),
      totalHeight: round(totalHeight),
      availableHeight: round(availableHeight),
    });
    y = safe;
  }
  for (const block of blocks) {
    block.x = Math.round((W - block.panelWidth) / 2);
    block.y = Math.round(y);
    let cursorY = block.y + block.panelPad;
    for (const role of block.roles) {
      role.x = block.x + block.panelPad + block.markerGutter;
      role.y = cursorY;
      role.textX = role.x + Math.round((block.panelWidth - block.panelPad * 2 - block.markerGutter - role.width) / 2);
      for (let i = 0; i < role.lines.length; i += 1) {
        const line = role.lines[i];
        line.x = role.textX;
        line.y = cursorY + i * role.lineHeightPx;
      }
      cursorY += role.height + settings.roleGap;
    }
    y += block.panelHeight + settings.blockGap;
  }

  const suggestions = [];
  const blockAvail = new Map(activeGroups.map((group) => [group.id, boxFor(group).usable]));
  for (const block of blocks) {
    for (const role of block.roles) {
      const layout = { lines: role.lines.map((line) => ({ width: line.width, text: line.text, over: line.over })), issues: role.issues };
      const roleSuggestions = findSuggestions(role.role, blockAvail.get(block.groupId), W - 2 * safe - 2 * panelPad - markerGutter, layout, settings);
      if (roleSuggestions.length) suggestions.push({ groupId: block.groupId, role: role.role, suggestions: roleSuggestions });
    }
  }
  const vertical = issues.find((issue) => issue.type === 'vertical-overflow');
  if (vertical) {
    suggestions.push({
      groupId: '*',
      role: '*',
      suggestions: [
        { kind: 'decrease-font-size', label: '整体缩小原文/译文字号', value: Math.max(12, Math.floor(settings.original.fontSize * (H - 2 * safe) / vertical.totalHeight)), possible: true },
        { kind: 'reduce-gap', label: '缩小段间距 / 面板内边距', value: true, possible: true },
        { kind: 'increase-max-lines', label: '检查行数上限（可能增加面板高度）', value: null, possible: false },
      ],
    });
  }

  for (const block of blocks) {
    for (const role of block.roles) {
      for (const line of role.lines) {
        if (block.x < safe - 0.5 || block.x + block.panelWidth > W - safe + 0.5) {
          issues.push({ type: 'safe-margin', groupId: block.groupId, role: role.role, lineIndex: line.lineIndex, label: '字幕面板超出水平安全边距' });
        }
      }
    }
    if (block.y < safe - 0.5 || block.y + block.panelHeight > H - safe + 0.5) {
      issues.push({ type: 'safe-margin-vertical', groupId: block.groupId, label: '字幕面板超出垂直安全边距' });
    }
  }

  if (activeTrace) {
    activeTrace.scene.blocks = blocks.map((block) => ({
      groupId: block.groupId,
      panel: { x: block.x, y: block.y, width: block.panelWidth, height: block.panelHeight },
      roles: block.roles.map((role) => ({ role: role.role, lines: role.lines.length, width: role.width })),
    }));
    finalizeTrace(activeTrace);
  }

  return {
    blocks,
    issues,
    suggestions,
    canvas,
    availableWidth: round(availableWidth),
    canvasTextLimit: round(canvasTextLimit),
    safeMarginPx: safe,
    fontStack,
    totalHeight: round(totalHeight),
    trace: activeTrace || undefined,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ROLE_MARK = { original: '原', translation: '译' };
const DEFAULT_ACCENTS = ['#ff9f43', '#7bd389', '#c792ea', '#ffd166', '#4dd0e1'];
const ROLE_COLOR = { original: '#ffd86b', translation: '#7ef0a8' };

export function accentForIndex(index) {
  return DEFAULT_ACCENTS[index % DEFAULT_ACCENTS.length];
}

export function renderOverlayHTML(layout, settings, options = {}) {
  const accentMap = new Map();
  layout.blocks.forEach((block, index) => accentMap.set(block.groupId, accentForIndex(index)));
  const attrFont = inlineFontStack(settings);
  const guides = options.guides ? `
      <div class="guide safe" style="position:absolute;left:${layout.safeMarginPx}px;top:${layout.safeMarginPx}px;width:${layout.canvas.width - layout.safeMarginPx * 2}px;height:${layout.canvas.height - layout.safeMarginPx * 2}px;border:2px dashed rgba(255,255,255,.5);"></div>` : '';
  const reviewHud = options.review ? `
      <div style="position:absolute;left:${layout.safeMarginPx}px;top:${layout.safeMarginPx + 96}px;font:600 26px/1.3 ${attrFont};color:#9fe8ff;background:rgba(0,10,20,.78);padding:8px 12px;border-radius:6px;border:1px solid rgba(120,210,255,.4);">
        REVIEW MASK · SHEET F${options.review.frame} · ${(options.review.frame / options.review.fps).toFixed(3)}s
      </div>` : '';
  const blocksHtml = layout.blocks.map((block, index) => {
    const accent = accentMap.get(block.groupId);
    const colorKey = options.debugColors ? `outline:1px dashed ${accent};` : '';
    const rolesHtml = block.roles.map((role) => {
      const guideLines = (options.guides || options.review) ? role.lines.map((line) => `
          <div style="position:absolute;left:${line.x - role.x}px;top:${line.y - role.y}px;width:${Math.max(1, line.width)}px;height:${line.height}px;border:1px solid ${options.review ? accent : 'rgba(255,255,255,.35)'};"></div>`).join('') : '';
      const linesHtml = role.lines.map((line) => `
        <div class="line" data-line data-group="${escapeHtml(block.groupId)}" data-role="${role.role}" data-line-index="${line.lineIndex}"
             style="position:absolute;left:${line.x - role.x}px;top:${line.y - role.y}px;width:${Math.max(1, line.width + 0.5)}px;height:${role.lineHeightPx}px;line-height:${role.lineHeightPx}px;font-size:${role.fontSize}px;font-weight:${role.fontWeight};letter-spacing:${role.tracking}px;color:${settings[role.role]?.color || ROLE_COLOR[role.role]};">${escapeHtml(line.text)}</div>`).join('');
      const roleTag = options.review
        ? `<div style="position:absolute;left:${-block.markerGutter + 2}px;top:${Math.round(role.lineHeightPx * 0.5 - 12)}px;font:600 16px/24px ${attrFont};color:${accent};">${ROLE_MARK[role.role]}</div>`
        : `<div class="role-mark" style="position:absolute;left:${-block.markerGutter + 8}px;top:${Math.round(role.lineHeightPx * 0.5 - 11)}px;width:22px;height:22px;line-height:22px;text-align:center;font:600 15px/22px ${attrFont};color:${settings[role.role]?.color || ROLE_COLOR[role.role]};opacity:.92;">${ROLE_MARK[role.role]}</div>`;
      return `
        <div class="role" data-role-block="${role.role}" data-group="${escapeHtml(block.groupId)}"
             style="position:absolute;left:${role.x - block.x}px;top:${role.y - block.y}px;width:${Math.max(1, block.panelWidth - block.panelPad * 2 - block.markerGutter)}px;height:${Math.max(1, role.height)}px;">
          ${roleTag}
          ${guideLines}
          ${linesHtml}
        </div>`;
    }).join('');
    const handle = options.draggable
      ? `<div class="box-handle" data-box-handle="${escapeHtml(block.groupId)}" title="拖动改变框宽（作用于该字幕组）"
             style="position:absolute;right:-9px;top:50%;transform:translateY(-50%);width:18px;height:64px;border-radius:5px;background:${accent};opacity:.75;cursor:ew-resize;pointer-events:auto;display:flex;align-items:center;justify-content:center;">
           <span style="width:3px;height:34px;background:rgba(0,0,0,.4);border-radius:2px;"></span>
         </div>`
      : '';
    return `
      <div class="group-block" data-group-block="${escapeHtml(block.groupId)}"
           data-available-width="${Math.round(block.availableWidth ?? 0)}"
           data-canvas-limit="${Math.round(block.canvasTextLimit ?? 0)}"
           style="position:absolute;left:${block.x}px;top:${block.y}px;width:${block.panelWidth}px;height:${block.panelHeight}px;background:rgba(7,11,18,${settings.panelAlpha});border-left:4px solid ${accent};border-radius:8px;${colorKey}">
        ${options.showTags ? `<div class="group-tag" style="position:absolute;left:6px;top:-22px;font:600 15px/18px ${attrFont};color:${accent};opacity:.9;">${escapeHtml(block.groupId)} · ${index + 1}</div>` : ''}
        ${rolesHtml}
        ${handle}
      </div>`;
  }).join('');
  return `
    <style>
      #subtitle-canvas { position:absolute; inset:0; width:${layout.canvas.width}px; height:${layout.canvas.height}px; overflow:hidden; font-family:${layout.fontStack}; }
      #subtitle-canvas .line { white-space:pre; text-align:left; overflow:visible; }
    </style>
    <div id="subtitle-canvas" data-canvas="${layout.canvas.width}x${layout.canvas.height}">${guides}${reviewHud}${blocksHtml}</div>`;
}

export function layoutSummary(layout) {
  const summary = {
    canvas: layout.canvas,
    availableWidth: layout.availableWidth,
    canvasTextLimit: layout.canvasTextLimit,
    safeMarginPx: layout.safeMarginPx,
    totalHeight: layout.totalHeight,
    issues: layout.issues,
    suggestions: layout.suggestions,
    blocks: layout.blocks.map((block) => ({
      groupId: block.groupId,
      start: block.start,
      end: block.end,
      panel: { x: block.x, y: block.y, width: block.panelWidth, height: block.panelHeight },
      roles: block.roles.map((role) => ({
        role: role.role,
        text: role.text,
        fontSize: role.fontSize,
        lineHeightPx: role.lineHeightPx,
        roleBox: { x: role.x, y: role.y, width: role.width, height: role.height },
        lines: role.lines,
        integrity: role.integrity,
        boundaryViolations: role.boundaryViolations,
        issues: role.issues,
      })),
    })),
  };
  if (layout.trace) summary.trace = layout.trace;
  return summary;
}
