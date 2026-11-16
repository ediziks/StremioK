# Tier 1 Implementation Plan: APL TV-Class Live TV UI/UX & Smart Playlist Tidier

> **For agentic workers:** Execute this plan task-by-task cleanly on branch `feat/apltv-iptv-parity` in `/Users/ediz/Downloads/PERS/TV/StremioK`. Read each referenced file slice before editing, write tests first inside `tests/run.js`, run `node tests/run.js` after every change, and never claim completion without fresh verification evidence.

**Goal:** Transform StremioK's Live TV (`IPTV`, `Guide`, player HUD, and playlist parser) into a responsive APL TV-class Live TV experience with live video playing behind frosted glass, a windowed 3-pane split channel/EPG browser, a Smart Playlist Tidier + Variant Merger, OLED pixel-shift/pause-dimming protection, and upgraded `Res/Codec/FPS` stream pills.

**Architecture:** All channel data cleanup stays synchronous inside `js/iptv.js` over a preserved raw per-playlist cache (`_rawByPlaylist`) configured via `stremiok.prefs`. Fullscreen `<object id="av-player">` (`z-index: 1`) stays decoding behind `#app` (`z-index: 10`) using a clean `Player.setBrowseOverlay(true/false)` mode toggling `body.live-behind`, routed through `App.onKey` / `App.back` and a self-contained `Views.zapLiveChannel` helper. The `IPTV` tab (`_homeTab === 'tv'`) mounts a dedicated windowed module `js/view-iptv.js` (`11` category rows, `10` channel rows max in DOM) alongside the existing frosted `js/view-guide.js`.

**Tech Stack:** Vanilla ES5 JavaScript (Chromium 47+ through Tizen 9 WebKit), CSS3 (`fx-full` `backdrop-filter` glass with Tizen 3–5 translucent fallback), Samsung `webapis.avplay` + HTML5 `<video>`, Node `vm` unit & ES5 test runner (`tests/run.js`), Chrome DevTools MCP for `1920x1080` visual verification.

**Spec Reference:** [2026-11-16-tier1-apltv-ui-design.md](../specs/2026-11-16-tier1-apltv-ui-design.md)

---

## Global Constraints

1. **Strict ES5 in `js/` and `service/`:** `var` declarations and `function ()` expressions ONLY. No `let`, `const`, arrows, classes, template literals, destructuring, spread, default arguments, or `async`/`await`. Every commit must pass `scanES5` in `node tests/run.js` with `0` violations.
2. **Single Preference Store (`stremiok.prefs`):** All 6 new settings (`iptvTidy`, `iptvHideAdult`, `iptvCollapseVariants`, `iptvCountries`, `liveBrowseMode`, `oledShift`) live in `'stremiok.prefs'` inside `U.store`. `IPTV.getTidyCfg()` / `setTidyCfg()` must share that exact key whether `Stremio` is loaded (runtime) or omitted (unit tests).
3. **Bounded DOM & Zero-Lag Focus:** Never render full channel lists or full category lists into the DOM. Enforce `CAT_ROWS = 11` and `CHAN_ROWS = 10` sliding windows with in-place `.focused` swaps inside the window. Never start stream playback on focus highlight (`OK` tunes behind glass; `OK` on the already-playing channel or `PLAY` enters fullscreen).
4. **All UI Copy Wrapped in `U.t(...)`:** Every visible label, hint, toast, button, and Settings label must use `U.t(...)`.
5. **Contrast Safety Over Video:** Whenever `body.live-behind` is active, frosted overlays force dark glass + white typography even when user theme is `Gray` or `White`.
6. **Zero Side-Effect Packaging / Workspace Rules:** Work strictly inside `/Users/ediz/Downloads/PERS/TV/StremioK` on `feat/apltv-iptv-parity` (never create git worktrees, never push upstream, never sideload onto TV or touch `zx-pi` during blackout windows without explicit instruction).

## Review Focus

When reviewing each task and the whole-branch diff, inspect closely for:
- **ES5 & Script Load Order:** `js/view-iptv.js` loaded after `js/view-guide.js` and before `js/views.js` in `index.html`; `0` ES5 violations across `js/` and `service/`.
- **Namespace Export Completeness:** Every helper called externally must be explicitly returned by `js/player.js` (`isLivePlaying`, `isBrowseOverlay`, `currentLiveId`, `liveMeta`, `onLiveMetaChange`, `setBrowseOverlay`, `togglePlay`), `js/views.js` (`zapLiveChannel`, `syncLiveBrowse`, `iptvBackOn`, `backInIptv`), and `js/iptv.js` (`getTidyCfg`, `setTidyCfg`, `tidyChannels`, `rebuild`).
- **`BACK` & Decoder Leak Safety:** Leaving `IPTV`/`Guide` for `Movies`/`Series`/`Detail`/`Settings` always stops `browseOverlay` playback so AVPlay hardware decoder is released; `BACK` in Frosted Mode closes modals -> steps panes/Top Menu -> stops stream *before* ever invoking `askExit()`.
- **Tidier Collision & Stripping Safety:** `FOX (TR)` vs `FOX (US)` never merge; `Channel 4 +1` vs `Channel 4` never merge; `Channel 18` isn't flagged as Adult; `*** TRT 1 HD ***` cleans to `TRT 1` rather than being dropped as a separator; favorites remain intact when toggling `Tidy <-> Raw`.
- **OLED Orbit Cleanup:** CSS `transform` resets cleanly (`''`) on `Player.exit()`, tab exit, and `oledShift: 'off'`; `.av-player` is never shifted.

