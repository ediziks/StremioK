'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const crypto = require('crypto');
const url = require('url');
const string_decoder = require('string_decoder');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Strip comments, string literals, and regex literals from JS code to check for banned ES6+ syntax.
 * Replaces stripped characters with spaces so line numbers and offsets remain aligned.
 */
function stripCode(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let state = 'CODE'; // CODE, LINE_COMMENT, BLOCK_COMMENT, STR_SINGLE, STR_DOUBLE, REGEX
    let lastToken = '';
    let inCharClass = false;

    // Tokens before which a '/' is considered a regex literal rather than division
    const regexPrevTokens = new Set([
        '(', '[', '{', '=', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~',
        '?', ':', ';', ',', '<', '>', '<=', '>=', '==', '!=', '===', '!==',
        '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=',
        '&&', '||',
        'return', 'throw', 'typeof', 'void', 'delete', 'instanceof', 'in', 'new', 'case'
    ]);

    while (i < n) {
        const c = src[i];
        const next = i + 1 < n ? src[i + 1] : '';

        if (state === 'LINE_COMMENT') {
            if (c === '\n') {
                state = 'CODE';
                out += '\n';
            } else if (c === '\r') {
                out += '\r';
            } else {
                out += ' ';
            }
            i++;
            continue;
        }

        if (state === 'BLOCK_COMMENT') {
            if (c === '*' && next === '/') {
                state = 'CODE';
                out += '  ';
                i += 2;
            } else {
                out += (c === '\n' ? '\n' : (c === '\r' ? '\r' : ' '));
                i++;
            }
            continue;
        }

        if (state === 'STR_SINGLE') {
            if (c === '\\') {
                out += (c === '\n' ? '\n' : ' ');
                out += (next === '\n' ? '\n' : ' ');
                i += 2;
            } else if (c === '\'') {
                state = 'CODE';
                out += ' ';
                i++;
            } else {
                out += (c === '\n' ? '\n' : (c === '\r' ? '\r' : ' '));
                i++;
            }
            continue;
        }

        if (state === 'STR_DOUBLE') {
            if (c === '\\') {
                out += (c === '\n' ? '\n' : ' ');
                out += (next === '\n' ? '\n' : ' ');
                i += 2;
            } else if (c === '"') {
                state = 'CODE';
                out += ' ';
                i++;
            } else {
                out += (c === '\n' ? '\n' : (c === '\r' ? '\r' : ' '));
                i++;
            }
            continue;
        }

        if (state === 'REGEX') {
            if (c === '\\') {
                out += '  ';
                i += 2;
            } else if (c === '[' && !inCharClass) {
                inCharClass = true;
                out += ' ';
                i++;
            } else if (c === ']' && inCharClass) {
                inCharClass = false;
                out += ' ';
                i++;
            } else if (c === '/' && !inCharClass) {
                state = 'CODE';
                out += ' ';
                i++;
                // consume flags (gimsuy)
                while (i < n && /[a-z]/i.test(src[i])) {
                    out += ' ';
                    i++;
                }
            } else {
                out += (c === '\n' ? '\n' : ' ');
                i++;
            }
            continue;
        }

        // state === CODE
        if (c === '/' && next === '/') {
            state = 'LINE_COMMENT';
            out += '  ';
            i += 2;
            continue;
        }

        if (c === '/' && next === '*') {
            state = 'BLOCK_COMMENT';
            out += '  ';
            i += 2;
            continue;
        }

        if (c === '\'') {
            state = 'STR_SINGLE';
            out += ' ';
            i++;
            continue;
        }

        if (c === '"') {
            state = 'STR_DOUBLE';
            out += ' ';
            i++;
            continue;
        }

        if (c === '/') {
            if (!lastToken || regexPrevTokens.has(lastToken)) {
                state = 'REGEX';
                inCharClass = false;
                out += ' ';
                i++;
                continue;
            }
        }

        // Keep track of last token for regex disambiguation
        if (/[a-zA-Z0-9_$]/.test(c)) {
            let ident = '';
            let j = i;
            while (j < n && /[a-zA-Z0-9_$]/.test(src[j])) {
                ident += src[j];
                out += src[j];
                j++;
            }
            lastToken = ident;
            i = j;
            continue;
        }

        if (!/\s/.test(c)) {
            let op = c;
            if (next && '+-=*&|<>!'.includes(c) && '=><+-'.includes(next)) {
                op += next;
            }
            lastToken = op;
        }

        out += c;
        i++;
    }

    return out;
}

