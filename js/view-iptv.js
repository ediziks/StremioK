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
        catNodes: [],
        chanNodes: [],
        unsubLive: null,
        unsubEpg: false,
        paneCatsEl: null,
        paneChansEl: null,
        paneInspEl: null,
        hudEl: null,
        toolbarFirstEl: null,
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
        if (recList.length) { groups.push({ key: '__rec__', label: U.t('🕒 Recent'), list: recList }); }

        groups.push({ key: '__all__', label: U.t('📺 All Channels'), list: live });

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
        return _st.cats[0] || { key: '__all__', label: U.t('📺 All Channels'), list: [] };
    }

    function updateMiniHud() {
        var hud = _st.hudEl;
        if (!hud) { return; }
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
        var fullBtn = U.el('div', 'iptv-chip focusable', '⛶ ' + U.t('Fullscreen'));
        fullBtn.__onselect = function () { if (Player.setBrowseOverlay) { Player.setBrowseOverlay(false); } };
        var stopBtn = U.el('div', 'iptv-chip iptv-chip-stop focusable', '⏹ ' + U.t('Stop'));
        stopBtn.__onselect = function () { Player.exit(); redrawAll(); };
        hud.appendChild(fullBtn);
        hud.appendChild(stopBtn);
        wireToolbarNav();
    }

    function wireToolbarNav() {
        var bar = _st.wrap ? _st.wrap.querySelector('.iptv-toolbar') : null;
        if (!bar) { return; }
        var chips = bar.querySelectorAll('.iptv-chip.focusable');
        for (var i = 0; i < chips.length; i++) {
            (function (idx, node) {
                node.__goUP = function () { return undefined; };   // header tabs
                node.__goDOWN = function () { return _st.chanNodes[0] || _st.catNodes[0] || false; };
                node.__goLEFT = function () { return idx > 0 ? chips[idx - 1] : false; };
                node.__goRIGHT = function () { return idx < chips.length - 1 ? chips[idx + 1] : false; };
            })(i, chips[i]);
        }
        _st.toolbarFirstEl = chips[0] || null;
    }

    function renderToolbar(shell) {
        var bar = U.el('div', 'iptv-toolbar');
        var left = U.el('div', 'iptv-tb-left');

        var filterBtn = U.el('div', 'iptv-chip focusable', _st.filterText ? ('🔍 ' + _st.filterText + ' ✕') : ('🔍 ' + U.t('Filter')));
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
        var tidyBtn = U.el('div', 'iptv-chip focusable' + (cfg.enabled ? ' on' : ''), cfg.enabled ? ('✨ ' + U.t('Tidied') + countryHint) : U.t('Raw list'));
        tidyBtn.__onselect = function () {
            if (typeof IPTV === 'undefined' || !IPTV.setTidyCfg) { return; }
            var curId = (_st.chans[_st.chanIdx] && _st.chans[_st.chanIdx].id) || '';
            IPTV.setTidyCfg({ enabled: !cfg.enabled });
            IPTV.rebuild();
            refreshAddonRows('local:iptv');
            redrawData(false, curId);
        };
        left.appendChild(tidyBtn);

        ['__fav__', '__rec__', '__all__'].forEach(function (k) {
            var grp = null;
            for (var i = 0; i < _st.cats.length; i++) { if (_st.cats[i].key === k) { grp = _st.cats[i]; break; } }
            if (!grp) { return; }
            var btn = U.el('div', 'iptv-chip focusable' + (_st.grpKey === k ? ' on' : ''), grp.label + ' (' + grp.list.length + ')');
            btn.__onselect = function () { setActiveGroup(k, true); };
            left.appendChild(btn);
        });

        bar.appendChild(left);
        var hud = U.el('div', 'iptv-hud hidden');
        _st.hudEl = hud;
        bar.appendChild(hud);
        shell.appendChild(bar);
        updateMiniHud();
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
            renderCatsWindow(false);
            renderChansWindow(true, false);
        }
        if (focusCenter) {
            var target = _st.chanNodes[_st.chanIdx - _st.winTop] || _st.chanNodes[0];
            if (target) { Focus.setFocus(target); }
        }
    }

    function renderCatsWindow(setFocusHere) {
        var host = _st.paneCatsEl;
        if (!host) { return; }
        if (_st.catIdx >= _st.cats.length) { _st.catIdx = Math.max(0, _st.cats.length - 1); }
        if (_st.catIdx < _st.catTop) { _st.catTop = _st.catIdx; }
        else if (_st.catIdx >= _st.catTop + CAT_ROWS) { _st.catTop = _st.catIdx - CAT_ROWS + 1; }
        _st.catTop = Math.max(0, Math.min(_st.catTop, Math.max(0, _st.cats.length - CAT_ROWS)));

        U.clear(host);
        _st.catNodes = [];
        var visible = _st.cats.slice(_st.catTop, _st.catTop + CAT_ROWS);
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
                return false;
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
                if (_st.catIdx >= _st.catTop + CAT_ROWS) { renderCatsWindow(true); return false; }
                return _st.catNodes[_st.catIdx - _st.catTop];
            };
            row.addEventListener('focus', function () {
                _st.catIdx = abs;
                if (_st.catDebounce) { clearTimeout(_st.catDebounce); }
                _st.catDebounce = setTimeout(function () {
                    _st.catDebounce = null;
                    setActiveGroup(g.key, false);
                }, 70);
            }, false);
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
        if (ep && ep.now) {
            if (titleEl) { titleEl.textContent = hhmm(ep.now.start) + ' ' + ep.now.title; }
            if (barEl && fillEl) {
                var pct = Math.max(0, Math.min(100, Math.round(((Date.now() / 1000) - ep.now.start) / Math.max(1, ep.now.stop - ep.now.start) * 100)));
                barEl.style.display = '';
                fillEl.style.width = pct + '%';
            }
        } else {
            if (titleEl) { titleEl.textContent = ch.group || U.t('Live TV'); }
            if (barEl) { barEl.style.display = 'none'; }
        }
    }

    function updateVisibleEpg() {
        if (!_st.mounted) { return; }
        _st.chanNodes.forEach(function (node) {
            if (node.__chan) { updateRowEpg(node, node.__chan); }
        });
        var cur = _st.chans[_st.chanIdx];
        if (cur) { renderInspector(cur); }
    }

    function openSourcesModal(ch) {
        if (!ch || !ch.variants || ch.variants.length < 2) { return; }
        var items = ch.variants.map(function (v, idx) {
            return [String(idx), (v.badge ? '[' + v.badge + '] ' : '') + (v.rawName || v.name) + (v.group ? ' · ' + v.group : '')];
        });
        pickList(ch.name + ' · ' + U.t('Sources'), items, '0', function (val) {
            tuneChannel(ch, _st.chanIdx, true, +val || 0);
        });
    }

    function openCatchupModal(ch) {
        if (!ch || !ch.archive || typeof EPG === 'undefined' || !EPG.schedule || typeof IPTV === 'undefined' || !IPTV.catchupUrl) { return; }
        var now = Date.now() / 1000;
        var aired = (EPG.schedule(ch.id) || []).filter(function (p) {
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
    }

    function openChannelMenu(ch, absIdx) {
        var fav = typeof IPTV !== 'undefined' && IPTV.isFavorite && IPTV.isFavorite(ch.id);
        var items = [['full', '▶  ' + U.t('Watch fullscreen')]];
        if (ch.variants && ch.variants.length > 1) {
            items.push(['sources', '🔀  ' + U.t('Choose source ({n})', { n: ch.variants.length })]);
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
            redrawData(false, ch.id);
        });
    }

    function onChannelZapped(ch) {
        if (ch && ch.id) { pushRecent(ch.id); }
        _st.chanNodes.forEach(function (node) {
            if (!node.__chan || !node.classList) { return; }
            node.classList[isChannelPlaying(node.__chan) ? 'add' : 'remove']('playing');
        });
        updateMiniHud();
        renderInspector(_st.chans[_st.chanIdx]);
    }

    function tuneChannel(ch, absIdx, forceFullscreen, streamIndex) {
        if (!ch) { return; }
        var browseMode = !forceFullscreen && !!(typeof Stremio !== 'undefined' && Stremio.getPrefs().liveBrowseMode);
        if (browseMode && isChannelPlaying(ch) && typeof Player !== 'undefined' && Player.isBrowseOverlay && Player.isBrowseOverlay()) {
            Player.setBrowseOverlay(false);
            return;
        }
        pushRecent(ch.id);
        if (V.zapLiveChannel) {
            V.zapLiveChannel(ch, {
                browseOverlay: browseMode,
                channels: _st.chans,
                idx: absIdx,
                streamIndex: streamIndex,
                onZapped: onChannelZapped
            });
        }
    }

    function renderInspector(ch) {
        var host = _st.paneInspEl;
        if (!host) { return; }
        U.clear(host);
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
        var playBtn = U.el('div', 'iptv-act-btn primary focusable', playingHere ? ('⛶ ' + U.t('Fullscreen')) : ('▶ ' + U.t('Watch')));
        playBtn.__onselect = function () { tuneChannel(ch, _st.chanIdx, false); };

        var fav = typeof IPTV !== 'undefined' && IPTV.isFavorite && IPTV.isFavorite(ch.id);
        var favBtn = U.el('div', 'iptv-act-btn focusable', fav ? ('★ ' + U.t('Favorited')) : ('☆ ' + U.t('Favorite')));
        favBtn.__onselect = function () {
            IPTV.setFavorite(ch.id, !fav);
            refreshAddonRows('local:iptv');
            renderInspector(ch);
            _st.chanNodes.forEach(function (n) {
                if (n.__chan && n.__chan.id === ch.id) {
                    var b = n.querySelector('.iptv-fav-mark');
                    if (b) { b.style.display = !fav ? '' : 'none'; }
                }
            });
        };
        actions.appendChild(playBtn);
        actions.appendChild(favBtn);

        if (ch.variants && ch.variants.length > 1) {
            var srcBtn = U.el('div', 'iptv-act-btn focusable', '🔀 ' + U.t('Sources') + ' (' + ch.variants.length + ')');
            srcBtn.__onselect = function () { openSourcesModal(ch); };
            actions.appendChild(srcBtn);
        }
        if (ch.archive && ch.archiveDays > 0) {
            var cuBtn = U.el('div', 'iptv-act-btn focusable', '↺ ' + U.t('Catch-up'));
            cuBtn.__onselect = function () { openCatchupModal(ch); };
            actions.appendChild(cuBtn);
        }
        host.appendChild(actions);

        var btns = actions.querySelectorAll('.iptv-act-btn.focusable');
        for (var i = 0; i < btns.length; i++) {
            (function (bIdx, btn) {
                btn.__goUP = function () { return bIdx > 0 ? btns[bIdx - 1] : (_st.toolbarFirstEl || undefined); };
                btn.__goDOWN = function () { return bIdx < btns.length - 1 ? btns[bIdx + 1] : false; };
                btn.__goLEFT = function () { return _st.chanNodes[_st.chanIdx - _st.winTop] || _st.chanNodes[0] || false; };
                btn.__goRIGHT = function () { return false; };
            })(i, btns[i]);
        }

        // Now & Up Next EPG section
        var epgBox = U.el('div', 'iptv-insp-epg');
        var ep = (typeof EPG !== 'undefined' && EPG.now) ? EPG.now(ch.id) : null;
        if (ep && ep.now) {
            var lbl = U.el('div', 'iptv-epg-kicker', '● ' + U.t('NOW') + '  ' + hhmm(ep.now.start) + '–' + hhmm(ep.now.stop));
            epgBox.appendChild(lbl);
            epgBox.appendChild(U.el('div', 'iptv-epg-main-title', ep.now.title));
            var bar = U.el('div', 'iptv-insp-bar');
            var fill = U.el('div', 'iptv-insp-fill');
            var pct = Math.max(0, Math.min(100, Math.round(((Date.now() / 1000) - ep.now.start) / Math.max(1, ep.now.stop - ep.now.start) * 100)));
            fill.style.width = pct + '%';
            bar.appendChild(fill);
            epgBox.appendChild(bar);
            if (ep.now.desc) { epgBox.appendChild(U.el('div', 'iptv-epg-desc', ep.now.desc)); }
        } else {
            epgBox.appendChild(U.el('div', 'iptv-epg-kicker', U.t('PROGRAM INFO')));
            epgBox.appendChild(U.el('div', 'iptv-epg-desc', U.t('No live guide information for this channel yet.')));
        }

        if (typeof EPG !== 'undefined' && EPG.schedule) {
            var nowSec = Date.now() / 1000;
            var upcoming = (EPG.schedule(ch.id) || []).filter(function (p) { return p.start > nowSec; }).slice(0, 3);
            if (upcoming.length) {
                epgBox.appendChild(U.el('div', 'iptv-epg-kicker iptv-next-kicker', U.t('UP NEXT')));
                upcoming.forEach(function (u) {
                    var item = U.el('div', 'iptv-next-item');
                    item.appendChild(U.el('span', 'iptv-next-time', hhmm(u.start)));
                    item.appendChild(U.el('span', 'iptv-next-title', u.title));
                    epgBox.appendChild(item);
                });
            }
        }
        host.appendChild(epgBox);
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
            cta.__goUP = function () { return _st.toolbarFirstEl || undefined; };
            cta.__goLEFT = function () { return _st.catNodes[0] || false; };
            empty.appendChild(cta);
            host.appendChild(empty);
            renderInspector(null);
            if (focusHere) { Focus.setFocus(cta); }
            return;
        }

        if (_st.chanIdx >= list.length) { _st.chanIdx = Math.max(0, list.length - 1); }
        if (_st.chanIdx < _st.winTop) { _st.winTop = _st.chanIdx; }
        else if (_st.chanIdx >= _st.winTop + CHAN_ROWS) { _st.winTop = _st.chanIdx - CHAN_ROWS + 1; }
        _st.winTop = Math.max(0, Math.min(_st.winTop, Math.max(0, list.length - CHAN_ROWS)));

        U.clear(host);
        _st.chanNodes = [];
        var visible = list.slice(_st.winTop, _st.winTop + CHAN_ROWS);
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
                var prevNode = _st.chanNodes[_st.chanIdx - _st.winTop];
                renderInspector(prevNode ? prevNode.__chan : null);
                return prevNode || false;
            };
            row.__goDOWN = function () {
                if (absIdx >= list.length - 1) { return false; }
                _st.chanIdx = absIdx + 1;
                _st.lastChanByGrp[_st.grpKey] = _st.chanIdx;
                if (_st.chanIdx >= _st.winTop + CHAN_ROWS) { renderChansWindow(true, true); return false; }
                var nextNode = _st.chanNodes[_st.chanIdx - _st.winTop];
                renderInspector(nextNode ? nextNode.__chan : null);
                return nextNode || false;
            };
            row.addEventListener('focus', function () {
                _st.chanIdx = absIdx;
                _st.lastChanByGrp[_st.grpKey] = absIdx;
                renderInspector(ch);
            }, false);

            host.appendChild(row);
            _st.chanNodes.push(row);
            if (absIdx === _st.chanIdx) { activeNode = row; }
        });

        requestVisibleEpg();
        var focusTarget = activeNode || _st.chanNodes[0] || null;
        renderInspector(focusTarget ? focusTarget.__chan : null);
        if (focusHere && focusTarget) { Focus.setFocus(focusTarget); }
    }

    function redrawData(focusCenter, keepId) {
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
        redrawAll(focusCenter);
    }

    function redrawAll(focusCenter) {
        if (!_st.wrap) { return; }
        U.clear(_st.wrap);
        var shell = U.el('div', 'iptv-shell');
        renderToolbar(shell);

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
        renderChansWindow(true, !!focusCenter);
    }

    function iptvBrowser(rowsEl) {
        _st.mounted = true;
        _st.wrap = rowsEl;
        if (!_st.unsubEpg && typeof EPG !== 'undefined' && EPG.onChange) {
            _st.unsubEpg = true;
            EPG.onChange(updateVisibleEpg);
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
        if (_st.catDebounce) { clearTimeout(_st.catDebounce); _st.catDebounce = null; }
        if (_st.epgTimer) { clearTimeout(_st.epgTimer); _st.epgTimer = null; }
        if (_st.digitTimer) { clearTimeout(_st.digitTimer); _st.digitTimer = null; }
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

    V.iptvBrowser = iptvBrowser;
    V.iptvLeave = iptvLeave;
    V.iptvBackOn = iptvBackOn;
    V.backInIptv = backInIptv;
    V.iptvNumberKey = iptvNumberKey;
})(ViewParts);