---

### Task 1: Deterministic `catchupUrl` Clock Fix, `stremiok.prefs` Schema & Extended `formatTags`

**Files:**
- Modify: `tests/run.js`
- Modify: `js/stremio.js`

- [ ] **Step 1: Fix `catchupUrl` VM `Date` sandbox flake and write failing tests for `Stremio.getPrefs()` & `Stremio.formatTags()`**
  - Open `tests/run.js` around line 675 (`catchupUrl`) and line 1150 (`Summary`).
  - Pass `Date: Date` inside extra globals in `loadBrowserScript('js/iptv.js', { Date: Date, YTPlay: ... })` inside `catchupUrl` test (and restore `Date.now` in `finally`).
  - Add unit test `'prefs & formatTags (Tier 1 Live TV prefs, FPS & Mbps bitrate)'` loading `js/stremio.js`:
    - Assert defaults: `iptvTidy === true`, `iptvHideAdult === true`, `iptvCollapseVariants === true`, `iptvCountries === 'TR,UK,NL'`, `liveBrowseMode === true`, `oledShift === 'auto'`.
    - Assert validation: invalid `oledShift` falls back to `'auto'`; `iptvCountries` sanitizes/uppercases `' tr, de , us '` -> `'TR,DE,US'` (capped at 8 valid codes).
    - Assert `Stremio.formatTags({ res: 1080, codec: 'h264', audio: ['aac'], container: 'hls' }, { height: 2160, codec: 'hevc', fps: 50, bitrate: 14200000, audio: 'eac3', channels: 6 })` includes `4K`, `HEVC`, `50fps`, `DD+ · 5.1`, `14.2 Mbps`, `HLS` (joined by `'  ·  '`), and gracefully omits `fps`/`bitrate` when absent (`0`).

- [ ] **Step 2: Run test suite and verify the new assertions fail**
  - Run: `cd /Users/ediz/Downloads/PERS/TV/StremioK && node tests/run.js`
  - Expected: `catchupUrl` passes now (`9` old tests pass); new `'prefs & formatTags'` test fails cleanly because new keys and `fps`/`bitrate` handling do not exist yet.

- [ ] **Step 3: Implement `stremiok.prefs` extensions & `formatTags` FPS/bitrate support in `js/stremio.js`**
  - Add pure ES5 helper `countryCsv(val)` normalizing comma/space separated 2-letter uppercase tokens (max 8 codes; default `'TR,UK,NL'` when `val === undefined`, allowing `''` empty string when explicitly cleared to `'off'`).
  - Extend `getPrefs()` return object cleanly (`p.iptvTidy !== false`, `p.iptvHideAdult !== false`, `p.iptvCollapseVariants !== false`, `iptvCountries: countryCsv(p.iptvCountries)`, `liveBrowseMode: p.liveBrowseMode !== false`, `oledShift: p.oledShift === 'on' || p.oledShift === 'off' ? p.oledShift : 'auto'`).
  - Update `formatTags(info, actual)` (`js/stremio.js:2343-2368`): when `actual && actual.fps > 0`, push `actual.fps + 'fps'`; when `actual && actual.bitrate >= 100000`, push `(Math.round(actual.bitrate / 100000) / 10).toFixed(1) + ' Mbps'`. Keep VOD behavior intact when `fps`/`bitrate` are zero.

- [ ] **Step 4: Run `node tests/run.js` & verify PASS + ES5 guard, then commit**
  - Run: `cd /Users/ediz/Downloads/PERS/TV/StremioK && node tests/run.js`
  - Expected: `10 passed, 0 failed, 10 total`, `[PASS] ES5 syntax guard`.
  - Commit: `git add tests/run.js js/stremio.js && git commit -m "feat(prefs,osd): add Tier 1 IPTV prefs schema and FPS/bitrate formatTags"`

---

### Task 2: Smart Playlist Tidier, Country Sorter & Variant Merger (`js/iptv.js`)

