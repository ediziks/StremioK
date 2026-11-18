#!/usr/bin/env node
'use strict';
// StremioK on the TV, through its inspector (tools/tv.sh debug forwards it): development only.
//   node tools/tv-cdp.js eval '<expression>'   run it in the app (promises awaited), print the result
//   node tools/tv-cdp.js console [seconds]     print the app's console and errors (default 60 s)
// INSPECT_PORT (default 9222). Logins in links (user=, password=, Xtream /live/u/p/) are masked.
const PORT = +process.env.INSPECT_PORT || 9222;

function mask(s) {
    return String(s)
        .replace(/((?:user(?:name)?|pass(?:word)?|token|key)=)[^&\s"']+/gi, '$1***')
        .replace(/\/(live|movie|series|timeshift)\/[^/\s"']+\/[^/\s"']+\//gi, '/$1/***/***/');
}
async function target() {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || list.find((t) => t.webSocketDebuggerUrl);
    if (!page) { throw new Error('no inspectable page (run tools/tv.sh debug first)'); }
    return page.webSocketDebuggerUrl;
}
function open(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        let id = 0;
        const waiting = new Map();
        ws.onopen = () => resolve({
            ws,
            send(method, params) { const n = ++id; ws.send(JSON.stringify({ id: n, method, params: params || {} })); return new Promise((r) => waiting.set(n, r)); },
            on: null
        });
        ws.onerror = (e) => reject(new Error('inspector: ' + (e.message || 'connection failed')));
        ws.onmessage = (m) => {
            const msg = JSON.parse(m.data);
            if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); return; }
            if (open.onEvent) { open.onEvent(msg); }
        };
    });
}
function show(v) { return mask(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); }

(async () => {
    const [cmd, arg] = process.argv.slice(2);
    const c = await open(await target());
    if (cmd === 'eval' && arg) {
        const r = await c.send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true, timeout: 60000 });
        const res = r.result || {};
        if (res.exceptionDetails) { console.error(show(res.exceptionDetails.exception ? res.exceptionDetails.exception.description : res.exceptionDetails.text)); process.exitCode = 1; }
        else { console.log(show(res.result ? (res.result.value !== undefined ? res.result.value : res.result.description) : r)); }
    } else if (cmd === 'console') {
        open.onEvent = (msg) => {
            const p = msg.params || {};
            if (msg.method === 'Runtime.consoleAPICalled') { console.log('[' + p.type + '] ' + show(p.args.map((a) => a.value !== undefined ? a.value : a.description).join(' '))); }
            else if (msg.method === 'Runtime.exceptionThrown') { console.log('[exception] ' + show(p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text)); }
            else if (msg.method === 'Log.entryAdded') { console.log('[' + p.entry.level + '] ' + show(p.entry.text + (p.entry.url ? ' ' + p.entry.url : ''))); }
        };
        await c.send('Runtime.enable'); await c.send('Log.enable');
        await new Promise((r) => setTimeout(r, (+arg || 60) * 1000));
    } else {
        console.log('usage: node tools/tv-cdp.js eval \'<expression>\' | console [seconds]');
        process.exitCode = 1;
    }
    c.ws.close();
})().catch((e) => { console.error(mask(e.message)); process.exit(1); });
