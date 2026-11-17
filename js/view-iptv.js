/* ViewParts: 3-Pane Split Live TV Browser on the IPTV tab (js/view-home.js, index.html).
   Renders virtualized/windowed Categories Rail (11 rows max), Channel List (10 rows max),
   and EPG/Variant/Action Inspector over frosted glass behind live playing video. */
(function (V) {
    'use strict';
    function scr() { return V.scr.apply(null, arguments); }
    function pickList() { return V.pickList.apply(null, arguments); }
    function refreshAddonRows() { return V.refreshAddonRows.apply(null, arguments); }

    var CAT_ROWS = 11;
    var CHAN_ROWS = 10;
    function visibleCatRows() {
        var h = _st.paneCatsEl && _st.paneCatsEl.clientHeight;
        if (!h || h <= 0) { return CAT_ROWS; }
        return Math.max(5, Math.min(CAT_ROWS, Math.floor((h - 24) / 66)));
    }
    function visibleChanRows() {
        var h = _st.paneChansEl && _st.paneChansEl.clientHeight;
        if (!h || h <= 0) { return CHAN_ROWS; }
        return Math.max(5, Math.min(CHAN_ROWS, Math.floor((h - 24) / 80)));
    }
    var RECENT_KEY = 'stremiok.iptv.recent';
    var RECENT_MAX = 25;
    var MONO_COLORS = ['#4f46e5', '#0f766e', '#0369a1', '#9333ea', '#be123c', '#b45309', '#15803d', '#334155'];

    var _st = {
        mounted: false,
        wrap: null,
        cats: [],
        chans: [],
        grpKey: '',
        chanIdx: 0,
        winTop: 0,
        catIdx: 0,
        catTop: 0,
        lastChanByGrp: {},
        filterText: '',
        digits: '',
        digitTimer: null,
        catDebounce: null,
        epgTimer: null,
        epgUiTimer: null,
        inspTimer: null,
        inspForId: '',
        schedCache: {},
        schedAsked: {},
        catNodes: [],
        chanNodes: [],
        unsubLive: null,
        unsubEpg: false,
        paneCatsEl: null,
        paneChansEl: null,
        paneInspEl: null,
        hudEl: null,
        toolbarFirstEl: null,
        toolbarEl: null,
        emptyCta: null,
        digitBannerEl: null
    };

    function hhmm(sec) {
        if (typeof EPG !== 'undefined' && EPG.hhmm) { return EPG.hhmm(sec); }
        var d = new Date(sec * 1000);
        return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    }

    function recentIds() {
        var list = U.store.get(RECENT_KEY, []) || [];
        return Array.isArray(list) ? list.filter(function (x) { return typeof x === 'string'; }) : [];
    }
    function pushRecent(id) {
        if (!id) { return; }
        var next = [id].concat(recentIds().filter(function (x) { return x !== id; })).slice(0, RECENT_MAX);
        U.store.set(RECENT_KEY, next);
    }

    function isChannelPlaying(ch) {
        if (!ch || typeof Player === 'undefined' || !Player.isLivePlaying || !Player.isLivePlaying()) { return false; }
        var curId = Player.currentLiveId ? Player.currentLiveId() : '';
        if (!curId) { return false; }
        if (ch.id === curId) { return true; }
        return Array.isArray(ch._mergedIds) && ch._mergedIds.indexOf(curId) !== -1;
    }

    function logoInitials(name) {
        var words = ('' + (name || '?')).trim().split(/\s+/).filter(Boolean);
        if (!words.length) { return '?'; }
        if (words.length >= 2) { return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase(); }
        return words[0].slice(0, 2).toUpperCase();
    }
    function hashColor(name) {
        var h = 0, s = '' + (name || '');
        for (var i = 0; i < s.length; i++) { h = ((h * 31) + s.charCodeAt(i)) | 0; }
        return MONO_COLORS[Math.abs(h) % MONO_COLORS.length];
    }
    function buildLogoEl(ch, cls) {
        var box = U.el('div', cls || 'iptv-logo-box');
        var mono = U.el('div', 'iptv-monogram', logoInitials(ch.name));
        mono.style.background = hashColor(ch.name);
        box.appendChild(mono);
        var url = ch.logo || (typeof EPG !== 'undefined' && EPG.logo ? EPG.logo(ch.id) : '');
        if (url) {
            var img = U.el('img', 'iptv-logo');
            img.decoding = 'async';
            img.alt = '';
            img.onload = function () { mono.style.display = 'none'; };
            img.onerror = function () { if (img.parentNode) { img.parentNode.removeChild(img); } mono.style.display = ''; };
            img.src = url;
            box.appendChild(img);
        }
        return box;
    }

    function buildGroups(filterText) {
        var allRaw = (typeof IPTV !== 'undefined' && IPTV.channels) ? IPTV.channels() : [];
        var q = (filterText || '').trim().toLowerCase();
        var live = allRaw.filter(function (c) {
            if (!c || c.guideOnly || c.radio) { return false; }
            if (q && (c.name || '').toLowerCase().indexOf(q) === -1 && (c.group || '').toLowerCase().indexOf(q) === -1) { return false; }
            return true;
        });

        var groups = [];
        var favList = (typeof IPTV !== 'undefined' && IPTV.isFavorite) ? live.filter(function (c) { return IPTV.isFavorite(c.id); }) : [];
        if (favList.length) { groups.push({ key: '__fav__', label: U.t('★ Favorites'), list: favList }); }

        var byId = {};
        live.forEach(function (c) {
            byId[c.id] = c;
            if (Array.isArray(c._mergedIds)) { c._mergedIds.forEach(function (mid) { if (!byId[mid]) { byId[mid] = c; } }); }
        });
        var recSeen = {}, recList = [];
        recentIds().forEach(function (rid) {
            var match = byId[rid];
            if (match && !recSeen[match.id]) { recSeen[match.id] = 1; recList.push(match); }
        });
        if (recList.length) { groups.push({ key: '__rec__', label: U.t('Recent'), list: recList }); }

        groups.push({ key: '__all__', label: U.t('All channels'), list: live });

        var grpMap = {};
        live.forEach(function (c) {
            var gname = c.group || U.t('Live TV');
            var k = 'g:' + gname;
            if (!grpMap[k]) {
                grpMap[k] = { key: k, label: gname, list: [] };
                groups.push(grpMap[k]);
            }
            grpMap[k].list.push(c);
        });
        return { all: live, groups: groups };
    }

    function currentGroupObj() {
        for (var i = 0; i < _st.cats.length; i++) {
            if (_st.cats[i].key === _st.grpKey) { return _st.cats[i]; }
        }
        return _st.cats[0] || { key: '__all__', label: U.t('All channels'), list: [] };
    }

    function updateMiniHud() {
        var hud = _st.hudEl;
        if (!hud) { return; }
        var cur = Focus.current();
        var restoreTb = (cur && hud.contains(cur) && cur.getAttribute) ? cur.getAttribute('data-tb') : '';
        U.clear(hud);
        if (typeof Player === 'undefined' || !Player.isLivePlaying || !Player.isLivePlaying()) {
            hud.className = 'iptv-hud hidden';
            return;
        }
        var meta = Player.liveMeta ? Player.liveMeta() : null;
        if (!meta) { hud.className = 'iptv-hud hidden'; return; }
        hud.className = 'iptv-hud';
        var dot = U.el('span', 'iptv-hud-dot', '● ' + U.t('LIVE'));
        var nm = U.el('span', 'iptv-hud-name', meta.name || '');
        hud.appendChild(dot);
        hud.appendChild(nm);
        if (meta.tags) {
            hud.appendChild(U.el('span', 'iptv-hud-tags', meta.tags));
        }
        if (meta.buffering) {
            hud.appendChild(U.el('span', 'iptv-hud-tags', U.t('Buffering…')));
        }
        var fullBtn = U.el('div', 'iptv-chip focusable', '▣ ' + U.t('Fullscreen'));
        fullBtn.setAttribute('data-tb', 'hud-full');
        fullBtn.__onselect = function () { if (Player.setBrowseOverlay) { Player.setBrowseOverlay(false); } };
        var stopBtn = U.el('div', 'iptv-chip iptv-chip-stop focusable', U.t('Stop'));
        stopBtn.setAttribute('data-tb', 'hud-stop');
        stopBtn.__onselect = function () {
            Player.exit();   // (its BACK: the IPTV browser on the channel, see zapLiveChannel's onExited)
            var row = _st.chanNodes[_st.chanIdx - _st.winTop] || _st.chanNodes[0] || _st.toolbarFirstEl;
            if (row) { Focus.setScope(scr('home'), row); }
        };
        hud.appendChild(fullBtn);
        hud.appendChild(stopBtn);
        wireToolbarNav();
        if (restoreTb) {
            var target = (restoreTb === 'hud-stop') ? stopBtn : fullBtn;
            Focus.setFocus(target);
        }
    }

    function wireToolbarNav() {
        var bar = _st.wrap ? _st.wrap.querySelector('.iptv-toolbar') : null;
        if (!bar) { return; }
        var chips = bar.querySelectorAll('.iptv-chip.focusable');
        for (var i = 0; i < chips.length; i++) {
            (function (idx, node) {
                node.__goUP = function () { return undefined; };   // header tabs
                node.__goDOWN = function () { return _st.chanNodes[_st.chanIdx - _st.winTop] || _st.chanNodes[0] || _st.emptyCta || _st.catNodes[0] || false; };   // (the channel selected, not the window's first)
                node.__goLEFT = function () { return idx > 0 ? chips[idx - 1] : false; };
                node.__goRIGHT = function () { return idx < chips.length - 1 ? chips[idx + 1] : false; };
            })(i, chips[i]);
        }
        _st.toolbarFirstEl = chips[0] || null;
    }

    function renderToolbar() {
        var bar = U.el('div', 'iptv-toolbar');
        var left = U.el('div', 'iptv-tb-left');

        var filterBtn = U.el('div', 'iptv-chip focusable', _st.filterText ? ('🔍 ' + _st.filterText + ' ✕') : ('🔍 ' + U.t('Filter')));
        filterBtn.setAttribute('data-tb', 'filter');
        filterBtn.__onselect = function () {
            if (_st.filterText) {
                _st.filterText = '';
                redrawData(true);
                return;
            }
            App.openEntry({
                title: U.t('Filter IPTV channels'),
                hint: U.t('Type part of a channel or category name.'),
                value: _st.filterText || '',
                placeholder: U.t('e.g. TRT, BBC, Spor…'),
                onConfirm: function (val) {
                    _st.filterText = (val || '').trim();
                    App.back();
                    redrawData(true);
                }
            });
        };
        left.appendChild(filterBtn);

        var cfg = (typeof IPTV !== 'undefined' && IPTV.getTidyCfg) ? IPTV.getTidyCfg() : { enabled: true, countries: ['TR', 'UK', 'NL'] };
        var countryHint = cfg.countries && cfg.countries.length ? (' · ' + cfg.countries.join('/')) : '';
        var tidyBtn = U.el('div', 'iptv-chip focusable' + (cfg.enabled ? ' on' : ''), cfg.enabled ? ('◆ ' + U.t('Tidied') + countryHint) : U.t('Raw list'));
        tidyBtn.setAttribute('data-tb', 'tidy');
        tidyBtn.__onselect = function () {
            if (typeof IPTV === 'undefined' || !IPTV.setTidyCfg) { return; }
            var curId = (_st.chans[_st.chanIdx] && _st.chans[_st.chanIdx].id) || '';
            IPTV.setTidyCfg({ enabled: !cfg.enabled });
            IPTV.rebuild();
            refreshAddonRows('local:iptv');
            redrawData(false, curId, 'tidy');
        };
        left.appendChild(tidyBtn);

        ['__fav__', '__rec__', '__all__'].forEach(function (k) {
            var grp = null;
            for (var i = 0; i < _st.cats.length; i++) { if (_st.cats[i].key === k) { grp = _st.cats[i]; break; } }
            if (!grp) { return; }
            var btn = U.el('div', 'iptv-chip focusable' + (_st.grpKey === k ? ' on' : ''), grp.label + ' (' + grp.list.length + ')');
            btn.setAttribute('data-tb', k);
            btn.__onselect = function () { setActiveGroup(k, true); };
            left.appendChild(btn);
        });

        bar.appendChild(left);
        var hud = U.el('div', 'iptv-hud hidden');
        _st.hudEl = hud;
        bar.appendChild(hud);
        _st.toolbarEl = bar;
        return bar;
    }
    // The toolbar drawn again in place (its chips' counts: Recent after a channel plays), focus
    // kept on the chip it was on.
    function refreshToolbar() {
        var old = _st.toolbarEl;
        if (!old || !old.parentNode) { return; }
        var cur = Focus.current(), tb = (cur && old.contains(cur) && cur.getAttribute) ? cur.getAttribute('data-tb') : '';
        var bar = renderToolbar();
        old.parentNode.replaceChild(bar, old);
        wireToolbarNav();
        updateMiniHud();
        var again = tb ? bar.querySelector('[data-tb="' + tb + '"]') : null;
        if (again) { Focus.setFocus(again); }
    }

    function setActiveGroup(grpKey, focusCenter) {
        if (_st.grpKey !== grpKey) {
            _st.lastChanByGrp[_st.grpKey] = _st.chanIdx;
            _st.grpKey = grpKey;
            var gObj = currentGroupObj();
            _st.chans = gObj.list || [];
            var savedIdx = _st.lastChanByGrp[grpKey] || 0;
            _st.chanIdx = Math.max(0, Math.min(savedIdx, Math.max(0, _st.chans.length - 1)));
            _st.winTop = Math.max(0, Math.min(_st.chanIdx - Math.floor(CHAN_ROWS / 2), Math.max(0, _st.chans.length - CHAN_ROWS)));
            for (var i = 0; i < _st.cats.length; i++) { if (_st.cats[i].key === grpKey) { _st.catIdx = i; break; } }
            var cur = Focus.current();   // (focus on the categories: kept there as they're redrawn)
            renderCatsWindow(!!(cur && _st.paneCatsEl && _st.paneCatsEl.contains(cur)));
            renderChansWindow(true, false);
        }
        if (_st.toolbarEl) {   // (the Favorites / Recent / All chip of the group shown: marked)
            var chips = _st.toolbarEl.querySelectorAll('[data-tb]');
            for (var c = 0; c < chips.length; c++) {
                var k = chips[c].getAttribute('data-tb');
                if (/^__/.test(k)) { chips[c].classList[k === _st.grpKey ? 'add' : 'remove']('on'); }   // (not Filter / Tidied: their own state)
            }
        }
        if (focusCenter) {
            var target = _st.chanNodes[_st.chanIdx - _st.winTop] || _st.chanNodes[0] || _st.emptyCta;
            if (target) { Focus.setFocus(target); }
        }
    }

    function renderCatsWindow(setFocusHere) {
        var host = _st.paneCatsEl;
        if (!host) { return; }
        var catCap = visibleCatRows();
        if (_st.catIdx >= _st.cats.length) { _st.catIdx = Math.max(0, _st.cats.length - 1); }
        if (_st.catIdx < _st.catTop || _st.catIdx >= _st.catTop + catCap) { _st.catTop = _st.catIdx - Math.floor(catCap / 2); }
        _st.catTop = Math.max(0, Math.min(_st.catTop, Math.max(0, _st.cats.length - catCap)));

        U.clear(host);
        _st.catNodes = [];
        var visible = _st.cats.slice(_st.catTop, _st.catTop + catCap);
        var activeNode = null;
        visible.forEach(function (g, offset) {
            var abs = _st.catTop + offset;
            var row = U.el('div', 'iptv-cat focusable' + (g.key === _st.grpKey ? ' active' : ''));
            row.appendChild(U.el('span', 'iptv-cat-name', g.label));
            row.appendChild(U.el('span', 'iptv-cat-cnt', String(g.list.length)));
            row.__onselect = function () { setActiveGroup(g.key, true); };
            row.__goLEFT = function () { return false; };
            row.__goRIGHT = function () {
                if (_st.catDebounce) { clearTimeout(_st.catDebounce); _st.catDebounce = null; }
                setActiveGroup(g.key, true);
                return _st.chanNodes.length ? false : (_st.emptyCta || false);   // (an empty list: its button)
            };
            row.__goUP = function () {
                if (abs === 0) { return _st.toolbarFirstEl || undefined; }
                _st.catIdx = abs - 1;
                if (_st.catIdx < _st.catTop) { renderCatsWindow(true); return false; }
                return _st.catNodes[_st.catIdx - _st.catTop];
            };
            row.__goDOWN = function () {
                if (abs >= _st.cats.length - 1) { return false; }
                _st.catIdx = abs + 1;
                if (_st.catIdx >= _st.catTop + catCap) { renderCatsWindow(true); return false; }
                return _st.catNodes[_st.catIdx - _st.catTop];
            };
            row.__iptvFocus = function () {   // (focused: its channels shown once the remote settles)
                _st.catIdx = abs;
                if (_st.catDebounce) { clearTimeout(_st.catDebounce); }
                _st.catDebounce = setTimeout(function () {
                    _st.catDebounce = null;
                    setActiveGroup(g.key, false);
                }, 70);
            };
            host.appendChild(row);
            _st.catNodes.push(row);
            if (abs === _st.catIdx) { activeNode = row; }
        });
        if (setFocusHere && activeNode) { Focus.setFocus(activeNode); }
    }

    function requestVisibleEpg() {
        if (_st.epgTimer) { clearTimeout(_st.epgTimer); }
        _st.epgTimer = setTimeout(function () {
            _st.epgTimer = null;
            if (!_st.mounted || typeof EPG === 'undefined' || !EPG.want) { return; }
            var slice = _st.chans.slice(_st.winTop, _st.winTop + CHAN_ROWS + 6);
            if (slice.length) { EPG.want(slice.map(function (c) { return c.id; })); }
        }, 40);
    }

    function updateRowEpg(row, ch) {
        if (!row || !ch) { return; }
        var ep = (typeof EPG !== 'undefined' && EPG.now) ? EPG.now(ch.id) : null;
        var titleEl = row.querySelector('.iptv-row-epg');
        var fillEl = row.querySelector('.iptv-prog-fill');
        var barEl = row.querySelector('.iptv-prog-bar');
        var nextTitle = (ep && ep.now) ? (hhmm(ep.now.start) + ' ' + ep.now.title) : (ch.group || U.t('Live TV'));
        if (titleEl && titleEl.textContent !== nextTitle) { titleEl.textContent = nextTitle; }
        if (ep && ep.now) {
            if (barEl && fillEl) {
                var pct = Math.max(0, Math.min(100, Math.round(((Date.now() / 1000) - ep.now.start) / Math.max(1, ep.now.stop - ep.now.start) * 100)));
                if (barEl.style.display !== '') { barEl.style.display = ''; }
                var wStr = pct + '%';
                if (fillEl.style.width !== wStr) { fillEl.style.width = wStr; }
            }
        } else if (barEl && barEl.style.display !== 'none') {
            barEl.style.display = 'none';
        }
    }

    function updateInspectorEpg(ch) {
        var host = _st.paneInspEl;
        if (!host || !ch || ch.id !== _st.inspForId) { return; }
        var ep = (typeof EPG !== 'undefined' && EPG.now) ? EPG.now(ch.id) : null;
        var kEl = host.querySelector('.iptv-insp-epg .iptv-epg-kicker');
        var tEl = host.querySelector('.iptv-insp-epg .iptv-epg-main-title');
        var barEl = host.querySelector('.iptv-insp-bar');
        var fillEl = host.querySelector('.iptv-insp-fill');
        var dEl = host.querySelector('.iptv-insp-epg .iptv-epg-desc');
        if (!kEl || !tEl || !dEl) { return; }
        if (ep && ep.now) {
            var kTxt = '● ' + U.t('NOW') + '  ' + hhmm(ep.now.start) + '–' + hhmm(ep.now.stop);
            if (kEl.textContent !== kTxt) { kEl.textContent = kTxt; }
            if (tEl.style.display === 'none') { tEl.style.display = ''; }
            if (tEl.textContent !== ep.now.title) { tEl.textContent = ep.now.title; }
            if (barEl && fillEl) {
                if (barEl.style.display !== '') { barEl.style.display = ''; }
                var pct = Math.max(0, Math.min(100, Math.round(((Date.now() / 1000) - ep.now.start) / Math.max(1, ep.now.stop - ep.now.start) * 100)));
                fillEl.style.width = pct + '%';
            }
            var descTxt = ep.now.desc || '';
            if (dEl.textContent !== descTxt) { dEl.textContent = descTxt; }
            dEl.style.display = descTxt ? '' : 'none';
        }
    }

    function scheduleVisibleEpgRefresh() {
        if (!_st.mounted) { return; }
        if (_st.epgUiTimer) { clearTimeout(_st.epgUiTimer); }
        _st.epgUiTimer = setTimeout(function () {
            _st.epgUiTimer = null;
            updateVisibleEpg();
        }, 80);
    }

    function updateVisibleEpg() {
        if (!_st.mounted) { return; }
        _st.chanNodes.forEach(function (node) {
            if (node.__chan) { updateRowEpg(node, node.__chan); }
        });
        var cur = _st.chans[_st.chanIdx];
        if (!cur) { return; }
        if (cur.id === _st.inspForId) {
            updateInspectorEpg(cur);
        } else {
            var cf = Focus.current();
            var actKey = (cf && _st.paneInspEl && _st.paneInspEl.contains(cf) && cf.getAttribute) ? cf.getAttribute('data-act') : '';
            renderInspector(cur, actKey);
        }
    }

    function openSourcesModal(ch) {
        if (!ch || !ch.variants || ch.variants.length < 2) { return; }
        var items = ch.variants.map(function (v, idx) {
            var q = (IPTV.measuredLabel && IPTV.measuredLabel(v.url)) || v.badge;   // (what it played as, once known)
            return [String(idx), (q ? '[' + q + '] ' : '') + (v.rawName || v.name) + (v.group ? ' · ' + v.group : '')];
        });
        pickList(ch.name + ' · ' + U.t('Sources'), items, '0', function (val) {
            var v = ch.variants[+val || 0];
            tuneChannel(ch, _st.chanIdx, true, v && v.url);
        });
    }

    function openCatchupModal(ch) {
        if (!ch || !ch.archive || typeof EPG === 'undefined' || !EPG.schedule || typeof IPTV === 'undefined' || !IPTV.catchupUrl) { return; }
        Promise.resolve(EPG.schedule(ch.id)).then(function (list) {
            var now = Date.now() / 1000;
            var aired = (Array.isArray(list) ? list : []).filter(function (p) {
                return p.stop <= now && !!IPTV.catchupUrl(ch.id, p.start, p.stop);
            }).slice(-20).reverse();
            if (!aired.length) { U.toast(U.t('No catch-up programs found in guide'), 2500); return; }
            var items = aired.map(function (p, i) { return [String(i), hhmm(p.start) + '  ' + p.title]; });
            pickList(ch.name + ' · ' + U.t('↺ Catch-up'), items, '0', function (val) {
                var p = aired[+val || 0];
                if (!p) { return; }
                var cu = IPTV.catchupUrl(ch.id, p.start, p.stop);
                if (!cu) { return; }
                var focusNode = Focus.current();
                if (typeof Player !== 'undefined' && Player.isBrowseOverlay && Player.isBrowseOverlay()) { Player.exit(); }
                Player.play({
                    url: cu, type: ch.type || 'tv', id: ch.id, name: p.title + ' · ' + ch.name,
                    poster: ch.logo || '', isLive: false, fromStart: true,
                    streams: [], stream: { url: cu, _vod: true, _catchup: true }
                }, function () {
                    if (focusNode && document.documentElement.contains(focusNode)) { Focus.setScope(scr('home'), focusNode); }
                });
            });
        });
    }

    function openChannelMenu(ch, absIdx) {
        var fav = typeof IPTV !== 'undefined' && IPTV.isFavorite && IPTV.isFavorite(ch.id);
        var items = [['full', '▶  ' + U.t('Watch fullscreen')]];
        if (ch.variants && ch.variants.length > 1) {
            items.push(['sources', '≡  ' + U.t('Choose source ({n})', { n: ch.variants.length })]);
        }
        items.push(['fav', fav ? ('★  ' + U.t('Remove from favorites')) : ('★  ' + U.t('Add to favorites'))]);
        if (ch.archive && ch.archiveDays > 0 && typeof EPG !== 'undefined' && EPG.hasGuide && EPG.hasGuide(ch.id)) {
            items.push(['catchup', '↺  ' + U.t('Watch catch-up')]);
        }
        pickList(ch.name, items, items[0][0], function (v) {
            if (v === 'full') { tuneChannel(ch, absIdx, false); return; }
            if (v === 'sources') { openSourcesModal(ch); return; }
            if (v === 'catchup') { openCatchupModal(ch); return; }
            IPTV.setFavorite(ch.id, !fav);
            U.toast(fav ? U.t('Removed from favorites') : U.t('Added to ★ Favorites'), 2200);
            refreshAddonRows('local:iptv');
            redrawData(true, ch.id);   // (focus back on the channel)
        });
    }

    // A channel played (OK, CH+ / CH-, the Guide): Recent and the chips' counts again, the
    // playing marks, and the selection following it while you're in the channel list.
    function onChannelZapped(ch) {
        if (!_st.mounted) { return; }
        var built = buildGroups(_st.filterText);
        _st.cats = built.groups;
        if (_st.grpKey !== '__rec__') {   // (Recent shown: kept as it is under you, not reordered)
            var g = currentGroupObj();
            if (g.key === _st.grpKey) { _st.chans = g.list || []; }
        }
        for (var i = 0; i < _st.cats.length; i++) { if (_st.cats[i].key === _st.grpKey) { _st.catIdx = i; break; } }
        var cur = Focus.current();
        renderCatsWindow(!!(cur && _st.paneCatsEl && _st.paneCatsEl.contains(cur)));
        refreshToolbar();
        var inList = !!(cur && _st.paneChansEl && _st.paneChansEl.contains(cur)), at = -1;
        if (inList && ch) {
            for (var j = 0; j < _st.chans.length; j++) { var c = _st.chans[j]; if (c.id === ch.id || (Array.isArray(c._mergedIds) && c._mergedIds.indexOf(ch.id) !== -1)) { at = j; break; } }
        }
        if (at !== -1) {
            _st.chanIdx = at; _st.lastChanByGrp[_st.grpKey] = at;
            renderChansWindow(true, true);
        } else {
            _st.chanNodes.forEach(function (node) {
                if (!node.__chan || !node.classList) { return; }
                node.classList[isChannelPlaying(node.__chan) ? 'add' : 'remove']('playing');
            });
        }
        updateMiniHud();
        renderInspector(_st.chans[_st.chanIdx], null, true);
    }

    function tuneChannel(ch, absIdx, forceFullscreen, streamUrl) {
        if (!ch) { return; }
        var browseMode = !forceFullscreen && !!(typeof Stremio !== 'undefined' && Stremio.getPrefs().liveBrowseMode);
        if (browseMode && isChannelPlaying(ch) && typeof Player !== 'undefined' && Player.isBrowseOverlay && Player.isBrowseOverlay()) {
            Player.setBrowseOverlay(false);
            return;
        }
        if (V.zapLiveChannel) {
            V.zapLiveChannel(ch, {
                browseOverlay: browseMode,
                channels: _st.chans,
                idx: absIdx,
                streamUrl: streamUrl,
                onZapped: onChannelZapped
            });
        }
    }

    // force: drawn again for the same channel (its playing state or favorite changed); else a
    // channel already shown isn't rebuilt (a row's focus and the move that led there both ask).
    function renderInspector(ch, focusActKey, force) {
        var host = _st.paneInspEl;
        if (!host) { return; }
        if (!force && !focusActKey && ch && ch.id === _st.inspForId && host.firstChild) { return; }
        var had = Focus.current();   // (drawn again under its buttons' focus: kept on the same button)
        if (!focusActKey && had && host.contains(had) && had.getAttribute) { focusActKey = had.getAttribute('data-act'); }
        if (_st.inspTimer) { clearTimeout(_st.inspTimer); _st.inspTimer = null; }
        U.clear(host);
        _st.inspForId = ch ? ch.id : '';
        if (!ch) {
            host.appendChild(U.el('div', 'iptv-insp-empty', U.t('Select a channel to inspect EPG & sources.')));
            return;
        }
        var top = U.el('div', 'iptv-insp-head');
        top.appendChild(buildLogoEl(ch, 'iptv-insp-logo'));
        var meta = U.el('div', 'iptv-insp-meta');
        meta.appendChild(U.el('div', 'iptv-insp-title', ch.name));
        var subParts = [];
        if (ch.group) { subParts.push(ch.group); }
        if (ch.variants && ch.variants.length > 1) {
            var badges = ch.variants.map(function (v) { return v.badge || 'SD'; }).filter(function (v, idx, arr) { return arr.indexOf(v) === idx; });
            subParts.push(badges.join(' · ') + ' (' + ch.variants.length + ')');
        } else if (ch._qBadge) {
            subParts.push(ch._qBadge);
        }
        meta.appendChild(U.el('div', 'iptv-insp-sub', subParts.join('  ·  ')));
        if (ch._rawName && ch._rawName !== ch.name) {
            meta.appendChild(U.el('div', 'iptv-insp-raw', ch._rawName));
        }
        top.appendChild(meta);
        host.appendChild(top);

        var actions = U.el('div', 'iptv-insp-actions');
        var playingHere = isChannelPlaying(ch);
        var playBtn = U.el('div', 'iptv-act-btn primary focusable', playingHere ? ('▣ ' + U.t('Fullscreen')) : ('▶ ' + U.t('Watch')));
        playBtn.setAttribute('data-act', 'play');
        playBtn.__onselect = function () { tuneChannel(ch, _st.chanIdx, false); };

        var fav = typeof IPTV !== 'undefined' && IPTV.isFavorite && IPTV.isFavorite(ch.id);
        var favBtn = U.el('div', 'iptv-act-btn focusable', fav ? ('★ ' + U.t('Favorited')) : ('☆ ' + U.t('Favorite')));
        favBtn.setAttribute('data-act', 'fav');
        favBtn.__onselect = function () {
            IPTV.setFavorite(ch.id, !fav);
            refreshAddonRows('local:iptv');
            redrawData(false, ch.id, null, 'fav');
        };
        actions.appendChild(playBtn);
        actions.appendChild(favBtn);

        if (ch.variants && ch.variants.length > 1) {
            var srcBtn = U.el('div', 'iptv-act-btn focusable', '≡ ' + U.t('Sources') + ' (' + ch.variants.length + ')');
            srcBtn.setAttribute('data-act', 'sources');
            srcBtn.__onselect = function () { openSourcesModal(ch); };
            actions.appendChild(srcBtn);
        }
        if (ch.archive && ch.archiveDays > 0 && typeof EPG !== 'undefined' && EPG.hasGuide && EPG.hasGuide(ch.id)) {   // (its programs come from the guide)
            var cuBtn = U.el('div', 'iptv-act-btn focusable', '↺ ' + U.t('Catch-up'));
            cuBtn.setAttribute('data-act', 'catchup');
            cuBtn.__onselect = function () { openCatchupModal(ch); };
            actions.appendChild(cuBtn);
        }
        host.appendChild(actions);

        var btns = actions.querySelectorAll('.iptv-act-btn.focusable');
        var restoreBtn = null;
        for (var i = 0; i < btns.length; i++) {
            (function (bIdx, btn) {
                if (focusActKey && btn.getAttribute && btn.getAttribute('data-act') === focusActKey) { restoreBtn = btn; }
                btn.__goUP = function () { return _st.toolbarFirstEl || undefined; };
                btn.__goDOWN = function () { return false; };
                btn.__goLEFT = function () {
                    if (bIdx > 0) { return btns[bIdx - 1]; }
                    return _st.chanNodes[_st.chanIdx - _st.winTop] || _st.chanNodes[0] || false;
                };
                btn.__goRIGHT = function () { return bIdx < btns.length - 1 ? btns[bIdx + 1] : false; };
            })(i, btns[i]);
        }
        if (restoreBtn) { Focus.setFocus(restoreBtn); }

        // Now & Up Next EPG section
        var epgBox = U.el('div', 'iptv-insp-epg');
        var ep = (typeof EPG !== 'undefined' && EPG.now) ? EPG.now(ch.id) : null;
        var kEl = U.el('div', 'iptv-epg-kicker', (ep && ep.now) ? ('● ' + U.t('NOW') + '  ' + hhmm(ep.now.start) + '–' + hhmm(ep.now.stop)) : U.t('PROGRAM INFO'));
        var tEl = U.el('div', 'iptv-epg-main-title', (ep && ep.now) ? ep.now.title : '');
        if (!(ep && ep.now)) { tEl.style.display = 'none'; }
        var bar = U.el('div', 'iptv-insp-bar');
        var fill = U.el('div', 'iptv-insp-fill');
        if (ep && ep.now) {
            fill.style.width = Math.max(0, Math.min(100, Math.round(((Date.now() / 1000) - ep.now.start) / Math.max(1, ep.now.stop - ep.now.start) * 100))) + '%';
        } else {
            bar.style.display = 'none';
        }
        bar.appendChild(fill);
        var dEl = U.el('div', 'iptv-epg-desc', (ep && ep.now) ? (ep.now.desc || '') : U.t('No live guide information for this channel yet.'));
        if (ep && ep.now && !ep.now.desc) { dEl.style.display = 'none'; }
        epgBox.appendChild(kEl);
        epgBox.appendChild(tEl);
        epgBox.appendChild(bar);
        epgBox.appendChild(dEl);

        var nextWrap = U.el('div', 'iptv-insp-next');
        function renderUpcoming(items) {
            if (!items || !items.length) { return; }
            U.clear(nextWrap);
            nextWrap.appendChild(U.el('div', 'iptv-epg-kicker iptv-next-kicker', U.t('UP NEXT')));
            items.slice(0, 3).forEach(function (u) {
                var item = U.el('div', 'iptv-next-item');
                item.appendChild(U.el('span', 'iptv-next-time', hhmm(u.start)));
                item.appendChild(U.el('span', 'iptv-next-title', u.title));
                nextWrap.appendChild(item);
            });
        }
        var nowSec = Date.now() / 1000;
        var cachedSched = _st.schedCache[ch.id];
        if (cachedSched && (Date.now() - cachedSched.at < 300000)) {
            var cachedUp = cachedSched.list.filter(function (p) { return p.start > nowSec; });
            if (cachedUp.length) { renderUpcoming(cachedUp); }
        } else if (ep && ep.next) {
            renderUpcoming([ep.next]);
        }
        epgBox.appendChild(nextWrap);
        host.appendChild(epgBox);

        if ((!cachedSched || (Date.now() - cachedSched.at >= 300000)) && !_st.schedAsked[ch.id] && typeof EPG !== 'undefined' && EPG.schedule && EPG.hasGuide && EPG.hasGuide(ch.id)) {
            _st.inspTimer = setTimeout(function () {
                _st.inspTimer = null;
                if (!_st.mounted || !document.documentElement.contains(nextWrap) || _st.schedAsked[ch.id]) { return; }
                _st.schedAsked[ch.id] = 1;
                Promise.resolve(EPG.schedule(ch.id)).then(function (list) {
                    var clean = Array.isArray(list) ? list : [];
                    _st.schedCache[ch.id] = { list: clean, at: Date.now() };
                    delete _st.schedAsked[ch.id];
                    if (!_st.mounted || !document.documentElement.contains(nextWrap)) { return; }
                    var curSel = _st.chans[_st.chanIdx];
                    if (!curSel || curSel.id !== ch.id) { return; }
                    var upcoming = clean.filter(function (p) { return p.start > (Date.now() / 1000); });
                    if (upcoming.length) { renderUpcoming(upcoming); }
                }, function () { delete _st.schedAsked[ch.id]; });
            }, 90);
        }
    }

    function renderChansWindow(forceRedraw, focusHere) {
        var host = _st.paneChansEl;
        if (!host) { return; }
        var list = _st.chans || [];
        if (!list.length) {
            U.clear(host);
            _st.chanNodes = [];
            var empty = U.el('div', 'iptv-empty');
            empty.appendChild(U.el('div', 'iptv-empty-msg', _st.filterText
                ? U.t('No channels matched “{q}”.', { q: _st.filterText })
                : U.t('No IPTV channels loaded yet. Add a playlist or Xtream account in Settings › Content › IPTV.')));
            var cta = U.el('div', 'iptv-act-btn primary focusable', _st.filterText ? U.t('Clear filter') : U.t('Open IPTV settings'));
            cta.__onselect = function () {
                if (_st.filterText) { _st.filterText = ''; redrawData(true); return; }
                App.openSettings();
            };
            _st.emptyCta = cta;
            cta.__goUP = function () { return _st.toolbarFirstEl || undefined; };
            cta.__goLEFT = function () { return _st.catNodes[0] || false; };
            empty.appendChild(cta);
            host.appendChild(empty);
            renderInspector(null);
            if (focusHere) { Focus.setFocus(cta); }
            return;
        }

        _st.emptyCta = null;
        var chanCap = visibleChanRows();
        if (_st.chanIdx >= list.length) { _st.chanIdx = Math.max(0, list.length - 1); }
        // Past the window's edge it moves by half a window (the focused row mid-way), so holding
        // UP / DOWN rebuilds the rows every few steps instead of at each one.
        if (_st.chanIdx < _st.winTop || _st.chanIdx >= _st.winTop + chanCap) { _st.winTop = _st.chanIdx - Math.floor(chanCap / 2); }
        _st.winTop = Math.max(0, Math.min(_st.winTop, Math.max(0, list.length - chanCap)));

        U.clear(host);
        _st.chanNodes = [];
        var visible = list.slice(_st.winTop, _st.winTop + chanCap);
        var activeNode = null;
        visible.forEach(function (ch, offset) {
            var absIdx = _st.winTop + offset;
            var isCur = isChannelPlaying(ch);
            var row = U.el('div', 'iptv-row focusable' + (isCur ? ' playing' : ''));
            row.__chan = ch;
            row.__absIdx = absIdx;
            var numStr = (absIdx + 1) < 10 ? ('00' + (absIdx + 1)) : (absIdx + 1) < 100 ? ('0' + (absIdx + 1)) : String(absIdx + 1);
            row.appendChild(U.el('div', 'iptv-num', numStr));
            row.appendChild(buildLogoEl(ch, 'iptv-logo-box'));

            var mid = U.el('div', 'iptv-row-mid');
            var topLine = U.el('div', 'iptv-row-top');
            topLine.appendChild(U.el('span', 'iptv-row-name', ch.name));

            var favMark = U.el('span', 'iptv-fav-mark', '★');
            if (!(typeof IPTV !== 'undefined' && IPTV.isFavorite && IPTV.isFavorite(ch.id))) { favMark.style.display = 'none'; }
            topLine.appendChild(favMark);

            if (ch.archive && ch.archiveDays > 0) {
                topLine.appendChild(U.el('span', 'iptv-cu-mark', '↺'));
            }
            if (ch._qBadge || (ch.variants && ch.variants.length > 1)) {
                var badgeTxt = (ch._qBadge || 'SD') + (ch.variants && ch.variants.length > 1 ? (' +' + (ch.variants.length - 1)) : '');
                topLine.appendChild(U.el('span', 'iptv-q-pill', badgeTxt));
            }
            mid.appendChild(topLine);

            var subLine = U.el('div', 'iptv-row-sub');
            subLine.appendChild(U.el('div', 'iptv-row-epg', ch.group || U.t('Live TV')));
            var pBar = U.el('div', 'iptv-prog-bar');
            pBar.appendChild(U.el('div', 'iptv-prog-fill'));
            subLine.appendChild(pBar);
            mid.appendChild(subLine);
            row.appendChild(mid);

            updateRowEpg(row, ch);

            row.__onselect = function () { tuneChannel(ch, absIdx, false); };
            row.__onplay = function () { tuneChannel(ch, absIdx, true); };
            row.__onlongpress = function () { openChannelMenu(ch, absIdx); };
            row.__goLEFT = function () {
                return _st.catNodes[_st.catIdx - _st.catTop] || _st.catNodes[0] || false;
            };
            row.__goRIGHT = function () {
                return _st.paneInspEl ? (_st.paneInspEl.querySelector('.iptv-act-btn.focusable') || false) : false;
            };
            row.__goUP = function () {
                if (absIdx === 0) { return _st.toolbarFirstEl || undefined; }
                _st.chanIdx = absIdx - 1;
                _st.lastChanByGrp[_st.grpKey] = _st.chanIdx;
                if (_st.chanIdx < _st.winTop) { renderChansWindow(true, true); return false; }
                return _st.chanNodes[_st.chanIdx - _st.winTop] || false;   // (its focus draws the inspector)
            };
            row.__goDOWN = function () {
                if (absIdx >= list.length - 1) { return false; }
                _st.chanIdx = absIdx + 1;
                _st.lastChanByGrp[_st.grpKey] = _st.chanIdx;
                if (_st.chanIdx >= _st.winTop + chanCap) { renderChansWindow(true, true); return false; }
                return _st.chanNodes[_st.chanIdx - _st.winTop] || false;   // (its focus draws the inspector)
            };
            row.__iptvFocus = function () {
                _st.chanIdx = absIdx;
                _st.lastChanByGrp[_st.grpKey] = absIdx;
                renderInspector(ch);
            };

            host.appendChild(row);
            _st.chanNodes.push(row);
            if (absIdx === _st.chanIdx) { activeNode = row; }
        });

        requestVisibleEpg();
        var focusTarget = activeNode || _st.chanNodes[0] || null;
        renderInspector(focusTarget ? focusTarget.__chan : null);
        if (focusHere && focusTarget) { Focus.setFocus(focusTarget); }
    }

    function redrawData(focusCenter, keepId, focusTbKey, focusActKey) {
        var built = buildGroups(_st.filterText);
        _st.cats = built.groups;
        var hasKey = _st.cats.some(function (g) { return g.key === _st.grpKey; });
        if (!hasKey) {
            _st.grpKey = _st.cats[0] ? _st.cats[0].key : '__all__';
        }
        var gObj = currentGroupObj();
        _st.chans = gObj.list || [];
        if (keepId) {
            var found = -1;
            for (var i = 0; i < _st.chans.length; i++) {
                var c = _st.chans[i];
                if (c.id === keepId || (Array.isArray(c._mergedIds) && c._mergedIds.indexOf(keepId) !== -1)) { found = i; break; }
            }
            if (found !== -1) { _st.chanIdx = found; }
        }
        _st.chanIdx = Math.max(0, Math.min(_st.chanIdx, Math.max(0, _st.chans.length - 1)));
        _st.winTop = Math.max(0, Math.min(_st.chanIdx - Math.floor(CHAN_ROWS / 2), Math.max(0, _st.chans.length - CHAN_ROWS)));
        for (var j = 0; j < _st.cats.length; j++) { if (_st.cats[j].key === _st.grpKey) { _st.catIdx = j; break; } }
        redrawAll(focusCenter, focusTbKey, focusActKey);
    }

    function redrawAll(focusCenter, focusTbKey, focusActKey) {
        if (!_st.wrap) { return; }
        U.clear(_st.wrap);
        _st.inspForId = '';   // (a new inspector pane: drawn afresh)
        var shell = U.el('div', 'iptv-shell');
        shell.appendChild(renderToolbar());
        updateMiniHud();

        var cols = U.el('div', 'iptv-cols');
        var left = U.el('div', 'iptv-pane iptv-pane-cats glass-pane');
        var center = U.el('div', 'iptv-pane iptv-pane-chans glass-pane');
        var right = U.el('div', 'iptv-pane iptv-pane-insp glass-pane');
        _st.paneCatsEl = left;
        _st.paneChansEl = center;
        _st.paneInspEl = right;
        cols.appendChild(left);
        cols.appendChild(center);
        cols.appendChild(right);
        shell.appendChild(cols);

        var banner = U.el('div', 'iptv-digit-banner hidden');
        _st.digitBannerEl = banner;
        shell.appendChild(banner);

        _st.wrap.appendChild(shell);
        wireToolbarNav();
        renderCatsWindow(false);
        renderChansWindow(true, !!focusCenter && !focusTbKey && !focusActKey);
        if (focusActKey && _st.paneInspEl) {
            var actEl = _st.paneInspEl.querySelector('[data-act="' + focusActKey + '"]');
            if (actEl) { Focus.setFocus(actEl); }
        } else if (focusTbKey) {
            var tbEl = shell.querySelector('[data-tb="' + focusTbKey + '"]');
            if (tbEl) { Focus.setFocus(tbEl); }
        }
    }

    function iptvBrowser(rowsEl) {
        _st.mounted = true;
        _st.wrap = rowsEl;
        if (!_st.unsubEpg && typeof EPG !== 'undefined' && EPG.onChange) {
            _st.unsubEpg = true;
            EPG.onChange(scheduleVisibleEpgRefresh);
        }
        if (_st.unsubLive) { _st.unsubLive(); _st.unsubLive = null; }
        if (typeof Player !== 'undefined' && Player.onLiveMetaChange) {
            _st.unsubLive = Player.onLiveMetaChange(function () {
                if (_st.mounted) { updateMiniHud(); }
            });
        }
        redrawData(false, (typeof Player !== 'undefined' && Player.currentLiveId) ? Player.currentLiveId() : '');
        var first = _st.chanNodes[_st.chanIdx - _st.winTop] || _st.chanNodes[0] || _st.toolbarFirstEl;
        var cur = Focus.current();
        if (first && (!cur || !document.documentElement.contains(cur) || /\b(tab-pill|hchip)\b/.test(cur.className || ''))) {
            Focus.setScope(scr('home'), first);
        }
    }

    function iptvLeave() {
        _st.mounted = false;
        _st.inspForId = '';
        if (_st.catDebounce) { clearTimeout(_st.catDebounce); _st.catDebounce = null; }
        if (_st.epgTimer) { clearTimeout(_st.epgTimer); _st.epgTimer = null; }
        if (_st.epgUiTimer) { clearTimeout(_st.epgUiTimer); _st.epgUiTimer = null; }
        if (_st.inspTimer) { clearTimeout(_st.inspTimer); _st.inspTimer = null; }
        if (_st.digitTimer) { clearTimeout(_st.digitTimer); _st.digitTimer = null; }
        _st.digits = '';   // (a number half typed doesn't carry over to the next visit)
        if (_st.unsubLive) { _st.unsubLive(); _st.unsubLive = null; }
    }

    function iptvBackOn(id) {
        if (!_st.mounted || !id) { return null; }
        var found = -1;
        for (var i = 0; i < _st.chans.length; i++) {
            var c = _st.chans[i];
            if (c.id === id || (Array.isArray(c._mergedIds) && c._mergedIds.indexOf(id) !== -1)) { found = i; break; }
        }
        if (found === -1 && _st.grpKey !== '__all__') {
            setActiveGroup('__all__', false);
            for (var j = 0; j < _st.chans.length; j++) {
                var c2 = _st.chans[j];
                if (c2.id === id || (Array.isArray(c2._mergedIds) && c2._mergedIds.indexOf(id) !== -1)) { found = j; break; }
            }
        }
        if (found === -1) { return _st.chanNodes[0] || null; }
        _st.chanIdx = found;
        _st.lastChanByGrp[_st.grpKey] = found;
        renderChansWindow(true, false);
        onChannelZapped(_st.chans[_st.chanIdx]);
        return _st.chanNodes[_st.chanIdx - _st.winTop] || _st.chanNodes[0] || null;
    }

    function backInIptv() {
        if (!_st.mounted) { return false; }
        var cur = Focus.current();
        if (!cur || !_st.wrap || !_st.wrap.contains(cur)) { return false; }
        if (_st.paneInspEl && _st.paneInspEl.contains(cur)) {
            var cTarget = _st.chanNodes[_st.chanIdx - _st.winTop] || _st.chanNodes[0];
            if (cTarget) { Focus.setFocus(cTarget); return true; }
        }
        if (_st.paneChansEl && _st.paneChansEl.contains(cur)) {
            var catTarget = _st.catNodes[_st.catIdx - _st.catTop] || _st.catNodes[0];
            if (catTarget) { Focus.setFocus(catTarget); return true; }
        }
        return false;
    }

    function iptvNumberKey(digit) {
        if (!_st.mounted || !_st.chans.length) { return false; }
        var cur = Focus.current();
        if (!cur || !_st.wrap || !_st.wrap.contains(cur)) { return false; }
        if (_st.digitTimer) { clearTimeout(_st.digitTimer); _st.digitTimer = null; }
        _st.digits = (_st.digits + String(digit)).slice(-3);
        if (_st.digitBannerEl) {
            _st.digitBannerEl.textContent = '#' + _st.digits;
            _st.digitBannerEl.className = 'iptv-digit-banner';
        }
        function jump() {
            var num = parseInt(_st.digits, 10) || 0;
            _st.digits = '';
            if (_st.digitBannerEl) { _st.digitBannerEl.className = 'iptv-digit-banner hidden'; }
            if (num >= 1 && num <= _st.chans.length) {
                _st.chanIdx = num - 1;
                _st.lastChanByGrp[_st.grpKey] = _st.chanIdx;
                renderChansWindow(true, true);
            }
        }
        if (_st.digits.length >= 3) { jump(); }
        else { _st.digitTimer = setTimeout(jump, 1000); }
        return true;
    }

    // Every focus move (the remote, setFocus, LEFT back from the inspector…) reaches the row or
    // category it lands on: the engine marks nodes .focused, it doesn't fire DOM focus events.
    if (typeof Focus !== 'undefined' && Focus.onFocus) {
        Focus.onFocus(function (node) { if (_st.mounted && node && typeof node.__iptvFocus === 'function') { node.__iptvFocus(); } });
    }

    V.iptvPushRecent = pushRecent;
    V.iptvBrowser = iptvBrowser;
    V.iptvLeave = iptvLeave;
    V.iptvBackOn = iptvBackOn;
    V.backInIptv = backInIptv;
    V.iptvNumberKey = iptvNumberKey;
})(ViewParts);
