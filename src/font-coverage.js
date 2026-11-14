const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');

const ROOT = path.resolve(__dirname, '..');
const cache = new Map();

function loadFont(file) {
  if (cache.has(file)) return cache.get(file);
  const abs = path.resolve(ROOT, file);
  if (!fs.existsSync(abs)) {
    const missing = { missing: true, path: abs };
    cache.set(file, missing);
    return missing;
  }
  const font = opentype.loadSync(abs);
  cache.set(file, font);
  return font;
}

function glyphCoverage(font, codepoints) {
  const covered = [];
  const missing = [];
  for (const cp of codepoints) {
    if (font.charToGlyphIndex(String.fromCodePoint(cp))) covered.push(cp);
    else missing.push(cp);
  }
  return { covered, missing };
}

function graphemesOf(text) {
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

function coverageForGrapheme(font, grapheme) {
  const cps = Array.from(grapheme, (ch) => ch.codePointAt(0));
  for (const cp of cps) {
    if (!font.charToGlyphIndex(String.fromCodePoint(cp))) return false;
  }
  return true;
}

function fontCoverageReport(settings, text = '') {
  const families = [];
  for (const font of settings.fonts.declared) {
    const loaded = loadFont(font.file);
    if (loaded.missing) {
      families.push({ family: font.family, file: font.file, status: 'missing-file', note: font.note || null, glyphs: 0 });
    } else {
      const internal = loaded.names?.fontFamily?.en || null;
      families.push({
        family: font.family,
        file: font.file,
        status: 'available',
        glyphs: loaded.numGlyphs,
        unitsPerEm: loaded.unitsPerEm,
        internalFamily: internal,
        internalSubfamily: loaded.names?.fontSubfamily?.en || null,
        note: font.note || null,
      });
    }
  }
  const resolved = [];
  const unresolved = new Set();
  const byGlyph = {};
  if (text) {
    for (const grapheme of graphemesOf(text)) {
      if (/^\s$/u.test(grapheme)) continue;
      let picked = null;
      for (let i = 0; i < settings.fonts.declared.length; i += 1) {
        const font = settings.fonts.declared[i];
        const loaded = loadFont(font.file);
        if (loaded.missing) continue;
        if (coverageForGrapheme(loaded, grapheme)) { picked = { family: font.family, file: font.file }; break; }
      }
      if (!picked) {
        picked = { family: '（系统回退）', file: null };
        unresolved.add(grapheme);
      }
      if (!byGlyph[grapheme]) {
        byGlyph[grapheme] = {
          family: picked.family,
          file: picked.file,
          fallback: !picked.file,
          missing: !picked.file,
        };
      }
      const last = resolved[resolved.length - 1];
      if (last && last.family === picked.family) last.text += grapheme;
      else resolved.push({ ...picked, text: grapheme });
    }
  }
  const missingRequirements = families.filter((family) => family.status === 'missing-file').map((family) => family.family);
  return {
    requestedStack: settings.fonts.requestedStack,
    families,
    missingRequirements,
    resolved: text ? resolved : null,
    unresolved: text ? [...unresolved] : null,
    byGlyph: text ? byGlyph : null,
    source: 'opentype.js cmap coverage in declared stack order (pre-render approximation)',
  };
}

module.exports = { fontCoverageReport, loadFont };
