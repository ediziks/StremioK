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
        setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
        clearTimeout,
        setInterval: (fn, ms) => { const t = setInterval(fn, ms); if (t && t.unref) t.unref(); return t; },
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

    const files = Array.isArray(file) ? file : [file];
    const ctx = vm.createContext(sandbox);
    files.forEach(function (f) {
        const fullPath = path.isAbsolute(f) ? f : path.join(REPO_ROOT, f);
        const code = fs.readFileSync(fullPath, 'utf8');
        vm.runInContext(code, ctx, { filename: fullPath });
    });
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

    await runTest('catchupUrl (Xtream Catch-Up URL formatter)', async () => {
        const realNow = Date.now;
        const fixedNowMs = Date.UTC(2026, 10, 16, 20, 0, 0); // 2026-11-16T20:00:00Z
        Date.now = () => fixedNowMs;
        try {
            const svc = loadService();
            const rec12345 = svc.xtLiveRecord(
                { stream_id: 12345, name: 'Catchup TV', category_id: '10', tv_archive: 1, tv_archive_duration: 7 },
                { '10': 'News' }, 'http://host:8080', 'user', 'pass', 'ts'
            );
            const recNoArch = svc.xtLiveRecord(
                { stream_id: 99999, name: 'No Archive TV', category_id: '10', tv_archive: 0 },
                { '10': 'News' }, 'http://host:8080', 'user', 'pass', 'ts'
            );
            let curFmt = 'ts';
            const iptvCtx = loadBrowserScript('js/iptv.js', {
                Date: Date,
                YTPlay: {
                    installMode: () => 'service',
                    xtliveList: (base, user, pass, fmt) => {
                        curFmt = fmt || 'ts';
                        const chs = [rec12345, recNoArch].map((r) => Object.assign({}, r, {
                            url: `${base}/live/${user}/${pass}/${r.id}.${curFmt === 'hls' ? 'm3u8' : 'ts'}`
                        }));
                        return Promise.resolve({ state: 'ready', at: 123456, count: 2, groups: 1, dropped: 0, channels: chs });
                    }
                }
            });

            const id = iptvCtx.IPTV.addXtream('http://host:8080', 'user', 'pass');
            assert.ok(id);
            await iptvCtx.IPTV.load(true);

            const chs = iptvCtx.IPTV.channels();
            const chArch = chs.find((c) => c.streamId === 12345);
            const chNoArch = chs.find((c) => c.streamId === 99999);
            assert.ok(chArch && chNoArch);

            const start18 = Date.UTC(2026, 10, 16, 18, 0, 0) / 1000;
            const stop1845 = start18 + 45 * 60;

            // Default UTC (0h)
            assert.strictEqual(
                iptvCtx.IPTV.catchupUrl(chArch.id, start18, stop1845),
                'http://host:8080/timeshift/user/pass/45/2026-11-16:18-00/12345.ts'
            );

            // Positive & negative archiveOffset hours (-12..+14)
            assert.strictEqual(iptvCtx.IPTV.setArchiveOffset(id, 3), true);
            assert.strictEqual(iptvCtx.IPTV.getPlaylists()[0].archiveOffset, 3);
            assert.strictEqual(
                iptvCtx.IPTV.catchupUrl(chArch.id, start18, stop1845),
                'http://host:8080/timeshift/user/pass/45/2026-11-16:21-00/12345.ts'
            );

            assert.strictEqual(iptvCtx.IPTV.setArchiveOffset(id, -5), true);
            assert.strictEqual(
                iptvCtx.IPTV.catchupUrl(chArch.id, start18, stop1845),
                'http://host:8080/timeshift/user/pass/45/2026-11-16:13-00/12345.ts'
            );

            assert.strictEqual(iptvCtx.IPTV.setArchiveOffset(id, 99), false);
            assert.strictEqual(iptvCtx.IPTV.setArchiveOffset(id, -13), false);
            assert.strictEqual(iptvCtx.IPTV.setArchiveOffset(id, 0), true);
            assert.strictEqual(iptvCtx.IPTV.getPlaylists()[0].archiveOffset, undefined);

            // Reject outside archiveDays (older than 7 days)
            const tooOldStart = (fixedNowMs / 1000) - (8 * 86400);
            assert.strictEqual(iptvCtx.IPTV.catchupUrl(chArch.id, tooOldStart, tooOldStart + 2700), '');

            // Reject currently airing (progStopSec > now) and future programs
            const nowSec = fixedNowMs / 1000;
            assert.strictEqual(iptvCtx.IPTV.catchupUrl(chArch.id, nowSec - 600, nowSec + 600), '');
            assert.strictEqual(iptvCtx.IPTV.catchupUrl(chArch.id, nowSec + 3600, nowSec + 5400), '');

            // Reject channel without archive
            assert.strictEqual(iptvCtx.IPTV.catchupUrl(chNoArch.id, start18, stop1845), '');

            // HLS format produces .m3u8
            assert.strictEqual(iptvCtx.IPTV.setXtreamFormat(id, 'hls'), true);
            await iptvCtx.IPTV.load(true);
            assert.strictEqual(
                iptvCtx.IPTV.catchupUrl(chArch.id, start18, stop1845),
                'http://host:8080/timeshift/user/pass/45/2026-11-16:18-00/12345.m3u8'
            );
        } finally {
            Date.now = realNow;
        }
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

        // Failed force=1 refresh falls back to saved m3u-<hash>.jsonl with stale: true + error
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stremiok-m3u-'));
        try {
            const svc2 = loadService();
            svc2.tokenDir = () => tmpDir;
            svc2.entryAllowed = () => true;
            const testUrl = 'https://example.com/saved.m3u';
            const filePath = svc2.m3uFile(testUrl);
            assert.ok(filePath && filePath.startsWith(tmpDir));
            const metaLine = JSON.stringify({
                key: testUrl,
                at: 111111,
                title: 'Saved List',
                guides: ['https://epg.example.com/saved.xml'],
                groups: [{ name: 'TR', type: 'tv', count: 1 }],
                count: 1,
                dropped: 0
            });
            const chLine = JSON.stringify(res.channels[0]);
            fs.writeFileSync(filePath, metaLine + '\n' + chLine + '\n', 'utf8');

            svc2.m3uFetch = (u, cb) => {
                const err = new Error('HTTP 503');
                err.status = 502;
                cb(err);
            };

            function callM3uControl(reqPath, query) {
                return new Promise((resolve) => {
                    let status = 0;
                    let body = '';
                    const mockRes = {
                        writeHead: (s) => { status = s; },
                        write: (chunk) => { body += chunk; },
                        end: (chunk) => { if (chunk) { body += chunk; } resolve({ status, body }); },
                        on: () => {}
                    };
                    svc2.m3uControl({ headers: {} }, mockRes, reqPath, query);
                });
            }

            const loadRes = await callM3uControl('/m3u/load', 'u=' + encodeURIComponent(testUrl) + '&force=1');
            assert.strictEqual(loadRes.status, 200);
            const loadJson = JSON.parse(loadRes.body);
            assert.strictEqual(loadJson.state, 'ready');
            assert.strictEqual(loadJson.stale, true);
            assert.strictEqual(loadJson.error, 'HTTP 503');
            assert.strictEqual(loadJson.title, 'Saved List');
            assert.strictEqual(loadJson.at, 111111);
            assert.strictEqual(loadJson.count, 1);

            const chRes = await callM3uControl('/m3u/channels', 'u=' + encodeURIComponent(testUrl));
            assert.strictEqual(chRes.status, 200);
            const chJson = JSON.parse(chRes.body);
            assert.strictEqual(chJson.channels.length, 1);
            assert.strictEqual(chJson.channels[0].name, 'Channel 1');

            // Browser IPTV.load preserves st.stale and st.error while loading saved channels
            const staleIptvCtx = loadBrowserScript('js/iptv.js', {
                YTPlay: {
                    installMode: () => 'tizenbrew',
                    m3uLoad: () => Promise.resolve(loadJson),
                    m3uChannels: () => Promise.resolve(chJson)
                }
            });
            const spid = staleIptvCtx.IPTV.addPlaylist(testUrl, 'Saved');
            await staleIptvCtx.IPTV.load(true);
            const sst = staleIptvCtx.IPTV.status(spid);
            assert.strictEqual(sst.stale, true);
            assert.strictEqual(sst.error, 'HTTP 503');
            assert.strictEqual(sst.count, 1);
            assert.strictEqual(staleIptvCtx.IPTV.channels().length, 1);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await runTest('escHtml (Phone QR group name HTML escaping & POST form parsing)', async () => {
        const svc = loadService();
        svc.lanAddress = () => '192.168.1.50';
        svc.hasTicket = (q) => /(?:^|&)ticket=ok(?:&|$)/.test(q || '');

        function callEntryControl(method, reqPath, query, body, headers) {
            return new Promise((resolve) => {
                let status = 0;
                let resBody = '';
                const mockRes = {
                    headers: {},
                    setHeader: (k, v) => { mockRes.headers[k] = v; },
                    writeHead: (s) => { status = s; },
                    write: (chunk) => { resBody += chunk; },
                    end: (chunk) => { if (chunk) { resBody += chunk; } resolve({ status, body: resBody }); },
                    on: () => {}
                };
                svc.entryControl({ method, headers: headers || {} }, mockRes, reqPath, query, body);
            });
        }

        function callEntryPage(method, reqUrl, postBody) {
            return new Promise((resolve) => {
                let status = 0;
                let resBody = '';
                const listeners = {};
                const mockReq = {
                    method,
                    url: reqUrl,
                    headers: {},
                    on: (ev, fn) => { listeners[ev] = fn; }
                };
                const mockRes = {
                    headers: {},
                    setHeader: (k, v) => { mockRes.headers[k] = v; },
                    writeHead: (s) => { status = s; },
                    write: (chunk) => { resBody += chunk; },
                    end: (chunk) => { if (chunk) { resBody += chunk; } resolve({ status, body: resBody, headers: mockRes.headers }); },
                    on: () => {}
                };
                svc.entryPage(mockReq, mockRes);
                if (method === 'POST') {
                    setImmediate(() => {
                        if (postBody && listeners.data) { listeners.data(Buffer.from(postBody, 'utf8')); }
                        if (listeners.end) { listeners.end(); }
                    });
                }
            });
        }

        // Direct escHtml check
        assert.strictEqual(
            svc.escHtml('<script>alert("x")</script> & \'y\''),
            '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;'
        );

        // Invalid JSON rejected
        const badOpen = await callEntryControl('POST', '/entry/open', 'what=iptvgroups&ticket=ok', '{bad');
        assert.strictEqual(badOpen.status, 400);

        // Open iptvgroups entry via POST with ticket auth and weird group names
        const openRes = await callEntryControl('POST', '/entry/open', 'what=iptvgroups&ticket=ok', JSON.stringify({
            name: 'My "Test" & <List>',
            groups: [
                { id: '0', name: '<script>alert(1)</script>', count: 12, on: true },
                { id: '1', name: 'Sports & "News" \'Live\'', count: 5, on: false },
                { id: '2', name: 'Movies', count: 30, on: false }
            ]
        }));
        assert.strictEqual(openRes.status, 200);
        const opened = JSON.parse(openRes.body);
        assert.ok(opened.token && opened.url.includes('/e/' + opened.token));

        // GET phone page escapes weird names and includes UI controls
        const pageGet = await callEntryPage('GET', '/e/' + opened.token);
        assert.strictEqual(pageGet.status, 200);
        assert.ok(!pageGet.body.includes('<script>alert(1)</script>'), 'raw <script> must not appear in HTML');
        assert.ok(pageGet.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped <script> must appear');
        assert.ok(pageGet.body.includes('Sports &amp; &quot;News&quot; &#39;Live&#39;'), 'quotes and & must be escaped');
        assert.ok(pageGet.body.includes('My &quot;Test&quot; &amp; &lt;List&gt;'), 'playlist name must be escaped');
        assert.ok(pageGet.body.includes('Filter groups'));
        assert.ok(pageGet.body.includes('Select all'));
        assert.ok(pageGet.body.includes('Deselect all'));
        assert.ok(pageGet.body.includes('Save to TV'));

        // POST form selection resolves strictly against known group IDs (ignores unknown/proto)
        const pagePost = await callEntryPage('POST', '/e/' + opened.token, 'id=0&id=2&id=999&id=__proto__');
        assert.strictEqual(pagePost.status, 200);

        const pollRes = await callEntryControl('GET', '/entry/poll', 't=' + opened.token, '', { 'x-stremiok': '1' });
        assert.strictEqual(pollRes.status, 200);
        assert.deepStrictEqual(JSON.parse(JSON.parse(pollRes.body).text), ['0', '2']);

        // Empty POST (all deselected) resolves cleanly to []
        const openRes2 = await callEntryControl('POST', '/entry/open', 'what=iptvgroups&ticket=ok', JSON.stringify({
            name: 'Empty Test',
            groups: [{ id: '0', name: 'News', count: 3, on: true }]
        }));
        assert.strictEqual(openRes2.status, 200);
        const tok2 = JSON.parse(openRes2.body).token;
        const emptyPost = await callEntryPage('POST', '/e/' + tok2, '');
        assert.strictEqual(emptyPost.status, 200);
        const pollRes2 = await callEntryControl('GET', '/entry/poll', 't=' + tok2, '', { 'x-stremiok': '1' });
        assert.strictEqual(pollRes2.status, 200);
        assert.deepStrictEqual(JSON.parse(JSON.parse(pollRes2.body).text), []);

        // Direct helper check
        assert.deepStrictEqual(
            JSON.parse(JSON.stringify(svc.parseGroupSelectionBody('id=0&id=2&id=unknown', [{ id: '0' }, { id: '1' }, { id: '2' }]))),
            ['0', '2']
        );
    });

    await runTest('xtlControl (category_id 0 & password cache key)', async () => {
        const svc = loadService();
        svc.tokenDir = () => null;

        // xtLiveRecord preserves numeric category_id 0
        const recZero = svc.xtLiveRecord({
            stream_id: 10,
            name: 'Zero Cat Channel',
            category_id: 0
        }, { '0': 'Uncategorized' }, 'http://tv.example.com:8080', 'alice', 'pass1', 'ts');
        assert.strictEqual(recZero.group, 'Uncategorized');

        let fetchCount = 0;
        svc.xtvGet = (url, feed, cb) => {
            fetchCount++;
            if (url.includes('action=get_live_categories')) {
                feed(JSON.stringify([{ category_id: 0, category_name: 'Uncategorized' }, { category_id: 5, category_name: 'Sports' }]));
                cb(null);
                return;
            }
            feed(JSON.stringify([
                { stream_id: 10, name: 'Zero Cat Channel', category_id: 0 },
                { stream_id: 11, name: 'Sports Channel', category_id: 5 }
            ]));
            cb(null);
        };

        function callXtl(pathName, query) {
            return new Promise((resolve) => {
                let status = 0;
                let body = '';
                const req = { headers: { 'x-stremiok': '1' } };
                const res = {
                    writeHead: (s) => { status = s; },
                    end: (chunk) => {
                        if (chunk) body += chunk.toString();
                        resolve({ status, body });
                    }
                };
                svc.xtlControl(req, res, pathName, query);
            });
        }

        const r1 = await callXtl('/xtlive/list', 'base=http://tv.example.com:8080&user=alice&pass=pass1&fmt=ts&cats=0');
        assert.strictEqual(r1.status, 200);
        const j1 = JSON.parse(r1.body);
        assert.strictEqual(j1.channels.length, 1);
        assert.strictEqual(j1.channels[0].id, 10);
        assert.strictEqual(j1.channels[0].group, 'Uncategorized');
        assert.strictEqual(j1.channels[0].url, 'http://tv.example.com:8080/live/alice/pass1/10.ts');
        const fetchesAfterPass1 = fetchCount;

        // Changing password must miss cache and return updated URLs
        const r2 = await callXtl('/xtlive/list', 'base=http://tv.example.com:8080&user=alice&pass=pass2&fmt=ts&cats=0');
        assert.strictEqual(r2.status, 200);
        const j2 = JSON.parse(r2.body);
        assert.strictEqual(j2.channels.length, 1);
        assert.strictEqual(j2.channels[0].url, 'http://tv.example.com:8080/live/alice/pass2/10.ts');
        assert.ok(fetchCount > fetchesAfterPass1, 'password change must trigger fresh fetch');
        assert.strictEqual(Object.keys(svc._xtl).length, 2);
    });

    await runTest('m3uControl (>24h stale fallback skips redundant re-fetch on m3uChannels)', async () => {
        const svc = loadService();
        svc.tokenDir = () => null;
        const playlistUrl = 'http://cdn.example.com/list.m3u';
        svc._m3u[playlistUrl] = {
            key: playlistUrl,
            state: 'ready',
            title: 'Test List',
            guides: [],
            groups: [{ name: 'News', count: 1 }],
            count: 1,
            dropped: 0,
            at: Date.now() - 25 * 3600 * 1000,
            items: [{ name: 'Ch 1', url: 'http://cdn.example.com/1.ts', group: 'News', logo: '', tvgId: '' }],
            saved: false,
            stale: false,
            staleAt: 0,
            error: '',
            waiters: []
        };

        let fetchCount = 0;
        svc.m3uFetch = (u, cb) => {
            fetchCount++;
            setImmediate(() => cb(new Error('network timeout')));
        };

        function callM3u(pathName, query) {
            return new Promise((resolve) => {
                let status = 0;
                let body = '';
                const req = { headers: { 'x-stremiok': '1' } };
                const res = {
                    writeHead: (s) => { status = s; },
                    end: (chunk) => {
                        if (chunk) body += chunk.toString();
                        resolve({ status, body });
                    }
                };
                svc.m3uControl(req, res, pathName, query);
            });
        }

        const loadRes = await callM3u('/m3u/load', 'u=' + encodeURIComponent(playlistUrl) + '&force=1');
        assert.strictEqual(loadRes.status, 200);
        const loadJson = JSON.parse(loadRes.body);
        assert.strictEqual(loadJson.state, 'ready');
        assert.strictEqual(loadJson.stale, true);
        assert.strictEqual(fetchCount, 1);
        assert.ok(svc._m3u[playlistUrl].staleAt > 0, 'staleAt must be recorded');

        // Immediate m3uChannels without force=1 must serve stale fallback without re-fetching
        const chRes = await callM3u('/m3u/channels', 'u=' + encodeURIComponent(playlistUrl));
        assert.strictEqual(chRes.status, 200);
        const chJson = JSON.parse(chRes.body);
        assert.strictEqual(chJson.channels.length, 1);
        assert.strictEqual(chJson.channels[0].name, 'Ch 1');
        assert.strictEqual(fetchCount, 1);
    });

    await runTest('service: comma group names, ungrouped Xtream list not cached, missing saved M3U re-read', async () => {
        const svc = loadService();
        const os = require('os'), fs = require('fs'), path = require('path');
        function call(fn, pathName, query) {
            return new Promise((resolve) => {
                let status = 0, body = '';
                const req = { headers: { 'x-stremiok': '1' } };
                const res = {
                    writeHead: (st) => { status = st; },
                    write: (chunk) => { body += chunk.toString(); return true; },
                    on: () => {},
                    end: (chunk) => { if (chunk) { body += chunk.toString(); } resolve({ status, body }); }
                };
                fn(req, res, pathName, query);
            });
        }
        // 1. A group-title with a comma, as YTPlay.m3uChannels sends it (each name %-encoded, joined, encoded again)
        svc.tokenDir = () => null;
        const u1 = 'http://cdn.example.com/a.m3u';
        svc._m3u[u1] = { key: u1, state: 'ready', title: '', guides: [], groups: [], count: 2, dropped: 0, at: Date.now(),
            items: [{ name: 'Film 1', group: 'Movies, Series', url: 'http://cdn.example.com/1.ts' }, { name: 'News 1', group: 'News', url: 'http://cdn.example.com/2.ts' }],
            saved: false, stale: false, staleAt: 0, error: '', waiters: [] };
        const groupsParam = encodeURIComponent(['Movies, Series'].map(encodeURIComponent).join(','));
        const r1 = await call(svc.m3uControl, '/m3u/channels', 'u=' + encodeURIComponent(u1) + '&groups=' + groupsParam);
        assert.deepStrictEqual(JSON.parse(r1.body).channels.map((c) => c.name), ['Film 1'], '"Movies, Series" is one group');

        // 2. get_live_categories fails: channels shown ungrouped, not kept as fresh (read again next time)
        let listReads = 0;
        svc.xtvGet = (url, feed, cb) => {
            if (url.includes('get_live_categories')) { const e = new Error('HTTP 502'); e.status = 502; cb(e); return; }
            listReads++;
            feed(JSON.stringify([{ stream_id: 7, name: 'Ch 7', category_id: 3 }]));
            cb(null);
        };
        const q = 'base=http://tv.example.com&user=u&pass=p&fmt=ts';
        const x1 = JSON.parse((await call(svc.xtlControl, '/xtlive/list', q)).body);
        assert.strictEqual(x1.channels[0].group, 'Live TV');
        await call(svc.xtlControl, '/xtlive/list', q);
        assert.strictEqual(listReads, 2, 'an ungrouped list is not served from cache');

        // 3. The saved M3U list is gone (swept / cleared): read from its link again, not an empty list
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-m3u-'));
        svc.tokenDir = () => dir;
        const u2 = 'http://cdn.example.com/b.m3u';
        svc._m3u[u2] = { key: u2, state: 'ready', title: '', guides: [], groups: [], count: 1, dropped: 0, at: Date.now(), items: null,
            saved: true, stale: false, staleAt: 0, error: '', waiters: [] };
        let fetched = 0;
        svc.m3uFetch = (u, cb) => { fetched++; setImmediate(() => cb(null, { title: '', guides: [], groups: [{ name: 'G', type: 'tv', count: 1 }], count: 1, dropped: 0, channels: [{ name: 'Back', group: 'G', url: 'http://cdn.example.com/3.ts' }] })); };
        const r3 = await call(svc.m3uControl, '/m3u/channels', 'u=' + encodeURIComponent(u2));
        assert.strictEqual(fetched, 1);
        assert.deepStrictEqual(JSON.parse(r3.body).channels.map((c) => c.name), ['Back']);
        await new Promise((r) => setTimeout(r, 50));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await runTest('prefs & formatTags (Tier 1 Live TV prefs, FPS & Mbps bitrate)', async () => {
        const ctx = loadBrowserScript(['js/iptv.js', 'js/stremio.js']);
        const defs = ctx.Stremio.getPrefs();
        assert.strictEqual(defs.iptvTidy, true);
        assert.strictEqual(defs.iptvHideAdult, true);
        assert.strictEqual(defs.iptvCollapseVariants, true);
        assert.strictEqual(defs.iptvCountries, 'TR,UK,NL');
        assert.strictEqual(defs.liveBrowseMode, true);
        assert.strictEqual(defs.oledShift, 'auto');

        ctx.Stremio.setPref('oledShift', 'bogus');
        ctx.Stremio.setPref('iptvCountries', ' tr, de , invalid, us, uk, fr, es, it, ar, jp ');
        const updated = ctx.Stremio.getPrefs();
        assert.strictEqual(updated.oledShift, 'auto');
        assert.strictEqual(updated.iptvCountries, 'TR,DE,US,UK,FR,ES,IT,AR');

        ctx.Stremio.setPref('iptvCountries', '');
        assert.strictEqual(ctx.Stremio.getPrefs().iptvCountries, '');

        const rich = ctx.Stremio.formatTags(
            { res: 1080, codec: 'h264', audio: ['aac'], container: 'hls' },
            { height: 2160, codec: 'hevc', fps: 50, bitrate: 14200000, audio: 'eac3', channels: 6 }
        );
        assert.ok(rich.indexOf('4K') !== -1, 'Expected 4K in: ' + rich);
        assert.ok(rich.indexOf('HEVC') !== -1, 'Expected HEVC in: ' + rich);
        assert.ok(rich.indexOf('50fps') !== -1, 'Expected 50fps in: ' + rich);
        assert.ok(rich.indexOf('DD+') !== -1, 'Expected DD+ in: ' + rich);
        assert.ok(rich.indexOf('5.1') !== -1, 'Expected 5.1 in: ' + rich);
        assert.ok(rich.indexOf('14.2 Mbps') !== -1, 'Expected 14.2 Mbps in: ' + rich);

        const plain = ctx.Stremio.formatTags(
            { res: 1080, codec: 'h264', audio: ['aac'], container: 'mkv' },
            { height: 1080, codec: 'h264', fps: 0, bitrate: 0 }
        );
        assert.strictEqual(plain, '1080p · H.264 · AAC · MKV');
    });

    await runTest('iptvTidy (separators, adult filter, TR/UK/NL boost, variant collapse & favorites)', async () => {
        const fakeChannels = [
            { stream_id: '1', name: '--- === SEPARATOR === ---', category_id: '1' },
            { stream_id: '2', name: '|||||', category_id: '1' },
            { stream_id: '3', name: 'US: FOX HD', category_id: '2' },
            { stream_id: '4', name: 'Playboy 18+ HD', category_id: '3' },
            { stream_id: '5', name: 'Channel 18 HD', category_id: '2' },
            { stream_id: '6', name: 'Channel 4 HD', category_id: '4' },
            { stream_id: '7', name: 'Channel 4 +1 HD', category_id: '4' },
            { stream_id: '8', name: '*** TRT 1 Backup ***', category_id: '5' },
            { stream_id: '9', name: 'TR | TRT 1 SD', category_id: '5' },
            { stream_id: '10', name: 'TR | TRT 1 HEVC', category_id: '5' },
            { stream_id: '11', name: 'TR | TRT 1 FHD', category_id: '5', tv_archive: 1, tv_archive_duration: 7 },
            { stream_id: '12', name: 'TR | TRT 1 4K UHD', category_id: '6' },
            { stream_id: '13', name: 'TR | FOX HD', category_id: '5' },
            { stream_id: '14', name: 'NL | NPO 1 FHD', category_id: '7' },
            { stream_id: '15', name: 'Show TV Ü HD', category_id: '5' }
        ];
        const fakeGroups = {
            '1': 'DE | Info',
            '2': 'US | Entertainment',
            '3': 'XXX Adult 18+',
            '4': 'UK | Entertainment',
            '5': 'TR | ✦ ULUSAL VIP ✦',
            '6': 'TR | 4K UHD',
            '7': 'NL | Live'
        };
        const svc = loadService();
        let listCalls = 0;
        const recs = fakeChannels.map((c) => Object.assign({}, svc.xtLiveRecord(c, fakeGroups, 'http://host:8080', 'user', 'pass', 'ts'), {
            url: 'http://host:8080/live/user/pass/' + c.stream_id + '.ts'
        }));
        const iptvCtx = loadBrowserScript('js/iptv.js', {
            Date: Date,
            YTPlay: {
                installMode: () => 'service',
                xtliveList: () => {
                    listCalls++;
                    return Promise.resolve({ state: 'ready', at: Date.now(), count: recs.length, groups: 7, dropped: 0, channels: recs });
                }
            }
        });

        const pid = iptvCtx.IPTV.addXtream('http://host:8080', 'user', 'pass');
        assert.ok(pid);
        assert.strictEqual(typeof iptvCtx.IPTV.getTidyCfg, 'function');
        await iptvCtx.IPTV.load(true);
        assert.strictEqual(listCalls, 1);

        // Clean tidied view
        const tidied = iptvCtx.IPTV.channels();
        const names = tidied.map((c) => c.name);
        // Separators and Adult removed, Channel 18 preserved, bordered TRT 1 preserved/collapsed
        assert.ok(!names.some((n) => n.indexOf('SEPARATOR') !== -1 || n === '|||||'), 'Separators must be dropped');
        assert.ok(!names.some((n) => /Playboy/i.test(n)), 'Adult 18+ must be hidden');
        assert.ok(names.indexOf('Channel 18') !== -1, 'Channel 18 must NOT be falsely filtered as adult');

        // +1 timeshift kept distinct
        assert.ok(names.indexOf('Channel 4') !== -1);
        assert.ok(names.indexOf('Channel 4 +1') !== -1);

        // Turkish Unicode kept distinct
        assert.ok(names.indexOf('Show TV Ü') !== -1, 'Expected Show TV Ü in ' + JSON.stringify(names));

        // Cross-country FOX (TR vs US) NOT merged
        const foxes = tidied.filter((c) => c.name === 'FOX');
        assert.strictEqual(foxes.length, 2, 'TR and US FOX must stay distinct');

        // TRT 1 variants collapsed cleanly into ONE channel sorted 4K > FHD > HEVC > SD > Backup
        const trtList = tidied.filter((c) => c.name === 'TRT 1');
        assert.strictEqual(trtList.length, 1, 'Expected 1 merged TRT 1, got ' + trtList.length);
        const trt = trtList[0];
        assert.strictEqual(trt.variants.length, 5);
        assert.ok(trt.variants[0].badge.indexOf('4K') !== -1, 'Best variant must be 4K first');
        assert.ok(trt.variants[1].badge.indexOf('FHD') !== -1, '2nd variant must be FHD');
        assert.ok(trt.variants[2].badge.indexOf('HEVC') !== -1, '3rd variant must be HEVC');
        assert.ok(trt.variants[4].badge.indexOf('Backup') !== -1, 'Backup variant must be last');

        // Merged channel streams() exposes ordered multi-source list
        const trtStreams = await iptvCtx.IPTV.streams(trt.id);
        assert.strictEqual(trtStreams.length, 5);
        assert.ok(trtStreams[0].url.endsWith('/12.ts'));
        assert.ok(trtStreams[4].url.endsWith('/8.ts'));

        // Archive variant inheritance allows catch-up on merged channel even if 4K variant lacks tv_archive
        assert.strictEqual(trt.archive, true);
        const nowSec = Math.floor(Date.now() / 1000);
        const cuUrl = iptvCtx.IPTV.catchupUrl(trt.id, nowSec - 7200, nowSec - 3600);
        assert.ok(cuUrl.indexOf('/11.ts') !== -1, 'Expected catchup on archive variant 11, got: ' + cuUrl);

        // Preferred Country order: TR before UK before NL before US
        const firstCountryOf = (countryCode) => tidied.findIndex((c) => c._country === countryCode);
        assert.ok(firstCountryOf('TR') < firstCountryOf('UK'));
        assert.ok(firstCountryOf('UK') < firstCountryOf('NL'));
        assert.ok(firstCountryOf('NL') < firstCountryOf('US'));

        // Favorite on sub-variant preserves across Tidy <-> Raw rebuild with zero extra fetch
        const sdVariantId = trt.variants[3].id;
        iptvCtx.IPTV.setFavorite(sdVariantId, true);
        assert.strictEqual(iptvCtx.IPTV.isFavorite(trt.id), true, 'Merged channel must reflect favorited variant');

        iptvCtx.IPTV.setTidyCfg({ enabled: false });
        iptvCtx.IPTV.rebuild();
        assert.strictEqual(listCalls, 1, 'rebuild() must not trigger network fetch');
        assert.strictEqual(iptvCtx.IPTV.channels().length, 15, 'Raw mode exposes all 15 channels');
        assert.strictEqual(iptvCtx.IPTV.isFavorite(sdVariantId), true);

        // Toggle back to Tidied
        iptvCtx.IPTV.setTidyCfg({ enabled: true });
        iptvCtx.IPTV.rebuild();
        assert.strictEqual(listCalls, 1);
        assert.strictEqual(iptvCtx.IPTV.channels().filter((c) => c.name === 'TRT 1').length, 1);
    });

    await runTest('playerBrowseOverlay & liveMeta (state transitions & FPS parser)', async () => {
        function makeEl(id, tag) {
            const clsSet = new Set();
            const node = {
                id: id || '', tagName: tag || 'DIV', style: {}, className: '', textContent: '',
                children: [], parentNode: null,
                classList: {
                    add: function (c) { clsSet.add(c); node.className = Array.from(clsSet).join(' '); },
                    remove: function (c) { clsSet.delete(c); node.className = Array.from(clsSet).join(' '); },
                    contains: function (c) { return clsSet.has(c); }
                },
                appendChild: function (c) { c.parentNode = node; node.children.push(c); return c; },
                removeChild: function (c) { const i = node.children.indexOf(c); if (i !== -1) node.children.splice(i, 1); return c; },
                setAttribute: function () {}, getAttribute: function () { return null; },
                addEventListener: function () {}, removeEventListener: function () {},
                pause: function () {}, play: function () { return Promise.resolve(); }, removeAttribute: function () {}, load: function () {},
                querySelectorAll: function () { return []; }
            };
            return node;
        }
        const byIdMap = {};
        ['app', 'av-player', 'html5-player', 'player-osd', 'osd-title', 'osd-clock', 'osd-tags', 'osd-bar', 'osd-buffer', 'osd-progress',
         'osd-cur', 'osd-dur', 'osd-chapter', 'osd-chapters', 'osd-sponsor', 'osd-scrub', 'osd-scrub-range', 'osd-scrub-time',
         'osd-scrub-pic', 'osd-hint', 'subs', 'subs2', 'sub-menu', 'player-bar', 'stream-info', 'skip-prompt', 'channel-drawer'].forEach((id) => {
            byIdMap[id] = makeEl(id, id === 'html5-player' ? 'VIDEO' : 'DIV');
        });
        const bodyEl = makeEl('body', 'BODY');
        let orbitStarted = 0, orbitStopped = 0;
        const baseCtx = loadBrowserScript('js/iptv.js');
        const extraU = Object.assign({}, baseCtx.U, {
            byId: (id) => byIdMap[id] || makeEl(id),
            el: (tag, cls, txt) => {
                const n = makeEl('', (tag || 'div').toUpperCase());
                if (cls) { cls.split(/\s+/).forEach((c) => { if (c) n.classList.add(c); }); }
                if (txt !== undefined) n.textContent = String(txt);
                return n;
            },
            clear: (n) => { n.children = []; n.textContent = ''; },
            getText: () => Promise.resolve(''),
            getJSON: () => Promise.resolve(null),
            listOf: (x) => Array.isArray(x) ? x : [],
            fmtTime: () => '0:00',
            whenVisible: () => {},
            cancelToken: () => ({ cancelled: false, cancel: function () { this.cancelled = true; } }),
            crumb: () => {}, zoom: () => 1, fromUTF8: (b) => b, toUTF8: (s) => s, loadScript: () => Promise.resolve(),
            deferImage: () => {}, cardImage: () => {}, qrCanvas: () => {},
            toast: () => {},
            spinner: () => {},
            startOledOrbit: () => { orbitStarted++; },
            stopOledOrbit: () => { orbitStopped++; }
        });
        const timeoutsAsked = [];
        const ctx = loadBrowserScript([
            'js/stremio.js',
            'js/player-core.js',
            'js/player-store.js',
            'js/player-lang.js',
            'js/player-quality.js',
            'js/player-subs.js',
            'js/player-audio.js',
            'js/player-controls.js',
            'js/player.js'
        ], {
            setTimeout: (fn, ms) => { timeoutsAsked.push(ms); const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
            setInterval: (fn, ms) => { const t = setInterval(fn, ms); if (t && t.unref) t.unref(); return t; },
            U: extraU,
            document: {
                body: bodyEl,
                documentElement: bodyEl,
                getElementById: (id) => byIdMap[id] || null,
                createElement: extraU.el,
                querySelector: () => null,
                querySelectorAll: (sel) => byIdMap[sel.slice(1)] ? [byIdMap[sel.slice(1)]] : [],
                addEventListener: () => {},
                removeEventListener: () => {}
            }
        });

        assert.strictEqual(typeof ctx.Player.setBrowseOverlay, 'function');
        assert.strictEqual(typeof ctx.Player.isBrowseOverlay, 'function');
        assert.strictEqual(typeof ctx.Player.isLivePlaying, 'function');
        assert.strictEqual(typeof ctx.Player.liveMeta, 'function');
        assert.strictEqual(typeof ctx.Player.onLiveMetaChange, 'function');
        assert.strictEqual(typeof ctx.Player.togglePlay, 'function');

        assert.strictEqual(ctx.PlayerParts.parseFps('50'), 50);
        assert.strictEqual(ctx.PlayerParts.parseFps('50/1'), 50);
        assert.strictEqual(ctx.PlayerParts.parseFps('60000/1001'), 59.94);
        assert.strictEqual(ctx.PlayerParts.parseFps('25.000'), 25);
        assert.strictEqual(ctx.PlayerParts.parseFps('0'), 0);
        assert.strictEqual(ctx.PlayerParts.parseFps('bad'), 0);

        let metaUpdates = 0;
        ctx.Player.onLiveMetaChange(() => { metaUpdates++; });

        ctx.Player.init();
        ctx.Player.play({
            url: 'http://stream.example.com/live/1.m3u8',
            type: 'tv',
            id: 'iptv:ch1',
            name: 'TRT 1',
            isLive: true,
            browseOverlay: true,
            fromHome: true
        });
        assert.strictEqual(ctx.Player.isLivePlaying(), true);
        assert.strictEqual(ctx.Player.isBrowseOverlay(), true);
        assert.strictEqual(ctx.Player.currentLiveId(), 'iptv:ch1');
        assert.ok(bodyEl.classList.contains('live-behind'), 'body must have live-behind');
        assert.strictEqual(byIdMap.app.className, '', '#app must remain visible behind glass');
        assert.ok(byIdMap['player-osd'].className.indexOf('hidden') !== -1, 'OSD stays hidden during browseOverlay');

        timeoutsAsked.length = 0;
        ctx.Player.setBrowseOverlay(false);
        assert.strictEqual(ctx.Player.isBrowseOverlay(), false);
        assert.ok(timeoutsAsked.indexOf(4000) !== -1, 'fullscreen shows the OSD a moment, then hides it (not left standing on an OLED)');
        assert.ok(!bodyEl.classList.contains('live-behind'));
        assert.strictEqual(byIdMap.app.className, 'hidden');

        ctx.Player.setBrowseOverlay(true);
        assert.strictEqual(ctx.Player.isBrowseOverlay(), true);
        assert.ok(orbitStarted >= 1);

        const snap = ctx.Player.liveMeta();
        assert.strictEqual(snap.id, 'iptv:ch1');
        assert.ok(metaUpdates >= 1);

        ctx.Player.exit();
        assert.strictEqual(ctx.Player.isLivePlaying(), false);
        assert.strictEqual(ctx.Player.isBrowseOverlay(), false);
        assert.ok(!bodyEl.classList.contains('live-behind'));
        assert.strictEqual(byIdMap.app.className, '');
        assert.ok(orbitStopped >= 1);
    });

    await runTest('viewIptv windowing (2000 channels render <= 10 DOM rows & <= 11 categories)', async () => {
        const makeEl = (id, tag) => {
            const clsSet = new Set();
            const attrs = {};
            const node = {
                id: id || '', tagName: tag || 'DIV', style: {}, className: '', textContent: '',
                children: [], parentNode: null, listeners: {},
                setAttribute: (k, v) => { attrs[k] = String(v); },
                getAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null,
                contains: (other) => other === node || node.children.some((c) => c.contains && c.contains(other)),
                classList: {
                    add: (c) => { clsSet.add(c); node.className = Array.from(clsSet).join(' '); },
                    remove: (c) => { clsSet.delete(c); node.className = Array.from(clsSet).join(' '); },
                    contains: (c) => clsSet.has(c)
                },
                appendChild: (c) => { c.parentNode = node; node.children.push(c); return c; },
                removeChild: (c) => { const i = node.children.indexOf(c); if (i !== -1) node.children.splice(i, 1); return c; },
                addEventListener: (ev, fn) => { node.listeners[ev] = fn; },
                querySelector: (sel) => {
                    const chain = sel.trim().split(/\s+/);
                    const matchOne = (el, part) => el.classList && part.split('.').filter(Boolean).every((c) => el.classList.contains(c));
                    const findChain = (root, idx) => {
                        for (const ch of root.children) {
                            if (matchOne(ch, chain[idx])) {
                                if (idx === chain.length - 1) return ch;
                                const sub = findChain(ch, idx + 1);
                                if (sub) return sub;
                            }
                            const nested = findChain(ch, idx);
                            if (nested) return nested;
                        }
                        return null;
                    };
                    return findChain(node, 0);
                },
                querySelectorAll: (sel) => {
                    const out = [];
                    const parts = sel.split('.').filter(Boolean);
                    const walk = (root) => {
                        for (const ch of root.children) {
                            if (parts.every((p) => ch.classList && ch.classList.contains(p))) out.push(ch);
                            walk(ch);
                        }
                    };
                    walk(node);
                    return out;
                }
            };
            return node;
        };
        const channels = [];
        for (let i = 1; i <= 2000; i++) {
            channels.push({
                id: 'iptv:ch-' + i,
                type: 'tv',
                name: 'Channel ' + i,
                group: 'TR · Group ' + ((i % 40) + 1),
                logo: '',
                variants: [{ id: 'iptv:ch-' + i, badge: 'FHD', rawName: 'Channel ' + i + ' FHD' }],
                _qBadge: 'FHD'
            });
        }
        const wrap = makeEl('rows', 'DIV');
        const baseCtx = loadBrowserScript('js/iptv.js');
        const extraU = Object.assign({}, baseCtx.U, {
            el: (tag, cls, txt) => {
                const n = makeEl('', (tag || 'div').toUpperCase());
                if (cls) cls.split(/\s+/).forEach((c) => { if (c) n.classList.add(c); });
                if (txt !== undefined) n.textContent = String(txt);
                return n;
            },
            clear: (n) => { n.children = []; n.textContent = ''; },
            toast: () => {}
        });
        let focused = null;
        const ctx = loadBrowserScript('js/view-iptv.js', {
            U: extraU,
            ViewParts: { scr: () => wrap, pickList: () => {}, refreshAddonRows: () => {} },
            IPTV: { channels: () => channels, isFavorite: () => false, getTidyCfg: () => ({ enabled: true, countries: ['TR', 'UK', 'NL'] }) },
            EPG: { want: () => {}, now: () => null, schedule: () => [], onChange: () => {}, hhmm: () => '20:00', hasGuide: () => false, logo: () => '' },
            Player: { isLivePlaying: () => false, currentLiveId: () => '', onLiveMetaChange: () => () => {} },
            Stremio: { getPrefs: () => ({ liveBrowseMode: true }) },
            Focus: {
                current: () => focused,
                setFocus: (n) => { focused = n; },
                setScope: (s, n) => { focused = n || focused; }
            },
            document: { documentElement: wrap, contains: () => true }
        });
        wrap.contains = () => true;
        ctx.ViewParts.iptvBrowser(wrap);
        const rows = wrap.querySelectorAll('.iptv-row');
        const cats = wrap.querySelectorAll('.iptv-cat');
        assert.strictEqual(rows.length, 10, 'Center pane must render exactly 10 channel rows in DOM');
        assert.strictEqual(cats.length, 11, 'Left rail must cap at 11 category rows in DOM');

        // Scroll DOWN past row 9 into channel #11 and verify DOM remains capped at 10 rows
        let cur = rows[9];
        const next = cur.__goDOWN();
        assert.strictEqual(next, false);
        assert.strictEqual(wrap.querySelectorAll('.iptv-row').length, 10);
        assert.strictEqual(focused.__absIdx, 10);
    });

    await runTest('IPTV tidier edge cases (EU wrapper, Unicode pipes, space-separated UK, skip Xtream XHR probe)', async () => {
        const m3u = [
            '#EXTM3U',
            '#EXTINF:-1 tvg-id="bbc1.uk" group-title="EU | UK GENERAL",UK| BBC 1 HD',
            'http://xt.example.com/live/user1/pass1/1001.ts',
            '#EXTINF:-1 tvg-id="bbc1.uk" group-title="EU | UK GENERAL",BBC 1 FHD',
            'http://xt.example.com/live/user1/pass1/1002.ts',
            '#EXTINF:-1 tvg-id="trt1.tr" group-title="TR | \u2726 ULUSAL VIP \u2726",TR \u2502 TRT 1 4K',
            'http://xt.example.com/live/user1/pass1/2001.ts'
        ].join('\n');

        let xhrCalls = 0;
        function MockXHR() { this.readyState = 0; }
        MockXHR.prototype.open = () => { xhrCalls++; };
        MockXHR.prototype.send = () => {};

        const ctx = loadBrowserScript('js/iptv.js', {
            XMLHttpRequest: MockXHR
        });
        ctx.IPTV.reset();
        ctx.U.store.set('stremiok.prefs', {
            iptvTidy: true,
            iptvHideAdult: true,
            iptvCollapseVariants: true,
            iptvCountries: 'UK, TR'
        });

        // Parse M3U via internal finish/m3uReader path or load from inline source cache:
        // Exercise cleanGroup, countryFromText, cleanChannelName via addPlaylist + load:
        ctx.U.getText = () => Promise.resolve(m3u);
        ctx.IPTV.addPlaylist('http://xt.example.com/get.php?username=u&password=p&type=m3u_plus', 'MyIPTV');
        await ctx.IPTV.load(true);
        const list = ctx.IPTV.channels();
        const bbc = list.find((c) => c.name === 'BBC 1');
        assert.ok(bbc, 'UK| BBC 1 HD should normalize to BBC 1');
        assert.strictEqual(bbc._country, 'UK');
        assert.strictEqual(bbc.group, 'UK · General');
        assert.strictEqual(bbc.variants.length, 2, 'BBC 1 HD and BBC 1 FHD should collapse into variants');

        const trt = list.find((c) => c.name === 'TRT 1');
        assert.ok(trt, 'TR Unicode pipe channel should normalize to TRT 1');
        assert.strictEqual(trt.group, 'TR · Ulusal');

        const stList = await ctx.IPTV.streams(bbc.id);
        assert.ok(Array.isArray(stList) && stList.length >= 2);
        assert.strictEqual(xhrCalls, 0, 'Xtream /live/ streams(id) must not probe youTubeEnd over HTTP');
    });

    await runTest('viewIptv EPG burst coalescing prevents inspector wipe & preserves focus', async () => {
        const makeEl = (id, tag) => {
            const clsSet = new Set();
            const attrs = {};
            const node = {
                id: id || '', tagName: tag || 'DIV', style: {}, className: '', textContent: '',
                children: [], parentNode: null, listeners: {},
                setAttribute: (k, v) => { attrs[k] = String(v); },
                getAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null,
                contains: (other) => other === node || node.children.some((c) => c.contains && c.contains(other)),
                classList: {
                    add: (c) => { clsSet.add(c); node.className = Array.from(clsSet).join(' '); },
                    remove: (c) => { clsSet.delete(c); node.className = Array.from(clsSet).join(' '); },
                    contains: (c) => clsSet.has(c)
                },
                appendChild: (c) => { c.parentNode = node; node.children.push(c); return c; },
                removeChild: (c) => { const i = node.children.indexOf(c); if (i !== -1) node.children.splice(i, 1); return c; },
                addEventListener: (ev, fn) => { node.listeners[ev] = fn; },
                querySelector: (sel) => {
                    const chain = sel.trim().split(/\s+/);
                    const matchOne = (el, part) => el.classList && part.split('.').filter(Boolean).every((c) => el.classList.contains(c));
                    const findChain = (root, idx) => {
                        for (const ch of root.children) {
                            if (matchOne(ch, chain[idx])) {
                                if (idx === chain.length - 1) return ch;
                                const sub = findChain(ch, idx + 1);
                                if (sub) return sub;
                            }
                            const nested = findChain(ch, idx);
                            if (nested) return nested;
                        }
                        return null;
                    };
                    return findChain(node, 0);
                },
                querySelectorAll: (sel) => {
                    const out = [];
                    const parts = sel.split('.').filter(Boolean);
                    const walk = (root) => {
                        for (const ch of root.children) {
                            if (parts.every((p) => ch.classList && ch.classList.contains(p))) out.push(ch);
                            walk(ch);
                        }
                    };
                    walk(node);
                    return out;
                }
            };
            return node;
        };

        const channels = [{
            id: 'iptv:bbc1',
            type: 'tv',
            name: 'BBC One',
            group: 'UK · General',
            logo: '',
            variants: [{ id: 'iptv:bbc1', badge: 'FHD', rawName: 'BBC One FHD' }],
            _qBadge: 'FHD'
        }];

        let inspClears = 0;
        const wrap = makeEl('rows', 'DIV');
        const baseCtx = loadBrowserScript('js/iptv.js');
        const extraU = Object.assign({}, baseCtx.U, {
            el: (tag, cls, txt) => {
                const n = makeEl('', (tag || 'div').toUpperCase());
                if (cls) cls.split(/\s+/).forEach((c) => { if (c) n.classList.add(c); });
                if (txt !== undefined) n.textContent = String(txt);
                return n;
            },
            clear: (n) => {
                if (n && n.classList && n.classList.contains('iptv-insp')) { inspClears++; }
                n.children = [];
                n.textContent = '';
            },
            toast: () => {}
        });

        let epgListener = null;
        let schedCalls = 0;
        let progTitle = 'Program Alpha';
        let focused = null;
        const ctx = loadBrowserScript('js/view-iptv.js', {
            U: extraU,
            ViewParts: { scr: () => wrap, pickList: () => {}, refreshAddonRows: () => {} },
            IPTV: { channels: () => channels, isFavorite: () => false, getTidyCfg: () => ({ enabled: true, countries: ['UK'] }) },
            EPG: {
                want: () => {},
                now: () => ({ now: { title: progTitle, start: 1000, stop: 2000, progress: 0.4 } }),
                schedule: () => {
                    schedCalls++;
                    return Promise.resolve([
                        { title: progTitle, start: 1000, stop: 2000 },
                        { title: 'Next Show 1', start: 2000, stop: 3000 },
                        { title: 'Next Show 2', start: 3000, stop: 4000 }
                    ]);
                },
                onChange: (fn) => { epgListener = fn; },
                hhmm: () => '20:00',
                hasGuide: () => true,
                logo: () => ''
            },
            Player: { isLivePlaying: () => false, currentLiveId: () => '', onLiveMetaChange: () => () => {} },
            Stremio: { getPrefs: () => ({ liveBrowseMode: true }) },
            Focus: {
                current: () => focused,
                setFocus: (n) => { focused = n; },
                setScope: (s, n) => { focused = n || focused; }
            },
            document: { documentElement: wrap, contains: () => true }
        });
        wrap.contains = () => true;
        ctx.ViewParts.iptvBrowser(wrap);
        await new Promise((r) => setTimeout(r, 120));

        const clearsAfterRender = inspClears;
        const schedAfterRender = schedCalls;
        const favBtn = wrap.querySelector('.iptv-act-btn');
        assert.ok(favBtn, 'Inspector action button must exist');
        focused = favBtn;

        progTitle = 'Program Beta';
        for (let i = 0; i < 5; i++) { epgListener(); }
        await new Promise((r) => setTimeout(r, 120));

        assert.strictEqual(inspClears, clearsAfterRender, 'EPG bursts must update inspector in place without clearing .iptv-insp');
        assert.strictEqual(schedCalls, schedAfterRender, 'EPG bursts for same channel must not re-query EPG.schedule');
        assert.strictEqual(focused, favBtn, 'Focus inside inspector must survive EPG updates');
        const nowNode = wrap.querySelector('.iptv-epg-main-title');
        assert.ok(nowNode && nowNode.textContent.indexOf('Program Beta') !== -1, 'Inspector live title must update in place');
        ctx.ViewParts.iptvLeave();
    });

    await runTest('IPTV ids stable across Xtream reads, tidier heuristics, favorites set', async () => {
        const svc = loadService();
        const cats = { '1': 'UK | Kids', '2': 'IN | Hindi', '3': 'Entertainment' };
        let recs = [];
        const mk = (sid, name, cat, tvg) => Object.assign({}, svc.xtLiveRecord({ stream_id: sid, name: name, category_id: cat, epg_channel_id: tvg || '' }, cats, 'http://host:8080', 'user', 'pass', 'ts'));
        const iptvCtx = loadBrowserScript('js/iptv.js', {
            Date: Date,
            YTPlay: { installMode: () => 'service', xtliveList: () => Promise.resolve({ state: 'ready', at: Date.now(), count: recs.length, groups: 2, dropped: 0, channels: recs }) }
        });
        const pid = iptvCtx.IPTV.addXtream('http://host:8080', 'user', 'pass');
        recs = [mk(101, 'Adult Swim', '1', 'adultswim.uk'), mk(102, 'ALT Balaji', '2'), mk(103, 'CH 5 HD', '3'), mk(104, 'Venus TV', '2'), mk(105, 'UK: Sky News HD', '1', 'skynews.uk')];
        await iptvCtx.IPTV.load(true);
        const byName = {};
        iptvCtx.IPTV.channels().forEach((c) => { byName[c.name] = c; });
        assert.ok(byName['Adult Swim'], 'Adult Swim is a cartoon channel, not adult');
        assert.ok(byName['Venus TV'], 'Venus TV is not adult');
        assert.ok(byName['ALT Balaji'] && byName['ALT Balaji']._qBadge.indexOf('Backup') === -1, '"ALT" in a name is not a backup tag');
        assert.strictEqual(byName['CH 5']._country, '', '"CH 5" is not Switzerland');
        assert.strictEqual(byName['Sky News']._country, 'UK');

        // The server renumbers its streams: ids (favorites, Recent, per-channel memory) stay
        const skyId = byName['Sky News'].id;
        assert.ok(skyId.indexOf('iptv:' + pid + ':') === 0 && !/:105$/.test(skyId), 'ids come from tvg-id / name, not stream_id: ' + skyId);
        iptvCtx.IPTV.setFavorite(skyId, true);
        assert.strictEqual(iptvCtx.IPTV.isFavorite(skyId), true);
        recs = [mk(905, 'UK: Sky News HD', '1', 'skynews.uk')];
        await iptvCtx.IPTV.load(true);
        assert.strictEqual(iptvCtx.IPTV.channels()[0].id, skyId, 'same channel, same id after renumbering');
        assert.strictEqual(iptvCtx.IPTV.isFavorite(skyId), true, 'still a favorite');
        iptvCtx.IPTV.setFavorite(skyId, false);
        assert.strictEqual(iptvCtx.IPTV.isFavorite(skyId), false, 'the favorites set follows the saved list');
    });

    await runTest('zapLiveChannel fallback chain (collapsed variants + Xtream .ts -> .m3u8 mirror)', async () => {
        let playedCtx = null;
        const streamsById = {
            'iptv:ch-4k': [
                { url: 'http://xt.example.com/live/u/p/101.ts', title: '4K' },
                { url: 'http://xt.example.com/live/u/p/102.ts', title: 'FHD' },
                { url: 'http://xt.example.com/live/u/p/103.ts', title: 'HD' }
            ]
        };
        const ch = {
            id: 'iptv:ch-4k',
            name: 'Sky Sports',
            group: 'UK · Sports',
            variants: [
                { id: 'iptv:ch-4k', badge: '4K' },
                { id: 'iptv:ch-fhd', badge: 'FHD' }
            ]
        };
        const ctx = loadBrowserScript('js/view-core.js', {
            IPTV: {
                channels: () => [ch],
                rawChannels: () => [ch],
                streams: (id) => Promise.resolve(streamsById[id] || []),
                catchupUrl: () => null
            },
            EPG: { now: () => null, logo: () => '', onChange: () => {} },
            Player: { play: (c) => { playedCtx = c; } },
            App: { showScreen: () => {} },
            Stremio: {
                getStreams: (type, id) => Promise.resolve(streamsById[id] || []),
                isPlayable: (s) => !!(s && s.url),
                sourceId: (s) => 'u|' + ((s && s.url) || ''),   // (as Stremio.sourceId: not the bare link)
                streamInfo: () => ({})
            },
            Focus: { current: () => null, setFocus: () => {}, setScope: () => {}, backScope: () => {}, onFocus: () => {} },
            U: { toast: () => {}, spinner: () => {}, log: () => {}, sanitizeHeaders: (h) => h, t: (s) => s, listOf: (x) => Array.isArray(x) ? x : [], el: () => ({}), clear: () => {} }
        });

        await ctx.ViewParts.zapLiveChannel(ch, { browseOverlay: true, fromHome: true });
        await new Promise((r) => setTimeout(r, 30));
        assert.ok(playedCtx && typeof playedCtx.nextSource === 'function', 'zapLiveChannel must attach ctx.nextSource');
        assert.strictEqual(playedCtx.url, 'http://xt.example.com/live/u/p/101.ts');

        assert.strictEqual(playedCtx.variantsOnly, true, 'its next sources are the channel\'s own variants');
        // As nextSourceOnFail keeps them: Stremio.sourceId of each source that failed
        const sid = (u) => 'u|' + u;
        const tried = [sid(playedCtx.url)];
        const order = [];
        let n;
        while ((n = playedCtx.nextSource(tried))) { order.push(n.source.url); tried.push(sid(n.source.url)); }
        assert.deepStrictEqual(order, [
            'http://xt.example.com/live/u/p/102.ts',
            'http://xt.example.com/live/u/p/103.ts',
            'http://xt.example.com/live/u/p/101.m3u8'
        ], 'every variant then the .m3u8 mirror, each once (no going back to a failed one)');

        // Sources: a variant picked by its link plays that one
        playedCtx = null;
        await ctx.ViewParts.zapLiveChannel(ch, { browseOverlay: true, streamUrl: 'http://xt.example.com/live/u/p/103.ts' });
        await new Promise((r) => setTimeout(r, 30));
        assert.strictEqual(playedCtx.url, 'http://xt.example.com/live/u/p/103.ts');
    });

    await runTest('player-core AVPlay stop-before-close on live zap, browseOverlay buffering, and live nextSourceOnFail', async () => {
        const calls = [];
        let activeListener = null;
        let avState = 'NONE';
        const mockAvplay = {
            open: (u) => { calls.push('open:' + u); avState = 'IDLE'; },
            stop: () => { calls.push('stop'); avState = 'IDLE'; },
            close: () => { calls.push('close'); avState = 'NONE'; },
            setListener: (l) => { activeListener = l; },
            prepareAsync: (ok) => { calls.push('prepareAsync'); ok(); },
            play: () => { calls.push('play'); avState = 'PLAYING'; },
            getState: () => avState,
            getDuration: () => 0,
            getCurrentTime: () => 0,
            getTotalTrackInfo: () => [],
            getCurrentStreamInfo: () => [],
            setDisplayRect: () => {},
            setDisplayMethod: () => {},
            setBufferingParam: () => {},
            setStreamingProperty: () => {},
            setSilentSubtitle: () => {},
            seekTo: () => {},
            suspend: () => {},
            restore: () => {}
        };

        const makeEl = (id, tag) => {
            const clsSet = new Set();
            const node = {
                id: id || '', tagName: tag || 'DIV', style: {}, className: '', textContent: '',
                children: [], parentNode: null, listeners: {},
                setAttribute: () => {}, getAttribute: () => null, contains: () => false,
                classList: {
                    add: (c) => { clsSet.add(c); node.className = Array.from(clsSet).join(' '); },
                    remove: (c) => { clsSet.delete(c); node.className = Array.from(clsSet).join(' '); },
                    contains: (c) => clsSet.has(c)
                },
                appendChild: (c) => { c.parentNode = node; node.children.push(c); return c; },
                removeChild: (c) => { const i = node.children.indexOf(c); if (i !== -1) node.children.splice(i, 1); return c; },
                addEventListener: (ev, fn) => { node.listeners[ev] = fn; },
                querySelector: () => null,
                querySelectorAll: () => []
            };
            return node;
        };

        const byIdMap = {};
        ['app', 'player-osd', 'osd-title', 'osd-subtitle', 'osd-tags', 'osd-logo', 'osd-badges',
         'osd-time', 'osd-progress', 'osd-fill', 'osd-thumb', 'osd-scrub', 'osd-scrub-time',
         'osd-scrub-pic', 'osd-hint', 'subs', 'subs2', 'sub-menu', 'player-bar', 'stream-info',
         'skip-prompt', 'channel-drawer'].forEach((id) => {
            byIdMap[id] = makeEl(id, 'DIV');
        });
        const bodyEl = makeEl('body', 'BODY');
        const spinnerCalls = [];
        const baseCtx = loadBrowserScript('js/iptv.js');
        const extraU = Object.assign({}, baseCtx.U, {
            byId: (id) => byIdMap[id] || makeEl(id),
            el: (tag, cls, txt) => {
                const n = makeEl('', (tag || 'div').toUpperCase());
                if (cls) cls.split(/\s+/).forEach((c) => { if (c) n.classList.add(c); });
                if (txt !== undefined) n.textContent = String(txt);
                return n;
            },
            clear: (n) => { n.children = []; n.textContent = ''; },
            getText: () => Promise.resolve(''),
            getJSON: () => Promise.resolve(null),
            listOf: (x) => Array.isArray(x) ? x : [],
            fmtTime: () => '0:00',
            whenVisible: () => {},
            cancelToken: () => ({ cancelled: false, cancel: function () { this.cancelled = true; } }),
            crumb: () => {}, zoom: () => 1, fromUTF8: (b) => b, toUTF8: (s) => s, loadScript: () => Promise.resolve(),
            deferImage: () => {}, cardImage: () => {}, qrCanvas: () => {},
            toast: () => {},
            spinner: (on, msg) => { spinnerCalls.push({ on: !!on, msg: msg || '' }); },
            startOledOrbit: () => {},
            stopOledOrbit: () => {}
        });

        const ctx = loadBrowserScript([
            'js/stremio.js',
            'js/player-core.js',
            'js/player-store.js',
            'js/player-lang.js',
            'js/player-quality.js',
            'js/player-subs.js',
            'js/player-audio.js',
            'js/player-controls.js',
            'js/player.js'
        ], {
            setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
            setInterval: (fn, ms) => { const t = setInterval(fn, ms); if (t && t.unref) t.unref(); return t; },
            webapis: { avplay: mockAvplay },
            U: extraU,
            document: {
                body: bodyEl,
                documentElement: bodyEl,
                getElementById: (id) => byIdMap[id] || null,
                createElement: extraU.el,
                querySelector: () => null,
                querySelectorAll: () => [],
                addEventListener: () => {},
                removeEventListener: () => {}
            }
        });

        const metaEvents = [];
        ctx.Player.onLiveMetaChange((m) => metaEvents.push(Object.assign({}, m)));
        ctx.Player.init();

        ctx.Player.play({
            url: 'http://xt.example.com/live/u/p/101.ts',
            stream: { url: 'http://xt.example.com/live/u/p/101.ts' },
            type: 'tv',
            id: 'iptv:ch1',
            name: 'Channel 1',
            isLive: true,
            browseOverlay: true,
            fromHome: true,
            variantsOnly: true,
            nextSource: (tried) => tried.length === 1 ? {
                source: { url: 'http://xt.example.com/live/u/p/101.m3u8', stream: { url: 'http://xt.example.com/live/u/p/101.m3u8' } },
                total: 2
            } : null
        });

        assert.ok(activeListener, 'AVPlay listener attached');
        spinnerCalls.length = 0;
        activeListener.onbufferingstart();
        assert.strictEqual(spinnerCalls.some((s) => s.on), false, 'browseOverlay buffering must not show blocking fullscreen spinner');
        assert.strictEqual(ctx.Player.liveMeta().buffering, true, 'liveMeta().buffering must turn true on onbufferingstart');
        activeListener.onbufferingcomplete();
        assert.strictEqual(ctx.Player.liveMeta().buffering, false, 'liveMeta().buffering must turn false on onbufferingcomplete');

        // Error before playing on live stream must trigger nextSourceOnFail -> .m3u8
        calls.length = 0;
        activeListener.onerror('PLAYER_ERROR_NOT_SUPPORTED_FORMAT');
        await new Promise((r) => setTimeout(r, 250));
        const stopIdx = calls.indexOf('stop');
        const closeIdx = calls.indexOf('close');
        const m3u8OpenIdx = calls.indexOf('open:http://xt.example.com/live/u/p/101.m3u8');
        assert.ok(stopIdx !== -1 && closeIdx !== -1 && stopIdx < closeIdx, 'Live switch/fallback must call avplay.stop() before avplay.close()');
        assert.ok(m3u8OpenIdx > closeIdx, 'Live onerror must open fallback .m3u8 URL after closing failed stream; calls=' + JSON.stringify(calls) + ' ctx=' + JSON.stringify({ active: ctx.Player.isLivePlaying(), liveId: ctx.Player.currentLiveId() }));

        // Direct zap from active live channel A to live channel B must also stop-then-close with settle delay
        calls.length = 0;
        ctx.Player.play({
            url: 'http://xt.example.com/live/u/p/202.ts',
            stream: { url: 'http://xt.example.com/live/u/p/202.ts' },
            type: 'tv',
            id: 'iptv:ch2',
            name: 'Channel 2',
            isLive: true,
            browseOverlay: true
        });
        assert.strictEqual(calls.indexOf('open:http://xt.example.com/live/u/p/202.ts'), -1, 'Switching active live channel must wait settle delay before opening next');
        await new Promise((r) => setTimeout(r, 180));
        assert.ok(calls.indexOf('stop') !== -1 && calls.indexOf('stop') < calls.indexOf('close'));
        assert.ok(calls.indexOf('close') < calls.indexOf('open:http://xt.example.com/live/u/p/202.ts'));

        ctx.Player.exit();
    });

    await runTest('Live AV stream health recovery (no-audio / no-video fallback & repack, keep default live track)', async () => {
        const calls = [];
        let activeListener = null;
        let currentStreamInfo = [];
        let totalTrackInfo = [];
        let liveOpenCalls = 0;

        const mockAvplay = {
            open: (u) => { calls.push('open:' + u); },
            stop: () => { calls.push('stop'); },
            close: () => { calls.push('close'); },
            setListener: (l) => { activeListener = l; },
            prepareAsync: (ok) => { ok(); },
            play: () => {},
            getState: () => 'PLAYING',
            getDuration: () => 0,
            getCurrentTime: () => 0,
            getTotalTrackInfo: () => totalTrackInfo,
            getCurrentStreamInfo: () => currentStreamInfo,
            setSelectTrack: (type, idx) => { calls.push('select:' + type + ':' + idx); },
            setDisplayRect: () => {},
            setDisplayMethod: () => {},
            setBufferingParam: () => {},
            setStreamingProperty: () => {},
            setSilentSubtitle: () => {},
            seekTo: () => {},
            suspend: () => {},
            restore: () => {}
        };

        const makeEl = (id, tag) => {
            const clsSet = new Set();
            return {
                id: id || '', tagName: tag || 'DIV', style: {}, className: '', textContent: '',
                children: [], parentNode: null,
                setAttribute: () => {}, getAttribute: () => null, contains: () => false,
                classList: {
                    add: (c) => { clsSet.add(c); },
                    remove: (c) => { clsSet.delete(c); },
                    contains: (c) => clsSet.has(c)
                },
                appendChild: (c) => c, removeChild: (c) => c,
                addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => []
            };
        };
        const byIdMap = {};
        ['app', 'player-osd', 'osd-title', 'osd-subtitle', 'osd-tags', 'osd-logo', 'osd-badges',
         'osd-time', 'osd-progress', 'osd-fill', 'osd-thumb', 'osd-scrub', 'osd-scrub-time',
         'osd-scrub-pic', 'osd-hint', 'subs', 'subs2', 'sub-menu', 'player-bar', 'stream-info',
         'skip-prompt', 'channel-drawer'].forEach((id) => { byIdMap[id] = makeEl(id, 'DIV'); });
        const bodyEl = makeEl('body', 'BODY');
        const baseCtx = loadBrowserScript('js/iptv.js');
        const extraU = Object.assign({}, baseCtx.U, {
            byId: (id) => byIdMap[id] || makeEl(id),
            el: (tag, cls, txt) => makeEl('', (tag || 'div').toUpperCase()),
            clear: (n) => { n.children = []; n.textContent = ''; },
            getText: () => Promise.resolve(''),
            getJSON: () => Promise.resolve(null),
            listOf: (x) => Array.isArray(x) ? x : [],
            fmtTime: () => '0:00',
            whenVisible: () => {},
            cancelToken: () => ({ cancelled: false, cancel: function () { this.cancelled = true; } }),
            crumb: () => {}, zoom: () => 1, fromUTF8: (b) => b, toUTF8: (s) => s, loadScript: () => Promise.resolve(),
            deferImage: () => {}, cardImage: () => {}, qrCanvas: () => {},
            toast: () => {}, spinner: () => {}, startOledOrbit: () => {}, stopOledOrbit: () => {}
        });

        const ctx = loadBrowserScript([
            'js/stremio.js',
            'js/player-core.js',
            'js/player-store.js',
            'js/player-lang.js',
            'js/player-quality.js',
            'js/player-subs.js',
            'js/player-audio.js',
            'js/player-controls.js',
            'js/player.js'
        ], {
            Date: Date,
            webapis: { avplay: mockAvplay },
            YTPlay: {
                installMode: () => 'service',
                liveOpen: (url, h, active, opts) => {
                    if (opts && opts.fix) { liveOpenCalls++; }   // (the repack; the HLS look is asked too)
                    return Promise.resolve({ ok: true, url: 'http://localhost:8098/live/fixed.m3u8', fix: !!(opts && opts.fix) });
                }
            },
            U: extraU,
            document: {
                body: bodyEl, documentElement: bodyEl,
                getElementById: (id) => byIdMap[id] || null,
                createElement: extraU.el, querySelector: () => null, querySelectorAll: () => [],
                addEventListener: () => {}, removeEventListener: () => {}
            }
        });
        ctx.U.store.set('stremiok.audio', { lang: 'eng', lang2: 'tur', switch: 'safe', wait: 6 });
        ctx.Player.init();

        // 1. Live TV with multi-audio must NOT blindly switch track away from track 0 on global pref
        totalTrackInfo = [
            { type: 'AUDIO', index: 1, extra_info: JSON.stringify({ language: 'tur' }) },
            { type: 'AUDIO', index: 2, extra_info: JSON.stringify({ language: 'eng' }) }
        ];
        currentStreamInfo = [
            { type: 'VIDEO', index: 0, extra_info: JSON.stringify({ Width: 1920, Height: 1080, fourCC: 'h264' }) },
            { type: 'AUDIO', index: 1, extra_info: JSON.stringify({ fourCC: 'aac', channels: 2 }) }
        ];
        ctx.Player.play({
            url: 'http://xt.example.com/live/u/p/301.ts',
            stream: { url: 'http://xt.example.com/live/u/p/301.ts' },
            type: 'tv', id: 'iptv:ch301', name: 'Live Multi', isLive: true, variantsOnly: true,
            nextSource: (tried) => tried.length === 1 ? {
                source: { url: 'http://xt.example.com/live/u/p/301.m3u8', stream: { url: 'http://xt.example.com/live/u/p/301.m3u8' } },
                total: 2
            } : null
        });
        activeListener.oncurrentplaytime(500);
        activeListener.oncurrentplaytime(1200);
        activeListener.oncurrentplaytime(2100);
        ctx.PlayerParts.applyPreferredAudio();
        assert.strictEqual(calls.some((c) => c.startsWith('select:AUDIO')), false, 'Live TV without per-channel memory must keep default audio track 0');

        // 2. Playing video WITHOUT audio after grace window -> triggers nextSource fallback (.m3u8)
        calls.length = 0;
        currentStreamInfo = [{ type: 'VIDEO', index: 0, extra_info: JSON.stringify({ Width: 1920, Height: 1080, fourCC: 'h264' }) }];
        totalTrackInfo = [];
        ctx.PlayerParts.checkLiveAV(Date.now() + 6000);
        await new Promise((r) => setTimeout(r, 180));
        assert.ok(calls.indexOf('open:http://xt.example.com/live/u/p/301.m3u8') !== -1, 'Missing audio on playing video must fall back to nextSource (.m3u8)');

        // 3. When .m3u8 ALSO plays video WITHOUT audio & no candidates remain -> falls back to liveOpen({ fix: true }) repack
        calls.length = 0;
        ctx.PlayerParts.S.playing = true;
        ctx.PlayerParts.S.playStarted = true;
        ctx.PlayerParts.checkLiveAV(Date.now() + 6000);
        await new Promise((r) => setTimeout(r, 180));
        assert.strictEqual(liveOpenCalls, 1, 'Exhausted candidates with no audio must attempt liveOpen audio repack once');
        assert.ok(calls.indexOf('open:http://localhost:8098/live/fixed.m3u8') !== -1, 'Service repack URL must be opened when audio is missing');

        // 4. A sound-only stream (no VIDEO track among all its tracks) is left playing
        calls.length = 0;
        currentStreamInfo = [{ type: 'AUDIO', index: 1, extra_info: JSON.stringify({ fourCC: 'aac', channels: 2 }) }];
        totalTrackInfo = [{ type: 'AUDIO', index: 1, extra_info: '{}' }];
        ctx.Player.play({
            url: 'http://xt.example.com/live/u/p/501.ts',
            stream: { url: 'http://xt.example.com/live/u/p/501.ts' },
            type: 'tv', id: 'iptv:ch501', name: 'Music Channel', isLive: true, variantsOnly: true,
            nextSource: (tried) => tried.length === 1 ? {
                source: { url: 'http://xt.example.com/live/u/p/501.m3u8', stream: { url: 'http://xt.example.com/live/u/p/501.m3u8' } },
                total: 2
            } : null
        });
        await new Promise((r) => setTimeout(r, 180));
        ctx.PlayerParts.S.playing = true;
        ctx.PlayerParts.S.playStarted = true;
        ctx.PlayerParts.checkLiveAV(Date.now() + 6000);
        await new Promise((r) => setTimeout(r, 180));
        assert.strictEqual(calls.indexOf('open:http://xt.example.com/live/u/p/501.m3u8'), -1, 'A sound-only channel must not be treated as missing video');

        // 5. A TV stream whose VIDEO track stopped decoding (listed, not playing) falls back
        calls.length = 0;
        totalTrackInfo = [{ type: 'VIDEO', index: 0, extra_info: '{}' }, { type: 'AUDIO', index: 1, extra_info: '{}' }];
        ctx.Player.play({
            url: 'http://xt.example.com/live/u/p/401.ts',
            stream: { url: 'http://xt.example.com/live/u/p/401.ts' },
            type: 'tv', id: 'iptv:ch401', name: 'TV Channel', isLive: true, variantsOnly: true,
            nextSource: (tried) => tried.length === 1 ? {
                source: { url: 'http://xt.example.com/live/u/p/401.m3u8', stream: { url: 'http://xt.example.com/live/u/p/401.m3u8' } },
                total: 2
            } : null
        });
        await new Promise((r) => setTimeout(r, 180));
        ctx.PlayerParts.S.playing = true;
        ctx.PlayerParts.S.playStarted = true;
        ctx.PlayerParts.checkLiveAV(Date.now() + 6000);
        await new Promise((r) => setTimeout(r, 180));
        assert.ok(calls.indexOf('open:http://xt.example.com/live/u/p/401.m3u8') !== -1, 'A TV stream that lost its picture must fall back to .m3u8');

        ctx.Player.exit();
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
