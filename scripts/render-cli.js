const path = require('path');
const store = require('../src/project-store');
const { renderProject } = require('../src/render');

function usage() {
  console.error('usage: node scripts/render-cli.js <projectId> [--mask] [--fps N] [--port N]');
  process.exit(2);
}

(async () => {
  const args = process.argv.slice(2);
  const projectId = args.find((arg) => !arg.startsWith('--'));
  if (!projectId) usage();
  const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const port = Number(flag('--port') || process.env.PORT || 4310);
  const result = await renderProject({
    projectId,
    baseUrl: `http://127.0.0.1:${port}`,
    mode: args.includes('--mask') ? 'preview-mask' : 'burn',
    fps: flag('--fps') ? Number(flag('--fps')) : undefined,
    actor: 'cli',
  });
  console.log(JSON.stringify({
    output: result.output,
    outputPath: path.relative(process.cwd(), result.outputPath),
    fps: result.fps,
    totalFrames: result.totalFrames,
    issueCount: result.issueCount,
    manifest: result.manifest,
  }, null, 2));
})().catch((error) => {
  console.error(`render failed: ${error.message}`);
  process.exit(1);
});
