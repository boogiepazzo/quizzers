// Loads the extension's classic-script libraries into Node's global scope,
// the same way importScripts() does in the service worker.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// QZ_EXT_DIR=edge-extension runs the same suites against the Edge edition.
const EXT = process.env.QZ_EXT_DIR
  ? path.resolve(__dirname, '..', '..', process.env.QZ_EXT_DIR)
  : path.join(__dirname, '..', '..', 'extension');

function loadLib(...files) {
  for (const file of files) {
    vm.runInThisContext(fs.readFileSync(path.join(EXT, file), 'utf8'), { filename: file });
  }
  return globalThis.QZ;
}

module.exports = { loadLib, EXT };
