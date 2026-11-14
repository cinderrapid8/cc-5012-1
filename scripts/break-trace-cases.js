// Counterexample cases for the break-decision tracer. Each case isolates one
// mechanism so a failure cannot be blamed on "the container is too narrow":
//
//   font-fallback      same characters, some glyphs absent from the declared stack
//   combining-marks    same grapheme count, composed vs decomposed glyph forms
//   glyph-width        same code point count, narrow vs wide glyph forms
//   kinsoku            closing punctuation must stay attached to the preceding glyph
//   tracking-scale     letter-spacing enters measurement at scale 1
//   unbreakable        one token wider than any candidate break
//   narrow-box         an explicitly dragged box is the verified constraint
//   old-samples        the shipped bilingual project runs to completion

const path = require('path');
const store = require('../src/project-store');
const { loadFont } = require('../src/font-coverage');

const ROOT = path.resolve(__dirname, '..');

// Resolves every non-space grapheme against the declared stack, in order, using
// the real font cmap. A glyph no declared font can draw is marked as system
// fallback, which is what the shaping stage reports.
function coverageFor(settings, texts) {
  const fonts = (settings.fonts?.declared || []).map((font) => ({
    family: font.family,
    file: font.file,
    loaded: loadFont(font.file),
  }));
  const byGlyph = {};
  const seen = new Set();
  for (const text of texts) {
    const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(String(text || '')), (part) => part.segment);
    for (const glyph of graphemes) {
      if (seen.has(glyph) || /^\s+$/u.test(glyph)) continue;
      seen.add(glyph);
      const cps = Array.from(glyph, (ch) => String.fromCodePoint(ch.codePointAt(0)));
      let picked = null;
      for (const font of fonts) {
        if (font.loaded.missing) continue;
        if (cps.every((ch) => font.loaded.charToGlyphIndex(ch))) { picked = { family: font.family, file: font.file }; break; }
      }
      byGlyph[glyph] = picked
        ? { family: picked.family, file: picked.file, fallback: false, missing: false }
        : { family: '（系统回退）', file: null, fallback: true, missing: true };
    }
  }
  return {
    byGlyph,
    families: fonts.map((font) => ({ family: font.family, file: font.file, available: !font.loaded.missing })),
    source: 'opentype.js cmap coverage in declared stack order',
  };
}

function case_({ id, description, groups, boxWidthPx, settings, asserts = [], expect }) {
  return { id, description, groups, boxWidthPx, settings, asserts, expect };
}

const LONG_WORD = 'pneumonoultramicroscopicsilicovolcanoconiosis';
const FALLBACK_TEXT = 'The inscription Ⱟ 𝄞 and ꙮ marks predate the survey.';

