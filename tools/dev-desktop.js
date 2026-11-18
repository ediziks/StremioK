'use strict';
// Desktop dev runner (not for the TV): the real service (TizenBrew mode, 127.0.0.1:8098, guides
// kept in memory only) and the app at http://127.0.0.1:8081/module/stremiok/index.html.
// App changes: reload the page. Service changes: restart this. Keys: Esc BACK, F2 GUIDE, F3 BLUE,
// F4 PLAY, F5 STOP, PgUp/PgDn CH+/CH-. From Gemini's session (2026-11-16).

const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');   // (the repo: this file is in tools/)
const STATIC_PORT = 8081;

// 1. Start StremioK Node service in TizenBrew sandbox mode (typeof __filename === 'undefined' -> listens on 127.0.0.1:8098)
const serviceCode = fs.readFileSync(path.join(REPO, 'service/index.js'), 'utf8');
const svcCtx = vm.createContext({
    require,
    process,
    Buffer,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    URL,
    TextDecoder,
    TextEncoder
});
svcCtx.global = svcCtx;
vm.runInContext(serviceCode, svcCtx, { filename: 'service-tizenbrew-dev.js' });

// 2. Serve StremioK at http://127.0.0.1:8081/module/stremiok/index.html (triggers YTPlay TizenBrew mode -> service :8098)
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8'
};

// Tiny desktop key shim (maps Esc -> 10009 BACK, F2 -> GUIDE, F3 -> BLUE, F4 -> PLAY, Shift+Enter -> OK_LONG)
const DESKTOP_SHIM = `<script>
(function(){
  if (window.Keys && window.Keys.CODE) {
    Keys.CODE[27] = 'BACK';
    Keys.CODE[113] = 'GUIDE';
    Keys.CODE[114] = 'BLUE';
    Keys.CODE[115] = 'PLAY';
    Keys.CODE[116] = 'STOP';
    Keys.CODE[33] = 'CHUP';
    Keys.CODE[34] = 'CHDOWN';
  }
})();
</script>`;

const web = http.createServer((req, res) => {
    const cleanUrl = (req.url || '/').split('?')[0];
    if (cleanUrl === '/' || cleanUrl === '/index.html' || cleanUrl === '/module/stremiok' || cleanUrl === '/module/stremiok/') {
        res.writeHead(302, { Location: '/module/stremiok/index.html' });
        res.end();
        return;
    }
    const prefix = '/module/stremiok/';
    const rel = cleanUrl.startsWith(prefix) ? cleanUrl.slice(prefix.length) : cleanUrl.replace(/^\/+/, '');
    const filePath = path.resolve(REPO, rel || 'index.html');
    if (!filePath.startsWith(REPO)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const type = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        if (rel === 'index.html' && ext === '.html') {
            res.end(data.toString('utf8').replace('</body>', DESKTOP_SHIM + '</body>'));
            return;
        }
        res.end(data);
    });
});

web.listen(STATIC_PORT, '127.0.0.1', () => {
    console.log('[desktop-dev] UI serving at http://127.0.0.1:' + STATIC_PORT + '/module/stremiok/index.html');
});
