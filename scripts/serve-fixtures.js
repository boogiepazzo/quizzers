// Serves tests/fixtures on http://localhost:8080 for manual testing in Chrome.
// Open http://localhost:8080/quiz.html, then click the Quizzers toolbar icon →
// "Scan this tab" (localhost isn't in the default site list, so the popup
// injects the content scripts on demand via activeTab).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'tests', 'fixtures');
const PORT = Number(process.env.PORT) || 8080;

http
  .createServer((req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname)) || 'quiz.html';
    const file = path.join(ROOT, name);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    let html = fs.readFileSync(file, 'utf8');
    // The e2e suite serves the iframes from edX/other origins; locally, keep them same-origin.
    html = html
      .replace('https://courses.edx.org/xblock/quizzers-e2e', '/edx-frame.html')
      .replace('https://example.org/embed', '/other-frame.html');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  })
  .listen(PORT, () => console.log(`Fixtures at http://localhost:${PORT}/quiz.html (Ctrl+C to stop)`));