**Files:**
- Modify: `js/iptv.js`
- Modify: `tests/run.js`

- [ ] **Step 1: Write failing unit tests for `IPTV.tidyChannels`, `IPTV.rebuild`, favorites preservation, and `IPTV.streams` variants in `tests/run.js`**
  - Add `'iptvTidy (separators, adult filter, TR/UK/NL boost, variant collapse & favorites)'`:
    - Test separator dropping (`'--- === ---'`, `'***'`, `'|||||'`) WITHOUT dropping bordered real channel `'*** TRT 1 HD ***'` -> cleaned name `'TRT 1'`, `_country: 'TR'` (when in `'TR | Ulusal'`).
    - Test adult filtering: drops `'TR | Adult 18+'` / `'XXX Playboy'`, preserves `'Channel 18 HD'` (`Channel 18` must NOT be dropped).
    - Test Unicode & timeshift safety: `'Show TV Ü'` stays distinct; `'Channel 4 HD'` and `'Channel 4 +1 HD'` stay SEPARATE channels; `'FOX HD'` under `'TR | Ulusal'` and `'FOX HD'` under `'US | Entertainment'` stay SEPARATE channels.
    - Test variant collapsing & ranking: `'TRT 1 SD'`, `'TRT 1 Backup'`, `'TRT 1 FHD'`, `'TRT 1 HEVC'`, `'TRT 1 4K UHD'` in `'TR | Ulusal'` / `'TR | 4K'` collapse into ONE channel `'TRT 1'` with `variants.length === 5` ordered `[4K UHD, FHD, HEVC, SD, Backup]`!
    - Test `IPTV.streams(mergedChannel.id)` returns all 5 ordered stream entries with badge labels (`4K · ...`, `FHD · ...`, `Backup · ...`).
    - Test `IPTV.setFavorite(rawSubId, true)` stays `isFavorite(mergedId) === true` when switching `Raw -> Tidy -> Raw` via `IPTV.setTidyCfg(...)` + `IPTV.rebuild()`, without re-calling `ytliveList` / network!
    - Test `countries: ['TR', 'UK', 'NL']` boosts `TR`, then `UK`, then `NL`, then `DE`/`US` while maintaining internal relative group order.

- [ ] **Step 2: Run `node tests/run.js` and confirm failure on missing API**
  - Run: `cd /Users/ediz/Downloads/PERS/TV/StremioK && node tests/run.js`
  - Expected: Fails on missing `IPTV.tidyChannels` / `IPTV.getTidyCfg`.

- [ ] **Step 3: Implement Pure ES5 Playlist Tidier Pipeline in `js/iptv.js`**
  - Maintain `_rawByPlaylist = {}` storing untouched per-playlist parsed channel arrays inside `loadOne` and clearing in `reset()`.
  - Implement canonical `getTidyCfg()` / `setTidyCfg(patch)` reading/writing `'stremiok.prefs'` directly (or via `Stremio.getPrefs()`/`setPref` if defined) so both runtime UI and standalone Node tests share identical config.
  - Implement pure ES5 helpers inside `js/iptv.js`:
    - `isSeparatorName(rawName)`: strips decorative boundary runs; returns true if core has 0 Unicode/ASCII letters/digits.
    - `isAdultChannel(c)`: checks `group` + `name` against `/\b(?:xxx|adult|18\+|porn|porno|erotic|erotik|nsfw|sex|brazzers|playboy|hustler|redlight|dorcel|venus)\b/i` or `(?:\+18|18\+|₊₁₈)`.
    - `extractCountry(group, name)`: extracts normalized 2-letter codes (`TR`, `UK`, `NL`, `DE`, `US`, `FR`, `ES`, `IT`, `AR`, etc.) ignoring TV tokens (`TV`, `HD`, `SD`, `4K`, `8K`, `IP`, `FX`).
    - `cleanGroup(group, country)` & `cleanChannelMeta(c)`: computes `_country`, `_rawName`, `_rawGroup`, `_qScore`, `_qBadge` (`4K`, `FHD 50`, `HEVC`, `HD`, `SD`, `Backup`), `_cleanName`, `_cleanGroup` while safeguarding channel names like `HD+` or `Channel 4 +1`.
    - `normalizeMergeKey(name)`: ES5 Unicode-safe punctuation stripping keeping `+` and non-ASCII word chars.
    - `collapseVariants(list)` & `orderByCountries(list, countries)`: collapses same `(type, _country || _cleanGroup, normKey)` into one primary record with `.variants` (compact array) and `._mergedIds` (`byId` aliases all `_mergedIds` cleanly to `primary`).
  - Update `isFavorite(id)` / `setFavorite(id, on)` to check `byId[id]._mergedIds` transparently; update `streams(id)` to map multi-variant channels via `plainStreams` / `youTubeEnd(v0)` cleanly; expose `getTidyCfg`, `setTidyCfg`, `tidyChannels`, `rebuild` on returned `IPTV` object.

