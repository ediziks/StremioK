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
        log: function () {},
        problem: function (e) { return (e && e.message) || String(e); },
        parseUrl: function (u) {
            try { return new URL(u); } catch (e) { return null; }
        },
        sanitizeHeaders: function (h) { return h || {}; },
        t: function (s) { return s; },
        tn: function (s) { return s; },
        settleAll: function (promises) {
            return Promise.all((promises || []).map(function (p) {
                return Promise.resolve(p).then(
                    function (v) { return { status: 'fulfilled', value: v }; },
                    function (e) { return { status: 'rejected', reason: e }; }
                );
            }));
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

function run() {
    console.log('=== StremioK Test Suite ===\n');

    let passed = 0;
    let failed = 0;

    function runTest(name, fn) {
        try {
            fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (err) {
            console.log(`[FAIL] ${name}: ${err.message}`);
            failed++;
        }
    }

    // 1. ES5 syntax & vm.Script guard
    runTest('ES5 syntax guard (scan js/*.js & service/*.js)', () => {
        const { files, errors } = scanES5();
        if (errors.length > 0) {
            const details = errors.map(e => `  ${e.file}:${e.line} - ${e.reason}`).join('\n');
            assert.fail(`ES5 violations found in ${errors.length} locations:\n${details}`);
        }
        assert.ok(files.length > 0, 'No files were scanned');
    });

    // 2. Placeholder unit tests (failing with 'not implemented' until implemented in Tasks 2-5)
    runTest('xtLiveUrl (Xtream Live URL builder)', () => {
        assert.fail('not implemented');
    });

    runTest('catchupUrl (Xtream Catch-Up URL formatter)', () => {
        assert.fail('not implemented');
    });

    runTest('m3uStreamParser (Streaming chunked M3U parser)', () => {
        assert.fail('not implemented');
    });

    runTest('escHtml (Phone QR group name HTML escaping)', () => {
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
