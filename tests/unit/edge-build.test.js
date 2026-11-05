const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { check, OUT } = require('../../scripts/build-edge');

test('edge-extension/ is generated from extension/ and up to date', () => {
  assert.deepEqual(check(), [], 'run: node scripts/build-edge.js');
});

test('Edge edition has Edge wording and no Chrome-only URLs', () => {
  const read = (f) => fs.readFileSync(path.join(OUT, f), 'utf8');
  assert.match(read('lib/errors.js'), /edge:\/\/ pages, the Microsoft Edge Add-ons store/);
  assert.match(read('popup.js'), /edge:\/\/extensions\/shortcuts/);
  for (const f of ['lib/errors.js', 'popup.js', 'popup.html', 'manifest.json']) {
    assert.doesNotMatch(read(f), /chrome:\/\/|Web Store/, f);
  }
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.name, /Microsoft Edge/);
});
