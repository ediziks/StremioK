/* IPTV / M3U support. Global namespace: IPTV
   Parses user-supplied M3U playlists into Stremio-shaped `tv` / `radio` catalogs, so the
   rest of the app (home rows, search, detail, player) treats live channels exactly
   like any other addon's content. Exposed to Stremio as a local synthetic addon
   (see synthAddon()); Stremio.loadAddons / getCatalog / getMeta / getStreams route
   `iptv:` ids here instead of over HTTP.

   Direct HTTP(S) streams play through AVPlay. YouTube channels are tagged `_yt` and
   handed to YTPlay's native-HLS resolver at playback time. */
var IPTV = (function () {
    'use strict';

    var PLAYLISTS_KEY = 'stremiok.iptv.playlists';
    var CACHE_PREFIX = 'stremiok.iptv.cache.';       // one key per playlist id
    var PREFS_KEY = 'stremiok.prefs';                // canonical Settings prefs key shared with Stremio.getPrefs()
    var _cache = null;        // active view { ts, channels, groups, byId, byGroup, catalogs }
    var _rawChannels = null;  // raw merged playlist list before tidying/collapsing (enables instant Tidy <-> Raw toggle)
    // A playlist is downloaded up to playlistMax() and kept to maxChannels() channels: bigger
    // ones would exhaust an older TV's memory (both show in Settings > IPTV when they apply).
    // Settings › Content › IPTV › Largest playlist: 20 MB (30,000 channels) unless raised, the
    // channels in step (1,500 per MB), the download given longer (15 s per 20 MB).
    var SIZE_KEY = 'stremiok.iptv.size', SIZES = [20, 40, 60, 100], CHANNELS_PER_MB = 1500;
    function sizeMb() { var n = +U.store.get(SIZE_KEY, 20); return SIZES.indexOf(n) !== -1 ? n : 20; }
    function setSizeMb(n) { n = +n; if (SIZES.indexOf(n) === -1 || n === 20) { U.store.remove(SIZE_KEY); } else { U.store.set(SIZE_KEY, n); } }
    function playlistMax() { return sizeMb() * 1024 * 1024; }
    function maxChannels() { return sizeMb() * CHANNELS_PER_MB; }
    var _status = {};    // playlist id -> { url, count, groups, error, uncached, title, fetchedAt, stale }
    var NAME_MAX = 60;

    function cleanUrl(u) { return ('' + (u || '')).trim(); }

    function getPlaylists() {
        var saved = U.store.get(PLAYLISTS_KEY, []) || [];
        if (!Array.isArray(saved)) { saved = []; }
        return saved.filter(function (p) { return p && p.id && cleanUrl(p.url); })
            .map(function (p) {
                var o = { id: '' + p.id, url: cleanUrl(p.url) };
                if (typeof p.name === 'string' && p.name.trim()) { o.name = p.name.trim().slice(0, NAME_MAX); }
                if (p.off === true) { o.off = true; }
                if (typeof p.guide === 'string' && U.parseUrl(p.guide)) { o.guide = p.guide; }   // (its TV guide, yours: see EPG.guideUrl)
                if (macOf(p.mac)) { o.mac = macOf(p.mac); }   // (a Stalker portal: see addStalker)
                if (o.mac && Array.isArray(p.genres) && p.genres.length) { o.genres = p.genres; }   // (only those read: see setStalkerGroups)
                if (p.xtream === true || isXtream(o.url)) { o.xtream = true; }
                if (Array.isArray(p.groups)) {
                    var grps = p.groups.map(function (g) { return String(g || '').trim(); }).filter(Boolean);
                    if (grps.length) { o.groups = grps; }
                }
                if (p.noVod === true) { o.noVod = true; }
                if (p.archiveOffset !== undefined && p.archiveOffset !== null && p.archiveOffset !== '') {
                    var ao = Math.round(+p.archiveOffset);
                    if (isFinite(ao) && ao >= -12 && ao <= 14 && ao !== 0) { o.archiveOffset = ao; }
                }
                return o;
            });
    }

    // keepChannels: only a name changed (the channels read stay as they are).
    function savePlaylists(list, keepChannels) {
        U.store.set(PLAYLISTS_KEY, list);
        _sources = null;
        if (!keepChannels) { reset(); }
    }
    function find(list, id) {
        for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return i; } }
        return -1;
    }

    // What a playlist is called: its name (its file's when added, or yours), else the one in
    // the playlist (#PLAYLIST: / playlist-name="…"), else its server's address.
    function label(p) {
        if (!p) { return ''; }
        if (p.name) { return p.name; }
        var st = _status[p.id];
        if (st && st.title) { return st.title; }
        var u = U.parseUrl(p.url);
        return u ? u.host : U.t('Playlist');
    }
    function labelOf(id) { var list = getPlaylists(), i = find(list, id); return i === -1 ? '' : label(list[i]); }
    // Your name for it ('' puts back the playlist's own / its server's).
    function renamePlaylist(id, name) {
        var list = getPlaylists(), i = find(list, id);
        if (i === -1) { return false; }
        name = ('' + (name || '')).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
        if (name) { list[i].name = name; } else { delete list[i].name; }
        savePlaylists(list, true);
        return true;
    }
    // Its TV guide: a link of yours (an XMLTV file), or '' for the one it names / an Xtream
    // playlist's own (EPG.guideUrl). false: not a link.
    function setPlaylistGuide(id, url) {
        var list = getPlaylists(), i = find(list, id);
        url = ('' + (url || '')).trim();
        if (i === -1 || (url && !checkedUrl(url))) { return false; }
        if (url) { list[i].guide = checkedUrl(url); } else { delete list[i].guide; }
        savePlaylists(list, true);
        if (typeof EPG !== 'undefined' && EPG.reset) { EPG.reset(); }
        return true;
    }
    // Off: kept (with its saved copy), but its channels aren't read or shown.
    function setPlaylistOff(id, off) {
        var list = getPlaylists(), i = find(list, id);
        if (i === -1) { return false; }
        if (off) { list[i].off = true; } else { delete list[i].off; }
        savePlaylists(list);
        return true;
    }
    // Up (-1) or down (1): a channel in two playlists comes from the first, and rows are
    // in playlist order.
    function movePlaylist(id, dir) {
        var list = getPlaylists();
        if (!U.moveIn(list, find(list, id), dir)) { return false; }   // (one place, or to the top / bottom)
        savePlaylists(list);
        return true;
    }

    function newId() {
        return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
    }

    // A playlist URL as typed / imported: U.parseUrl's (http(s), no user:password@), else ''.
    // (Saved playlists aren't re-checked: getPlaylists only trims them.)
    function checkedUrl(u) { var p = U.parseUrl(u); return p ? p.href : ''; }
    // A playlist's file name without its extension ("…/sports.m3u8?token=…": "sports"), or ''
    // (a link without one, like an Xtream get.php: named as before, see label).
    function fileName(url) {
        var m = ('' + url).replace(/[?#].*$/, '').match(/\/([^\/]+)\.m3u8?$/i);
        if (!m) { return ''; }
        var n = m[1];
        try { n = decodeURIComponent(n); } catch (e) {}
        return n.replace(/\s+/g, ' ').trim();
    }
    // A name no other playlist goes by, capitals or not: "(2)", "(3)"… after it when one does.
    function freeName(base, list) {
        var taken = {};
        list.forEach(function (p) { taken[label(p).toLowerCase()] = 1; });
        base = base.slice(0, NAME_MAX);
        if (!taken[base.toLowerCase()]) { return base; }
        for (var n = 2; ; n++) {
            var tail = ' (' + n + ')', name = base.slice(0, NAME_MAX - tail.length).replace(/\s+$/, '') + tail;
            if (!taken[name.toLowerCase()]) { return name; }
        }
    }
    // Added (by hand or with a configuration file): named after its file, when it has one.
    function addPlaylist(url) {
        url = checkedUrl(url);
        if (!url) { return false; }
        var list = getPlaylists();
        for (var i = 0; i < list.length; i++) { if (list[i].url === url) { return list[i].id; } }
        var id = newId(), o = { id: id, url: url }, fn = fileName(url);
        if (fn) { o.name = freeName(fn, list); }
        list.push(o);
        savePlaylists(list);
        return id;
    }

    // ---- An Xtream account: its server, username and password ----
    // The server as typed ("tv.example.net:8080": http:// when it has no scheme; a page or a
    // .php after it left out), or a whole Xtream link pasted there (its username and password
    // too): { base, user, pass } or null.
    function xtreamParts(server) {
        var s = ('' + (server || '')).trim();
        if (!s) { return null; }
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { s = 'http://' + s.replace(/^\/+/, ''); }
        var u = U.parseUrl(s);
        if (!u) { return null; }
        function param(name) { var m = new RegExp('(?:^|&)' + name + '=([^&#]*)').exec(u.query || ''); try { return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : ''; } catch (e) { return ''; } }
        var path = (u.path || '/').replace(/\/[^\/]*\.php$/i, '').replace(/\/+$/, '');
        return { base: u.scheme + '://' + u.host + (u.port ? ':' + u.port : '') + path, user: param('username'), pass: param('password') };
    }
    // Its channels as MPEG-TS (output=ts): servers' own HLS tends to stall a few minutes in;
    // Format (setXtreamFormat) switches an account to HLS (output=m3u8) and back.
    function xtreamUrl(base, user, pass) {
        return base + '/get.php?username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass) + '&type=m3u_plus&output=ts';
    }
    function isXtream(url) { var u = U.parseUrl(url); return !!(u && /\/get\.php$/i.test(u.path) && /(?:^|&)username=/.test(u.query) && /(?:^|&)password=/.test(u.query)); }
    // An Xtream account's format: 'ts' or 'hls' ('' for a playlist that isn't one).
    function xtreamFormat(id) {
        var list = getPlaylists(), i = find(list, id);
        if (i === -1 || !isXtream(list[i].url)) { return ''; }
        return /(?:[?&])output=(m3u8|hls)(?:&|$)/i.test(list[i].url) ? 'hls' : 'ts';
    }
    function setXtreamFormat(id, fmt) {
        var list = getPlaylists(), i = find(list, id);
        if (i === -1 || !isXtream(list[i].url)) { return false; }
        var out = fmt === 'hls' ? 'm3u8' : 'ts', u = list[i].url;
        u = /([?&])output=[^&#]*/i.test(u) ? u.replace(/([?&])output=[^&#]*/i, '$1output=' + out) : u + '&output=' + out;
        return updatePlaylist(id, u);
    }
    // Checked with the server (player_api.php): resolves 'ok', 'refused' (a wrong login, an
    // account expired or banned: { refused, status }) or 'unreachable'.
    function xtreamCheck(base, user, pass) {
        return U.getJSON(base + '/player_api.php?username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass), 15000, 1048576).then(function (j) {
            var ui = j && j.user_info;
            return (ui && +ui.auth === 1 && !/^(expired|banned|disabled)$/i.test('' + (ui.status || ''))) ? { ok: true } : { refused: true, status: ui && ui.status ? '' + ui.status : '' };
        }, function () { return { unreachable: true }; });
    }
    // Added as its get.php link, named after its server ("Xtream · tv.example.net"). Its id.
    function addXtream(base, user, pass) {
        var id = addPlaylist(xtreamUrl(base, user, pass));
        var u = U.parseUrl(base);
        if (id && u) {
            var list = getPlaylists(), i = find(list, id);
            if (i !== -1 && !list[i].name) { list[i].name = freeName('Xtream · ' + u.host, list.filter(function (p) { return p.id !== id; })); savePlaylists(list, true); }
        }
        return id;
    }
    function xtreamGroups(id) {
        var list = getPlaylists(), i = find(list, id);
        if (i < 0 || !isXtream(list[i].url)) { return Promise.reject(new Error(U.t('Not an Xtream account'))); }
        if (typeof YTPlay === 'undefined' || !YTPlay.xtliveCats || (YTPlay.installMode && YTPlay.installMode() === 'browser')) {
            return Promise.reject(new Error(U.t('Xtream groups are read by StremioK’s service (not in a desktop browser)')));
        }
        var x = xtreamParts(list[i].url);
        if (!x || !x.user || !x.pass) { return Promise.reject(new Error(U.t('Invalid Xtream account'))); }
        return YTPlay.xtliveCats(x.base, x.user, x.pass).then(function (r) {
            if (!r || !Array.isArray(r.cats)) { throw new Error(U.t('Couldn’t read the server’s groups')); }
            return r.cats;
        });
    }
    function setPlaylistGroups(id, ids) {
        var list = getPlaylists(), i = find(list, id);
        if (i < 0) { return false; }
        var clean = Array.isArray(ids) ? ids.map(function (g) { return String(g || '').trim(); }).filter(Boolean) : [];
        if (clean.length) { list[i].groups = clean; } else { delete list[i].groups; }
        savePlaylists(list);
        return true;
    }
    function setXtreamNoVod(id, on) {
        var list = getPlaylists(), i = find(list, id);
        if (i < 0) { return false; }
        if (on) { list[i].noVod = true; } else { delete list[i].noVod; }
        savePlaylists(list, true);
        return true;
    }
    function setArchiveOffset(id, hours) {
        var list = getPlaylists(), i = find(list, id);
        if (i < 0) { return false; }
        var h = Math.round(+hours);
        if (!isFinite(h) || h < -12 || h > 14) { return false; }
        if (h === 0) { delete list[i].archiveOffset; } else { list[i].archiveOffset = h; }
        savePlaylists(list, true);
        return true;
    }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    // An Xtream playlist's account for catch-up links ({ base, user, pass, ext, offset } or null),
    // kept until the saved playlists change: the Guide asks for every aired program it draws.
    var _acctSrc, _acct = null;
    function catchupAccount(playlistId) {
        var raw = U.store.get(PLAYLISTS_KEY, null);
        if (!_acct || raw !== _acctSrc) { _acctSrc = raw; _acct = Object.create(null); }
        if (!(playlistId in _acct)) {
            var list = getPlaylists(), i = find(list, playlistId), pl = i !== -1 ? list[i] : null;
            var x = pl && isXtream(pl.url) ? xtreamParts(pl.url) : null;
            _acct[playlistId] = (x && x.base && x.user && x.pass) ? {
                base: x.base, user: x.user, pass: x.pass,
                ext: xtreamFormat(pl.id) === 'hls' ? 'm3u8' : 'ts',
                offset: (pl.archiveOffset && isFinite(pl.archiveOffset)) ? pl.archiveOffset : 0
            } : null;
        }
        return _acct[playlistId];
    }
    function catchupUrl(channelId, progStartSec, progStopSec) {
        var c = _cache && _cache.byId ? _cache.byId[channelId] : null;
        if (!c) { return ''; }
        var arch = c._archiveVariant || c;
        if (!arch || !arch.archive || !(arch.archiveDays > 0) || !arch.streamId) { return ''; }
        var start = +progStartSec, stop = +progStopSec;
        if (!isFinite(start) || !isFinite(stop) || start <= 0 || stop <= start) { return ''; }
        var now = Date.now() / 1000;
        if (stop > now || start < now - arch.archiveDays * 86400) { return ''; }
        var x = catchupAccount(arch._playlistId);
        if (!x) { return ''; }
        var fmt = x.ext;
        var durationMin = Math.max(1, Math.round((stop - start) / 60));
        var offsetHours = x.offset;
        var d = new Date((start + offsetHours * 3600) * 1000);
        var stamp = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
            ':' + pad2(d.getUTCHours()) + '-' + pad2(d.getUTCMinutes());
        return x.base + '/timeshift/' + encodeURIComponent(x.user) + '/' + encodeURIComponent(x.pass) +
            '/' + durationMin + '/' + stamp + '/' + arch.streamId + '.' + fmt;
    }
    function m3uGroups(id) {
        var list = getPlaylists(), i = find(list, id);
        if (i < 0) { return Promise.reject(new Error(U.t('Playlist not found'))); }
        if (typeof YTPlay === 'undefined' || !YTPlay.m3uGroups || (YTPlay.installMode && YTPlay.installMode() === 'browser')) {
            var st = _status[id];
            if (st && Array.isArray(st.groupList) && st.groupList.length) {
                return Promise.resolve(st.groupList);
            }
            return Promise.reject(new Error(U.t('Channel groups are read by StremioK’s service (not in a desktop browser)')));
        }
        return YTPlay.m3uGroups(list[i].url).then(function (r) {
            if (!r || !Array.isArray(r.groups)) { throw new Error(U.t('Couldn’t read the playlist’s groups')); }
            return r.groups;
        });
    }

    // ---- A Stalker portal: its address and the MAC address your provider registered ----
    // Read by StremioK's service, which asks as a MAG box does (YTPlay.stalkerList): its channels
    // come as an M3U playlist, and a channel's link is asked for each time it plays (streams). Saved
    // as a playlist with its MAC ({ url: the portal, mac }).
    var STB_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
    // A MAC address as typed (00:1A:79:12:34:56, with dashes, or none): 00:1A:79:12:34:56, or ''.
    function macOf(v) {
        var h = ('' + (v || '')).trim().toUpperCase().replace(/[:\-.\s]/g, '');
        return /^[0-9A-F]{12}$/.test(h) ? h.match(/../g).join(':') : '';
    }
    // The portal as typed (http:// when it has no scheme): its address, or ''.
    function stalkerPortal(v) {
        var s = ('' + (v || '')).trim();
        if (s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { s = 'http://' + s.replace(/^\/+/, ''); }
        return checkedUrl(s);
    }
    function isStalker(p) { return !!(p && p.mac); }
    // Settings › Content › IPTV › Stalker channels: a portal read past its first 100 pages, up to
    // 30,000 channels (adding one is still checked by those pages: stalkerCheck).
    var STALKER_ALL_KEY = 'stremiok.iptv.stalkerall';
    function stalkerAll() { return U.store.get(STALKER_ALL_KEY, false) === true; }
    function setStalkerAll(on) { U.store.set(STALKER_ALL_KEY, !!on); }
    // A portal's Channel groups: its genres (the service's { genres: [{ id, title }] } or { why }),
    // and the ones to read (none: as Stalker channels says). Read again by whoever sets them.
    function stalkerGroups(id) {
        var list = getPlaylists(), i = find(list, id);
        if (i < 0 || typeof YTPlay === 'undefined' || !YTPlay.stalkerGenres) { return Promise.reject(new Error(U.t('Stalker portals are read by StremioK’s service (not in a desktop browser)'))); }
        return YTPlay.stalkerGenres(list[i].url, list[i].mac).then(function (r) {
            if (!r || !Array.isArray(r.genres)) { throw new Error(U.t('Couldn’t read the portal: {why}', { why: (r && r.why) || U.t('no answer') })); }
            return r.genres;
        });
    }
    function setStalkerGroups(id, ids) {
        var list = getPlaylists(), i = find(list, id);
        if (i < 0) { return false; }
        if (ids && ids.length) { list[i].genres = ids; } else { delete list[i].genres; }
        savePlaylists(list);
        return true;
    }
    // Checked through the service (its channels read): { ok, count }, { refused, why },
    // { unreachable, why } or { noService } (a desktop browser).
    function stalkerCheck(portal, mac) {
        if (typeof YTPlay === 'undefined' || !YTPlay.stalkerList) { return Promise.resolve({ noService: true }); }
        return YTPlay.stalkerList(portal, mac).then(function (r) {
            if (r && typeof r.m3u === 'string') { return { ok: true, count: r.count || 0, cut: r.cut || null }; }
            return r && r.refused ? { refused: true, why: '' + (r.why || '') } : { unreachable: true, why: '' + ((r && r.why) || '') };
        }, function (e) { return /no service/.test((e && e.message) || '') ? { noService: true } : { unreachable: true, why: U.problem(e) }; });
    }
    // Added (named after its server: "Stalker · portal.example.com"), or the one already there with
    // that portal and MAC. Its id.
    function addStalker(portal, mac) {
        portal = stalkerPortal(portal); mac = macOf(mac);
        if (!portal || !mac) { return false; }
        var list = getPlaylists();
        for (var i = 0; i < list.length; i++) { if (list[i].url === portal && list[i].mac === mac) { return list[i].id; } }
        var id = newId(), u = U.parseUrl(portal);
        list.push({ id: id, url: portal, mac: mac, name: freeName('Stalker · ' + (u ? u.host : 'portal'), list) });
        savePlaylists(list);
        return id;
    }

    function updatePlaylist(id, url) {
        url = checkedUrl(url);
        if (!url) { return false; }
        var list = getPlaylists(), changed = false;
        for (var i = 0; i < list.length; i++) {
            if (list[i].id !== id) { continue; }
            changed = list[i].url !== url;
            if (changed) {
                forgetSaved(list[i]);
                // Another Xtream server or account: its categories (by number) and time offset aren't this one's
                var a = isXtream(list[i].url) ? xtreamParts(list[i].url) : null, b = isXtream(url) ? xtreamParts(url) : null;
                if (a && (!b || a.base !== b.base || a.user !== b.user)) { delete list[i].groups; delete list[i].archiveOffset; }
            }
            list[i].url = url;
            break;
        }
        if (!changed) { return false; }
        U.bigStore.remove(CACHE_PREFIX + id);
        savePlaylists(list);
        return true;
    }
    // The service's saved lists for a playlist (its logins in them): deleted when it goes.
    function forgetSaved(p) {
        if (!p || typeof YTPlay === 'undefined' || !YTPlay.iptvForget || isStalker(p)) { return; }
        var x = isXtream(p.url) ? xtreamParts(p.url) : null;
        YTPlay.iptvForget(x && x.base && x.user ? { base: x.base, user: x.user } : { u: p.url });
    }

    function removePlaylist(id) {
        var all = getPlaylists(), list = all.filter(function (p) { return p.id !== id; });
        all.forEach(function (p) { if (p.id === id) { forgetSaved(p); } });
        U.bigStore.remove(CACHE_PREFIX + id);
        delete _status[id];
        savePlaylists(list);
    }

    function isEnabled() { return getPlaylists().some(function (p) { return !p.off; }); }
    // The playlists' revision: changed (added, edited, removed, switched off, moved, reloaded),
    // a load still under way for the old ones keeps nothing, and they're read as they are now.
    var _rev = 0, _pending = null, _ytEnds = {};   // (_ytEnds: Xtream link -> where it led, youTubeEnd)
    function reset() { _cache = null; _rawChannels = null; _rev++; _ytEnds = {}; }

    // Playlist text is cached per playlist (one key each), in the big store (IndexedDB:
    // far more room than localStorage, which keeps settings and progress). A playlist that
    // can't be saved is flagged in its status (uncached) instead of failing silently.
    // Both are promises.
    function readPersist(id) {
        return U.bigStore.get(CACHE_PREFIX + id);
    }
    // Returns false when the text didn't fit in storage (it re-downloads next launch).
    var SVC_SAVED = '\u0001svc:';   // (a saved copy that's the service's channel list, JSON, not the M3U itself)
    function writePersist(id, url, text, at) {
        return U.bigStore.set(CACHE_PREFIX + id, { url: url, text: text, at: at });
    }

    function slug(s) {
        var v = ('' + s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return v.slice(0, 40) || 'x';
    }
    // A short hash of the exact text (FNV-1a, base 36). Added to the readable slug so ids
    // stay unique and stable: "News HD" / "News-HD", "news" / "News", names alike in their
    // first 40 characters, and names in other scripts (all slug to "x") no longer share one.
    function hash(s) {
        var h = 0x811c9dc5, t = '' + s;
        for (var i = 0; i < t.length; i++) {
            h ^= t.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return h.toString(36);
    }
    function idOf(s, exact) { return slug(s) + '-' + hash(exact === undefined ? s : exact); }
    // A channel's id within its playlist, the same whichever way it was read (M3U in the TV, the
    // service's M3U reader, Xtream's API): its tvg-id, else its name; repeats numbered -2, -3…
    // (favorites, Recent, a channel's remembered audio and format are kept by it).
    function channelId(c, seen) {
        var base = 'iptv:' + idOf(c.tvgId || c.name), id = base, n = 2;
        while (seen[id]) { id = base + '-' + n; n++; }
        seen[id] = 1;
        return id;
    }

    function attr(line, re) { var m = line.match(re); return m ? m[1] : ''; }
    // A header a playlist gives a channel, by name: its User-Agent, Referer or Cookie (the ones the
    // TV's player takes: any other is left out). Checked when played (U.sanitizeHeaders).
    function headerInto(c, name, value) {
        var n = ('' + name).trim().toLowerCase(), v = ('' + (value || '')).trim();
        if (!v) { return; }
        if (n === 'user-agent') { c.ua = v; } else if (n === 'referer' || n === 'referrer') { c.ref = v; } else if (n === 'cookie') { c.cookie = v; }
    }

    // A channel's DRM, from Kodi's #KODIPROP:inputstream.adaptive.<key>=<value> lines: { sys:
    // 'widevine' | 'playready' | 'clearkey' | 'other', url: its license server, h: { name: value }
    // for the license request, b64: its answer comes in base64, bad: a request or answer template
    // StremioK can't follow, keys: ClearKey's { kid: key } (hex) when the playlist gives them }.
    // Widevine or PlayReady with a license server: the TV's player (drmPlayable); ClearKey with keys
    // or a key server: Shaka Player (drmShaka, see the player's startShaka). stream_headers /
    // manifest_headers: the stream's own User-Agent and Referer.
    function drmSys(v) { v = ('' + v).toLowerCase(); return /widevine/.test(v) ? 'widevine' : /playready/.test(v) ? 'playready' : /clearkey/.test(v) ? 'clearkey' : 'other'; }
    function headersOf(text) {   // "Name=value&Name2=value2" (values may be %-encoded) -> { Name: value }
        var out = {}, n = 0;
        ('' + (text || '')).split('&').forEach(function (kv) {
            var eq = kv.indexOf('='), k = eq > 0 ? kv.slice(0, eq).trim() : '', v = eq > 0 ? kv.slice(eq + 1) : '';
            try { v = decodeURIComponent(v); } catch (e) {}
            if (/^[A-Za-z0-9-]{1,40}$/.test(k) && v && v.length <= 1000 && !/[\r\n]/.test(v) && n < 16) { out[k] = v; n++; }
        });
        return out;
    }
    function hexOf(v) {   // a key id or key: hex (32 digits), or base64url (a JWK's)
        v = ('' + (v || '')).trim();
        if (/^[0-9a-f]{32}$/i.test(v)) { return v.toLowerCase(); }
        if (!/^[A-Za-z0-9_-]{21,24}={0,2}$/.test(v)) { return ''; }
        try {
            var bin = atob(v.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '') + '=='.slice(0, (4 - v.replace(/=+$/, '').length % 4) % 4)), out = '';
            for (var i = 0; i < bin.length; i++) { out += (bin.charCodeAt(i) < 16 ? '0' : '') + bin.charCodeAt(i).toString(16); }
            return out.length === 32 ? out : '';
        } catch (e) { return ''; }
    }
    // ClearKey's keys as a playlist gives them: kid:key[,kid:key], { "kid": "key" }, or a JWK set
    // { "keys": [{ "kid", "k" }] } -> { kid: key } in hex, or null.
    function keysOf(text) {
        var out = {}, n = 0, j = null;
        function put(kid, key) { kid = hexOf(kid); key = hexOf(key); if (kid && key && n < 32) { out[kid] = key; n++; } }
        text = ('' + (text || '')).trim();
        if (text.charAt(0) === '{') {
            try { j = JSON.parse(text); } catch (e) { j = null; }
            if (j && Array.isArray(j.keys)) { j.keys.forEach(function (k) { if (k) { put(k.kid, k.k); } }); }
            else if (j && typeof j === 'object') { Object.keys(j).forEach(function (k) { put(k, j[k]); }); }
        } else {
            text.split(',').forEach(function (pair) { var p = pair.split(':'); if (p.length === 2) { put(p[0], p[1]); } });
        }
        return n ? out : null;
    }
    function drmServer(d, url, headers) {
        if (/^https?:\/\/[^\s|]+$/i.test(url || '') && url.length <= 2000) { d.url = url; }
        else if (url) { d.inline = true; d.keys = keysOf(url); }   // (ClearKey's kid:key, or keys as JSON)
        if (headers) { d.h = headersOf(headers); }
    }
    function drmInto(c, key, v) {
        if (key === 'stream_headers' || key === 'manifest_headers') { var sh = headersOf(v); Object.keys(sh).forEach(function (k) { headerInto(c, k, sh[k]); }); return; }
        var d = c.drm || (c.drm = { sys: '' });
        if (key === 'license_type') { d.sys = drmSys(v); return; }
        if (key === 'license_key') {   // URL|headers|request template|answer template
            var p = v.split('|');
            drmServer(d, p[0], p[1]);
            if (p[2] && p[2] !== 'R{SSM}') { d.bad = true; }
            if (p[3] === 'B') { d.b64 = true; } else if (p[3]) { d.bad = true; }
            return;
        }
        if (key === 'drm_legacy') { var q = v.split('|'); d.sys = drmSys(q[0]); drmServer(d, q[1], q[2]); return; }
        if (key === 'drm') {   // {"com.widevine.alpha": {"license": {"server_url": …, "req_headers": "Name=value&…"}}}
            var j = null;
            try { j = JSON.parse(v); } catch (e) { j = null; }
            var sys = j && typeof j === 'object' ? Object.keys(j)[0] : '', lic = sys && j[sys] && j[sys].license;
            d.sys = sys ? drmSys(sys) : 'other';
            if (lic && typeof lic === 'object') { drmServer(d, typeof lic.server_url === 'string' ? lic.server_url : '', typeof lic.req_headers === 'string' ? lic.req_headers : ''); }
            if (lic && (lic.keyids || lic.keys)) { d.inline = true; d.keys = keysOf(JSON.stringify(lic.keyids || { keys: lic.keys })); }
        }
    }
    function drmPlayable(d) { return !!d && (d.sys === 'widevine' || d.sys === 'playready') && !!d.url && !d.bad && !d.inline; }
    function drmShaka(d) { return !!d && d.sys === 'clearkey' && !d.bad && (!!d.keys || (!!d.url && !d.inline)); }

    // A link to a file, not a stream: a film or an episode (an Xtream account's /movie/… and
    // /series/… links, or a video file's name), played as one (seeking; see Player's isLive).
    var VOD_LINK = /\.(mkv|mp4|m4v|avi|mov|wmv|mpg|mpeg|webm)(?:[?#]|$)/i;
    var XTREAM_VOD = /^https?:\/\/[^\/]+(?:\/[^?#]*)?\/(movie|series)\/[^\/?#]+\/[^\/?#]+\/\d+\.[a-z0-9]{2,4}(?:[?#]|$)/i;
    function truthy(v) { return /^(?:1|true|yes)$/i.test(('' + (v || '')).trim()); }

    function audioUrl(u) {
        return /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav)(?:[?#]|$)/i.test(u || '');
    }

    // Returns [{ id, type, name, logo, group, tvgId, ua, ref, url, _yt }]
    // The M3U reader, a line at a time (so a big playlist can be read in chunks, see
    // parseM3UAsync). max: channels kept; any beyond are only counted (dropped). guides: the TV
    // guides it names (url-tvg / x-tvg-url / tvg-url, several split by commas).
    // only: the group names to keep (the playlist's chosen groups), or null for all. Every group is
    // still counted (r.groupList: the groups to choose from); channels of others aren't kept and
    // don't count towards max.
    function m3uReader(max, only) {
        var r = { channels: [], dropped: 0, title: '', guides: [], groupList: [] }, cur = null, seen = {}, pre = null, groupAt = {};
        function counted(c) {   // false: a group not chosen
            var k = c.type + '|' + c.group;
            if (!groupAt[k]) { groupAt[k] = { name: c.group, type: c.type, count: 0 }; r.groupList.push(groupAt[k]); }
            groupAt[k].count++;
            return !only || !!only[c.group];
        }   // (pre: #KODIPROP lines before a channel's #EXTINF)
        function add(c) {
            c.id = channelId(c, seen);
            r.channels.push(c);
        }
        r.line = function (raw) {
            var s = raw.replace(/^\s+/, '');
            if (s.indexOf('#EXTM3U') === 0 && !r.guides.length) {
                r.guides = attr(s, /(?:^|\s)(?:url-tvg|x-tvg-url|tvg-url)="([^"]{1,4000})"/i).split(',').map(function (u) { return u.trim(); })
                    .filter(function (u) { return /^https?:\/\//i.test(u); }).slice(0, 5);
            }
            if (!r.title && s.indexOf('#EXTM3U') === 0) {   // the playlist's own name, if it has one
                r.title = attr(s, /(?:^|\s)(?:x-playlist-name|playlist-name|x-tvg-name)="([^"]{1,200})"/i).trim().slice(0, NAME_MAX);
            } else if (!r.title && s.indexOf('#PLAYLIST:') === 0) {
                r.title = s.slice(10).trim().slice(0, NAME_MAX);
            }
            if (s.indexOf('#EXTINF') === 0) {
                var group = attr(s, /group-title="([^"]*)"/i).trim();   // (as the groups you choose are kept: trimmed)
                var kind = attr(s, /tvg-type="([^"]*)"/i);
                cur = {
                    name: (s.slice(s.lastIndexOf(',') + 1).trim()) || U.t('Channel'),
                    logo: attr(s, /tvg-logo="([^"]*)"/i),
                    group: group,
                    tvgId: attr(s, /tvg-id="([^"]*)"/i),
                    ua: attr(s, /http-user-agent="([^"]*)"/i),
                    ref: attr(s, /http-referr?er="([^"]*)"/i),   // (both spellings)
                    radio: truthy(attr(s, /(?:^|\s)radio="([^"]*)"/i)) || /^radio$/i.test(kind),
                    sport: /^sports?$/i.test(kind),   // (StremioK's own mark: the Sports tab)
                    url: ''
                };
                if (pre) { if (pre.drm) { cur.drm = pre.drm; } if (!cur.ua && pre.ua) { cur.ua = pre.ua; } if (!cur.ref && pre.ref) { cur.ref = pre.ref; } if (!cur.cookie && pre.cookie) { cur.cookie = pre.cookie; } pre = null; }
                if (/^guide$/i.test(kind)) {   // (StremioK's own mark: a channel watched elsewhere, kept for its TV guide alone; a link after it is ignored)
                    cur.guideOnly = true; cur.radio = false; cur.type = 'tv';
                    if (!cur.group) { cur.group = 'TV guide'; }
                    if (!counted(cur)) { cur = null; return; }
                    if (max && r.channels.length >= max) { r.dropped++; cur = null; return; }
                    add(cur);
                    cur = null;
                }
            } else if (/^#EXTVLCOPT:http-(user-agent|referr?er)=/i.test(s)) {   // (http-referer: the one-r spelling too)
                if (cur) { var opt = /^#EXTVLCOPT:http-(user-agent|referr?er)=(.*)$/i.exec(s); headerInto(cur, opt[1], opt[2]); }
            } else if (/^#KODIPROP:inputstream\.adaptive\.[a-z_]+=/i.test(s)) {   // a channel's DRM (Kodi's: see drmInto)
                var kp = /^#KODIPROP:inputstream\.adaptive\.([a-z_]+)=(.*)$/i.exec(s);
                drmInto(cur || (pre = pre || {}), kp[1].toLowerCase(), kp[2].trim());
            } else if (s.indexOf('#EXTHTTP:') === 0) {   // #EXTHTTP:{"User-Agent": "…", "Referer": "…"}
                var j = null;
                try { j = JSON.parse(s.slice(9)); } catch (e) { j = null; }
                if (cur && j && typeof j === 'object') { Object.keys(j).forEach(function (k) { if (typeof j[k] === 'string') { headerInto(cur, k, j[k]); } }); }
            } else if (s && s.charAt(0) !== '#') {
                if (cur) {
                    var u = s.trim();
                    // headers after a | (Kodi's): …m3u8|Referer=…&User-Agent=… (values may be %-encoded)
                    var bar = u.indexOf('|');
                    if (bar !== -1 && /^[A-Za-z][A-Za-z-]*=/.test(u.slice(bar + 1))) {
                        u.slice(bar + 1).split('&').forEach(function (kv) {
                            var eq = kv.indexOf('='), v = eq === -1 ? '' : kv.slice(eq + 1);
                            try { v = decodeURIComponent(v); } catch (e) {}
                            if (eq > 0) { headerInto(cur, kv.slice(0, eq), v); }
                        });
                        u = u.slice(0, bar);
                    }
                    if (/^https?:\/\//i.test(u)) {
                        cur.url = u;
                        cur.radio = !cur.sport && (cur.radio || /\bradio\b/i.test(cur.group) || audioUrl(u));
                        cur.type = cur.sport ? 'sport' : cur.radio ? 'radio' : 'tv';
                        if (!cur.group) { cur.group = cur.sport ? 'Sports' : cur.radio ? 'Live Radio' : 'Live TV'; }
                        if (!counted(cur)) { cur = null; return; }   // (a group not chosen: before the cap, so chosen ones aren't crowded out)
                        if (max && r.channels.length >= max) { r.dropped++; cur = null; return; }
                        cur._yt =
                            /^https?:\/\/(?:[^\/]+\.)?youtube\.com(?::\d+)?(?:\/|$)/i.test(u) ||
                            /^https?:\/\/youtu\.be(?::\d+)?(?:\/|$)/i.test(u);
                        if (VOD_LINK.test(u) || XTREAM_VOD.test(u)) { cur.vod = true; }   // (a film's file: played as one, see plainStreams)
                        add(cur);
                    }
                    cur = null;
                }
            }
        };
        return r;
    }
    function parseM3U(text) {
        var r = m3uReader(0), lines = ('' + text).split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) { r.line(lines[i]); }
        return r.channels;
    }
    // The same, PARSE_CHUNK lines at a time with a pause between (the remote stays
    // responsive while a big playlist is read); onProgress(channels so far). Resolves
    // { channels, dropped }. The text isn't kept once split.
    var PARSE_CHUNK = 3000;
    function parseM3UAsync(text, max, onProgress, only) {
        return new Promise(function (resolve) {
            var lines = ('' + text).split(/\r?\n/), r = m3uReader(max, only), i = 0;
            text = null;
            (function step() {
                var end = Math.min(lines.length, i + PARSE_CHUNK);
                for (; i < end; i++) { r.line(lines[i]); }
                if (onProgress) { try { onProgress(r.channels.length); } catch (e) {} }
                if (i < lines.length) { setTimeout(step, 0); return; }
                lines = null;
                resolve(r);
            })();
        });
    }

    // ---- ★ Favorites: channels you picked (hold OK on a channel card), a row first on the IPTV
    // tab (FAV_CAT, asks to come first among Home feeds unless you've placed it) and first on the
    // Guide tab; by channel id (its playlist and tvg-id / name), FAV_MAX at most.
    var FAV_KEY = 'stremiok.iptv.favs', FAV_MAX = 300, FAV_CAT = 'iptv_favs';
    function favs() { var f = U.store.get(FAV_KEY, []) || []; return Array.isArray(f) ? f.filter(function (x) { return typeof x === 'string'; }) : []; }
    // The favorites as a set, made again only when the saved list changes (U.store hands back the
    // same array until it's written): isFavorite is asked for every channel a list draws.
    var _favSrc, _favSet = null;
    function favSet() {
        var raw = U.store.get(FAV_KEY, null);
        if (_favSet && raw === _favSrc) { return _favSet; }
        _favSrc = raw; _favSet = Object.create(null);
        if (Array.isArray(raw)) { raw.forEach(function (x) { if (typeof x === 'string') { _favSet[x] = true; } }); }
        return _favSet;
    }
    function isFavorite(id) {
        var f = favSet();
        if (f[id]) { return true; }
        var c = _cache && _cache.byId ? _cache.byId[id] : null;
        if (c && c._mergedIds) {
            for (var i = 0; i < c._mergedIds.length; i++) { if (f[c._mergedIds[i]]) { return true; } }
        }
        return false;
    }
    function setFavorite(id, on) {
        var c = _cache && _cache.byId ? _cache.byId[id] : null;
        var drop = {};
        drop[id] = 1;
        if (c && c._mergedIds) {
            c._mergedIds.forEach(function (mid) { drop[mid] = 1; });
        }
        var f = favs().filter(function (x) { return !drop[x]; });
        if (on) { f.unshift(id); }
        U.store.set(FAV_KEY, f.slice(0, FAV_MAX));
        if (_cache) { favCatalog(_cache); }
        return true;
    }
    // The Favorites catalog, first in the list, while there are favorites among the channels read
    // (changed in place: the IPTV addon's manifest holds the same list).
    function favCatalog(d) {
        var at = -1;
        for (var i = 0; i < d.catalogs.length; i++) { if (d.catalogs[i].id === FAV_CAT) { at = i; } }
        var any = favs().some(function (id) { return !!d.byId[id]; });
        if (any && at === -1) { d.catalogs.unshift({ type: 'tv', id: FAV_CAT, name: U.t('★ Favorites'), extra: [{ name: 'search' }], _favs: true, _first: true }); }
        if (!any && at !== -1) { d.catalogs.splice(at, 1); }
    }

    // ---- What a channel's link really played as (the player's report: Player.liveMeta) ----
    // { url: { h, f, hevc, at } }, MEASURED_MAX links at most (the oldest go). A merged channel's
    // variants are ranked by it once known, ahead of what their names say.
    var MEASURED_KEY = 'stremiok.iptv.measured', MEASURED_MAX = 1500;
    function measured(url) { var all = U.store.get(MEASURED_KEY, null); return (all && url && all[url]) || null; }
    function noteMeasured(url, a) {
        if (!url || !a || !(+a.height > 0)) { return; }
        var rec = { h: +a.height, f: Math.round(+a.fps || 0), hevc: /hev|hvc|h\.?265/i.test(a.codec || '') ? 1 : 0, at: Date.now() };
        var all = U.store.get(MEASURED_KEY, {}) || {}, prev = all[url];
        if (prev && prev.h === rec.h && prev.f === rec.f && prev.hevc === rec.hevc && rec.at - prev.at < 86400000) { return; }
        all[url] = rec;
        var urls = Object.keys(all);
        if (urls.length > MEASURED_MAX) { urls.sort(function (x, y) { return all[x].at - all[y].at; }).slice(0, urls.length - MEASURED_MAX).forEach(function (u) { delete all[u]; }); }
        U.store.set(MEASURED_KEY, all);
    }
    function measuredScore(m) {
        return (m.h >= 2000 ? 400 : m.h >= 1000 ? 300 : m.h >= 700 ? 200 : m.h >= 400 ? 100 : 50) + (m.f >= 48 ? 30 : 0) + (m.hevc ? 25 : 0);
    }
    // "4K", "1080p50", "720p", for the source lists
    function measuredLabel(url) {
        var m = measured(url);
        if (!m) { return ''; }
        return (m.h >= 2000 ? '4K' : m.h + 'p') + (m.f >= 48 ? (m.h >= 2000 ? ' ' : '') + m.f : '');
    }

    // ---- Smart Playlist Tidier & Variant Merger ----
    function normalizeCountryList(val) {
        if (val === undefined || val === null) { return ['TR', 'UK', 'NL']; }
        if (Array.isArray(val)) { val = val.join(','); }
        var out = [], seen = {};
        String(val).split(/[\s,;]+/).forEach(function (tok) {
            var c = tok.trim().toUpperCase();
            if (/^[A-Z]{2}$/.test(c) && !seen[c] && out.length < 8) { seen[c] = 1; out.push(c); }
        });
        return out;
    }
    function getTidyCfg() {
        var p = (typeof Stremio !== 'undefined' && Stremio.getPrefs) ? Stremio.getPrefs() : (U.store.get(PREFS_KEY, {}) || {});
        return {
            enabled: p.iptvTidy !== false,
            hideAdult: p.iptvHideAdult !== false,
            collapseVariants: p.iptvCollapseVariants !== false,
            countries: normalizeCountryList(p.iptvCountries)
        };
    }
    function setTidyCfg(patch) {
        patch = patch || {};
        var map = { enabled: 'iptvTidy', hideAdult: 'iptvHideAdult', collapseVariants: 'iptvCollapseVariants', countries: 'iptvCountries' };
        var useStremio = typeof Stremio !== 'undefined' && Stremio.setPref;
        var p = useStremio ? null : (U.store.get(PREFS_KEY, {}) || {});
        Object.keys(patch).forEach(function (k) {
            var prefKey = map[k];
            if (!prefKey) { return; }
            var v = patch[k];
            if (k === 'countries') { v = normalizeCountryList(v).join(','); }
            else { v = !!v; }
            if (useStremio) { Stremio.setPref(prefKey, v); }
            else { p[prefKey] = v; }
        });
        if (!useStremio) { U.store.set(PREFS_KEY, p); }
        return getTidyCfg();
    }

    var COUNTRY_WORDS = {
        TR: 'TR', TUR: 'TR', TURK: 'TR', TURKIYE: 'TR', TURKEY: 'TR',
        UK: 'UK', GB: 'UK', ENG: 'UK', BRITISH: 'UK',
        NL: 'NL', NED: 'NL', NLD: 'NL', DUTCH: 'NL', NEDERLAND: 'NL', HOLLAND: 'NL',
        DE: 'DE', GER: 'DE', GERMANY: 'DE', DEUTSCH: 'DE',
        US: 'US', USA: 'US', AMERICA: 'US',
        FR: 'FR', FRA: 'FR', FRANCE: 'FR', FRENCH: 'FR',
        ES: 'ES', ESP: 'ES', SPAIN: 'ES', SPANISH: 'ES',
        IT: 'IT', ITA: 'IT', ITALY: 'IT', ITALIAN: 'IT',
        AR: 'AR', ARB: 'AR', ARAB: 'AR', ARABIC: 'AR',
        PT: 'PT', BR: 'BR', PL: 'PL', RU: 'RU', GR: 'GR', BE: 'BE', AT: 'AT', CH: 'CH', CA: 'CA', AU: 'AU'
    };
    var NON_COUNTRY_2 = { TV: 1, HD: 1, SD: 1, '4K': 1, '8K': 1, IP: 1, FX: 1, VIP: 1, RAW: 1, EU: 1, WW: 1, INT: 1, ALL: 1 };
    var REGION_PREFIX_RE = /^(?:EU|EUROPE|EUROP|WW|INTL?|WORLD|ALL|GLOBAL)\s*[:|\-\u2502\u2503\u250A\u250B\u2551\u01C0\u2223\/]+\s*/i;
    var DECOR_BOUND = /^[\s\-=_*#|┃│║∣ǀ─═•·.+~<>✦★☆●◆■▲►»«]+|[\s\-=_*#|┃│║∣ǀ─═•·.+~<>✦★☆●◆■▲►»«]+$/g;
    var DIVIDER_WORDS = /^(?:separator|divider|section|group|category|kategori|placeholder|empty|none)$/i;
    var ADULT_RE = /(?:^|[^0-9])(?:18\+|\+18|₊₁₈)|\b(?:xxx|porn|porno|erotic|erotik|nsfw|sex|brazzers|playboy|hustler|redlight|dorcel)\b|\badult\b(?!\s*swim)/i;

    // What isn't a letter or a digit in any script: spaces, punctuation (ASCII, Latin-1, general,
    // CJK, fullwidth), arrows, maths, box drawing, shapes, dingbats, emoji (surrogate pairs) and
    // their variation selectors, and the letter-like pipe ǀ that playlists draw dividers with.
    var NOT_A_LETTER = /[\s!-\/:-@\[-`{-~\u00A0-\u00BF\u00D7\u00F7\u01C0\u2000-\u206F\u2190-\u23FF\u2500-\u27BF\u2B00-\u2BFF\u3000-\u303F\uFE00-\uFE0F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\uD800-\uDFFF]/g;
    function isSeparatorName(rawName) {
        var core = ('' + (rawName || '')).replace(DECOR_BOUND, '').trim();
        if (!core) { return true; }
        if (DIVIDER_WORDS.test(core)) { return true; }
        return !core.replace(NOT_A_LETTER, '');   // (letters or digits in any script: Hebrew, Thai, Hangul, Kana, Devanagari… too)
    }
    function isAdultChannel(c) {
        return ADULT_RE.test((c.group || '') + ' ' + (c.name || ''));
    }
    // strict (a channel's name): a 2-letter code counts only with a separator after it ("TR |",
    // "UK:"), so "CH 5" or "BE IN SPORTS" stay as they are; a group's may be followed by a space
    // ("UK GENERAL").
    function countryFromText(s, strict) {
        var t = ('' + (s || '')).trim().replace(REGION_PREFIX_RE, '').replace(/^[\[({|┃│║∣ǀ]+\s*/, '');
        var m = /^([A-Za-z]{2,12})(?:\s*[:|\-\u2502\u2503\u250A\u250B\u2551\u01C0\u2223\/\])]|\s+|$)/.exec(t);
        if (!m) { return ''; }
        var tok = m[1].toUpperCase();
        var sepAfter = /^\s*[:|\-\u2502\u2503\u250A\u250B\u2551\u01C0\u2223\/\])]/.test(t.slice(m[1].length));
        if (COUNTRY_WORDS[tok] && !(strict && tok.length === 2 && !sepAfter)) { return COUNTRY_WORDS[tok]; }
        if (/^[A-Z]{2}$/.test(tok) && !NON_COUNTRY_2[tok] && /[:|\-\u2502\u2503\u250A\u250B\u2551\u01C0\u2223\/\])]/.test(t.slice(tok.length, tok.length + 3))) { return tok; }
        return '';
    }
    function extractCountry(group, name) {
        return countryFromText(group) || countryFromText(name, true) || '';
    }
    var KEEP_UPPER = { TR: 1, UK: 1, NL: 1, DE: 1, US: 1, FR: 1, ES: 1, IT: 1, AR: 1, TV: 1, HD: 1, FHD: 1, UHD: 1, '4K': 1, '8K': 1, HEVC: 1, VIP: 1, NBA: 1, UFC: 1, NHL: 1, NFL: 1, MLB: 1, F1: 1, PPV: 1, VOD: 1, CNN: 1, BBC: 1, TRT: 1 };
    function cleanGroup(group, country) {
        var g = ('' + (group || 'Live TV')).trim().replace(REGION_PREFIX_RE, '');
        g = g.replace(/^([A-Za-z]{2,12})(?:\s*[:|\-\u2502\u2503\u250A\u250B\u2551\u01C0\u2223\/]+\s*|\s+)/i, function (all, word) {
            var up = word.toUpperCase();
            return (COUNTRY_WORDS[up] || (country && up === country)) ? '' : all;
        });
        g = g.replace(DECOR_BOUND, '').replace(/^(?:VIP|RAW)\s*[:|\-\u2502\u2503\u250A\u250B\u2551\u01C0\u2223\/]+\s*/i, '').replace(/\s+(?:VIP|RAW)$/i, '').replace(DECOR_BOUND, '').replace(/\s+/g, ' ').trim();
        if (!g) { g = 'Live TV'; }
        g = g.split(' ').map(function (w) {
            var up = w.toUpperCase();
            if (KEEP_UPPER[up] || w.length <= 3) { return w === up ? up : w; }
            if (w === up) { return w.charAt(0) + w.slice(1).toLowerCase(); }
            return w;
        }).join(' ');
        return country ? (country + ' · ' + g) : g;
    }
    function extractQuality(rawName) {
        var s = '' + (rawName || '');
        var res = '';
        var base = 100;
        if (/\b(?:4k|uhd|2160p?)\b/i.test(s)) { res = '4K'; base = 400; }
        else if (/\b(?:fhd|1080p?|full\s*hd)\b/i.test(s)) { res = 'FHD'; base = 300; }
        else if (/\b(?:hevc|h\.?265|x265)\b/i.test(s)) { res = 'HEVC'; base = 250; }
        else if (/\b(?:hd|720p)\b/i.test(s)) { res = 'HD'; base = 200; }
        else if (/\b(?:sd|480p|360p|lq)\b/i.test(s)) { res = 'SD'; base = 50; }
        var isHevc = /\b(?:hevc|h\.?265|x265)\b/i.test(s);
        var fpsM = /\b(50|60)\s*fps\b/i.exec(s);
        var fps = fpsM ? +fpsM[1] : 0;
        // ("Alt" / "Bak" / "Link" only numbered or bracketed: "ALT Balaji" is a channel's name)
        var isBackup = /\b(?:backup|mirror|spare|yedek)\b|\b(?:alt|bak|link)\s*\d+\b|[\[(](?:alt|bak)[\])]/i.test(s);
        var score = base + (fps ? 30 : 0) + (isHevc && res !== 'HEVC' ? 25 : 0) - (isBackup ? 150 : 0);
        var parts = [];
        if (isBackup && !res) { parts.push('Backup'); }
        else {
            if (res) { parts.push(res); }
            if (isHevc && res && res !== 'HEVC') { parts.push('HEVC'); }
            if (fps) { parts.push(String(fps)); }
            if (isBackup) { parts.push('Backup'); }
        }
        return { score: score, badge: parts.join(' '), res: res };
    }
    function cleanChannelName(rawName, country) {
        var s = ('' + (rawName || '')).replace(DECOR_BOUND, '').trim();
        s = s.replace(/^[\[(]([A-Za-z]{2,4})[\])]\s*/i, function (all, c) {
            var up = c.toUpperCase();
            return (COUNTRY_WORDS[up] || up === country) ? '' : all;
        });
        s = s.replace(/^([A-Za-z]{2,4})\s*[:|\-\u2502\u2503\u250A\u250B\u2551\u01C0\u2223\/]+\s*/i, function (all, c) {
            var up = c.toUpperCase();
            return (COUNTRY_WORDS[up] || up === country) ? '' : all;
        });
        s = s.replace(/^(?:VIP|RAW)\s*[:|\-\u2502\u2503\u250A\u250B\u2551\u01C0\u2223\/]+\s*/i, '');
        var stripped = s.replace(/\[(?:4k|uhd|fhd|hd|sd|hevc|h\.?26[45]|vip|raw|backup|yedek|1080p|720p|50fps|60fps)\]/ig, ' ')
            .replace(/\((?:4k|uhd|fhd|hd|sd|hevc|h\.?26[45]|vip|raw|backup|yedek|1080p|720p|50fps|60fps)\)/ig, ' ');
        if (country) {
            stripped = stripped.replace(new RegExp('\\s*[(\\[]' + country + '[)\\]]\\s*', 'ig'), ' ');
        }
        stripped = stripped.replace(/\b(?:4k\s*uhd|uhd\s*4k|full\s*hd|uhd|4k|fhd|hevc|h\.?265|x265|h\.?264|x264|1080p|720p|480p|50\s*fps|60\s*fps|backup|yedek|hd|sd)\b/ig, ' ');
        stripped = stripped.replace(/\s+(?:VIP|RAW)$/i, '');
        stripped = stripped.replace(DECOR_BOUND, '').replace(/\s+/g, ' ').trim();
        return stripped || s || ('' + (rawName || U.t('Channel')));
    }
    function normalizeMergeKey(name) {
        return ('' + (name || '')).toLowerCase()
            .replace(/['’".,!?:;()\[\]|┃\-_/*•·]+/g, ' ')
            .replace(/\s+/g, ' ').trim();
    }
    function cloneChannel(c) {
        var o = {};
        Object.keys(c).forEach(function (k) { o[k] = c[k]; });
        return o;
    }
    function toVariantRecord(c, cleanGrp) {
        return {
            id: c.id, name: c._cleanName || c.name, rawName: c._rawName || c.name, tvgId: c.tvgId || '',
            badge: c._qBadge || 'SD', score: c._qScore || 100,
            url: c.url, group: cleanGrp || c.group, type: c.type,
            ua: c.ua || '', ref: c.ref || '', cookie: c.cookie || '', drm: c.drm || null,
            archive: !!c.archive, archiveDays: +c.archiveDays || 0, streamId: +c.streamId || 0,
            _yt: !!c._yt, vod: !!c.vod, _playlistId: c._playlistId, country: c._country || ''
        };
    }
    function tidyChannels(rawList, cfg) {
        cfg = cfg || getTidyCfg();
        var list = rawList || [];
        if (!cfg.enabled) { return list.slice(0); }
        var cleaned = [];
        list.forEach(function (src, idx) {
            if (!src || isSeparatorName(src.name)) { return; }
            if (cfg.hideAdult && isAdultChannel(src)) { return; }
            var c = cloneChannel(src);
            c._idx = idx;
            c._rawName = src.name;
            c._rawGroup = src.group || 'Live TV';
            c._country = extractCountry(c._rawGroup, c._rawName);
            var q = extractQuality(c._rawName);
            if (!q.res) { q = extractQuality(c._rawName + ' ' + c._rawGroup); }   // (its quality in its group's name: "TR | 4K UHD")
            c._qScore = q.score;
            c._qBadge = q.badge;
            c._cleanName = cleanChannelName(c._rawName, c._country);
            c._cleanGroup = cleanGroup(c._rawGroup, c._country);
            c.name = c._cleanName;
            c.group = c._cleanGroup;
            cleaned.push(c);
        });

        var merged;
        if (cfg.collapseVariants) {
            var buckets = {}, order = [];
            cleaned.forEach(function (c) {
                if (c.guideOnly) { order.push([c]); return; }
                var scope = (c.type || 'tv') + '|' + (c._country || c._cleanGroup).toLowerCase() + '|' + normalizeMergeKey(c._cleanName);
                if (!buckets[scope]) { buckets[scope] = []; order.push(buckets[scope]); }
                buckets[scope].push(c);
            });
            merged = order.map(function (groupList) {
                if (groupList.length === 1) {
                    var single = groupList[0];
                    if (!single.guideOnly) {
                        single.variants = [toVariantRecord(single, single._cleanGroup)];
                        single._mergedIds = [single.id];
                    }
                    return single;
                }
                groupList.sort(function (a, b) {
                    if (b._qScore !== a._qScore) { return b._qScore - a._qScore; }
                    return a._idx - b._idx;
                });
                var primary = cloneChannel(groupList[0]);
                // Prefer a general category name over dedicated "4K" / "HEVC" sub-bouquet when available
                var prefGroup = primary._cleanGroup;
                if (/\b(4k|uhd|hevc|vip)\b/i.test(prefGroup)) {
                    for (var j = 0; j < groupList.length; j++) {
                        if (!/\b(4k|uhd|hevc)\b/i.test(groupList[j]._cleanGroup)) { prefGroup = groupList[j]._cleanGroup; break; }
                    }
                }
                primary._cleanGroup = prefGroup;
                primary.group = prefGroup;
                primary._mergedIds = [];
                primary.variants = [];
                var firstArch = null;
                groupList.forEach(function (v) {
                    primary._mergedIds.push(v.id);
                    primary.variants.push(toVariantRecord(v, v._cleanGroup));
                    if (!primary.logo && v.logo) { primary.logo = v.logo; }
                    if (!primary.tvgId && v.tvgId) { primary.tvgId = v.tvgId; }
                    if (!firstArch && v.archive && v.archiveDays > 0 && v.streamId) { firstArch = v; }
                });
                if (!primary.archive && firstArch) {
                    primary.archive = true;
                    primary.archiveDays = firstArch.archiveDays;
                    primary._archiveVariant = { archive: true, archiveDays: firstArch.archiveDays, streamId: firstArch.streamId, _playlistId: firstArch._playlistId };
                }
                return primary;
            });
        } else {
            merged = cleaned;
        }

        // Stage D: Country/language priority boost (preserving relative order per bucket)
        var countries = cfg.countries || [];
        if (countries.length) {
            var rankMap = {};
            countries.forEach(function (code, rIdx) { rankMap[code] = rIdx; });
            merged.forEach(function (c, i) { c._sortPos = i; });
            merged.sort(function (a, b) {
                var ra = Object.prototype.hasOwnProperty.call(rankMap, a._country) ? rankMap[a._country] : 1000;
                var rb = Object.prototype.hasOwnProperty.call(rankMap, b._country) ? rankMap[b._country] : 1000;
                if (ra !== rb) { return ra - rb; }
                return a._sortPos - b._sortPos;
            });
        }
        return merged;
    }

    function build(channels) {
        var groups = [], byGroup = {}, byId = {};
        channels.forEach(function (c) {
            byId[c.id] = c;
            if (Array.isArray(c._mergedIds)) {
                c._mergedIds.forEach(function (mid) { if (!byId[mid]) { byId[mid] = c; } });
            }
            if (c.guideOnly) { return; }   // (its TV guide alone: the Guide tab, no row)
            var key = c.type + '|' + c.group;
            if (!byGroup[key]) { byGroup[key] = []; groups.push({ type: c.type, name: c.group }); }
            byGroup[key].push(c);
        });
        var catalogs = groups.map(function (g) {
            var prefix = g.type === 'radio' ? 'iptv_radio_' : g.type === 'sport' ? 'iptv_sport_' : 'iptv_';
            return { type: g.type, id: prefix + idOf(g.name, g.type + '|' + g.name), name: g.name,
                extra: [{ name: 'search' }], _group: g.name };
        });
        var d = { ts: Date.now(), channels: channels, groups: groups, byId: byId, byGroup: byGroup, catalogs: catalogs };
        favCatalog(d);
        return d;
    }
    function buildView(rawChannels) {
        _rawChannels = rawChannels || [];
        var cfg = getTidyCfg();
        var display = cfg.enabled ? tidyChannels(_rawChannels, cfg) : _rawChannels;
        return build(display);
    }
    function rebuild() {
        if (!_rawChannels) { return _cache; }
        _sources = null;
        _cache = buildView(_rawChannels);
        if (typeof EPG !== 'undefined' && EPG.start) { setTimeout(function () { EPG.start(); }, 0); }
        return _cache;
    }

    function tagChannels(channels, playlistId) {
        channels.forEach(function (c) {
            c.id = 'iptv:' + playlistId + ':' + c.id.slice(5);
            c._playlistId = playlistId;
        });
        return channels;
    }
    // The playlist a channel came from, by name (shown with its group). A playlist named
    // only by its server's address says nothing more when there's just one playlist.
    var _sources = null;   // playlist id -> that, worked out once (a row may list thousands)
    function sourceOf(c) {
        if (!_sources) {
            _sources = {};
            var list = getPlaylists();
            list.forEach(function (p) {
                var st = _status[p.id];
                _sources[p.id] = (p.name || (st && st.title) || list.length > 1) ? label(p) : '';
            });
        }
        return _sources[c._playlistId] || '';
    }

    function loadOne(playlist, force) {
        var st = { id: playlist.id, url: playlist.url, count: 0, groups: 0, error: '', uncached: false, title: '', fetchedAt: 0, stale: false };
        _status[playlist.id] = st;
        if (/^http:/i.test(playlist.url)) {   // (Settings › Diagnostics › Logs)
            U.log('iptv', 'Playlist “' + label(playlist) + '” is downloaded over unencrypted http:// — anyone on the network path can see or change it (and ' + (isStalker(playlist) ? 'its MAC address' : 'any username / password in its link') + ')');
        }
        var src = playlist.url + (playlist.mac ? '#mac=' + playlist.mac : '') + (playlist.genres ? '#genres=' + playlist.genres.join(',') : '') + (playlist.groups ? '#groups=' + playlist.groups.map(encodeURIComponent).join(',') : '');   // (its saved copy: this portal, MAC and groups')
        var useXtLive = isXtream(playlist.url) && typeof YTPlay !== 'undefined' && YTPlay.xtliveList && (!YTPlay.installMode || YTPlay.installMode() !== 'browser');
        var useServiceM3U = !isStalker(playlist) && !isXtream(playlist.url) && /^https?:\/\//i.test(playlist.url) && typeof YTPlay !== 'undefined' && YTPlay.m3uLoad && YTPlay.m3uChannels && (!YTPlay.installMode || YTPlay.installMode() !== 'browser');

        function xtLiveToChannel(c, seen) {
            var sid = +c.id || 0;
            return {
                id: channelId(c, seen),
                type: 'tv',
                name: c.name || '',
                group: c.group || 'Live TV',
                logo: c.logo || '',
                tvgId: c.tvgId || '',
                url: c.url || '',
                streamId: sid,
                archive: !!c.archive,
                archiveDays: +c.archiveDays || 0
            };
        }

        function serviceM3UToChannel(c, seen) {
            var u = c.url || '';
            var out = {
                id: channelId(c, seen),
                type: c.type || 'tv',
                name: c.name || '',
                logo: c.logo || '',
                group: c.group || 'Live TV',
                tvgId: c.tvgId || '',
                ua: c.ua || '',
                ref: c.ref || '',
                radio: !!c.radio,
                sport: !!c.sport,
                url: u,
                _yt: /^https?:\/\/(?:[^\/]+\.)?youtube\.com(?::\d+)?(?:\/|$)/i.test(u) || /^https?:\/\/youtu\.be(?::\d+)?(?:\/|$)/i.test(u)
            };
            if (c.cookie) { out.cookie = c.cookie; }
            if (c.drm) { out.drm = c.drm; }
            if (c.guideOnly) { out.guideOnly = true; }
            if (c.vod) { out.vod = true; }
            return out;
        }

        // An M3U's chosen groups as a set (null: all; an Xtream account's and a portal's are read
        // by their own APIs)
        function groupSet() {
            if (!Array.isArray(playlist.groups) || !playlist.groups.length || isXtream(playlist.url) || isStalker(playlist)) { return null; }
            var allow = Object.create(null);
            playlist.groups.forEach(function (g) { allow[g] = true; });
            return allow;
        }

        function finish(text, at) {
            st.fetchedAt = at || 0;
            if (isXtream(playlist.url) && text && text.charAt(0) === '[') {
                var arr = [];
                try { arr = JSON.parse(text); } catch (e) { arr = []; }
                if (!Array.isArray(arr)) { arr = []; }
                _sources = null;
                var xseen = {}, xmax = maxChannels();
                if (xmax && arr.length > xmax) { st.dropped = (st.dropped || 0) + (arr.length - xmax); arr = arr.slice(0, xmax); }   // (Settings › IPTV › Largest playlist: as an M3U's)
                return Promise.resolve(counted(tagChannels(arr.map(function (c) { return xtLiveToChannel(c, xseen); }), playlist.id)));
            }
            var m3uOnly = groupSet();   // (an M3U's chosen groups: picked out as it's read, see m3uReader)
            return parseM3UAsync(text, maxChannels(), function (n) { progress(playlist.id, n); }, m3uOnly).then(function (r) {
                if (r.dropped) { st.dropped = r.dropped; }   // (kept to what the TV can hold; the rest dropped, and said so)
                st.title = r.title || '';
                st.guides = r.guides || [];
                _sources = null;
                // An Xtream account's films and episodes: its Movies and Series (js/xtvod.js), not channels
                var channels = r.channels;
                if (isXtream(playlist.url) && typeof XtVod !== 'undefined' && XtVod.hidesVodLines && XtVod.hidesVodLines(playlist.id)) {
                    channels = channels.filter(function (c) { return !XTREAM_VOD.test(c.url); });
                    st.vodLines = r.channels.length - channels.length;
                }
                if (!isXtream(playlist.url) && !isStalker(playlist)) { st.groupList = r.groupList; }
                return counted(tagChannels(channels, playlist.id));
            });
        }
        function counted(channels) {
            var groups = {};
            channels.forEach(function (c) { groups[c.type + '|' + c.group] = 1; });
            st.count = channels.length;
            st.groups = Object.keys(groups).length;
            if (!channels.length && !st.error && !st.vodLines) {
                st.error = U.t('No channels parsed (is the URL returning the .m3u file?)');
            }
            return channels;
        }

        var keepText = true;   // (a read the TV shouldn't keep: see xtliveText)
        function serviceM3ULoad() {
            return YTPlay.m3uLoad(playlist.url, playlist.groups, force).then(function (r) {
                if (!r || r.state === 'failed' || (r.error && !r.stale)) {
                    throw new Error((r && r.error) || U.t('Could not fetch the playlist URL'));
                }
                if (r.stale) {
                    st.stale = true;
                    if (r.error) { st.error = r.error; }
                }
                st.fetchedAt = r.at || Date.now();
                st.title = r.title || '';
                st.guides = r.guides || [];
                st.groupList = Array.isArray(r.groups) ? r.groups : [];
                if (r.dropped) { st.dropped = r.dropped; }
                return YTPlay.m3uChannels(playlist.url, playlist.groups);
            }).then(function (r) {
                if (!r || !Array.isArray(r.channels)) {
                    throw new Error(U.t('Could not fetch the playlist URL'));
                }
                // kept on the TV too (as the playlist itself is when the TV reads it): the channels
                // if the provider or the service can't be reached next time
                var at = st.fetchedAt || Date.now();
                if (!st.stale) { writePersist(playlist.id, src, SVC_SAVED + JSON.stringify(r.channels), at).then(function (ok) { st.uncached = !ok; }); }
                return fromService(r.channels);
            }, function (e) {
                st.error = (e && e.message) ? e.message : U.t('Could not fetch the playlist URL');
                return readPersist(playlist.id).then(function (prev) {
                    if (!(prev && prev.url === src && typeof prev.text === 'string' && prev.text.indexOf(SVC_SAVED) === 0)) { return []; }
                    var list = null;
                    try { list = JSON.parse(prev.text.slice(SVC_SAVED.length)); } catch (e2) { list = null; }
                    if (!Array.isArray(list)) { return []; }
                    st.stale = true; st.fetchedAt = prev.at || 0;   // (the channels are the saved copy's)
                    return fromService(list);
                });
            });
        }
        function fromService(list) {
            var seen = {}, max = maxChannels();
            var only = groupSet();   // (the service picked them out already, unless too many to name in a link)
            if (only) { list = list.filter(function (c) { return !!only[('' + (c.group || '')).trim()]; }); }
            if (max && list.length > max) {
                st.dropped = (st.dropped || 0) + (list.length - max);
                list = list.slice(0, max);
            }
            var channels = list.map(function (c) { return serviceM3UToChannel(c, seen); });
            _sources = null;
            return counted(tagChannels(channels, playlist.id));
        }

        if (useServiceM3U) {
            return serviceM3ULoad();
        }

        var saved = force ? Promise.resolve(null) : readPersist(playlist.id);
        return saved.then(function (p) {
            if (p && p.url === src && typeof p.text === 'string' && p.text.indexOf(SVC_SAVED) !== 0) { return finish(p.text, p.at); }
            return fetchIt();
        });
        // A Stalker portal's channels, from the service (see stalkerCheck): its M3U text.
        function stalkerText() {
            if (typeof YTPlay === 'undefined' || !YTPlay.stalkerList) { return Promise.reject(new Error(U.t('Stalker portals are read by StremioK’s service (not in a desktop browser)'))); }
            return YTPlay.stalkerList(playlist.url, playlist.mac, stalkerAll(), playlist.genres).then(function (r) {
                if (r && typeof r.m3u === 'string') {
                    if (r.cut) {   // (stopped short: said, with what's there)
                        st.cut = r.cut.total || true;
                        U.log('iptv', 'Stalker portal “' + label(playlist) + '”: read ' + (r.count || 0) + ' channels' + (r.cut.total ? ' of ' + r.cut.total : '') + ', and stopped' + (r.cut.why ? ' (' + r.cut.why + ')' : ''));
                    }
                    return r.m3u;
                }
                var why = (r && r.why) || U.t('no answer');
                throw new Error(r && r.refused ? U.t('The portal refused it: {why}', { why: why }) : U.t('Couldn’t read the portal: {why}', { why: why }));
            }, function (e) {
                throw new Error(/no service/.test((e && e.message) || '') ? U.t('Stalker portals are read by StremioK’s service (not in a desktop browser)') : U.t('Couldn’t reach StremioK’s service: {why}', { why: U.problem(e) }));
            });
        }
        function xtliveText() {
            var x = xtreamParts(playlist.url);
            if (!x || !x.user || !x.pass) { return Promise.reject(new Error(U.t('Invalid Xtream account'))); }
            return YTPlay.xtliveList(x.base, x.user, x.pass, xtreamFormat(playlist.id) || 'ts', playlist.groups, force).then(function (r) {
                if (!r || !Array.isArray(r.channels)) { throw new Error((r && r.error) || U.t('Couldn’t read the Xtream account')); }
                if (r.dropped) { st.dropped = r.dropped; }
                if (!r.at) { keepText = false; }   // (read without its categories: not kept, read again next time)
                return JSON.stringify(r.channels);
            });
        }
        function fetchIt() {
            var ask = isStalker(playlist) ? stalkerText() : (useXtLive ? xtliveText() : U.getText(playlist.url, 15000 * sizeMb() / 20, playlistMax()));
            return ask.then(function (text) {
                var at = Date.now();
                return (keepText ? writePersist(playlist.id, src, text, at) : Promise.resolve(false)).then(function (ok) {
                    st.uncached = !ok;
                    return finish(text, at);
                });
            }, function (e) {
                var msg = (e && e.message) ? e.message : U.t('Could not fetch the playlist URL');
                // status 0 / network error on a URL that opens fine in a browser almost
                // always means the server sent no Access-Control-Allow-Origin header.
                if (!isStalker(playlist) && (/HTTP 0\b/.test(msg) || /Network error|^No answer/i.test(msg))) {
                    msg += U.t(' — the playlist server likely isn\'t sending an Access-Control-Allow-Origin header (CORS). Serve the .m3u with CORS enabled.');
                }
                st.error = msg;
                // Fall back to this playlist's saved copy so a failed refresh doesn't wipe it.
                return readPersist(playlist.id).then(function (prev) {
                    if (!(prev && prev.url === src && typeof prev.text === 'string') || prev.text.indexOf(SVC_SAVED) === 0) { return []; }
                    st.stale = true;   // (the channels are the saved copy's)
                    return finish(prev.text, prev.at);
                });
            });
        }
    }

    // Progress while playlists are read: onProgress(fn) -> fn(channels read so far, all playlists).
    var _progress = {}, _progressFns = [];
    function progress(id, n) {
        _progress[id] = n;
        var total = 0;
        for (var k in _progress) { if (Object.prototype.hasOwnProperty.call(_progress, k)) { total += _progress[k]; } }
        _progressFns.forEach(function (fn) { try { fn(total); } catch (e) {} });
    }
    function onProgress(fn) { _progressFns.push(fn); }
    function isReady() { return !!_cache; }   // (the playlists read: synthAddon has their channels)

    // Each playlist is fetched once and saved (the big store). Passing a playlist id
    // forces only that entry to refresh; true refreshes every configured playlist.
    function load(forceId) {
        var playlists = getPlaylists().filter(function (p) { return !p.off; });   // (switched off: not read)
        if (!playlists.length) {
            _cache = buildView([]);
            if (typeof EPG !== 'undefined' && EPG.start) { setTimeout(EPG.start, 0); }   // (their guides dropped: no Guide tab)
            return Promise.resolve(_cache);
        }
        if (!forceId && _cache) { return Promise.resolve(_cache); }
        if (!forceId && _pending && _pending.rev === _rev) { return _pending.p; }   // (one under way: shared)
        var rev = _rev;
        var tasks = playlists.map(function (p) {
            return function () { return loadOne(p, forceId === true || forceId === p.id); };
        });
        _progress = {};
        var pr = U.settleAll(tasks, 3).then(function (results) {
            if (_pending && _pending.p === pr) { _pending = null; }
            if (rev !== _rev) { return load(); }   // (the playlists changed meanwhile)
            // All playlists together; a channel listed more than once (exactly the same: link,
            // name, group and the headers it's played with) once, from the first playlist that
            // has it. The same link under another name, group, User-Agent or Referer is a
            // channel of its own (a provider may need its own headers for it).
            var channels = [], seen = {};
            results.forEach(function (r) {
                if (!r.ok || !r.value) { return; }
                r.value.forEach(function (c) {
                    var k = sameKey(c);
                    if (!seen[k]) { seen[k] = 1; channels.push(c); }
                });
            });
            _cache = buildView(channels);
            if (typeof EPG !== 'undefined' && EPG.start) { setTimeout(EPG.start, 0); }   // (their TV guides: see js/epg.js)
            return _cache;
        });
        _pending = { rev: rev, p: pr };
        return pr;
    }

    function sameKey(c) {
        var p = U.parseUrl(c.url);   // (scheme and host in lower case)
        return [p ? p.href : c.url, c.name, c.group, c.type, c.ua || '', c.ref || '', c.cookie || ''].join('\u0001');
    }

    function reload(id) {   // (its TV guide read again too: EPG.start)
        reset();
        return load(id || true).then(function (d) {
            if (typeof EPG !== 'undefined' && EPG.start) { EPG.start(id || true); }
            return d;
        });
    }
    // Auto-refresh (Settings › Content › IPTV): every this many hours (0: Off), all playlists and
    // their guides downloaded again, as Reload does (the Home ticker: see view-home's
    // iptvRefreshTick). EVERY: the choices.
    var EVERY_KEY = 'stremiok.iptv.every', EVERY = [0, 1, 3, 6, 12];
    function refreshEvery() { var h = +U.store.get(EVERY_KEY, 0); return EVERY.indexOf(h) !== -1 ? h : 0; }
    function setRefreshEvery(h) { h = +h; U.store.set(EVERY_KEY, EVERY.indexOf(h) !== -1 ? h : 0); }
    // When the playlists switched on were last downloaded: the oldest of them (a saved copy's own
    // date), 0 when one never was.
    function readAt() {
        var on = getPlaylists().filter(function (p) { return !p.off; }), t = Infinity;
        on.forEach(function (p) { var st = _status[p.id]; t = Math.min(t, st && st.fetchedAt ? st.fetchedAt : 0); });
        return on.length ? t : Infinity;
    }
    function status(id) {
        if (id) { return _status[id] || { id: id, url: '', count: 0, groups: 0, error: '', title: '', fetchedAt: 0 }; }
        return _status;
    }

    function toMeta(c) {
        return {
            id: c.id, type: c.type, name: c.name,
            poster: c.logo || '', background: c.logo || '', logo: c.logo || '',
            posterShape: 'landscape', description: c.group + (sourceOf(c) ? '  ·  ' + U.t('from {source}', { source: sourceOf(c) }) : '')
        };
    }

    function catalog(catId, extra) {
        return load().then(function (d) {
            var cat = null;
            for (var i = 0; i < d.catalogs.length; i++) {
                if (d.catalogs[i].id === catId) { cat = d.catalogs[i]; break; }
            }
            if (!cat) { return []; }
            var q = (extra && extra.search) ? ('' + extra.search).toLowerCase() : '';
            var out = [];
            var list = [];
            if (cat._favs) {
                var seenFav = {};
                favs().forEach(function (id) {
                    var fc = d.byId[id];
                    if (fc && !seenFav[fc.id]) { seenFav[fc.id] = 1; list.push(fc); }
                });
            } else {
                list = d.byGroup[cat.type + '|' + cat._group] || [];
            }
            list.forEach(function (c) {
                if (q && c.name.toLowerCase().indexOf(q) === -1) { return; }
                out.push(toMeta(c));
            });
            // Discover pages through a group 100 channels at a time (Home takes them all)
            if (extra && extra.skip != null) { var sk = parseInt(extra.skip, 10) || 0; return out.slice(sk, sk + 100); }
            return out;
        });
    }

    function meta(id) {
        return load().then(function (d) { var c = d.byId[id]; return c ? toMeta(c) : null; });
    }

    // An Xtream channel's link (…/live/user/pass/id.ext) can lead anywhere, YouTube among them
    // (a provider's "Alt" channel): looked at once it failed to play (the player's failedStart; not
    // before every tune: a second connection to a one-connection account can cut the stream, and
    // it costs the tune a round trip), redirects followed, its headers only, within YT_PROBE_MS. Resolves the YouTube page it ends on, or ''. Where it led
    // is kept YT_KEEP_MS, or until the playlists reload (reset): a server can renumber its
    // channels, and the same link then leads somewhere else.
    var XTREAM_LIVE = /^https?:\/\/[^\/]+(?:\/[^?#]*)?\/live\/[^\/?#]+\/[^\/?#]+\/\d+(?:\.[a-z0-9]{2,4})?(?:[?#]|$)/i, YT_PROBE_MS = 4000, YT_KEEP_MS = 5 * 60000;
    function isYouTube(u) { return /^https?:\/\/(?:[^\/]+\.)?youtube\.com(?::\d+)?(?:\/|$)/i.test(u) || /^https?:\/\/youtu\.be(?::\d+)?(?:\/|$)/i.test(u); }
    function youTubeEnd(url) {
        if (!XTREAM_LIVE.test(url)) { return Promise.resolve(''); }
        var kept = Object.prototype.hasOwnProperty.call(_ytEnds, url) ? _ytEnds[url] : null;
        if (kept && Date.now() - kept.at < YT_KEEP_MS) { return Promise.resolve(kept.page); }
        return new Promise(function (resolve) {
            var x = null, done = false;
            function end(page) { if (done) { return; } done = true; clearTimeout(t); try { x.abort(); } catch (e) {} _ytEnds[url] = { page: page, at: Date.now() }; resolve(page); }
            var t = setTimeout(function () { done = true; try { x.abort(); } catch (e) {} resolve(''); }, YT_PROBE_MS);   // (not remembered: asked again next time)
            try {
                x = new XMLHttpRequest();
                x.open('GET', url, true);
                x.onreadystatechange = function () {
                    if (x.readyState < 2) { return; }
                    var to = '' + (x.responseURL || '');
                    end(isYouTube(to) ? to : '');
                };
                x.onerror = function () { end(''); };
                x.send();
            } catch (e) { end(''); }
        });
    }
    function streams(id) {
        return load().then(function (d) {
            var c = d.byId[id];
            if (!c || c.guideOnly) { return []; }
            var list = getPlaylists();
            function own(x) {   // (one copy: YouTube, a portal's link asked for now, else its link)
                var xpl = list[find(list, x._playlistId)];
                if (x._yt) { return Promise.resolve([{ url: x.url, _yt: true, ytPage: x.url, name: x.name || c.name, title: 'YouTube · ' + (x.group || c.group) }]); }
                if (isStalker(xpl)) { return stalkerStreams(x, xpl); }
                return Promise.resolve(plainStreams(x));
            }
            var variants = (Array.isArray(c.variants) && c.variants.length > 1) ? c.variants : null;
            if (!variants) { return own(c); }
            // best first: what each played as when known, else what its name says
            variants = variants.map(function (v, i) {
                var m = measured(v.url), backup = /Backup/.test(v.badge || '');
                return { v: v, i: i, score: m ? measuredScore(m) - (backup ? 150 : 0) : (v.score || 0) };
            }).sort(function (a, b) { return (b.score - a.score) || (a.i - b.i); }).map(function (x) { return x.v; });
            return Promise.all(variants.map(function (v) {
                var q = measuredLabel(v.url) || v.badge || '', label = (q ? q + ' · ' : '') + (v.rawName || v.name), from = sourceOf(v);
                return own(v).then(function (l) {
                    return l.map(function (st) {   // (what the source lists show: its quality and the provider's name for it)
                        st.name = label;
                        st.title = [st._yt ? 'YouTube' : '', v.group, from].filter(Boolean).join(' · ');
                        return st;
                    });
                });
            })).then(function (lists) {
                var out = [];
                lists.forEach(function (l) { out.push.apply(out, l); });
                return out.length ? out : own(c);
            });   // (an Xtream link leading to YouTube is found only if it fails: the player asks youTubeEnd then)
        });
    }
    function plainStreams(c) {
        var from = sourceOf(c);
        var st = { url: c.url, name: c.name, title: 'IPTV · ' + c.group + (from ? ' · ' + from : '') };
        if (c.vod) { st._vod = true; }
        if (c.drm) {   // (see the player's drmSetup and startShaka)
            st._drm = { sys: c.drm.sys || 'other', url: c.drm.url || '', h: c.drm.h || {}, b64: !!c.drm.b64, ok: drmPlayable(c.drm), shaka: drmShaka(c.drm) };
            if (c.drm.keys) { st._drm.keys = c.drm.keys; }
        }
        var h = U.sanitizeHeaders({ ua: c.ua, ref: c.ref, cookie: c.cookie });   // (only what the player takes, checked)
        if (h) { st._headers = h; }
        return [st];
    }

    // A Stalker portal's channel: its link asked for now (create_link: most portals' links work for
    // a short while, or once), played with a MAG User-Agent. None given: the one in its playlist,
    // unless that's a stand-in (http://localhost/ch/…), which plays nothing.
    function stalkerStreams(c, pl) {
        var asked = typeof YTPlay !== 'undefined' && YTPlay.stalkerLink ? YTPlay.stalkerLink(pl.url, pl.mac, c.url) : Promise.reject(new Error('no service'));
        return asked.then(function (r) {
            if (r && r.url) { return r.url; }
            U.log('iptv', 'Stalker: no link for “' + c.name + '” (' + ((r && r.why) || 'no answer') + ')');
            return '';
        }, function (e) { U.log('iptv', 'Stalker: no link for “' + c.name + '” (' + U.problem(e) + ')'); return ''; }).then(function (url) {
            if (!url && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(c.url)) { return []; }
            var st = plainStreams(c)[0];
            st.url = url || c.url;
            var h = U.sanitizeHeaders({ ua: STB_UA, ref: c.ref, cookie: c.cookie });
            if (h) { st._headers = h; }
            return [st];
        });
    }

    // A local addon object shaped like the HTTP addons in Stremio.loadAddons().
    // `__local` tells Stremio to route resource calls here instead of over HTTP.
    function synthAddon() {
        var d = _cache || build([]);
        return {
            __local: true, url: 'local:iptv', base: 'local:iptv',
            manifest: {
                id: 'org.stremiok.iptv', name: 'IPTV', version: '1.0.0',
                types: ['tv', 'radio', 'sport'], resources: ['catalog', 'meta', 'stream'],
                idPrefixes: ['iptv:'], catalogs: d.catalogs
            }
        };
    }

    return {
        getPlaylists: getPlaylists, addPlaylist: addPlaylist, updatePlaylist: updatePlaylist,
        removePlaylist: removePlaylist, renamePlaylist: renamePlaylist, setPlaylistOff: setPlaylistOff,
        movePlaylist: movePlaylist, setPlaylistGuide: setPlaylistGuide, label: labelOf,
        macOf: macOf, stbUa: STB_UA, stalkerPortal: stalkerPortal, stalkerCheck: stalkerCheck, addStalker: addStalker, isStalker: isStalker, stalkerAll: stalkerAll, setStalkerAll: setStalkerAll, stalkerGroups: stalkerGroups, setStalkerGroups: setStalkerGroups,
        xtreamParts: xtreamParts, xtreamUrl: xtreamUrl, xtreamCheck: xtreamCheck, addXtream: addXtream, xtreamFormat: xtreamFormat, setXtreamFormat: setXtreamFormat, xtreamGroups: xtreamGroups, m3uGroups: m3uGroups, setPlaylistGroups: setPlaylistGroups, setXtreamNoVod: setXtreamNoVod,
        setArchiveOffset: setArchiveOffset, catchupUrl: catchupUrl,
        getTidyCfg: getTidyCfg, setTidyCfg: setTidyCfg, countryList: normalizeCountryList, youTubeEnd: youTubeEnd, noteMeasured: noteMeasured, measuredLabel: measuredLabel, tidyChannels: tidyChannels, rebuild: rebuild,
        isFavorite: isFavorite, setFavorite: setFavorite, refreshEvery: refreshEvery, setRefreshEvery: setRefreshEvery, readAt: readAt,
        sizeMb: sizeMb, setSizeMb: setSizeMb, maxChannels: maxChannels, SIZES: SIZES,
        channels: function () { return _cache ? _cache.channels : []; }, channel: function (id) { return _cache ? _cache.byId[id] || null : null; }, isEnabled: isEnabled, reset: reset, status: status,
        load: load, reload: reload, catalog: catalog, meta: meta, streams: streams, synthAddon: synthAddon, isReady: isReady,
        onProgress: onProgress
    };
})();
