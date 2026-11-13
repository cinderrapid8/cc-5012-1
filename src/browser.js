const path = require('path');
const { chromium } = require('playwright');

const SYSROOT = path.resolve(__dirname, '../vendor/sysroot');
const libDirs = [
  path.join(SYSROOT, 'usr/lib/aarch64-linux-gnu'),
  path.join(SYSROOT, 'lib/aarch64-linux-gnu'),
  path.join(SYSROOT, 'usr/lib'),
  path.join(SYSROOT, 'lib'),
];
process.env.LD_LIBRARY_PATH = [
  ...libDirs,
  process.env.LD_LIBRARY_PATH || '',
].filter(Boolean).join(':');

async function launchBrowser(options = {}) {
  return chromium.launch({
    headless: true,
    args: [
      '--font-render-hinting=none',
      '--disable-lcd-text',
      '--force-color-profile=srgb',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
    ...options,
  });
}

module.exports = { launchBrowser };
