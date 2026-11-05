// Builds the Microsoft Edge edition of the extension into edge-extension/.
//
// Edge runs Chromium's Manifest V3 platform, so the code is shared with
// extension/. Only browser-specific strings and manifest fields differ;
// they are listed below and every replacement must match, so the Edge
// edition can't silently drift from the Chrome source.
//
//   node scripts/build-edge.js          regenerate edge-extension/
//   node scripts/build-edge.js --check  fail if edge-extension/ is out of date
//   node scripts/build-edge.js --zip    also write dist/quizzers-edge-<version>.zip
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'edge-extension');

const REPLACEMENTS = [
  {
    file: 'lib/errors.js',
    from: 'Chrome blocks extensions on chrome:// pages, the Web Store and some other sites.',
    to: 'Edge blocks extensions on edge:// pages, the Microsoft Edge Add-ons store and some other sites.',
  },
  {
    file: 'popup.js',
    from: 'chrome://extensions/shortcuts',
    to: 'edge://extensions/shortcuts',
  },
];

const MANIFEST_OVERRIDES = {
  name: 'Quizzers – MCQ Answer Highlighter for Microsoft Edge',
  description:
    'Finds visible multiple-choice questions on course pages, asks an OpenRouter model, and highlights the suggested answer in Edge. Never clicks for you.',
  // Edge versions track Chromium versions, so the Chromium minimum applies as-is.
};

const EDGE_README = `# Quizzers for Microsoft Edge

Generated from \`../extension/\` by \`node scripts/build-edge.js\`, so don't edit files here.
Change \`extension/\` (or the Edge-specific overrides in \`scripts/build-edge.js\`) and rebuild.

## Load unpacked in Edge

1. Open **edge://extensions** in Microsoft Edge 116 or newer.
2. Turn on **Developer mode** (toggle in the left sidebar, or at the bottom of the page).
3. Click **Load unpacked** and choose this \`edge-extension/\` folder.
4. Click the puzzle-piece **Extensions** button in the toolbar, then the eye icon next to Quizzers to show it in the toolbar.
5. The settings page opens on first install. Paste your OpenRouter API key, pick a model, click **Test key**, then **Save**.

After changing files, rebuild, click **Reload** on the Quizzers card in edge://extensions, and refresh the course tab.

The shortcut is Alt+Shift+Q. Change it at **edge://extensions/shortcuts**.

## Publish to Edge Add-ons

1. Run \`node scripts/build-edge.js --zip\` to create \`dist/quizzers-edge-<version>.zip\`.
2. Upload the zip in [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview).

The store listing needs a privacy policy, because the extension sends question text to OpenRouter with the user's own key. See "Privacy" in the main README.

Everything else is the same as the Chrome edition: features, guardrails, permissions and tests. See the [main README](../README.md).
`;

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

function build(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  copyDir(SRC, outDir);

  for (const { file, from, to } of REPLACEMENTS) {
    const p = path.join(outDir, file);
    const text = fs.readFileSync(p, 'utf8');
    if (!text.includes(from)) throw new Error(`Edge override no longer matches ${file}: “${from}”. Update scripts/build-edge.js.`);
    fs.writeFileSync(p, text.split(from).join(to));
  }

  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  Object.assign(manifest, MANIFEST_OVERRIDES);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  fs.writeFileSync(path.join(outDir, 'README.md'), EDGE_README);
  return manifest;
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p)];
  });
}

function check() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quizzers-edge-'));
  try {
    build(tmp);
    const expected = listFiles(tmp).sort();
    const actual = fs.existsSync(OUT) ? listFiles(OUT).sort() : [];
    const stale = [
      ...expected.filter((f) => !actual.includes(f) || !fs.readFileSync(path.join(tmp, f)).equals(fs.readFileSync(path.join(OUT, f)))),
      ...actual.filter((f) => !expected.includes(f)),
    ];
    return stale;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const stale = check();
    if (stale.length) {
      console.error(`edge-extension/ is out of date (${stale.join(', ')}). Run: node scripts/build-edge.js`);
      process.exit(1);
    }
    console.log('edge-extension/ is up to date.');
  } else {
    const manifest = build(OUT);
    console.log(`Built edge-extension/ (v${manifest.version}).`);
    if (process.argv.includes('--zip')) {
      const dist = path.join(ROOT, 'dist');
      fs.mkdirSync(dist, { recursive: true });
      const zipPath = path.join(dist, `quizzers-edge-${manifest.version}.zip`);
      fs.rmSync(zipPath, { force: true });
      // Zip the folder's contents (manifest.json at the archive root), without the README.
      execFileSync('zip', ['-r', '-X', '-q', zipPath, '.', '-x', 'README.md'], { cwd: OUT });
      console.log(`Wrote ${path.relative(ROOT, zipPath)}`);
    }
  }
}

module.exports = { build, check, REPLACEMENTS, OUT };
