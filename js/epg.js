/* TV guide (XMLTV) for IPTV channels. Global namespace: EPG
   Which guide a playlist has (guideUrl: the Guide link you set, else the one the playlist
   names, else an Xtream playlist's own), read by StremioK's service for your channels only
   (their keys as a bitset: see service/index.js, epgControl), and the programs asked for as
   the cards, Home's details strip, the player and a channel's schedule need them. Not in a
   desktop browser (no service). */
var EPG = (function () {
    'use strict';

    // A channel's key, as the service makes it: "i:" and its tvg-id (iptv-org's feed after an @
    // left out: "ElTrece.ar@SD" is a guide's "ElTrece.ar"), or "n:" and its name without
    // capitals, accents, spaces, "TV" or HD / FHD / 4K tags ("El Trece HD": "n:eltrece"). A
    // country is taken out and kept apart: a tvg-id's ".ar", a name's " ARG" / " MX" at the end
    // or "TR:" / "|UK|" / "DE -" at the start (COUNTRY), so "TR: TRT 1 HD" is "trt1" in "tr".
    // A guide's channel answers with its key in its country (".tr", or ".~" when its guide names
    // none) and without one (guideKeys); a channel asks with its own country and ".~" when it
    // knows its country, else without one (keysOf). So a Turkish "FOX" never gets the guide of
    // an American "FOX.us", and a key two countries' channels share answers neither (the service
    // marks it unclear) rather than the first one listed.
    var ACCENTS = { 'á': 'a', 'à': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a', 'å': 'a', 'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e', 'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
        'ó': 'o', 'ò': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o', 'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u', 'ñ': 'n', 'ç': 'c' };
    var COUNTRY = { ar: 'ar', arg: 'ar', mx: 'mx', mex: 'mx', us: 'us', usa: 'us', uk: 'uk', gb: 'uk', gbr: 'uk', eng: 'uk', es: 'es', esp: 'es', br: 'br', cl: 'cl', co: 'co', pe: 'pe',
        uy: 'uy', py: 'py', ve: 've', ec: 'ec', bo: 'bo', ca: 'ca', fr: 'fr', fra: 'fr', de: 'de', ger: 'de', deu: 'de', it: 'it', ita: 'it', pt: 'pt', por: 'pt',
        tr: 'tr', tur: 'tr', nl: 'nl', ned: 'nl', nld: 'nl', be: 'be', bel: 'be', pl: 'pl', pol: 'pl', at: 'at', aut: 'at', ch: 'ch', se: 'se', swe: 'se',
        no: 'no', dk: 'dk', fi: 'fi', gr: 'gr', gre: 'gr', ro: 'ro', hu: 'hu', cz: 'cz', sk: 'sk', ru: 'ru', rus: 'ru', ua: 'ua', 'in': 'in', au: 'au', aus: 'au',
        ie: 'ie', irl: 'ie', al: 'al', rs: 'rs', hr: 'hr', ba: 'ba', bg: 'bg', si: 'si', il: 'il', ae: 'ae', sa: 'sa', eg: 'eg', ma: 'ma', za: 'za', nz: 'nz', ir: 'ir', irn: 'ir', pk: 'pk', pak: 'pk', bd: 'bd', cn: 'cn', chn: 'cn', 'do': 'do', afg: 'af', sw: 'se', jp: 'jp', kr: 'kr', ph: 'ph', th: 'th', vn: 'vn', my: 'my',
        id: 'id', lk: 'lk', np: 'np', qa: 'qa', kw: 'kw', iq: 'iq', jo: 'jo', lb: 'lb', sy: 'sy', ps: 'ps', om: 'om', bh: 'bh', ye: 'ye', tn: 'tn', dz: 'dz', ly: 'ly',
        ng: 'ng', gh: 'gh', ke: 'ke', mk: 'mk', me: 'me', xk: 'xk', lt: 'lt', lv: 'lv', ee: 'ee', is: 'is', lu: 'lu', cy: 'cy', mt: 'mt', cr: 'cr', gt: 'gt', hn: 'hn',
        sv: 'sv', ni: 'ni', pa: 'pa', pr: 'pr', jm: 'jm', tt: 'tt', cu: 'cu' };
    var SUFFIX_SKIP = { 'in': 1, at: 1, no: 1, be: 1, ba: 1, ma: 1, sa: 1, si: 1, por: 1, aus: 1, 'do': 1, is: 1, me: 1, my: 1, id: 1, pa: 1, pr: 1, sv: 1, ni: 1, om: 1, cu: 1, ke: 1, ye: 1, ps: 1, tt: 1, gt: 1, cr: 1, lb: 1, jo: 1, np: 1, sw: 1 };   // (words a name may end with: "Plug In"; only as a prefix, "IN: …")
    var NOT_CC = { hd: 1, sd: 1, tv: 1, fm: 1, hq: 1 };   // (a tvg-id's ".hd" isn't a country)
    var PREFIX = /^[\s|\[(\u2502\u2503]*([a-z]{2,3})(?:\s*[:|\])\u2502\u2503]+|\s+-+)\s*/;   // ("TR:", "|UK|", "[DE]", "NL -"; not "AL-Jazeera")
    function parts(kind, s) {
        var t = ('' + (s || '')).toLowerCase().replace(/[áàâäãåéèêëíìîïóòôöõúùûüñç]/g, function (c) { return ACCENTS[c]; }).trim(), cc = '', m;
        if (kind === 'i') { t = t.replace(/@.*$/, ''); }
        if (kind === 'n' && (m = PREFIX.exec(t)) && COUNTRY[m[1]] && t.length > m[0].length) { cc = COUNTRY[m[1]]; t = t.slice(m[0].length); }
        if ((m = /\.([a-z]{2})$/.exec(t)) && !NOT_CC[m[1]]) { cc = cc || COUNTRY[m[1]] || m[1]; t = t.slice(0, -3); }
        else if (kind === 'n' && (m = /[\s_-]+([a-z]{2,3})$/.exec(t)) && COUNTRY[m[1]] && !SUFFIX_SKIP[m[1]] && t.length > m[0].length) { cc = cc || COUNTRY[m[1]]; t = t.slice(0, -m[0].length); }
        if (kind === 'n') { t = t.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\b(hd|fhd|uhd|sd|hq|4k|8k|hevc|h265|1080p?|720p?|tv)\b/g, ' '); }
        t = t.replace(/[^a-z0-9]+/g, '');
        if (kind === 'n' && t.length > 4) { t = t.replace(/tv$/, ''); }   // ("CronicaTV")
        return { base: t.slice(0, 60), cc: cc };
    }
    function key(kind, s) { var p = parts(kind, s); return p.base ? kind + ':' + p.base + (p.cc ? '.' + p.cc : '') : ''; }
    // A guide's channel's keys (its id and display names), as the service makes them: each one
    // without a country and in the channel's (its id's, else a name's; ".~" when neither says).
    function guideKeys(id, names) {
        var ip = parts('i', id), np = (names || []).map(function (n) { return parts('n', n); }), cc = ip.cc, out = [];
        np.forEach(function (p) { if (!cc && p.cc) { cc = p.cc; } });
        function add(kind, p) { if (p.base) { out.push(kind + ':' + p.base, kind + ':' + p.base + '.' + (cc || '~')); } }
        add('i', ip);
        np.forEach(function (p) { add('n', p); });
        return { keys: out, cc: cc };
    }
    function hash(s) {
        var h = 0x811c9dc5;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
        return h;
    }
    // The keys as a bitset, base64url: 16 bits a key (1,024 to 1,048,576 in all); a key sets two
    // bits, its hash's and its "~"-hash's (bitPair), so a big playlist's set still lets few of a
    // guide's other channels through (one bit a key in 131,072: half of them got in).
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    function bitPair(k, n) { return [hash(k) % n, hash('~' + k) % n]; }
    function bitsFor(keys) {
        var n = 1024, bytes = [], i;
        while (n < keys.length * 16 && n < 1048576) { n *= 2; }
        for (i = 0; i < n / 8; i++) { bytes.push(0); }
        keys.forEach(function (k) { if (k) { bitPair(k, n).forEach(function (b) { bytes[b >> 3] |= 1 << (b & 7); }); } });
        var out = '';
        for (i = 0; i < bytes.length; i += 3) {
            var v = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
            out += B64.charAt((v >> 18) & 63) + B64.charAt((v >> 12) & 63) + (i + 1 < bytes.length ? B64.charAt((v >> 6) & 63) : '') + (i + 2 < bytes.length ? B64.charAt(v & 63) : '');
        }
        return out;
    }
    // A channel's copies: a tidied channel's merged variants (each from its own playlist, with its
    // own tvg-id and the name the playlist gave it), else the channel itself.
    function membersOf(c) { return (c && Array.isArray(c.variants) && c.variants.length) ? c.variants : [c]; }
    // Its country: a copy's tvg-id's (".tr"), else a copy's name's ("TR: …", "… MX"), else the
    // one the cleaner found (its group's: "TURKEY ➾ …"; not its "AR", Arabic, not Argentina).
    // (a group's region or language, not a country: "AR" Arabic, "AM | Canada" Americas, "AS |
    // Pakistan" Asia, "AF" Africa, "KU" Kurdish)
    var REGION = { ar: 1, am: 1, as: 1, af: 1, eu: 1, ww: 1, ku: 1 };
    function countryOf(c) {
        var ms = membersOf(c), i, cc = '';
        for (i = 0; i < ms.length && !cc; i++) { if (ms[i].tvgId) { cc = parts('i', ms[i].tvgId).cc; } }
        for (i = 0; i < ms.length && !cc; i++) { cc = parts('n', ms[i].rawName || ms[i]._rawName || '').cc; }
        var tidy = ('' + ((c && c._country) || (ms[0] && ms[0].country) || '')).toLowerCase();
        if (!cc && tidy && !REGION[tidy]) { cc = COUNTRY[tidy] || (/^[a-z]{2}$/.test(tidy) ? tidy : ''); }
        return cc;
    }
    // Its keys in a guide: every copy's tvg-id and playlist name (the guide knows those, not the
    // tidied name), then its name as shown; in its country, then in a guide that names none
    // (".~"); without a country only when it has none.
    function keysOf(c) {
        var bases = [], seen = {}, cc = countryOf(c);
        function add(kind, s) { var p = parts(kind, s), b = p.base && kind + ':' + p.base; if (b && !seen[b]) { seen[b] = 1; bases.push(b); } }
        membersOf(c).forEach(function (m) { if (m.tvgId) { add('i', m.tvgId); } add('n', m.rawName || m._rawName || ''); });
        add('n', c.name);
        if (!cc) { return bases; }
        return bases.map(function (b) { return b + '.' + cc; }).concat(bases.map(function (b) { return b + '.~'; }));
    }

    // A playlist's guide: yours (p.guide), else the first the playlist names (url-tvg), else an
    // Xtream get.php link's xmltv.php (the same login; also in place of a guide the playlist
    // names on its own server without the login). '' when none.
    function param(q, name) {
        var m = new RegExp('(?:^|&)' + name + '=([^&#]*)').exec(q || '');
        if (!m) { return ''; }
        try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return ''; }
    }
    function guideUrl(p, named) {
        if (p && p.guide) { return p.guide; }
        var g = (named || []).filter(function (u) { return !!U.parseUrl(u) && /^https?:\/\//i.test(u); })[0];
        var u = U.parseUrl(p && p.url), xt = '';
        if (u && /\/get\.php$/i.test(u.path)) {
            var user = param(u.query, 'username'), pass = param(u.query, 'password');
            if (user && pass) { xt = u.scheme + '://' + u.host + (u.port ? ':' + u.port : '') + u.path.replace(/get\.php$/i, 'xmltv.php') + '?username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass); }
        }
        var gu = g && U.parseUrl(g);
        if (g && xt && gu && gu.host === u.host && gu.port === u.port && !param(gu.query, 'username')) { return xt; }   // (its own server's, without the login)
        return g || xt;
    }

    // Extra guides: free ones per country (epgshare01, updated daily), read by the service after a
    // playlist's own for the channels it gives no programs (see service/index.js, epgSources), for
    // the countries a playlist has EXTRA_MIN channels of. Settings › IPTV › Extra TV guides: on
    // (automatic, the default) or off.
    var EXTRA_BASE = 'https://epgshare01.online/epgshare01/epg_ripper_', EXTRA_MIN = 10;
    var EXTRA = { tr: ['TR1', 'TR3'], uk: ['UK1'], us: ['US2', 'US_SPORTS1'] };
    var EXTRA_KEY = 'stremiok.iptv.extraguides';
    function extraGuides() { return U.store.get(EXTRA_KEY, 'auto') !== 'off'; }
    function setExtraGuides(on) { U.store.set(EXTRA_KEY, on ? 'auto' : 'off'); }
    function extrasFor(chans) {
        if (!extraGuides()) { return []; }
        var n = {}, out = [];
        chans.forEach(function (c) { var cc = countryOf(c); if (EXTRA[cc]) { n[cc] = (n[cc] || 0) + 1; } });
        Object.keys(EXTRA).forEach(function (cc) { if (n[cc] >= EXTRA_MIN) { EXTRA[cc].forEach(function (f) { out.push(EXTRA_BASE + f + '.xml.gz'); }); } });
        return out;
    }
    // A guide's link with its extra ones after "#extra=" (never sent: a link's part after # stays
    // here), or the first extra one's when the playlist has no guide of its own.
    function withExtras(url, extras) {
        if (!extras.length) { return url; }
        if (!url) { url = extras[0]; extras = extras.slice(1); if (!extras.length) { return url; } }
        return url + '#extra=' + encodeURIComponent(extras.join('|'));
    }

    function available() { return typeof YTPlay !== 'undefined' && !!YTPlay.epgLoad && YTPlay.installMode() !== 'browser'; }

    // ---- the guides: asked to read, then waited for ----
    var _guides = {};    // url -> { k, state, at, channels, programmes, partial, error, timer }
    var _byList = {};    // playlist id -> its guide's url ('' none)
    var POLL_MS = [300, 300, 600, 1000, 2000], POLL_MS_LATER = 3000, POLLS = 300, CHECK_MS = 60 * 60 * 1000;
    // Every playlist's guide asked for (again: the service reads one only when it's old), for
    // its channels' keys. After the playlists are read, and every hour. again: a playlist's id,
    // or true for all (its Reload, IPTV.reload): their guides read again now, however new.
    function start(again) {
        if (!available() || typeof IPTV === 'undefined' || !IPTV.channels) { return; }
        var byGuide = {}, force = {};
        _byList = {};
        var perList = {};   // (each playlist's channels: their countries pick its extra guides)
        IPTV.channels().forEach(function (c) { membersOf(c).forEach(function (m) { (perList[m._playlistId] = perList[m._playlistId] || []).push(c); }); });
        IPTV.getPlaylists().forEach(function (p) {
            if (p.off) { return; }
            var st = IPTV.status(p.id), url = withExtras(guideUrl(p, st && st.guides), extrasFor(perList[p.id] || []));
            _byList[p.id] = url;
            if (url && !byGuide[url]) { byGuide[url] = []; }
            if (url && (again === true || again === p.id)) { force[url] = true; }
        });
        IPTV.channels().forEach(function (c) {   // (each copy's playlist's guide asked for the channel)
            var ks = keysOf(c), asked = {};
            membersOf(c).forEach(function (m) {
                var url = _byList[m._playlistId];
                if (url && !asked[url]) { asked[url] = 1; byGuide[url].push.apply(byGuide[url], ks); }
            });
        });
        var gone = false;
        Object.keys(_guides).forEach(function (url) {   // (a guide no playlist uses any more: dropped)
            if (byGuide[url]) { return; }
            if (_guides[url].timer) { clearTimeout(_guides[url].timer); }
            delete _guides[url];
            forget(url);
            gone = true;
        });
        Object.keys(byGuide).forEach(function (url) { if (byGuide[url].length) { loadGuide(url, bitsFor(byGuide[url]), !!force[url]); } });
        if (!_checker) { _checker = setInterval(function () { start(); }, CHECK_MS); }
        if (gone) { changed(); }
    }
    var _checker = null;
    function loadGuide(url, k, force) {
        var g = _guides[url];
        if (!g || g.k !== k || force) { if (g && g.timer) { clearTimeout(g.timer); } g = _guides[url] = { k: k, state: 'loading' }; }
        else if (g.timer || g.asking) { return; }
        (function ask(n) {
            g.asking = true;
            YTPlay.epgLoad(url, k, force && !n).then(function (r) {
                g.asking = false;
                if (_guides[url] !== g) { return; }
                var was = g.state + '|' + g.at;
                ['state', 'at', 'channels', 'programmes', 'partial', 'error'].forEach(function (f) { g[f] = r && r[f]; });
                if (g.state === 'loading' && n < POLLS) { g.timer = setTimeout(function () { g.timer = null; ask(n + 1); }, n < POLL_MS.length ? POLL_MS[n] : POLL_MS_LATER); }
                if (g.state + '|' + g.at !== was) {
                    if (g.state === 'ready') { _gen++; forget(url); }   // (read again: what's on, and the Guide tab's grid, asked again)
                    changed();
                }
            }, function () {
                g.asking = false;
                if (_guides[url] !== g) { return; }
                g.state = 'failed'; g.error = U.t('StremioK’s service didn’t answer');
                changed();
            });
        })(0);
    }
    // For Settings › IPTV: a playlist's guide and how it stands, or null when it has none.
    function status(playlistId) {
        var url = _byList[playlistId];
        if (!url) { return null; }
        var g = _guides[url] || { state: 'loading' };
        return { url: url, state: g.state, at: g.at || 0, channels: g.channels || 0, programmes: g.programmes || 0, partial: !!g.partial, error: g.error || '' };
    }

    // ---- programs: asked for in batches, kept per channel ----
    var _progs = {};     // channel id -> { at, list: [{ start, stop, title, desc }], full (the whole window) }
    var _icons = {};     // channel id -> its guide's logo (for one the playlist gives none: logo)
    var _want = {}, _wantTimer = null, _asking = 0, BATCH = 60, PROG_MS = 30 * 60 * 1000;
    function channelOf(id) { return (typeof IPTV !== 'undefined' && IPTV.channel) ? IPTV.channel(id) : null; }
    // The guide a channel's programs come from: its first copy's playlist with a guide read.
    function guideOf(c) {
        if (!c) { return ''; }
        var ms = membersOf(c);
        for (var i = 0; i < ms.length; i++) { var url = _byList[ms[i]._playlistId], g = url && _guides[url]; if (g && g.state === 'ready') { return url; } }
        return '';
    }
    function forget(url) { Object.keys(_progs).forEach(function (id) { if (_progs[id].url === url) { delete _progs[id]; } }); }
    function want(ids) {
        (ids || []).forEach(function (id) { if (/^iptv:/.test(id || '')) { _want[id] = 1; } });
        if (!_wantTimer) { _wantTimer = setTimeout(flush, 50); }
    }
    function nowSec() { return Math.floor(Date.now() / 1000); }
    function asList(rows, url) {
        return (rows || []).filter(function (r) { return r && r.length >= 3 && r[1] > r[0]; })
            .map(function (r) {
                var p = { start: +r[0], stop: +r[1], title: '' + r[2], desc: '' + (r[3] || ''), picture: (typeof r[4] === 'string' && U.parseUrl(r[4]) && !(U.urlIsPrivate(r[4]) && !U.urlIsPrivate(url || ''))) ? r[4] : '' };   // (no picture into your home network from a guide on the internet)
                var a = r[5];   // (what it is, from the guide's categories: a film's original title and year)
                if (a && typeof a === 'object') {
                    if (a.m === 'movie' || a.m === 'series') { p.kind = a.m; }
                    if (typeof a.o === 'string' && a.o) { p.orig = a.o.slice(0, 120); }
                    if (+a.y >= 1900 && +a.y <= 2100) { p.year = +a.y; }
                }
                return p;
            });
    }
    // One request a guide at a time per batch (BATCH channels): from now, the next few.
    function flush() {
        _wantTimer = null;
        if (_asking) { _wantTimer = setTimeout(flush, 200); return; }
        var byGuide = {};
        Object.keys(_want).forEach(function (id) {
            var c = channelOf(id), url = guideOf(c);
            if (!url) { return; }   // (no guide, or not read yet: asked again once it is)
            delete _want[id];
            if (fresh(id)) { return; }
            (byGuide[url] = byGuide[url] || []).push(c);
        });
        Object.keys(byGuide).forEach(function (url) {
            var list = byGuide[url];
            for (var i = 0; i < list.length; i += BATCH) { ask(url, list.slice(i, i + BATCH), nowSec(), nowSec() + 6 * 3600, 4, false); }
        });
    }
    function ask(url, chans, from, to, max, full) {
        var keys = [], gen = _gen;
        chans.forEach(function (c) { keys.push.apply(keys, keysOf(c)); });
        _asking++;
        // Resolves { id: programs } for the channels answered ([] when none, or not in the guide),
        // and _unknown: the ids not answered (failed, cut off, not read there, or the guides
        // changed since): kept as they were and asked again, never taken as empty.
        function unknown() { var o = {}; o._unknown = chans.map(function (c) { return c.id; }); return o; }
        return YTPlay.epgGet(url, keys, from, to, max).then(function (r) {
            _asking--;
            if (gen !== _gen || !r || typeof r !== 'object' || r._unread) { return unknown(); }   // (the guides changed since, or no answer to read)
            var cut = {};
            (Array.isArray(r._cut) ? r._cut : []).forEach(function (k) { cut[k] = 1; });
            var out = {}, icons = (r._icons && typeof r._icons === 'object') ? r._icons : {};
            var unk = [];
            chans.forEach(function (c) {
                if (guideOf(c) !== url) { unk.push(c.id); return; }   // (its guide is another now)
                var ks = keysOf(c), rows = null;
                for (var i = 0; i < ks.length && !rows; i++) { if (Array.isArray(r[ks[i]])) { rows = r[ks[i]]; } }
                if (!rows && ks.some(function (k) { return cut[k]; })) { unk.push(c.id); return; }   // (cut off: not answered)
                for (var j = 0; j < ks.length; j++) {
                    var icon = icons[ks[j]];
                    // (a guide on the internet can't point one into your home network)
                    if (typeof icon === 'string' && U.parseUrl(icon) && !(U.urlIsPrivate(icon) && !U.urlIsPrivate(url))) { _icons[c.id] = icon; break; }
                }
                var e = { at: Date.now(), url: url, list: asList(rows, url), full: full };
                if (!full && _progs[c.id] && _progs[c.id].full && _progs[c.id].at > Date.now() - PROG_MS) { return; }   // (a whole schedule kept)
                _progs[c.id] = e;
                out[c.id] = e.list;
            });
            trimProgs();
            if (unk.length) { out._unknown = unk; }
            changed();
            return out;
        }, function () { _asking--; return unknown(); });
    }
    // Programs kept for PROGS_KEEP channels at most (the ones read longest ago go first): a long
    // session going through thousands of channels doesn't keep them all.
    var PROGS_KEEP = 400;
    function trimProgs() {
        var ids = Object.keys(_progs);
        if (ids.length <= PROGS_KEEP) { return; }
        ids.sort(function (a, b) { return _progs[a].at - _progs[b].at; }).slice(0, ids.length - PROGS_KEEP).forEach(function (id) { delete _progs[id]; });
    }
    function fresh(id) {
        var e = _progs[id];
        if (!e || Date.now() - e.at > PROG_MS) { return false; }
        var t = nowSec();
        return !e.list.length || e.list[e.list.length - 1].stop > t;   // (what's on, still in what was read)
    }
    // What's on now, and next: { now, next } (either may be null), or null without a guide.
    function now(id) {
        var c = channelOf(id);
        if (!c || !guideOf(c)) { return null; }
        if (!fresh(id)) { want([id]); }
        var e = _progs[id];
        if (!e || e.url !== guideOf(c)) { return null; }
        var t = nowSec(), cur = null, next = null;
        for (var i = 0; i < e.list.length; i++) {
            var p = e.list[i];
            if (!cur && p.start <= t && t < p.stop) { cur = p; continue; }
            if (p.start > t && (!next || p.start < next.start)) { next = p; break; }
        }
        return (cur || next) ? { now: cur, next: next } : null;
    }
    // A channel's schedule, from 2 hours ago to tomorrow: Promise of [{ start, stop, title, desc }].
    function schedule(id) {
        var c = channelOf(id), url = guideOf(c);
        if (!url) { return Promise.resolve([]); }
        return ask(url, [c], nowSec() - 2 * 3600, nowSec() + 30 * 3600, 150, true).then(function (out) { return out[id] || []; });
    }
    function hasGuide(id) { return !!guideOf(channelOf(id)); }
    // A channel's logo from its guide ('' when it gave none, or not asked yet).
    function logo(id) { return _icons[id] || ''; }
    // Whether any guide was read with channels in it (the Guide tab shows then), and the channels
    // that have a guide, in the IPTV tab's order.
    function hasAny() {
        return Object.keys(_byList).some(function (id) { var g = _guides[_byList[id]]; return !!g && g.state === 'ready' && g.channels > 0; });
    }
    function guided() {   // (your favorites first)
        var all = (typeof IPTV !== 'undefined' && IPTV.channels ? IPTV.channels() : []).filter(function (c) { return !!guideOf(c); });
        var fav = IPTV.isFavorite ? all.filter(function (c) { return IPTV.isFavorite(c.id); }) : [];
        return fav.concat(all.filter(function (c) { return fav.indexOf(c) === -1; }));
    }
    // Many channels' programs from 'from' to 'to' (the Guide tab): Promise of { id: programs },
    // RANGE_BATCH channels a request (each answer kept to 2 MB by the service: 150 programs
    // a channel with their pictures and descriptions fit).
    var RANGE_BATCH = 20;
    function range(ids, from, to) {
        var byGuide = {}, jobs = [];
        (ids || []).forEach(function (id) { var c = channelOf(id), url = guideOf(c); if (url) { (byGuide[url] = byGuide[url] || []).push(c); } });
        Object.keys(byGuide).forEach(function (url) {
            var list = byGuide[url];
            for (var i = 0; i < list.length; i += RANGE_BATCH) { jobs.push(ask(url, list.slice(i, i + RANGE_BATCH), Math.floor(from), Math.ceil(to), 150, true)); }
        });
        return Promise.all(jobs).then(function (outs) {
            var all = {}, unknown = [];
            outs.forEach(function (o) { Object.keys(o || {}).forEach(function (id) { if (id === '_unknown') { unknown = unknown.concat(o._unknown); } else { all[id] = o[id]; } }); });
            if (unknown.length) { all._unknown = unknown; }   // (not answered: see ask)
            return all;
        });
    }

    // Diagnostics › TV guide matches: for every channel, the guide's channel it got and what's on
    // it now, or why none. Promise of { rows: [{ c, state, guide, gid, key, now }], guides: [{
    // host, state, channels, partial }] }; state: 'ok', 'empty' (in the guide, nothing on now),
    // 'unclear' (its name is two countries' channels'), 'none' (not in its guide), 'noguide'
    // (its playlist has none read), 'failed' (not answered).
    function matchReport() {
        if (!available() || typeof IPTV === 'undefined' || !IPTV.channels) { return Promise.resolve({ rows: [], guides: [] }); }
        var rows = [], byGuide = {}, jobs = [], t = nowSec();
        function host(url) { var u = U.parseUrl(url); return u ? u.host : '?'; }   // (never the link: an Xtream guide's has the login)
        // (an extra guide's channel, "x2:…": that guide's file, "epgshare01 TR1")
        function source(url, gid) {
            var m = /^x(\d+):/.exec(gid || ''), i = url.indexOf('#extra=');
            if (!m || i === -1) { return host(url.split('#')[0]); }
            var x = '';
            try { x = decodeURIComponent(url.slice(i + 7)).split('|')[+m[1] - 1] || ''; } catch (e) {}
            var f = /epg_ripper_([A-Z0-9_]+)\.xml/.exec(x);
            return f ? 'epgshare01 ' + f[1] : host(x);
        }
        IPTV.channels().forEach(function (c) {
            var url = guideOf(c);
            if (!url) { rows.push({ c: c, state: 'noguide' }); return; }
            (byGuide[url] = byGuide[url] || []).push(c);
        });
        Object.keys(byGuide).forEach(function (url) {
            var list = byGuide[url];
            for (var i = 0; i < list.length; i += BATCH) {
                jobs.push((function (chans) {
                    var keys = [];
                    chans.forEach(function (c) { keys.push.apply(keys, keysOf(c)); });
                    return YTPlay.epgGet(url, keys, t - 60, t + 60, 1, true).then(function (r) {
                        var ids = (r && r._ids) || {}, amb = {};
                        ((r && r._amb) || []).forEach(function (k) { amb[k] = 1; });
                        chans.forEach(function (c) {
                            var ks = keysOf(c), hit = '';
                            for (var j = 0; j < ks.length && !hit; j++) { if (ids[ks[j]]) { hit = ks[j]; } }
                            var row = { c: c, guide: host(url), state: 'none' };
                            if (hit) {
                                var l = Array.isArray(r[hit]) ? r[hit] : [];
                                row.state = l.length ? 'ok' : 'empty'; row.gid = ids[hit]; row.key = hit; row.guide = source(url, ids[hit]); row.now = l.length ? '' + (l[0][2] || '') : '';
                            } else if (ks.some(function (k) { return amb[k]; })) { row.state = 'unclear'; }
                            else if (!r || r._unread || (r._cut || []).length) { row.state = 'failed'; }
                            rows.push(row);
                        });
                    }, function () { chans.forEach(function (c) { rows.push({ c: c, guide: host(url), state: 'failed' }); }); });
                })(list.slice(i, i + BATCH)));
            }
        });
        return Promise.all(jobs).then(function () {
            var guides = Object.keys(_guides).map(function (url) { var g = _guides[url]; return { host: host(url.split('#')[0]) + (url.indexOf('#extra=') !== -1 ? ' + extra guides' : ''), state: g.state, channels: g.channels || 0, partial: !!g.partial }; });
            return { rows: rows, guides: guides };
        });
    }

    // 20:30, or with the day when it isn't today (Tue 01:00).
    function two(n) { return (n < 10 ? '0' : '') + n; }
    function hhmm(sec) { var d = new Date(sec * 1000); return two(d.getHours()) + ':' + two(d.getMinutes()); }
    function dayTime(sec) {
        var d = new Date(sec * 1000), today = new Date(Date.now());
        var same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
        return (same ? '' : U.weekday(d.getDay()) + ' ') + hhmm(sec);
    }

    // Told when a guide is read or programs arrive (once for a burst).
    var _fns = [], _changeTimer = null;
    function onChange(fn) { _fns.push(fn); }
    function changed() {
        if (_changeTimer) { return; }
        _changeTimer = setTimeout(function () {
            _changeTimer = null;
            if (Object.keys(_want).length && !_wantTimer) { _wantTimer = setTimeout(flush, 50); }   // (asked before the guide was read)
            _fns.forEach(function (fn) { try { fn(); } catch (e) {} });
        }, 60);
    }
    // The guide links changed (a playlist's Guide link, its link, its channels): asked again.
    // An answer asked before (an older _gen) is dropped when it comes.
    var _gen = 0;
    function reset() { _gen++; _progs = {}; _icons = {}; _want = {}; start(); }

    return {
        generation: function () { return _gen; },   // (changes when the guides do: what was read before isn't theirs)
        key: key, guideKeys: guideKeys, extraGuides: extraGuides, setExtraGuides: setExtraGuides, extrasFor: extrasFor, withExtras: withExtras, matchReport: matchReport, keysOf: keysOf, countryOf: countryOf, bitsFor: bitsFor, guideUrl: guideUrl, available: available, start: start, reset: reset, status: status,
        want: want, now: now, schedule: schedule, hasGuide: hasGuide, logo: logo, hasAny: hasAny, guided: guided, range: range, onChange: onChange, hhmm: hhmm, dayTime: dayTime
    };
})();
