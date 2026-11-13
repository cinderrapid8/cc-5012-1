const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');

function ffmpeg(args) {
  const local = path.join(ROOT, 'vendor/ffmpeg');
  const bin = fs.existsSync(local) ? local : require('ffmpeg-static');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-2000)))));
  });
}

function probe(file) {
  const bin = path.join(ROOT, 'vendor/ffprobe');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', file]);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', reject);
    child.on('close', () => resolve(JSON.parse(out)));
  });
}

async function extractFrame(video, time, out) {
  await ffmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', video, '-frames:v', '1', out]);
}

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

// Sample the image for "subtitle-ish" bright text pixels, and check whether any
// text pixel intrudes into the configured safe margin.
function analyzeFrame(file, { safeMarginPx, threshold = 190 }) {
  const png = readPng(file);
  const { width, height, data } = png;
  let bright = 0;
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  const rows = new Array(height).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luma > threshold) {
        bright += 1;
        rows[y] += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const marginViolations = [];
  if (bright > 0) {
    if (minX < safeMarginPx) marginViolations.push({ side: 'left', at: minX });
    if (maxX > width - safeMarginPx) marginViolations.push({ side: 'right', at: maxX });
    if (maxY > height - safeMarginPx) marginViolations.push({ side: 'bottom', at: maxY });
  }
  return { file: path.basename(file), width, height, bright, bounds: { minX, maxX, minY, maxY }, marginViolations };
}

// Compare a burned frame against the same source frame to confirm the subtitle
// layer is really present at the expected time and absent outside all cues.
function frameDelta(aFile, bFile) {
  const a = readPng(aFile);
  const b = readPng(bFile);
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > 24) diff += 1;
  }
  return { changedPixels: diff, totalPixels: a.width * a.height, ratio: diff / (a.width * a.height) };
}

// Compare burned frame against the same source-video frame at identical time.
// Only pixels the subtitle layer actually changed are considered; this excludes
// the test video's own HUD/grid and measures the true burned text bounds.
function analyzeDifference(burnedFile, referenceFile, { safeMarginPx, threshold = 24 }) {
  const burned = readPng(burnedFile);
  const reference = readPng(referenceFile);
  const { width, height } = burned;
  let changed = 0;
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  const cols = new Array(width).fill(0);
  const rows = new Array(height).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const d = Math.abs(burned.data[i] - reference.data[i])
        + Math.abs(burned.data[i + 1] - reference.data[i + 1])
        + Math.abs(burned.data[i + 2] - reference.data[i + 2]);
      if (d > threshold) {
        changed += 1;
        cols[x] += 1;
        rows[y] += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  // Encoding noise affects isolated pixels; require a row/column to carry a
  // meaningful number of changed pixels before it counts as text evidence.
  const MIN_RUN = 6;
  let strongMinX = width;
  let strongMaxX = 0;
  let strongMinY = height;
  let strongMaxY = 0;
  for (let x = 0; x < width; x += 1) {
    if (cols[x] >= MIN_RUN) { strongMinX = Math.min(strongMinX, x); strongMaxX = Math.max(strongMaxX, x); }
  }
  for (let y = 0; y < height; y += 1) {
    if (rows[y] >= MIN_RUN) { strongMinY = Math.min(strongMinY, y); strongMaxY = Math.max(strongMaxY, y); }
  }
  const marginViolations = [];
  if (strongMaxX > 0) {
    if (strongMinX < safeMarginPx) marginViolations.push({ side: 'left', at: strongMinX });
    if (strongMaxX > width - safeMarginPx) marginViolations.push({ side: 'right', at: strongMaxX });
    if (strongMinY < safeMarginPx) marginViolations.push({ side: 'top', at: strongMinY });
    if (strongMaxY > height - safeMarginPx) marginViolations.push({ side: 'bottom', at: strongMaxY });
  }
  return {
    burned: path.basename(burnedFile),
    reference: path.basename(referenceFile),
    changedPixels: changed,
    changedRatio: Number((changed / (width * height)).toFixed(5)),
    bounds: { minX, maxX, minY, maxY },
    strongBounds: { minX: strongMinX, maxX: strongMaxX, minY: strongMinY, maxY: strongMaxY },
    withinSafeArea: marginViolations.length === 0,
    marginViolations,
  };
}

async function ensureBaseline(referenceVideo, outFile) {
  if (fs.existsSync(outFile)) return outFile;
  await ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error', '-i', referenceVideo,
    '-vf', 'scale=1920:1080:flags=lanczos,setsar=1',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', outFile,
  ]);
  return outFile;
}