- [ ] **Step 4: Run `node tests/run.js` & verify all tests pass, then commit**
  - Run: `cd /Users/ediz/Downloads/PERS/TV/StremioK && node tests/run.js`
  - Expected: `11 passed, 0 failed, 11 total`, `0` ES5 violations.
  - Commit: `git add js/iptv.js tests/run.js && git commit -m "feat(iptv): add Smart Playlist Tidier, country sorter, adult filter and variant merger"`

---

### Task 3: Player Dual-Mode `browseOverlay`, Extended Telemetry (`FPS`/`Bitrate`), LiveMeta Listeners & OLED Protection

**Files:**
- Modify: `js/util.js`
- Modify: `js/player-core.js`
- Modify: `js/player-controls.js`
- Modify: `js/player.js`
- Modify: `css/style.css`
- Modify: `tests/run.js`

- [ ] **Step 1: Write unit tests for `parseFps`, `setBrowseOverlay`, `liveMeta` & `onLiveMetaChange` in `tests/run.js`**
  - Add `'playerBrowseOverlay & liveMeta (state transitions & FPS parser)'` verifying:
    - `parseFps`: handles `'50'`, `'50/1'`, `'60000/1001'` (`59.94`), `'25.000'` (`25`), rejects invalid (`'0'`, `'abc'`, `999`).
    - `Player.setBrowseOverlay(true)` reveals `#app`, adds `body.live-behind`, returns `Player.isBrowseOverlay() === true` while keeping `Player.isLivePlaying() === true`.
    - `Player.setBrowseOverlay(false)` removes `body.live-behind` and adds `'hidden'` to `#app`.
    - `Player.exit()` clears both `live-behind`, `browseOverlay`, and resets OLED orbit transforms (`style.transform = ''`).
    - `Player.onLiveMetaChange(fn)` fires with `{ width, height, fps, bitrate, codec, tags }` when metadata resolves.

- [ ] **Step 2: Run test suite and verify the new assertions fail**
  - Run: `cd /Users/ediz/Downloads/PERS/TV/StremioK && node tests/run.js`

- [ ] **Step 3: Implement `U.oledOrbit` helpers (`js/util.js`)**
  - Add pure ES5 `U.setOledShift(mode, bg)` and `U.tickOledOrbit(forceReset)` / `U.startOledOrbit()` / `U.stopOledOrbit()`:
    - Orbit offsets `[[0,0],[2,0],[2,2],[0,2],[-2,2],[-2,0],[-2,-2],[0,-2]]`.
    - Shifts explicit target selectors `['#player-osd', '#player-bar', '#stream-info', '#sub-menu', '.iptv-shell', '.guide']` every `60000ms` via `translate3d(x + 'px', y + 'px', 0)` when active (`mode === 'on'` or `mode === 'auto' && (bg === 'dark' || bg === 'black')`), resetting all `style.transform = ''` cleanly when disabled or exited.

- [ ] **Step 4: Implement `browseOverlay`, extended `playerFormats()`, `liveMeta()`, `onLiveMetaChange()`, and OLED pause dimmer**
  - In `js/player-core.js`:
    - Add `S.browseOverlay = false`, `_liveMetaFns = []`, `_metaPollTimer = null`.
    - Update `playerFormats()`: add `parseFps(...)`, extract `width`, `height`, `fps`, `bitrate` (plus `videoWidth`/`videoHeight` in HTML5 path). Schedule one-shot `2500ms` retry if `height === 0 || fps === 0`, updating `S.actual` and firing `renderOSD()` + `emitLiveMeta()`.
    - Implement `renderTags()` pill DOM: tokenize `'  ·  '` output from `Stremio.formatTags(...)` into `.osd-tag-pill` spans (highlighting resolution/HDR/HEVC/FPS badges cleanly via CSS class `.hi`).
    - Implement `isLivePlaying()`, `isBrowseOverlay()`, `currentLiveId()`, `liveMeta()`, `onLiveMetaChange(fn)`, `setBrowseOverlay(on)`; honor `ctx.browseOverlay` inside `play()` (suppress full-screen `#spinner` overlay and initial OSD when opening behind glass); clean up `live-behind`, `_metaPollTimer`, and OLED orbit inside `exit()` and `stopLiveLook()`.
  - In `js/player-controls.js`:
    - Expose `P.togglePlay = togglePlay;` cleanly.
    - Add `pauseIdle` `120000ms` dimmer timer on `PAUSE` -> sets `.oled-dim` on `#player-osd` & `#player-bar`, cleared on any `handleKey()` action or `PLAY`/`resume`/`exit()`.
  - In `js/player.js`:
    - Explicitly export: `isLivePlaying`, `isBrowseOverlay`, `currentLiveId`, `liveMeta`, `onLiveMetaChange`, `setBrowseOverlay`, `togglePlay`.
  - In `css/style.css`:
    - Style `.osd-tag-pill`, `.osd-tag-pill.hi`, and `#player-osd.oled-dim, #player-bar.oled-dim { opacity: 0.35; -webkit-transition: opacity 1.5s ease; transition: opacity 1.5s ease; }`.