/**
 * Scan all files in js/ (excluding vendor/ and lang/) and service/ for ES5 compliance.
 * Verifies both clean parse via vm.Script and absence of banned ES6+ syntax.
 */
function scanES5() {
    const BANNED_REGEX = /\b(let|const|class|async|await)\b|=>|`/g;
    const errors = [];
    const files = [];

    function collectFiles(dir, excludeDirs) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (!excludeDirs.includes(ent.name)) {
                    collectFiles(full, excludeDirs);
                }
            } else if (ent.isFile() && ent.name.endsWith('.js')) {
                files.push(full);
            }
        }
    }

    collectFiles(path.join(REPO_ROOT, 'js'), ['vendor', 'lang']);
    collectFiles(path.join(REPO_ROOT, 'service'), []);

    for (const filePath of files) {
        const relPath = path.relative(REPO_ROOT, filePath);
        const code = fs.readFileSync(filePath, 'utf8');

        // 1. Verify clean parse via vm.Script
        try {
            new vm.Script(code, { filename: relPath });
        } catch (err) {
            errors.push({
                file: relPath,
                line: err.lineNumber || 1,
                reason: `vm.Script parse error: ${err.message}`
            });
            continue;
        }

        // 2. Verify no banned tokens outside comments/strings/regexes
        const stripped = stripCode(code);
        const lines = stripped.split('\n');
        for (let idx = 0; idx < lines.length; idx++) {
            const line = lines[idx];
            let match;
            BANNED_REGEX.lastIndex = 0;
            while ((match = BANNED_REGEX.exec(line)) !== null) {
                errors.push({
                    file: relPath,
                    line: idx + 1,
                    reason: `Banned ES6+ token '${match[0]}'`,
                    snippet: line.trim()
                });
            }
        }
    }

    return { files, errors };
}

/**
 * Evaluates service/index.js in a vm sandbox with stubbed require, process, and console.
 * Returns the sandbox context so top-level function declarations can be called.
 */
function loadService(extraGlobals) {
    const mockServer = {
        listen: function () {
            const cb = arguments[arguments.length - 1];
            if (typeof cb === 'function') { setImmediate(cb); }
            return this;
        },
        on: function () { return this; },
        close: function (cb) {
            if (typeof cb === 'function') { setImmediate(cb); }
            return this;
        },
        maxConnections: 0,
        timeout: 0
    };

    const stubbedHttp = Object.assign({}, http, {
        createServer: function () { return mockServer; }
    });
    const stubbedHttps = Object.assign({}, https, {
        createServer: function () { return mockServer; }
    });

    const sandbox = {
        Buffer,
        setTimeout,
        clearTimeout,
        setInterval: function (fn, ms) {
            const t = setInterval(fn, ms);
            if (t && typeof t.unref === 'function') { t.unref(); }
            return t;
        },
        clearInterval,
        setImmediate,
        clearImmediate,
        console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
        process: {
            version: process.version,
            platform: process.platform,
            env: {},
            cwd: () => REPO_ROOT
        },
        require: function (mod) {
            if (extraGlobals && typeof extraGlobals.require === 'function') {
                const custom = extraGlobals.require(mod);
                if (custom !== undefined) return custom;
            }
            if (mod === 'http') return stubbedHttp;
            if (mod === 'https') return stubbedHttps;
            if (mod === 'net') return net;
            if (mod === 'tls') return tls;
            if (mod === 'zlib') return zlib;
            if (mod === 'crypto') return crypto;
            if (mod === 'url') return url;
            if (mod === 'string_decoder') return string_decoder;
            if (mod === 'fs') return fs;
            if (mod === 'os') return os;
            return require(mod);
        }
    };

    if (extraGlobals) {
        for (const k of Object.keys(extraGlobals)) {
            if (k !== 'require') {
                sandbox[k] = extraGlobals[k];
            }
        }
    }

    const ctx = vm.createContext(sandbox);
    const servicePath = path.join(REPO_ROOT, 'service/index.js');
    const code = fs.readFileSync(servicePath, 'utf8');
    vm.runInContext(code, ctx, { filename: servicePath });
    return ctx;
}

/**
 * Evaluates a js/*.js file in a vm sandbox with minimal stubs for window, document, localStorage, U.
 * Returns the sandbox context so IPTV or other browser modules can be called through public API.
 */
function loadBrowserScript(file, extraGlobals) {
    const fullPath = path.isAbsolute(file) ? file : path.join(REPO_ROOT, file);
    const storeData = {};

    const mockLocalStorage = {
        getItem: function (k) {
            return Object.prototype.hasOwnProperty.call(storeData, k) ? storeData[k] : null;
        },
        setItem: function (k, v) { storeData[k] = String(v); },
        removeItem: function (k) { delete storeData[k]; },
        clear: function () {
            Object.keys(storeData).forEach(function (k) { delete storeData[k]; });
        },
        get length() { return Object.keys(storeData).length; },
        key: function (i) { return Object.keys(storeData)[i] || null; }
    };

    const mockDocument = {
        createElement: function (tag) {
            return {
                tagName: String(tag).toUpperCase(),
                style: {},
                setAttribute: function () {},
                getAttribute: function () { return null; },
                appendChild: function (c) { return c; },
                removeChild: function (c) { return c; },
                addEventListener: function () {},
                removeEventListener: function () {}
            };
        },
        getElementById: function () { return null; },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        addEventListener: function () {},
        removeEventListener: function () {}
    };

    const mockU = {
        store: {
            get: function (k, def) {
                return Object.prototype.hasOwnProperty.call(storeData, k) ? storeData[k] : def;
            },
            set: function (k, v) { storeData[k] = v; },
            remove: function (k) { delete storeData[k]; }
        },
        bigStore: {
            get: function (k) {
                return Promise.resolve(Object.prototype.hasOwnProperty.call(storeData, k) ? storeData[k] : null);
            },
            set: function (k, v) { storeData[k] = v; return Promise.resolve(true); },
            remove: function (k) { delete storeData[k]; return Promise.resolve(); }
        },
        lru: function () {
            var map = Object.create(null);
            return {
                get: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
                set: function (k, v) { map[k] = v; },
                clear: function () { map = Object.create(null); }
            };
        },
        log: function () {},
        problem: function (e) { return (e && e.message) || String(e); },
        parseUrl: function (u) {
            try {
                const parsed = new URL(u);
                return {
                    href: parsed.href,
                    scheme: parsed.protocol.replace(/:$/, ''),
                    host: parsed.hostname,
                    port: parsed.port,
                    path: parsed.pathname,
                    query: parsed.search.replace(/^\?/, ''),
                    pathname: parsed.pathname,
                    search: parsed.search
                };
            } catch (e) { return null; }
        },
        sanitizeHeaders: function (h) { return h || {}; },
        t: function (s) { return s; },
        tn: function (s) { return s; },
        settleAll: function (tasks, concurrency) {
            concurrency = concurrency || 4;
            tasks = tasks || [];
            return new Promise(function (resolve) {
                var results = new Array(tasks.length);
                var idx = 0, active = 0, finished = 0;
                if (tasks.length === 0) { resolve(results); return; }
                function launch() {
                    while (active < concurrency && idx < tasks.length) {
                        (function (i) {
                            active++;
                            var p;
                            try { p = Promise.resolve(tasks[i]()); } catch (e0) { p = Promise.reject(e0); }
                            p.then(function (v) {
                                results[i] = { ok: true, value: v };
                            }, function (e) {
                                results[i] = { ok: false, error: e };
                            }).then(function () {
                                active--; finished++;
                                if (finished === tasks.length) { resolve(results); }
                                else { launch(); }
                            });
                        })(idx);
                        idx++;
                    }
                }
                launch();
            });
        }
    };

    const sandbox = {
        Buffer,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        setImmediate,
        clearImmediate,
        Promise,
        localStorage: mockLocalStorage,
        document: mockDocument,
        U: mockU,
        console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} }
    };

    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.global = sandbox;

    if (extraGlobals) {
        Object.assign(sandbox, extraGlobals);
    }

    const ctx = vm.createContext(sandbox);
    const code = fs.readFileSync(fullPath, 'utf8');
    vm.runInContext(code, ctx, { filename: fullPath });
    return ctx;
}

async function run() {
    console.log('=== StremioK Test Suite ===\n');

    let passed = 0;
    let failed = 0;

    async function runTest(name, fn) {
        try {
            await fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (err) {
            console.log(`[FAIL] ${name}: ${err.message}`);
            failed++;
        }
    }

    // 1. ES5 syntax & vm.Script guard
    await runTest('ES5 syntax guard (scan js/*.js & service/*.js)', () => {
        const { files, errors } = scanES5();
        if (errors.length > 0) {
            const details = errors.map(e => `  ${e.file}:${e.line} - ${e.reason}`).join('\n');
            assert.fail(`ES5 violations found in ${errors.length} locations:\n${details}`);
        }
        assert.ok(files.length > 0, 'No files were scanned');
    });

    // 2. Harness helper self-checks
    await runTest('mockU.settleAll (task execution & result shape)', async () => {
        const ctx = loadBrowserScript('js/iptv.js');
        const order = [];
        const tasks = [
            () => { order.push(1); return Promise.resolve('val1'); },
            () => { order.push(2); return 'val2'; },
            () => { order.push(3); throw new Error('err3'); },
            () => { order.push(4); return Promise.reject(new Error('err4')); }
        ];
        const results = await ctx.U.settleAll(tasks, 2);
        assert.deepStrictEqual(order, [1, 2, 3, 4]);
        assert.strictEqual(results.length, 4);
        assert.deepStrictEqual(results[0], { ok: true, value: 'val1' });
        assert.deepStrictEqual(results[1], { ok: true, value: 'val2' });
        assert.strictEqual(results[2].ok, false);
        assert.strictEqual(results[2].error.message, 'err3');
        assert.strictEqual(results[3].ok, false);
        assert.strictEqual(results[3].error.message, 'err4');
    });

    // 3. Xtream Live API, category filter, and Live-only toggle (Task 2)
    await runTest('xtLiveUrl (Xtream Live record, category filter & IPTV.load)', async () => {
        const svc = loadService();
        const catMap = { '10': 'Sports', '20': 'News' };
        const recTs = svc.xtLiveRecord({
            stream_id: 101,
            name: '  ESPN HD  ',
            category_id: '10',
            stream_icon: 'https://img.example.com/espn.png',
            epg_channel_id: 'espn.us',
            tv_archive: 1,
            tv_archive_duration: 7
        }, catMap, 'http://tv.example.com:8080/', 'alice', 'secret', 'ts');

        assert.deepStrictEqual(JSON.parse(JSON.stringify(recTs)), {
            id: 101,
            name: 'ESPN HD',
            group: 'Sports',
            logo: 'https://img.example.com/espn.png',
            tvgId: 'espn.us',
            url: 'http://tv.example.com:8080/live/alice/secret/101.ts',
            archive: true,
            archiveDays: 7
        });

        const recHls = svc.xtLiveRecord({
            stream_id: '202',
            name: 'BBC World',
            category_id: '20',
            tv_archive: 0
        }, catMap, 'http://tv.example.com:8080', 'alice', 'secret', 'hls');
        assert.strictEqual(recHls.url, 'http://tv.example.com:8080/live/alice/secret/202.m3u8');
        assert.strictEqual(recHls.archive, false);
        assert.strictEqual(recHls.archiveDays, 0);
        assert.strictEqual(svc.xtLiveRecord({ stream_id: 0, name: 'Bad' }, catMap, 'http://x', 'u', 'p', 'ts'), null);

        // Streaming category filter drops unselected categories during streaming
        const catSet = { '10': true };
        const streamed = [];
        const feed = svc.xtvItems(function (o) {
            if (!catSet[String(o.category_id || '')]) { return; }
            const r = svc.xtLiveRecord(o, catMap, 'http://tv.example.com:8080', 'alice', 'secret', 'ts');
            if (r) { streamed.push(r); }
        });
        const payload = JSON.stringify([
            { stream_id: 1, name: 'Keep Sports', category_id: '10', tv_archive: 1, tv_archive_duration: 3 },
            { stream_id: 2, name: 'Drop News', category_id: '20', tv_archive: 0 }
        ]);
        feed(payload.slice(0, 35));
        feed(payload.slice(35));
        assert.strictEqual(streamed.length, 1);
        assert.strictEqual(streamed[0].id, 1);
        assert.strictEqual(streamed[0].group, 'Sports');

        // Browser IPTV module: preserves groups/noVod, routes Xtream Live via YTPlay.xtliveList
        let xtliveCalled = false;
        const iptvCtx = loadBrowserScript('js/iptv.js', {
            YTPlay: {
                installMode: () => 'tizenbrew',
                xtliveList: (base, user, pass, fmt, cats) => {
                    xtliveCalled = true;
                    assert.strictEqual(base, 'http://tv.example.com:8080');
                    assert.strictEqual(user, 'alice');
                    assert.strictEqual(pass, 'secret');
                    assert.strictEqual(fmt, 'ts');
                    assert.deepStrictEqual(cats, ['10']);
                    return Promise.resolve({
                        state: 'ready',
                        at: 123456,
                        count: 1,
                        groups: 1,
                        dropped: 0,
                        channels: [recTs]
                    });
                }
            }
        });
        const id = iptvCtx.IPTV.addXtream('http://tv.example.com:8080', 'alice', 'secret');
        assert.ok(id);
        assert.strictEqual(iptvCtx.IPTV.setPlaylistGroups(id, ['10']), true);
        assert.strictEqual(iptvCtx.IPTV.setXtreamNoVod(id, true), true);

        const pls = iptvCtx.IPTV.getPlaylists();
        assert.strictEqual(pls.length, 1);
        assert.strictEqual(pls[0].xtream, true);
        assert.deepStrictEqual(pls[0].groups, ['10']);
        assert.strictEqual(pls[0].noVod, true);

        await iptvCtx.IPTV.load(true);
        assert.strictEqual(xtliveCalled, true);
        const chs = iptvCtx.IPTV.channels();
        assert.strictEqual(chs.length, 1);
        assert.strictEqual(chs[0].streamId, 101);
        assert.strictEqual(chs[0].archive, true);
        assert.strictEqual(chs[0].archiveDays, 7);
    });

    await runTest('xtVodNoVod (XtVod catalog removal when noVod toggled on)', async () => {
        let noVodFlag = false;
        let changeCount = 0;
        const xtvCtx = loadBrowserScript('js/xtvod.js', {
            IPTV: {
                getPlaylists: () => [{ id: 'p1', url: 'http://tv.example.com:8080/get.php?username=alice&password=secret', noVod: noVodFlag }],
                xtreamFormat: () => 'ts',
                xtreamParts: () => ({ base: 'http://tv.example.com:8080', user: 'alice', pass: 'secret' }),
                label: () => 'Xtream · tv.example.com'
            }
        });
        xtvCtx.U.getJSON = () => Promise.resolve([]);
        xtvCtx.U.store.set('stremiok.xtvod.cats', {
            p1: {
                sig: 'p1|http://tv.example.com:8080|alice',
                movie: [['1', 'Action']],
                series: [['2', 'Drama']],
                at: Date.now()
            }
        });
        xtvCtx.XtVod.onChange(() => { changeCount++; });
        const addon = xtvCtx.XtVod.synthAddon();
        assert.strictEqual(addon.manifest.catalogs.length, 2);
        assert.strictEqual(addon.manifest.catalogs[0].id, 'xv.p1.movie');
        assert.strictEqual(addon.manifest.catalogs[1].id, 'xv.p1.series');

        // Toggle noVod ON -> reload(id) must drop the account's catalogs and notify onChange
        noVodFlag = true;
        xtvCtx.XtVod.reload('p1');
        assert.strictEqual(addon.manifest.catalogs.length, 0);
        assert.ok(changeCount >= 1);
    });

    await runTest('catchupUrl (Xtream Catch-Up URL formatter)', () => {
        assert.fail('not implemented');
    });

    await runTest('m3uStreamParser (Streaming chunked M3U parser)', async () => {
        const svc = loadService();
        const parser = svc.m3uStreamParser({ max: 100 });
        const sample = [
            '\uFEFF#EXTM3U url-tvg="https://epg.example.com/g.xml"',
            '#PLAYLIST:Giant Test List',
            '#EXTINF:-1 tvg-id="a" tvg-logo="https://img.example.com/1.png" group-title="TR",Channel 1',
            'http://stream.example.com/live/1.ts|Referer=https%3A%2F%2Fref.example.com%2F',
            '#EXTINF:-1 tvg-id="b" group-title="News",Kanal Türkçe 📺',
            '#EXTVLCOPT:http-user-agent=VLC/3.0',
            '#EXTHTTP:{"Cookie":"sid=xyz"}',
            'http://stream.example.com/live/2.m3u8'
        ].join('\r\n');

        const buf = Buffer.from(sample, 'utf8');
        for (let off = 0; off < buf.length; off += 17) {
            parser.feed(buf.slice(off, Math.min(off + 17, buf.length)));
        }
        const res = parser.end();

        assert.strictEqual(res.title, 'Giant Test List');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(res.guides)), ['https://epg.example.com/g.xml']);
        assert.strictEqual(res.count, 2);
        assert.strictEqual(res.dropped, 0);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(res.channels[0])), {
            name: 'Channel 1',
            logo: 'https://img.example.com/1.png',
            group: 'TR',
            tvgId: 'a',
            ref: 'https://ref.example.com/',
            radio: false,
            sport: false,
            type: 'tv',
            url: 'http://stream.example.com/live/1.ts'
        });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(res.channels[1])), {
            name: 'Kanal Türkçe 📺',
            logo: '',
            group: 'News',
            tvgId: 'b',
            ua: 'VLC/3.0',
            cookie: 'sid=xyz',
            radio: false,
            sport: false,
            type: 'tv',
            url: 'http://stream.example.com/live/2.m3u8'
        });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(res.groups)), [
            { name: 'TR', type: 'tv', count: 1 },
            { name: 'News', type: 'tv', count: 1 }
        ]);

        // Browser IPTV module: routes raw HTTP(S) M3U via YTPlay.m3uLoad + m3uChannels without IndexedDB
        let m3uLoadCalled = false;
        let m3uChannelsCalled = false;
        let bigStoreWriteCount = 0;
        const iptvCtx = loadBrowserScript('js/iptv.js', {
            YTPlay: {
                installMode: () => 'tizenbrew',
                m3uLoad: (u, groups) => {
                    m3uLoadCalled = true;
                    assert.strictEqual(u, 'https://example.com/giant.m3u');
                    assert.deepStrictEqual(groups, ['TR']);
                    return Promise.resolve({
                        state: 'ready',
                        at: 999999,
                        title: 'Giant Test List',
                        guides: ['https://epg.example.com/g.xml'],
                        groups: res.groups,
                        count: 1,
                        dropped: 0,
                        error: ''
                    });
                },
                m3uChannels: (u, groups) => {
                    m3uChannelsCalled = true;
                    assert.strictEqual(u, 'https://example.com/giant.m3u');
                    assert.deepStrictEqual(groups, ['TR']);
                    return Promise.resolve({ channels: [res.channels[0]] });
                }
            }
        });
        const origBigSet = iptvCtx.U.bigStore.set;
        iptvCtx.U.bigStore.set = function (k, v) {
            bigStoreWriteCount++;
            return origBigSet(k, v);
        };
        const pid = iptvCtx.IPTV.addPlaylist('https://example.com/giant.m3u', 'Giant');
        assert.ok(pid);
        assert.strictEqual(iptvCtx.IPTV.setPlaylistGroups(pid, ['TR']), true);
        await iptvCtx.IPTV.load(true);
        assert.strictEqual(m3uLoadCalled, true);
        assert.strictEqual(m3uChannelsCalled, true);
        assert.strictEqual(bigStoreWriteCount, 0);
        const st = iptvCtx.IPTV.status(pid);
        assert.strictEqual(st.count, 1);
        assert.strictEqual(st.title, 'Giant Test List');
        assert.strictEqual(st.groupList.length, 2);
        const chs = iptvCtx.IPTV.channels();
        assert.strictEqual(chs.length, 1);
        assert.strictEqual(chs[0].name, 'Channel 1');
        assert.strictEqual(chs[0].ref, 'https://ref.example.com/');
    });

    await runTest('escHtml (Phone QR group name HTML escaping)', () => {
        assert.fail('not implemented');
    });

    console.log('\n===========================');
    console.log(`Summary: ${passed} passed, ${failed} failed, ${passed + failed} total`);

    if (failed > 0) {
        process.exit(1);
    }
}

module.exports = {
    loadService,
    loadBrowserScript,
    stripCode,
    scanES5,
    run
};

if (require.main === module) {
    run();
}