const cases = [
  case_({
    id: 'font-fallback',
    description: '同字数：ꙮ 由声明字体覆盖，Ⱟ 回退到系统字体，归因到整形阶段',
    groups: [
      {
        id: 'covered',
        original: 'The marks ꙮꙮꙮ appear in the margin.',
        translation: '覆盖字形出现在页边。',
      },
      {
        id: 'fallback',
        original: 'The marks ⰯⰯⰯ appear in the margin.',
        translation: '回退字形出现在页边。',
      },
    ],
    asserts: [
      { groupId: 'covered', role: 'original', cause: 'fit' },
      { groupId: 'fallback', role: 'original', cause: 'font-fallback-width', stage: 'shape' },
      { groupId: 'fallback', role: 'original', field: 'shape.fontFallback.fallbackCount', atLeast: 3 },
      { groupId: 'fallback', role: 'original', absentCause: 'box-width-is-binding' },
    ],
  }),
  case_({
    id: 'combining-marks',
    description: '同字素不同编码：预组合 é 与分解 e+U+0301 的宽度与字素完整',
    boxWidthPx: 900,
    groups: [
      {
        id: 'composed',
        original: 'café résumé naïve',
        translation: '组合字形：预组合字符。',
      },
      {
        id: 'decomposed',
        original: 'café résumé naïve',
        translation: '组合字形：分解字符加组合符。',
      },
    ],
    asserts: [
      { role: 'original', groupId: 'composed', cause: 'fit' },
      { role: 'original', groupId: 'decomposed', cause: 'fit' },
      { role: 'original', groupId: 'decomposed', field: 'shape.ok', equals: true },
      { role: 'original', groupId: 'decomposed', field: 'shape.fontFallback.fallbackCount', equals: 0 },
    ],
  }),
  case_({
    id: 'glyph-width',
    description: '同码点数：窄字形 ii 与宽字形 WW 的实测宽度不同',
    boxWidthPx: 330,
    groups: [
      {
        id: 'narrow',
        original: 'iiiiiiiiiiiiiiiiiiii ii',
        translation: '窄字形。',
      },
      {
        id: 'wide',
        original: 'WWWWWWWWWWWWWWWWWWWW WW',
        translation: '宽字形。',
      },
    ],
    asserts: [
      { role: 'original', groupId: 'narrow', cause: 'fit' },
      { role: 'original', groupId: 'wide', absentCause: 'box-width-is-binding' },
    ],
  }),
  case_({
    id: 'kinsoku',
    description: '禁则：收尾标点不得出现在行首，断点被规则拒绝',
    boxWidthPx: 420,
    groups: [
      {
        id: 'closing',
        original: '雾里，礁石雾里，海鸟雾里，灯塔雾里，渔船雾里，潮声雾里。',
        translation: '收尾标点必须跟随前一字素，不得置于行首。',
      },
    ],
    asserts: [
      { role: 'original', absentCause: 'line-overflow-unattributed' },
      { role: 'original', field: 'line-box.startsWithClosing', equals: false },
      { role: 'original', field: 'line-box.endsWithOpening', equals: false },
      { role: 'original', field: 'line-box.boundaryViolations', equals: [] },
      { role: 'original', field: 'candidates.ok', equals: true },
    ],
  }),
  case_({
    id: 'tracking-scale',
    description: '测量尺度：字间距 3px 进入测量，画布尺度保持 1',
    boxWidthPx: 900,
    groups: [
      {
        id: 'tracked',
        original: 'Tracking applies to the measured width, not the DOM only.',
        translation: '字间距必须进入测量，而不是只作用于 DOM。',
      },
    ],
    settings: { translation: { tracking: 3 } },
    asserts: [
      { role: 'translation', field: 'measure.tracking', equals: 3 },
      { role: 'translation', field: 'measure.scale', equals: 1 },
      { role: 'translation', cause: 'fit' },
    ],
  }),
  case_({
    id: 'unbreakable',
    description: '超长单词：禁则与词边界下没有任何可行断点',
    boxWidthPx: 720,
    groups: [
      {
        id: 'word',
        original: `A single diagnosis — ${LONG_WORD} — was treated as impossible out there.`,
        translation: '在那里，仅仅一个诊断都被视为不可能。',
      },
    ],
    asserts: [
      { role: 'original', cause: 'unbreakable-token', stage: 'candidates' },
      { role: 'original', field: 'solve.choice', equals: 'natural-overflow' },
    ],
  }),
  case_({
    id: 'narrow-box',
    description: '显式拖动的窄框：反事实求解在画布上限内可完全容纳',
    boxWidthPx: 300,
    groups: [
      {
        id: 'dragged',
        original: 'The crew lowered a hydrophone into the trench.',
        translation: '船员把水听器放入海沟。',
      },
    ],
    asserts: [
      { role: 'original', cause: 'box-width-is-binding', stage: 'mount' },
      { role: 'original', field: 'mount.boxWidthSource', equals: 'dragged-group-box' },
      { role: 'original', field: 'solve.counterfactual.overflowPx', equals: 0 },
    ],
  }),
];

// The shipped bilingual project must run to completion under the tracer. This
// case is generated from the real project file so it stays in sync with it.
function oldSampleCase(projectId = process.env.BENCH_PROJECT_ID || 'trench-signals-p2') {
  let project;
  try {
    project = store.readProject(projectId);
  } catch {
    const source = store.loadSource('trench-signals');
    project = { projectId: 'source-trench-signals', revision: 0, settings: source.data.settings, groups: source.data.groups };
  }
  return {
    id: 'old-samples',
    description: '旧双语样例：全部字幕组在真实工程修订下完整跑通',
    projectId,
    groups: project.groups.map((group) => ({
      id: group.id,
      original: group.edit.original,
      translation: group.edit.translation,
    })),
    asserts: project.groups.flatMap((group) => [
      { groupId: group.id, role: 'original', field: 'bind.ok', equals: true },
      { groupId: group.id, role: 'original', field: 'line-box.integrityOk', equals: true },
      { groupId: group.id, role: 'translation', field: 'line-box.integrityOk', equals: true },
      { groupId: group.id, role: 'translation', field: 'bind.chars', atLeast: 1 },
    ]),
  };
}

function all() {
  return [...cases.slice(), oldSampleCase()];
}

function byId(id) {
  if (id === 'old-samples') return oldSampleCase();
  return cases.find((item) => item.id === id) || null;
}

module.exports = { all, byId, coverageFor, oldSampleCase, LONG_WORD, FALLBACK_TEXT };