- [ ] **Step 5: Run `node tests/run.js`, verify clean green run, then commit**
  - Run: `cd /Users/ediz/Downloads/PERS/TV/StremioK && node tests/run.js`
  - Expected: All tests pass, `0` ES5 violations.
  - Commit: `git add js/util.js js/player-core.js js/player-controls.js js/player.js css/style.css tests/run.js && git commit -m "feat(player,oled): add browseOverlay mode, FPS/bitrate liveMeta, OSD pills and OLED protection"`

---

### Task 4: `Views.zapLiveChannel`, Guarded `App.back()` / Key Routing & Frosted Glass CSS Layer

**Files:**
- Modify: `js/view-core.js`
- Modify: `js/views.js`
- Modify: `js/app.js`
- Modify: `css/style.css`
- Modify: `css/modern.css`

- [ ] **Step 1: Add self-contained `V.zapLiveChannel(ch, opts)` in `js/view-core.js` & export in `js/views.js`**
  - Implement `zapLiveChannel(ch, opts)` cleanly independent of `view-detail.js`'s `_d`:
    - Accepts `ch` and `opts = { browseOverlay, channels, idx, playBest, onZapped }`.
    - Builds ordered candidate streams via `IPTV.streams(ch.id)` / `Stremio.getStreams(ch.type || 'tv', ch.id)` (incorporating `ch.variants` when present).
    - Starts `Player.play(ctx, onExit)` directly without calling `App.openDetail` or mutating `_stack`, tagging `ctx.fromHome = true`, `ctx.browseOverlay = !!opts.browseOverlay`, and attaching self-contained `ctx.zap(dir)`, `ctx.zapToId(nextCh)`, `ctx.zapTo(num)` closures over `opts.channels`.
    - `onExit` calls `Views.syncLiveBrowse(ctx.id)` cleanly and updates focus onto the ended channel row when appropriate.
  - Update `js/views.js`: add `zapLiveChannel: V.zapLiveChannel, syncLiveBrowse: V.syncLiveBrowse, iptvBackOn: V.iptvBackOn, backInIptv: V.backInIptv`.

- [ ] **Step 2: Update `js/app.js` (`onKey`, `back`, `guideKey`, `goHome`, `returnFromLive`, `showScreen`)**
  - Update `onKey(action)`:
    - If `Player.isActive() && !Player.isBrowseOverlay()` (Fullscreen):
      - `action === 'BACK'`: if `Player.isLivePlaying()`, `S.ctx.fromHome`, `!P_hasOpenOverlay` (check `Player.handleKey` or add `Player.hasOverlayOpen()` check / let `Player.handleKey('BACK')` return `'browse'` sentinel when top-level live `BACK` & `liveBrowseMode`!), switch cleanly to `Player.setBrowseOverlay(true)` + focus via `Views.syncLiveBrowse(Player.currentLiveId())` instead of killing playback! Wait: check cleanly — expose `Player.handleKey` returning `'browse'` OR handle right inside `js/player-controls.js`'s `BACK` case when `S.isLive && S.ctx && S.ctx.fromHome && Stremio.getPrefs().liveBrowseMode`! Returning `'browse'` or invoking a callback avoids peeking into `Player` private overlay vars from `app.js`!
      - Actually cleanest design: inside `js/player-controls.js` (`BACK` when no `_menuOpen`/`_drawer`/`_cast`/`_barOpen`/`_scrub`/`_skip`): if `S.isLive && S.ctx && S.ctx.fromHome && typeof Stremio !== 'undefined' && Stremio.getPrefs().liveBrowseMode`, call `P.setBrowseOverlay(true)` and invoke `S.ctx.onBrowseReturn && S.ctx.onBrowseReturn(S.ctx.id)` (which calls `Views.syncLiveBrowse(id)`)! Clean, zero circular dependency!
    - If `Player.isActive() && Player.isBrowseOverlay()` (Frosted Browse):
      - Route `STOP` -> `Player.exit()`, `PLAY` -> `Player.setBrowseOverlay(false)`, `PAUSE`/`PLAYPAUSE` -> `Player.togglePlay()`, `CHUP`/`CHDOWN` -> `Player.zap(dir)` / `ctx.zap(+1/-1)`, `BLUE` -> `Player.toggleStreamInfo()`, `GUIDE` -> toggle `tv <-> guide` tab cleanly (`Views.syncLiveBrowse`), while D-pad / `OK` / `OK_LONG` / `NUM0..9` / `BACK` go straight to active Home screen!
  - Update `App.back()` exact guard sequence (`if (Player.isActive() && !Player.isBrowseOverlay()) ...` first -> modal -> detail -> settings -> local -> `Views.backInIptv()` -> `toTopMenu()` -> `if (Player.isBrowseOverlay()) { Player.exit(); return; }` -> `_stack.pop()` / `askExit()`).
  - Update `App.guideKey()`: when `Player.isLivePlaying() && liveBrowseMode` -> `Player.setBrowseOverlay(true); goHome('guide', Player.currentLiveId()); return;`.
  - Update `App.goHome(tab, liveId)` & `App.returnFromLive(focusNode, liveId)` to use `Views.syncLiveBrowse(liveId)`.
  - Update `showScreen(name)`: if leaving `'home'` while `Player.isBrowseOverlay()`, call `Player.exit()`.

