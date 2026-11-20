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
    console.log('=== StremioK Test Suite (on upstream 2.4.5) ===\n');
    let passed = 0, failed = 0;
    async function runTest(name, fn) {
        try { await fn(); console.log(`[PASS] ${name}`); passed++; }
        catch (err) { console.log(`[FAIL] ${name}: ${err.message}`); failed++; }
    }
    const ts = (t) => new Date(t * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

    await runTest('ES5 syntax guard (scan js/*.js & service/*.js)', () => {
        const { files, errors } = scanES5();
        if (errors.length > 0) {
            assert.fail(`ES5 violations found in ${errors.length} locations:\n` + errors.map(e => `  ${e.file}:${e.line} - ${e.reason}`).join('\n'));
        }
        assert.ok(files.length > 0, 'No files were scanned');
    });

    await runTest('TV guide keys: countries, the same on both sides, unclear names', () => {
        const svc = loadService(); const EPG = loadBrowserScript('js/epg.js').EPG;
        assert.strictEqual(EPG.key('n', 'TR: TRT 1 HD'), 'n:trt1.tr');
        assert.strictEqual(EPG.key('n', '|UK| BBC One'), 'n:bbcone.uk');
        ['TR: TRT 1 HD', 'FOX SPORTS 2 ARG', '|UK| BBC One', 'Show TV', 'Das.Erste.de'].forEach((n) => {
            assert.strictEqual(EPG.key('n', n), svc.epgKey('n', n), 'name key ' + n);
            assert.strictEqual(JSON.stringify(EPG.guideKeys(n, [n])), JSON.stringify(svc.epgGuideKeys(n, [n])), 'guide keys ' + n);
        });
        assert.deepStrictEqual(Array.from(EPG.keysOf({ name: 'TR: FOX HD' })), ['n:fox.tr', 'n:fox.~']);
        const chans = [{ name: 'TR: FOX HD' }, { name: 'FOX' }, { name: 'TR: TRT 1' }, { name: 'ZDF' }];
        const keys = [].concat.apply([], chans.map((c) => Array.from(EPG.keysOf(c))));
        const p = svc.epgParser(svc.epgBits(EPG.bitsFor(keys)), 1800000000);
        p.feed('<tv><channel id="FOX.us"><display-name>FOX</display-name></channel><channel id="Fox.tr"><display-name>FOX</display-name></channel>' +
            '<channel id="trt1"><display-name>TRT 1</display-name></channel><channel id="ZDF.de"><display-name>ZDF</display-name></channel></tv>');
        p.finish();
        assert.strictEqual(p.keys['n:fox.tr'], 'Fox.tr', 'the Turkish FOX gets the Turkish guide');
        assert.strictEqual(p.keys['n:fox'], 0, 'a FOX without a country is unclear');
        assert.strictEqual(p.keys['n:trt1.~'], 'trt1');
        assert.strictEqual(p.keys['n:zdf'], 'ZDF.de');
    });

    await runTest('TV guide: big playlists\' bitset, programs shared fairly, extra guides only where empty', () => {
        const svc = loadService(); const EPG = loadBrowserScript('js/epg.js').EPG;
        const many = []; for (let i = 0; i < 100000; i++) { many.push('n:chan' + i + '.~'); }
        assert.ok(EPG.bitsFor(many.concat(many, many)).length <= svc.EPG_K_MAX, 'the largest bitset passes /epg/load');
        const n = 5207, ck = []; for (let i = 0; i < n; i++) { ck.push('i:ch' + i, 'i:ch' + i + '.~'); }
        const big = svc.epgParser(svc.epgBits(EPG.bitsFor(ck)), 1800000000);
        let xml = '<tv>'; for (let i = 0; i < n; i++) { xml += '<channel id="ch' + i + '"><display-name>x</display-name></channel>'; } big.feed(xml);
        for (let i = 0; i < n; i++) { let c = ''; for (let j = 0; j < 60; j++) { const s = 1800000000 - 5400 + j * 900; c += '<programme start="' + ts(s) + '" stop="' + ts(s + 900) + '" channel="ch' + i + '"><title>P' + j + '</title></programme>'; } big.feed(c); }
        big.feed('</tv>'); big.finish();
        assert.ok(big.count <= svc.EPG_TOTAL); assert.ok(big.progs['ch' + (n - 1)].length >= 4, 'the last channel keeps programs');
        assert.strictEqual(big.progs.ch0[0][2], 'P5', 'what is on now and one before'); assert.ok(!big.partial);
        const two = [{ name: 'TR| TRT 1 FHD', tvgId: 'trt1.tr' }, { name: 'TR| KANAL D FHD', tvgId: 'kanald.tr' }];
        const xp = svc.epgParser(svc.epgBits(EPG.bitsFor([].concat.apply([], two.map((c) => Array.from(EPG.keysOf(c)))))), 1800000000);
        const prog = (ch, t) => '<programme start="' + ts(1800000000 - 600) + '" stop="' + ts(1800000000 + 1200) + '" channel="' + ch + '"><title>' + t + '</title></programme>';
        xp.feed('<tv><channel id="trt1.tr"><display-name>TR| TRT 1 FHD</display-name></channel><channel id="kanald.tr"><display-name>TR| KANAL D FHD</display-name></channel>' + prog('kanald.tr', 'Own') + '</tv>');
        xp.src = 1; xp.buf = '';
        xp.feed('<tv><channel id="TRT.1.HD.tr"><display-name>TRT 1 HD</display-name></channel><channel id="KANAL.D.HD.tr"><display-name>KANAL D HD</display-name></channel>' + prog('TRT.1.HD.tr', 'Extra') + prog('KANAL.D.HD.tr', 'Extra D') + '</tv>');
        xp.finish();
        assert.strictEqual(xp.keys['i:trt1.tr'], 'x1:TRT.1.HD.tr', 'TRT 1 (empty in its own guide) takes the extra guide');
        assert.strictEqual(xp.keys['i:kanald.tr'], 'kanald.tr', 'Kanal D keeps its own');
    });

    await runTest('Saved copies: the first folder that can really be written', () => {
        const svc = loadService();
        const written = [];
        const fsMock = (ok) => ({
            mkdirSync: () => {},
            writeFileSync: (p) => { if (!ok.some((d) => p.indexOf(d + '/') === 0)) { const e = new Error('EROFS'); e.code = 'EROFS'; throw e; } written.push(p); },
            unlinkSync: () => {}
        });
        assert.strictEqual(svc.saveDirFrom(['/ro/data', '/rw/data', '/tmp/x'], fsMock(['/rw/data', '/tmp/x'])), '/rw/data', 'a read-only app folder is skipped');
        assert.strictEqual(svc.saveDirFrom([null, '/tmp/x'], fsMock(['/tmp/x'])), '/tmp/x', 'no private folder (TizenBrew): the temporary one');
        assert.strictEqual(svc.saveDirFrom(['/ro/a', '/ro/b'], fsMock([])), null, 'none writable: nothing saved');
        assert.ok(written.every((p) => /\.stremiok-write-test$/.test(p)), 'only the probe file is written');
    });

    // A playlist read by the TV itself (no service): two copies of a channel, merged
    function iptvWith(m3u, tidy) {
        const ctx = loadBrowserScript('js/iptv.js', {});
        ctx.U.getText = () => Promise.resolve(m3u);
        ctx.U.store.set('stremiok.iptv.playlists', [{ id: 'p1', url: 'http://pl.example/list.m3u' }]);
        if (tidy) { ctx.U.store.set('stremiok.iptv.tidy', tidy); }
        return ctx;
    }
    const M3U = '#EXTM3U\n#EXTINF:-1 group-title="TR",TR: Show TV HD\nhttp://a.example/show-hd.m3u8\n' +
        '#EXTINF:-1 group-title="TR",TR: Show TV SD\nhttp://a.example/show-sd.m3u8\n#EXTINF:-1 group-title="TR",TR: ATV\nhttp://a.example/atv.m3u8\n';

    await runTest('Merged copies ranked by what they really played as, ahead of their names', async () => {
        const ctx = iptvWith(M3U, { merge: 'all' });
        const d = await ctx.IPTV.load();
        const show = d.channels.filter((c) => c._copies)[0];
        assert.ok(show, 'Show TV merged: ' + d.channels.map((c) => c.name).join(', '));
        let list = await ctx.IPTV.streams(show.id);
        assert.strictEqual(list[0].url, 'http://a.example/show-hd.m3u8', 'by name: HD first');
        ctx.IPTV.noteMeasured('http://a.example/show-hd.m3u8', { height: 576, fps: 25, codec: 'avc1' });
        ctx.IPTV.noteMeasured('http://a.example/show-sd.m3u8', { height: 1080, fps: 50, codec: 'hvc1' });
        ctx.IPTV.noteMeasured('http://a.example/none.m3u8', { height: 0 });
        list = await ctx.IPTV.streams(show.id);
        assert.strictEqual(list[0].url, 'http://a.example/show-sd.m3u8', 'measured 1080p50 first');
        assert.ok(/1080p50/.test(list[0].title) && /576p/.test(list[1].title), 'titles say what was measured: ' + list.map((s) => s.title).join(' | '));
        assert.ok(!('http://a.example/none.m3u8' in ctx.U.store.get('stremiok.iptv.measured')), 'no height: not kept');
        ctx.U.store.set('stremiok.iptv.tidy', { merge: 'best' }); ctx.IPTV.reset();
        const d2 = await ctx.IPTV.load(), best = d2.channels.filter((c) => c._copies)[0];
        list = await ctx.IPTV.streams(best.id);
        assert.strictEqual(list.length, 1); assert.strictEqual(list[0].url, 'http://a.example/show-sd.m3u8');
        assert.strictEqual(list[0]._fallbacks[0].url, 'http://a.example/show-hd.m3u8', 'best: the rest as fallbacks, in measured order');
    });

    await runTest('Countries: a region before the country, and copies merged only within a country', async () => {
        const c0 = loadBrowserScript('js/iptv.js');
        const co = (t) => c0.IPTV.countryOf(t);
        assert.strictEqual(co('EU | UK DOCUMENTARY'), 'UK'); assert.strictEqual(co('EU | TURK ULUSAL'), 'TR');
        assert.strictEqual(co('EU | MY CHANNELS'), '', 'a region and no country: none'); assert.strictEqual(co('UK| DISCOVERY'), 'UK');
        assert.strictEqual(co('TR: FOX'), 'TR'); assert.strictEqual(co('EU|NL SPORT'), 'NL');
        const m3u = '#EXTM3U\n' + [['EU | UK DOCUMENTARY', 'UK| DISCOVERY CHANNEL FHD'], ['EU | UK DOCUMENTARY', 'UK| DISCOVERY CHANNEL SD'],
            ['EU | FR DOCUMENTAIRE', 'FR| DISCOVERY CHANNEL HD'], ['EU | UK DOCUMENTARY', 'ES| DISCOVERY CHANNEL HD'], ['EU | TURK ULUSAL', 'TRT 1 HD'], ['EU | TURK ULUSAL', 'TRT 1 SD']]
            .map((x, i) => '#EXTINF:-1 group-title="' + x[0] + '",' + x[1] + '\nhttp://a.example/' + i + '.m3u8').join('\n') + '\n';
        const ctx = iptvWith(m3u, { merge: 'all', countries: ['TR', 'UK'] });
        const d = await ctx.IPTV.load();
        const disc = d.channels.filter((c) => /DISCOVERY/.test(c.name));
        assert.strictEqual(disc.length, 3, 'UK, FR and ES apart: ' + disc.map((c) => c.name + '[' + (c._copies ? c._copies.length : 1) + ']').join(', '));
        const uk = disc.filter((c) => c._copies)[0];
        assert.ok(uk && uk._copies.length === 2 && uk._copies.every((x) => /^UK\|/.test(x.c.name)), 'the two UK copies merged');
        assert.ok(d.channels.some((c) => c._copies && /TRT 1/.test(c.name)), 'no prefix: the group\'s country (TR) merges them');
        assert.deepStrictEqual(Array.from(d.groups.map((g) => g.name)), ['EU | TURK ULUSAL', 'EU | UK DOCUMENTARY', 'EU | FR DOCUMENTAIRE'], 'Countries first sees through "EU |"');
    });

    await runTest('Recent: a row after Favorites, newest first, a merged channel once', async () => {
        const ctx = iptvWith(M3U, { merge: 'all' });
        const d = await ctx.IPTV.load();
        assert.ok(!d.catalogs.some((c) => c.id === 'iptv_recent'), 'no row before anything played');
        const atv = d.channels.filter((c) => !c._copies)[0], show = d.channels.filter((c) => c._copies)[0];
        ctx.IPTV.noteRecent(atv.id); ctx.IPTV.noteRecent(show._copies[1].c.id); ctx.IPTV.noteRecent(show.id); ctx.IPTV.noteRecent('not-iptv');
        assert.deepStrictEqual(Array.from(ctx.U.store.get('stremiok.iptv.recent')), [show.id, atv.id], 'a copy\'s id replaced by the channel\'s');
        ctx.IPTV.setFavorite(atv.id, true);
        const ids = d.catalogs.map((c) => c.id);
        assert.strictEqual(ids[0], 'iptv_favs'); assert.strictEqual(ids[1], 'iptv_recent');
        const metas = await ctx.IPTV.catalog('iptv_recent');
        assert.deepStrictEqual(Array.from(metas.map((m) => m.id)), [show.id, atv.id]);
    });

    await runTest('Format tags: frame rate the TV reports', () => {
        const ctx = loadBrowserScript('js/stremio.js');
        const t = ctx.Stremio.formatTags({}, { height: 1080, fps: 50, codec: 'hvc1' });
        assert.ok(/1080p/.test(t) && /50 fps/.test(t), t);
        assert.ok(!/fps/.test(ctx.Stremio.formatTags({}, { height: 720 })));
    });

    await runTest('Live channel without sound or picture: first audio track, next copy, repack', async () => {
        const calls = []; let listener = null, streamInfo = [], trackInfo = [], liveOpens = 0;
        const avplay = {
            open: (u) => { calls.push('open:' + u); }, stop: () => {}, close: () => {}, setListener: (l) => { listener = l; },
            prepareAsync: (ok) => { ok(); }, play: () => {}, getState: () => 'PLAYING', getDuration: () => 0, getCurrentTime: () => 0,
            getTotalTrackInfo: () => trackInfo, getCurrentStreamInfo: () => streamInfo, setSelectTrack: (t, i) => { calls.push('select:' + t + ':' + i); },
            setDisplayRect: () => {}, setDisplayMethod: () => {}, setBufferingParam: () => {}, setStreamingProperty: () => {}, setSilentSubtitle: () => {},
            seekTo: () => {}, suspend: () => {}, restore: () => {}
        };
        const el = (id, tag) => { const cl = new Set(); return { id: id || '', tagName: tag || 'DIV', style: {}, className: '', textContent: '', children: [], parentNode: null,
            setAttribute: () => {}, getAttribute: () => null, contains: () => false, classList: { add: (c) => cl.add(c), remove: (c) => cl.delete(c), contains: (c) => cl.has(c), toggle: () => {} },
            appendChild: (c) => c, removeChild: (c) => c, insertBefore: (c) => c, addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [],
            getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }), focus: () => {}, play: () => Promise.resolve(), pause: () => {} }; };
        const byId = {}; const body = el('body', 'BODY');
        const base = loadBrowserScript('js/iptv.js');
        const U2 = Object.assign({}, base.U, { byId: (id) => byId[id] || (byId[id] = el(id)), el: (t) => el('', (t || 'div').toUpperCase()), clear: (n) => { n.children = []; },
            getText: () => Promise.resolve(''), getJSON: () => Promise.resolve(null), fmtTime: () => '0:00', whenVisible: () => {}, toast: () => {}, spinner: () => {},
            cancelToken: () => ({ cancelled: false, cancel() { this.cancelled = true; } }), loadScript: () => Promise.resolve(), deferImage: () => {}, cardImage: () => {}, crumb: () => {}, zoom: () => 1, fromUTF8: (b) => b, toUTF8: (x) => x, qrCanvas: () => {}, listOf: (x) => Array.isArray(x) ? x : [] });
        const ctx = loadBrowserScript(['js/stremio.js', 'js/player-core.js', 'js/player-store.js', 'js/player-lang.js', 'js/player-quality.js', 'js/player-subs.js',
            'js/player-audio.js', 'js/player-controls.js', 'js/player.js'], {
            Date, webapis: { avplay },
            YTPlay: { installMode: () => 'service', liveOpen: (u, h, a, o) => { if (o && o.fix) { liveOpens++; } return Promise.resolve({ url: 'http://localhost:8098/live/fixed.m3u8' }); } },
            U: U2, document: { body, documentElement: body, getElementById: (id) => byId[id] || (byId[id] = el(id)), createElement: U2.el, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {} }
        });
        ctx.Player.init();
        const P = ctx.PlayerParts, wait = () => new Promise((r) => setTimeout(r, 150));
        const nextOf = (base2) => (tried) => tried.length === 1 ? { source: { url: base2 + '.m3u8', stream: { url: base2 + '.m3u8' } }, total: 2 } : null;
        function play(id, base2) {
            ctx.Player.play({ url: base2 + '.ts', stream: { url: base2 + '.ts' }, type: 'tv', id, name: id, liveFallbacks: true, nextSource: nextOf(base2) });
        }
        const VIDEO = { type: 'VIDEO', index: 0, extra_info: JSON.stringify({ Width: 1920, Height: 1080, fourCC: 'h264' }) };
        const AUDIO = { type: 'AUDIO', index: 1, extra_info: JSON.stringify({ fourCC: 'aac', channels: 2 }) };
        // 1. a picture, no sound: the next copy
        trackInfo = [VIDEO]; streamInfo = [VIDEO];
        play('iptv:ch1', 'http://xt.example/live/u/p/301'); await wait();
        P.S.playing = true; P.S.playStarted = true; calls.length = 0;
        P.checkLiveAV(Date.now() + 6000); await wait();
        assert.ok(calls.indexOf('open:http://xt.example/live/u/p/301.m3u8') !== -1, 'no sound: the next copy (' + calls.join(', ') + ') ' + JSON.stringify({ av: P.S.ctx && P.S.ctx._av, lf: P.S.ctx && P.S.ctx.liveFallbacks, live: P.S.isLive, pref: ctx.Stremio.getPrefs().nextOnFail, tried: P.S.ctx && P.S.ctx._tried }));
        // 2. that one too, none left: the sound repacked by the service, once
        P.S.playing = true; P.S.playStarted = true; calls.length = 0;
        P.checkLiveAV(Date.now() + 6000); await wait();
        assert.strictEqual(liveOpens, 1, 'repacked once');
        assert.ok(calls.indexOf('open:http://localhost:8098/live/fixed.m3u8') !== -1, 'the repacked link opened');
        P.checkLiveAV(Date.now() + 6000); await wait();
        assert.strictEqual(liveOpens, 1, 'not again');
        // 3. a radio-like stream (no video track at all): left alone
        trackInfo = [AUDIO]; streamInfo = [AUDIO];
        play('iptv:ch2', 'http://xt.example/live/u/p/501'); await wait();
        P.S.playing = true; P.S.playStarted = true; calls.length = 0;
        P.checkLiveAV(Date.now() + 6000); await wait();
        assert.strictEqual(calls.length, 0, 'sound only, no video listed: nothing done');
        // 4. sound, a video track listed but no picture: the next copy
        trackInfo = [VIDEO, AUDIO]; streamInfo = [AUDIO];
        play('iptv:ch3', 'http://xt.example/live/u/p/401'); await wait();
        P.S.playing = true; P.S.playStarted = true; calls.length = 0;
        P.checkLiveAV(Date.now() + 6000); await wait();
        assert.ok(calls.indexOf('open:http://xt.example/live/u/p/401.m3u8') !== -1, 'no picture: the next copy');
        // 5. within the grace time after it started: nothing yet
        trackInfo = [VIDEO]; streamInfo = [VIDEO];
        play('iptv:ch4', 'http://xt.example/live/u/p/601'); await wait();
        P.S.playing = true; P.S.playStarted = true; calls.length = 0;
        P.checkLiveAV(Date.now()); await wait();
        assert.strictEqual(calls.length, 0, 'not within LIVE_AV_GRACE_MS');
        assert.strictEqual(P.parseFps('25000/1000'), 25); assert.strictEqual(P.parseFps('29.97'), 29.97); assert.strictEqual(P.parseFps('0'), 0);
        ctx.Player.exit();
    });

    console.log(`\n===========================\nSummary: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    if (failed > 0) { process.exit(1); }
}

module.exports = { loadService, loadBrowserScript, stripCode, scanES5, run };

if (require.main === module) { run(); }
