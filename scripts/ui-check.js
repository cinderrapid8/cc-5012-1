const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { launchBrowser } = require('../src/browser');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.BENCH_UI_PORT || 4312);
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ui-projects-'));
const RENDERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ui-renders-'));

let server;
let browser;
let failures = 0;

function check(name, pass, detail) {
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('node', ['src/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), BENCH_PROJECTS_DIR: PROJECT_DIR, BENCH_RENDERS_DIR: RENDERS_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout.on('data', (data) => {
      out += data.toString();
      if (out.includes('listening')) resolve();
    });
    server.stderr.on('data', (data) => { out += data.toString(); });
    server.on('error', reject);
    setTimeout(() => reject(new Error(`server timeout: ${out}`)), 8000);
  });
}

const editTranslation = '船员把水听器放入海沟，那里只传来一声漫长的呼唤——';

(async () => {
  await startServer();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  const unexpected404 = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource: the server responded with a status of 404/.test(message.text())) errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() !== 404) return;
    if (!response.url().endsWith('/assets/fonts/DocumentarySerif-Regular.ttf')) unexpected404.push(response.url());
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#source-title', { state: 'attached' });
  check('workbench loads without unexpected JS errors', errors.length === 0, errors.join(' | '));
  check('the only missing resource is the intentionally absent font', unexpected404.length === 0, unexpected404.join(' | '));

  await page.click('#btn-new-project');
  await page.waitForFunction(() => document.querySelector('#revision-line')?.textContent.includes('r1'));
  check('new independent project can be created from the UI',
    (await page.textContent('#revision-line')).includes('r1'));

  await page.waitForFunction(() => document.querySelectorAll('#overlay .line').length > 0);
  const timeText = await page.textContent('#timecode');
  check('preview shows the first cue at load time', timeText.includes('F25'), timeText);

  const measurePreview = async () => {
    return page.evaluate(() => {
      const inner = document.querySelector('#overlay > div');
      const lines = [...document.querySelectorAll('#overlay .line')];
      return {
        innerWidth: inner.style.width,
        innerHeight: inner.style.height,
        fontSize: lines[0]?.style.fontSize,
        computedFontSize: lines[0] ? getComputedStyle(lines[0]).fontSize : null,
        transform: inner.style.transform,
        rectWidth: inner.getBoundingClientRect().width,
      };
    });
  };
  const setZoom = async (value) => {
    await page.evaluate((v) => {
      const input = document.querySelector('#zoom');
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await page.waitForTimeout(250);
  };
  const at30 = (await setZoom(30), await measurePreview());
  const at100 = (await setZoom(100), await measurePreview());
  check('zoom keeps the final canvas at 1920×1080', at30.innerWidth === '1920px' && at100.innerWidth === '1920px' && at30.innerHeight === '1080px' && at100.innerHeight === '1080px');
  check('zoom keeps the final font size in canvas pixels', at30.fontSize === at100.fontSize && at100.fontSize === '46px' && at30.computedFontSize === '46px');
  check('zoom only changes the view scale', at30.transform === 'scale(0.3)' && at100.transform === 'scale(1)' && Math.abs(at100.rectWidth - 1920) < 2);

  await page.waitForTimeout(1200);
  const fallback = await page.textContent('#fallback-detail');
  check('font panel reports the missing requested font', fallback.includes('请求但缺失') && fallback.includes('Documentary Serif'), fallback.slice(0, 120));
  check('font panel shows measured platform fonts', fallback.includes('实测'), fallback.slice(0, 220));

  // edit + save through the UI
  await page.fill('textarea.trans', editTranslation);
  await page.waitForTimeout(400);
  check('editing marks the project dirty', (await page.textContent('#save-status')).includes('未保存'));
  await page.click('#btn-save');
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('已保存'), { timeout: 15000 });
  check('saving through the UI succeeds', (await page.textContent('#save-status')).includes('已保存'));

  // reload and confirm persistence
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#overlay .line').length > 0, { timeout: 15000 });
  const reopenedText = await page.inputValue('textarea.trans');
  check('reopening the project restores the UI edit', reopenedText === editTranslation, reopenedText.slice(0, 40));

  const saveStatus = await page.textContent('#save-status');
  check('reopened project starts clean', saveStatus.includes('已保存'));

  // diagnostics at an overlap frame
  await page.evaluate(() => {
    const scrub = document.querySelector('#scrub');
    scrub.value = '12.6';
    scrub.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(900);
  const diagnostics = await page.textContent('#diagnostics');
  const live = await page.textContent('#live-issues');
  check('overlap frame shows two independent subtitle panels', (await page.$$('#overlay .group-block')).length === 2);
  check('diagnostics flag the time overlap', live.includes('时间交叠') || diagnostics.includes('交叠') || diagnostics.includes('overlap'), `${live}`);
  const blocks = await page.evaluate(() => [...document.querySelectorAll('#overlay .group-block')].map((block) => block.getAttribute('data-group-block')));
  check('overlapping groups render as separate group blocks', blocks.length === 2 && blocks[0] !== blocks[1], blocks.join(','));

  // overflow diagnostics + one-click adjustable option
  await page.evaluate(() => {
    const scrub = document.querySelector('#scrub');
    scrub.value = '5';
    scrub.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(900);
  check('overflowing cue is flagged in the live status', (await page.textContent('#live-issues')).includes('排版问题'));
  const diagnosticsOverflow = await page.textContent('#diagnostics');
  check('diagnostics expose an adjustable line-count option', (await page.$$('.sugg button')).length > 0 && diagnosticsOverflow.includes('超出配置行数'));
  await page.click('.sugg button');
  await page.waitForTimeout(900);
  check('applying the suggestion clears the overflow without deleting text',
    (await page.textContent('#live-issues')).includes('排版通过') && (await page.textContent('#save-status')).includes('未保存'));
  const originalLines = await page.evaluate(() => [...document.querySelectorAll('#overlay .line[data-role="original"]')].map((node) => node.textContent).join(' '));
  check('applied layout still contains the long word', originalLines.includes('pneumonoultramicroscopicsilicovolcanoconiosis'), originalLines.slice(0, 80));

  await page.evaluate(() => {
    const scrub = document.querySelector('#scrub');
    scrub.value = '2';
    scrub.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/ui-check.png', fullPage: true });

  // render through the UI is covered by selftest; here ensure the button exists and is enabled
  check('render button is available in the UI', await page.isEnabled('#btn-render'));

  await browser.close();
  server.kill('SIGTERM');
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  fs.rmSync(RENDERS_DIR, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nUI checks passed');
  process.exit(failures ? 1 : 0);
})().catch(async (error) => {
  console.error('UI CHECK ERROR', error);
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
  process.exit(2);
});