- [ ] **Step 3: Add `body.live-behind` & `.glass-pane` styles to `css/style.css` & `css/modern.css`**
  - Make `body.live-behind`, `body.live-behind #app`, `body.live-behind #screen-home` transparent; style `.home-bg` edge vignette scrim when `live-behind` is active.
  - Define `.glass-pane` translucent surface + `body.look-modern.fx-full .glass-pane` blur surface (`blur(22px) saturate(1.25)`), overriding `bg-light` inside `body.live-behind` so overlays over video remain dark-glass + white text.

- [ ] **Step 4: Run `node tests/run.js`, verify clean green run, then commit**
  - Run: `cd /Users/ediz/Downloads/PERS/TV/StremioK && node tests/run.js`
  - Commit: `git add js/view-core.js js/views.js js/player-controls.js js/app.js css/style.css css/modern.css && git commit -m "feat(nav,glass): add Views.zapLiveChannel, guarded browseOverlay routing and frosted glass CSS"`

---

### Task 5: 3-Pane Windowed Live TV Browser on `IPTV` Tab (`js/view-iptv.js` + `js/view-home.js` + `index.html`)

**Files:**
- Create: `js/view-iptv.js`
- Modify: `js/view-home.js`
- Modify: `index.html`
- Modify: `css/style.css`
- Modify: `css/modern.css`
- Modify: `tests/run.js`

- [ ] **Step 1: Add pure ES5 `js/view-iptv.js` (`V.iptvBrowser`, `V.iptvBackOn`, `V.backInIptv`, `V.iptvLeave`)**
  - Implement modular sub-builders (single-purpose, shallow functions):
    - `buildGroups(rawFilter)`: builds virtual categories (`★ Favorites` if any, `🕒 Recent` if any, `📺 All Channels`) + sorted tidied/raw groups from `IPTV.channels()`.
    - `renderToolbar()`: `🔍 Filter`, `✨ Tidied / Raw` live toggle (`IPTV.setTidyCfg({ enabled: !cfg.enabled }); IPTV.rebuild(); redraw()`), quick jump pills (`Favorites`, `Recent`, `All`), plus compact live-playing HUD (`● LIVE · <Name> · [Fullscreen] [⏹ Stop]`) updated via `Player.onLiveMetaChange`.
    - `renderCatsPane()` (`CAT_ROWS = 11` sliding window): `70ms` debounced category switch on highlight, immediate on `RIGHT`/`OK`.
    - `renderChansPane()` (`CHAN_ROWS = 10` sliding window): renders ONLY `10` `.iptv-row` DOM nodes (`number`, `img.iptv-logo` with hash-colored 2-letter monogram fallback on `onerror`, cleaned title, `★` fav badge, `↺` catch-up badge, quality pill `4K`/`FHD`/`HD`, `+N` source count badge, EPG `Now` title + progress bar, live playing dot). Moving within `[winTop, winTop + 10)` does ZERO DOM rebuild (`Focus.set` only).
    - `EPG.want(visibleIds)` debounced `40ms` + live `EPG.onChange` updating visible EPG text in-place.
    - `renderInspector(ch)`: renders right pane header, country/playlist provenance, focusable action pills (`▶ Watch / ⛶ Fullscreen`, `★ Favorite`, `🔀 Sources (N)` picker modal, `↺ Catch-up` aired shows modal via `EPG.schedule` + `IPTV.catchupUrl`), `NOW` card + progress bar + synopsis (`4` lines max), and `UP NEXT` timeline (`next 3` entries).
    - Full `Focus.__goUP`/`__goDOWN`/`__goLEFT`/`__goRIGHT` wiring across toolbar, Left Rail, Center List, and Right Inspector, plus `OK` (Dual-OK behind glass / fullscreen on 2nd `OK`), `OK_LONG` quick action picker, `PLAY` (fullscreen), `NUM0..9` quick jump banner, `backInIptv()` stepping Inspector -> Center -> Left -> false (so `App.back()` hits Top Menu next).
    - `V.iptvBackOn(id)`: finds `id` (or `_mergedIds`), focuses channel row inside current/All group cleanly.
    - Empty-state fallback: when `IPTV.channels()` is empty (or all filtered out by Adult/Filter), render a centered glass empty-state card with a focusable `[Open IPTV Settings]` or `[Clear Filter]` CTA wired `UP` to Top Menu so D-pad focus can never be stranded.

