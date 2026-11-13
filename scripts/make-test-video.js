const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { launchBrowser } = require('../src/browser');

const ROOT = path.resolve(__dirname, '..');
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 25;
const DURATION = 15;
const OUT = path.join(ROOT, 'media/test-documentary.mp4');
const FRAMES = path.join(ROOT, 'media/.frames');

function ffmpegPath() {
  const local = path.join(ROOT, 'vendor/ffmpeg');
  return fs.existsSync(local) ? local : require('ffmpeg-static');
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-3000)))));
  });
}

(async () => {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const total = FPS * DURATION;
  for (let frame = 0; frame < total; frame += 1) {
    const t = frame / FPS;
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#0a1620}
      .sky{position:absolute;inset:0;background:
        radial-gradient(ellipse at 70% 20%, rgba(90,170,220,.35), transparent 60%),
        linear-gradient(180deg,#071018,#0d2433 55%,#04121a)}
      .sea{position:absolute;left:0;right:0;bottom:0;height:36%;background:linear-gradient(180deg,#0b2b3c,#061920)}
      .ridge{position:absolute;left:0;right:0;bottom:34%;height:26%;background:linear-gradient(180deg,#123243,#0a202b);clip-path:polygon(0 70%,12% 40%,24% 62%,38% 22%,52% 58%,66% 30%,80% 66%,92% 44%,100% 62%,100% 100%,0 100%)}
      .grid{position:absolute;inset:0;background-image:linear-gradient(rgba(120,200,255,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(120,200,255,.08) 1px,transparent 1px);background-size:80px 45px}
      .marker{position:absolute;left:0;top:0;height:100%;width:3px;background:#ffb454;opacity:.7;transition:none}
      .hud{position:absolute;left:28px;top:24px;font:600 26px/1.3 ui-monospace,Menlo,monospace;color:#ffffff;background:rgba(3,10,15,.66);padding:10px 14px;border-radius:8px;border:1px solid rgba(150,220,255,.25)}
      .hud .small{font-size:16px;color:#8fc6de;font-weight:400}
      .tick{position:absolute;right:28px;top:24px;font:600 20px/1.2 ui-monospace,monospace;color:#7fd4ff;background:rgba(3,10,15,.66);padding:8px 12px;border-radius:8px}
      .waterline{position:absolute;left:0;right:0;bottom:36%;height:2px;background:rgba(160,230,255,.5)}
      .bubble{position:absolute;border-radius:50%;border:2px solid rgba(170,230,255,.55)}
    </style></head><body>
      <div class="sky"></div><div class="ridge"></div><div class="sea"></div><div class="grid"></div>
      <div class="waterline"></div>
      ${[0, 1, 2, 3, 4].map((i) => `<div class="bubble" style="width:${8 + i * 5}px;height:${8 + i * 5}px;left:${18 + i * 15}%;bottom:${20 + ((frame * (1 + i * 0.3)) % 26)}%"></div>`).join('')}
      <div class="hud">TRENCH SIGNALS · TEST REEL<br><span class="small">TC ${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}.${String(Math.round((t % 1) * 1000)).padStart(3, '0')} · FRAME ${frame}</span></div>
      <div class="tick">SOURCE ${FPS} FPS</div>
      <div class="marker" style="left:${(frame / total) * 100}%"></div>
    </body></html>`);
    const png = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(FRAMES, `f-${String(frame).padStart(5, '0')}.png`), png);
  }
  await browser.close();

  const audio = path.join(FRAMES, 'tone.wav');
  await run(ffmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=196:sample_rate=48000:duration=${DURATION}`, '-c:a', 'pcm_s16le', audio]);
  await run(ffmpegPath(), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(FPS), '-i', path.join(FRAMES, 'f-%05d.png'),
    '-i', audio,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', OUT,
  ]);
  fs.rmSync(FRAMES, { recursive: true, force: true });
  console.log('WROTE', OUT, fs.statSync(OUT).size);
})();