// Classifies subtitle pixels by the exact colors the layout uses
// (original #ffd86b, translation #7ef0a8) plus a luminance floor. This excludes
// the test video's own white/blue HUD and isolates the actual burned text.
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
}

function defaultPalette() {
  const sourceFile = path.join(ROOT, 'sources/trench-signals.json');
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  return {
    original: hexToRgb(source.settings.original.color),
    translation: hexToRgb(source.settings.translation.color),
    safeMarginPx: source.settings.safeMarginPx,
  };
}

function classifySubtitlePixels(png, { colorTolerance = 26, palette } = {}) {
  const pal = palette || defaultPalette();
  const colors = { original: pal.original, translation: pal.translation };
  const counts = { original: 0, translation: 0 };
  let minX = png.width;
  let maxX = 0;
  let minY = png.height;
  let maxY = 0;
  const box = { original: { minX: png.width, maxX: 0, minY: png.height, maxY: 0 }, translation: { minX: png.width, maxX: 0, minY: png.height, maxY: 0 } };
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i];
      const g = png.data[i + 1];
      const b = png.data[i + 2];
      if (r + g + b < 420) continue;
      for (const [role, [pr, pg, pb]] of Object.entries(colors)) {
        if (Math.abs(r - pr) <= colorTolerance && Math.abs(g - pg) <= colorTolerance && Math.abs(b - pb) <= colorTolerance) {
          counts[role] += 1;
          const roleBox = box[role];
          roleBox.minX = Math.min(roleBox.minX, x); roleBox.maxX = Math.max(roleBox.maxX, x);
          roleBox.minY = Math.min(roleBox.minY, y); roleBox.maxY = Math.max(roleBox.maxY, y);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
    }
  }
  const active = counts.original + counts.translation > 0;
  return {
    active,
    counts,
    bounds: active ? { minX, maxX, minY, maxY } : null,
    roleBounds: {
      original: counts.original ? box.original : null,
      translation: counts.translation ? box.translation : null,
    },
  };
}

function checkSafe(bounds, width, height, safeMarginPx) {
  if (!bounds) return { withinSafeArea: true, violations: [] };
  const violations = [];
  if (bounds.minX < safeMarginPx) violations.push({ side: 'left', at: bounds.minX });
  if (bounds.maxX > width - safeMarginPx) violations.push({ side: 'right', at: bounds.maxX });
  if (bounds.minY < safeMarginPx) violations.push({ side: 'top', at: bounds.minY });
  if (bounds.maxY > height - safeMarginPx) violations.push({ side: 'bottom', at: bounds.maxY });
  return { withinSafeArea: violations.length === 0, violations };
}

module.exports = { ffmpeg, probe, extractFrame, analyzeFrame, analyzeDifference, classifySubtitlePixels, checkSafe, frameDelta, readPng, ensureBaseline };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const video = args[0];
    const safe = Number(args[1] || defaultPalette().safeMarginPx);
    if (!video) {
      console.error('usage: node scripts/verify-output.js <video.mp4> [safeMarginPx]');
      process.exit(2);
    }
    const info = await probe(video);
    console.log(JSON.stringify(info, null, 2));
    const tmp = fs.mkdtempSync('/tmp/verify-');
    const times = args.slice(2).map(Number).filter((n) => Number.isFinite(n));
    for (const t of times.length ? times : [0.5, 2, 5, 9, 12.6, 14.6]) {
      const burnedFile = path.join(tmp, `b-${t}.png`);
      await extractFrame(video, t, burnedFile);
      const png = readPng(burnedFile);
      const classified = classifySubtitlePixels(png);
      const safeCheck = checkSafe(classified.bounds, png.width, png.height, safe);
      console.log(JSON.stringify({
        time: t,
        active: classified.active,
        textPixels: classified.counts,
        bounds: classified.bounds,
        roleBounds: classified.roleBounds,
        withinSafeArea: safeCheck.withinSafeArea,
        marginViolations: safeCheck.violations,
      }, null, 1));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  })().catch((error) => { console.error(error); process.exit(1); });
}