- [ ] **Step 2: Wire `js/view-iptv.js` into `index.html` and `js/view-home.js`**
  - Add `<script src="js/view-iptv.js?v=2.4.3"></script>` cleanly after `js/view-guide.js` and before `js/views.js` in `index.html`.
  - In `js/view-home.js`:
    - Include `'tv'` in `ownTab(t)` (`return t === 'continue' || t === 'calendar' || t === 'guide' || t === 'local' || t === 'tv';`).
    - In `renderHome()`: when `_homeTab === 'tv'`, set `#screen-home` class `'screen tab-tv'`, skip appending `.home-info`, mount `V.iptvBrowser(rows)`.
    - Add `V.syncLiveBrowse(id)` calling `V.iptvBackOn(id)` / `V.guideBackOn(id)` depending on `_homeTab`.
    - In `setHomeTab(key)` & tab-leaving paths: if switching to a non-live tab while `Player.isBrowseOverlay()`, call `Player.exit()`. Call `V.iptvLeave()` when leaving `'tv'`. (Single OLED orbit interval remains owned centrally by `U.setOledShift` + `Player.setBrowseOverlay`/`showOSD`, never duplicated inside `view-home.js`.)

- [ ] **Step 3: Add 3-pane responsive TV layout styles to `css/style.css` & `css/modern.css`**
  - Style `#screen-home.tab-tv .rows { top: 104px; }` (Modern) / `96px` (Classic), `.iptv-shell` flexbox container (`height: 100%; padding: 8px 60px 28px 60px`), `.iptv-toolbar`, `.iptv-cols` (`320px | 1fr | 520px`, `gap: 18px`), `.iptv-cat`, `.iptv-row`, `.iptv-monogram`, `.iptv-badge`, `.iptv-prog`, `.iptv-insp`, and live indicator glow.

- [ ] **Step 4: Add headless DOM windowing unit test in `tests/run.js`, verify ES5 + all tests, then commit**
  - Write unit test in `tests/run.js` instantiating a minimal DOM mock + `2,000` channels on `V.iptvBrowser(wrap)`, verifying `.iptv-row` count `<= 10` (`CHAN_ROWS`) and verifying scrolling `DOWN` shifts window without exceeding `10` rows!
  - Run: `cd /Users/ediz/Downloads/PERS/TV/StremioK && node tests/run.js`
  - Commit: `git add js/view-iptv.js js/view-home.js index.html css/style.css css/modern.css tests/run.js && git commit -m "feat(iptv-ui): add windowed 3-pane Live TV browser on IPTV tab"`

---

### Task 6: Frosted Glass `Guide` Grid Over Live Video (`js/view-guide.js` + CSS)

**Files:**
- Modify: `js/view-guide.js`
- Modify: `css/style.css`
- Modify: `css/modern.css`

- [ ] **Step 1: Upgrade `playChannel(g, r, best)` & active-channel marker inside `js/view-guide.js`**
  - Update `playChannel(g, r, best)`: when `!best && Stremio.getPrefs().liveBrowseMode`:
    - If `Player.isLivePlaying() && Player.currentLiveId() === c.id && Player.isBrowseOverlay()` -> `Player.setBrowseOverlay(false)` (enter fullscreen).
    - Else call `Views.zapLiveChannel(c, { browseOverlay: true, channels: list, idx: r })` so video tunes/zaps smoothly underneath the translucent EPG grid!
  - Inside `draw(g)`: add `.guide-ch-live` class + `● ` indicator to row `.guide-ch` matching `Player.currentLiveId()` cleanly, updating via `Player.onLiveMetaChange` when grid stays mounted.
  - Ensure `playCatchup(c, p, url)` exits any active `browseOverlay` live playback cleanly (`Player.exit` if needed) before opening catch-up VOD fullscreen.

- [ ] **Step 2: Restyle `Guide` for frosted glass under `body.live-behind` in `css/style.css` & `css/modern.css`**
  - Wrap `.guide` styling with `.guide-ch`, `.guide-track`, `.guide-prog`, `.guide-prog.now`, `#home-info` under `body.live-behind` using translucent dark glass panels (`rgba(14, 18, 28, 0.72)` + `backdrop-filter: blur(20px)` under `fx-full`), crisp focus ring, and playing-channel green/indigo marker.

- [ ] **Step 3: Run `node tests/run.js`, verify `0` failures/ES5 violations, then commit**
  - Run: `cd /Users/ediz/Downloads/PERS/TV/StremioK && node tests/run.js`
  - Commit: `git add js/view-guide.js css/style.css css/modern.css && git commit -m "feat(guide): support frosted live-behind browsing and Dual-OK zapping in TV Guide"`

---

### Task 7: Settings UI Integration (`js/view-settings.js`)

**Files:**
- Modify: `js/view-settings.js`

- [ ] **Step 1: Add 5 Live TV / Tidier settings rows inside `settingsIptv(wrap)` (`js/view-settings.js`)**
  - `Playlist Tidier` (`on`/`off`) -> `Stremio.setPref('iptvTidy', ...); IPTV.rebuild(); refreshAddonRows('local:iptv');`
  - `Preferred Countries` presets (`TR,UK,NL`, `NL,UK,DE`, `US,UK,CA`, `DE,AT,CH`, `''` Off, plus custom modal `App.openEntry` option allowing comma-separated ISO codes e.g. `TR,UK,DE`) -> updates `iptvCountries` + rebuilds cleanly.
  - `Collapse Quality Variants` (`on`/`off`) -> updates `iptvCollapseVariants` + rebuilds cleanly.
  - `Hide Adult (XXX / 18+)` (`on`/`off`) -> updates `iptvHideAdult` + rebuilds cleanly.
  - `Browse Over Live Video` (`on`/`off`) -> updates `liveBrowseMode`.

- [ ] **Step 2: Add `OLED Pixel Shift` row inside `settingsAppearance(wrap)` (`js/view-settings.js`)**
  - `subPickRow(U.t('OLED pixel shift'), [['auto', U.t('Auto (OLED / dark)')], ['on', U.t('Always on')], ['off', U.t('Off')]], 'oledShift', ...)` -> calls `Stremio.setPref('oledShift', cfg.oledShift); applyAppearance();` and configures `U.setOledShift(...)` inside `applyAppearance()`.

- [ ] **Step 3: Run `node tests/run.js`, verify ES5 & tests clean, then commit**
  - Run: `cd /Users/ediz/Downloads/PERS/TV/StremioK && node tests/run.js`
  - Commit: `git add js/view-settings.js && git commit -m "feat(settings): expose IPTV tidier, country order, browse-over-live and OLED shift controls"`

---

### Task 8: End-to-End Headless Browser (`1920x1080`) Visual Verification & Package Build

**Files:**
- Verify: entire app via `http://localhost:8080` + `chrome-devtools-mcp` (`1920x1080`)

- [ ] **Step 1: Run complete unit & ES5 verification**
  - Run: `cd /Users/ediz/Downloads/PERS/TV/StremioK && node tests/run.js`
  - Confirm `0` failures and `0` ES5 violations across every file.

- [ ] **Step 2: Visual & Interactive Verification in Headless Chrome (`1920x1080`) via `chrome-devtools-mcp`**
  - Serve `/Users/ediz/Downloads/PERS/TV/StremioK` on `http://127.0.0.1:8080` temporarily, open in Chrome DevTools at `1920x1080`, inject test `localStorage` playlist fixtures (`2,000+` mock channels with separators, `XXX`, `TR`/`UK`/`NL`/`US` groups, `4K`/`FHD`/`HEVC`/`Backup` variants, mock EPG schedule, plus Modern + `fx-full` look).
  - Verify visually & via DOM evaluation:
    1. `IPTV` tab renders 3-pane split layout (`Categories` | `Channels` | `Inspector`), zero horizontal overflow, clean channel monograms, `.home-info` hidden on `tab-tv`.
    2. Rendered `.iptv-row` count `<= 10` and `.iptv-cat` count `<= 11` even with `2,000` loaded channels.
    3. Simulate D-pad navigation (`ArrowDown`, `ArrowLeft`, `ArrowRight`, `Enter`, `Escape`): verify focus moves cleanly across Center -> Left Rail -> Center -> Inspector -> `Tidy / Raw` toggle pill.
    4. Simulate `body.live-behind` frosted glass mode on both `IPTV` and `Guide` tabs, plus `#osd-tags` pill badges; capture/inspect screenshot & verify zero uncaught console errors!
  - Tear down temporary HTTP server cleanly.

- [ ] **Step 3: Check package readiness**
  - Check `tizen build-web` / `.wgt` build readiness (or build `.wgt` artifact only when ready; do NOT sideload onto TV or touch `zx-pi` during blackout windows unless explicitly requested!).
