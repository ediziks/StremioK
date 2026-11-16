# StremioK IPTV Overhaul (APL TV Parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `StremioK`'s IPTV stack (`service/index.js`, `js/iptv.js`, `js/xtvod.js`, `js/epg.js`, `js/view-guide.js`, `js/view-settings.js`, `js/player-controls.js`) so 250K+ Xtream/M3U providers load fast without TV memory crashes, groups are curated from your phone, and Live TV supports Xtream Catch-Up plus an in-player `Now / Next` channel drawer.

**Architecture:** Move heavy Xtream Live (`get_live_categories` + `get_live_streams`) and streaming M3U parsing/storage out of browser RAM/`IndexedDB` into `service/index.js` (Node.js background service on `127.0.0.1:8099`, matching the existing `xtvControl` disk-backed JSONL pattern). Add category filtering before channel loading (`p.groups` + a phone QR checkbox page via `entryControl`), an Xtream `"Live TV only"` toggle (`p.noVod`), Xtream `/timeshift/` Catch-Up from the Guide tab, and an in-player Live Channel/EPG drawer that keeps playback running while browsing.

**Tech Stack:** ES5 JavaScript (Chromium 47 / Tizen 3.0+ compatible, unminified), Node.js built-in modules (`http`, `https`, `fs`, `crypto`, `url`, `string_decoder`) in `service/index.js`, `apps2samsung-cli` for `.wgt` signing/deployment.

---

## Global Constraints

- **ES5 only in `js/` and `service/`:** `var` only; no `let`/`const`, arrow functions, template literals, classes, destructuring, spread, default params, or `async`/`await`.
- **Unminified & modular:** Preserve `ViewParts` (`V`) and `PlayerParts` (`P`) split-file architecture; no external runtime npm dependencies in `js/` or `service/`.
- **Strict security & bounds:** Reuse `dlHostOk`, `sameServerRedirect`, `guardSelf`, `entryAllowed`/`hasToken`, byte/time caps, and HTML escaping (`&`, `<`, `>`, `"`, `'`) on all phone/TV inputs; never leak credentials in logs, exports, or URLs without `U.redactUrl`.
- **Tizen 3.0+ & browser-mode safe:** UI strings wrapped in `U.t(...)` / `U.tn(...)`; gracefully degrade in desktop browser mode (`YTPlay.installMode() === 'browser'`) with existing `U.getText` fallback.
- **Docs & version sync:** Update `docs/SETTINGS.md`, `docs/TECHNICAL-REFERENCE.md`, `docs/USER-GUIDE.md`, `CHANGELOG.md`, `translations/template.json`, and `?v=` cache-busters when cutting a build.

## Review Focus

- **250K+ Xtream provider (`200K` VOD + `25K` Live):** `get_live_streams` only pulls live channels (~2–10 MB instead of 100+ MB `get.php`), and `p.noVod` prevents `XtVod` from indexing 200K VOD items in the background.
- **Giant raw `.m3u` without Xtream API (80–150+ MB):** `service/index.js` parses the stream line-by-line via `StringDecoder` without holding the raw M3U string in memory or `IndexedDB`, serving only enabled groups to browser RAM.
- **XSS / weird group names on the Phone QR page (`|EN|`, `<Sport>`, `&`, quotes):** Every group name rendered on `entryPage` HTML is entity-escaped (`escHtml`) and submitted as indexed IDs/keys, validated strictly on the server.
- **Xtream Catch-Up timezone differences:** Providers vary between UTC and server-local time for `/timeshift/.../{YYYY-MM-DD:HH-MM}/`; include a per-playlist `Catch-up offset` setting (`0`, `-12..+14` hours, default `0` UTC) plus duration clamping to `archiveDays`.
- **Live Drawer + `CH+`/`CH-` state consistency:** Opening/closing the in-player channel drawer must not break `AVPlay` playback, `BACK` stack (`App.returnFromLive`), or `view-guide.js`'s `guideBackOn(id)` when zapping across groups.

---

### Task 1: Fork Setup & Local ES5 + Node Test Harness

**Files:**
- Create: `tests/run.js`
- Verify: `package.json`, `js/*.js`, `service/index.js`

**Interfaces:**
- Produces: `node tests/run.js` — verifies ES5 compatibility (via Node `vm.Script` + syntax check banning `let`/`const`/`=>`/template-strings outside comments/strings where appropriate, plus unit tests for M3U streaming parser, Xtream URL builders, Catch-Up timestamp formatting, and phone group HTML escaping).

- [ ] **Step 1: Create a clean working branch in the local repo**

Run:
```bash
cd ~/Downloads/PERS/TV/StremioK
git checkout -b feat/apltv-iptv-parity
```
Expected: `Switched to a new branch 'feat/apltv-iptv-parity'`.

- [ ] **Step 2: Write initial failing test runner `tests/run.js`**

Create `tests/run.js` with minimal zero-dep Node assertions (`assert`) checking:
1. Every `.js` file under `js/` (excluding `js/vendor/`) and `service/` parses cleanly in Node's `vm.Script` and contains no ES6+ keywords (`\b(let|const|class|async|await)\b` or `=>` or `` ` `` in code tokens).
2. Stubbed placeholder tests for `xtLiveUrl`, `catchupUrl`, `m3uStreamParser`, and `escHtml`.

- [ ] **Step 3: Run `node tests/run.js` to verify baseline ES5 check passes and new unit tests fail**

Run: `node tests/run.js`
Expected: ES5 syntax scan PASS on existing files; new unit tests FAIL (`not implemented`).

- [ ] **Step 4: Commit baseline test harness**

```bash
git add tests/run.js
git commit -m "test: add ES5 syntax guard and IPTV test harness"
```

---

### Task 2: Xtream Live API (`get_live_categories` + `get_live_streams`) & `"Live TV only"` Toggle

**Files:**
- Modify: `service/index.js` (reuse `xtvGet` / `xtvItems` pattern; add `/xtlive/cats` & `/xtlive/list`)
- Modify: `js/ytplay.js` (add `xtliveCats(base, user, pass)` & `xtliveList(base, user, pass, fmt, cats, force)`)
- Modify: `js/iptv.js` (support `xtream: true`, `noVod: true|false`, `groups: [catId...]` on playlists; route Xtream live loading via `YTPlay.xtliveList` when service is running, with `get.php` fallback in browser mode)
- Modify: `js/xtvod.js:16-24` (skip playlists where `p.noVod === true`)
- Modify: `js/view-settings.js` (`addXtream`, `playlistActions`)

**Interfaces:**
- Produces in `service/index.js`:
  - `GET /xtlive/cats?base=...&user=...&pass=...` → `{ cats: [{ id, name }] }` (from `player_api.php?action=get_live_categories`).
  - `GET /xtlive/list?base=...&user=...&pass=...&fmt=ts|hls[&cats=id1,id2][&force=1]` → `{ state, at, count, groups, dropped, channels: [{ id, name, group, logo, tvgId, url, archive, archiveDays }] }` (streams `player_api.php?action=get_live_streams` via `xtvItems`, maps `category_id` to category name, drops unselected categories *during streaming* so only selected groups enter memory/disk!).
- Produces in `js/iptv.js`:
  - `xtreamGroups(id) -> Promise<[{ id, name }]>`
  - `setPlaylistGroups(id, ids) -> boolean`
  - `setXtreamNoVod(id, on) -> boolean`
  - Channel fields added on Xtream channels: `c.streamId` (`+o.stream_id`), `c.archive` (`+o.tv_archive === 1`), `c.archiveDays` (`+o.tv_archive_duration || 0`).

- [ ] **Step 1: Add unit tests in `tests/run.js` for Xtream Live record mapping & URL builder**

Assert that:
- `xtLiveRecord(o, catMap, base, user, pass, 'ts')` produces `{ id, name, group, logo, tvgId, url: base + '/live/' + user + '/' + pass + '/' + o.stream_id + '.ts', archive: true, archiveDays: 7 }`.
- Unselected `category_id` entries are skipped during streaming when `cats` filter is non-empty.

- [ ] **Step 2: Implement `/xtlive/cats` and `/xtlive/list` in `service/index.js`**

Reuse `xtvGet` + `xtvItems` + `xtvSave`/`xtvLoad` style disk cache (`xtl-<hash>.jsonl` in `tokenDir()`, capped at `XTV_MAX` `150 MB`, `3`-day expiry in `xtvSweep`).

- [ ] **Step 3: Wire `YTPlay.xtliveCats` / `YTPlay.xtliveList` in `js/ytplay.js`, Xtream Live loader in `js/iptv.js`, and `noVod` check in `js/xtvod.js`**

In `js/xtvod.js` `accounts()`: filter out `p.noVod === true`.
In `js/iptv.js` `loadOne()`: when `isXtream(playlist.url)` and `YTPlay.xtliveList` is available, load via `YTPlay.xtliveList(..., playlist.groups)` instead of downloading giant `get.php`. Keep `get.php` path only when in `'browser'` dev mode.

- [ ] **Step 4: Update `js/view-settings.js` UI for Xtream `Channel groups` + `Live TV only`**

In `playlistActions()`:
- Add **`Channel groups`** (`pickMany`, matching Stalker's existing `Channel groups` action) for Xtream accounts.
- Add **`Movies & Series (VOD): Included / Live TV only`** toggle (`IPTV.setXtreamNoVod`), calling `XtVod.reload` / `refreshAddonRows` when changed.

- [ ] **Step 5: Run tests & check browser UI**

Run: `node tests/run.js`
Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add service/index.js js/ytplay.js js/iptv.js js/xtvod.js js/view-settings.js tests/run.js
git commit -m "feat(iptv): use Xtream get_live_streams API, category filter, and Live-only toggle"
```

---

### Task 3: Service-Side Streaming M3U Parser & Paged Disk Store (For Giant Raw `.m3u` URLs)

**Files:**
- Modify: `service/index.js` (add `/m3u/load`, `/m3u/groups`, `/m3u/channels`, disk store `m3u-<hash>.jsonl`)
- Modify: `js/ytplay.js` (add `m3uLoad`, `m3uGroups`, `m3uChannels`)
- Modify: `js/iptv.js` (for non-Xtream HTTP(S) `.m3u` URLs when service is running, delegate download/parsing to `service/index.js` instead of `U.getText` + `IndexedDB`; filter by `playlist.groups` before building `_cache`)

**Interfaces:**
- Produces in `service/index.js`:
  - `GET /m3u/load?u=<url>[&groups=g1,g2][&force=1]` → `{ state, at, title, guides: [...], groups: [{ name, type, count }], count, dropped, error }`
  - `GET /m3u/channels?u=<url>[&groups=g1,g2]` → `{ channels: [...] }` (streamed in chunks up to `250 MB` source file, never keeping raw M3U text string in RAM or `IndexedDB`).

- [ ] **Step 1: Add unit tests in `tests/run.js` for chunked M3U line reader across split UTF-8/CRLF chunk boundaries**

Test that splitting `#EXTINF:-1 tvg-id="a" group-title="TR",Channel 1\nhttp://...` mid-line across two 17-byte `Buffer` chunks produces the exact parsed channel object.

- [ ] **Step 2: Implement streaming chunked M3U parser + `m3u-<hash>.jsonl` cache in `service/index.js`**

Read HTTP(S) response chunks with `StringDecoder('utf8')`, parse line-by-line (supporting `#EXTINF`, `group-title`, `tvg-id`, `tvg-logo`, `#EXTVLCOPT`, `#EXTHTTP`, `#KODIPROP`, `|Referer=` syntax), cap at `250 MB` (`M3U_MAX`), enforce `dlHostOk` + `guardSelf`, and store parsed JSON lines on disk.

- [ ] **Step 3: Wire `YTPlay.m3u*` and `js/iptv.js` `loadOne()` for raw M3U playlists**

Expose group counts on `status(id)` and enable `Channel groups` (`pickMany`) in `js/view-settings.js` for raw M3U playlists too, not just Stalker/Xtream.

- [ ] **Step 4: Run tests & verify no memory regressions**

Run: `node tests/run.js`
Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add service/index.js js/ytplay.js js/iptv.js js/view-settings.js tests/run.js
git commit -m "feat(iptv): stream-parse large M3U playlists in background service"
```

---

### Task 4: `"Edit Groups on Your Phone"` QR Web UI (APL TV UX)

**Files:**
- Modify: `service/index.js` (`entryControl`, `entryPage` — add `what === 'iptvgroups'` supporting `POST /entry/open` or `/entry/give`-style payload `{ title, groups: [{ id, name, count, checked }] }` and returning JSON array of selected IDs on `/entry/poll`)
- Modify: `js/ytplay.js` (`entryOpenGroups(groupsPayload)` -> `{ url, token }`)
- Modify: `js/view-settings.js` (`playlistActions` → add **`Edit groups on your phone`** item opening QR modal + polling `entryPoll`, saving `setPlaylistGroups` / `setStalkerGroups`, and calling `Stremio.iptvReload(playlist.id)`)

**Interfaces:**
- Produces in `service/index.js`:
  - `POST /entry/open?what=iptvgroups` (body: JSON `{ name, groups: [{ id, name, count, on }] }`, max `512 KB`)
  - Phone HTML page `/e/<token>`: mobile-dark UI with live search box (`Filter groups...`), `Select all` / `Deselect all` buttons, checkboxes showing channel counts, and `Save to TV` button.

- [ ] **Step 1: Add unit test in `tests/run.js` for HTML escaping & group selection POST parsing**

Assert `<script>` in a group name is escaped (`&lt;script&gt;`) and `id=0&id=2` form POSTs resolve strictly against known group IDs.

- [ ] **Step 2: Implement `iptvgroups` phone page in `service/index.js` and `YTPlay.entryOpenGroups` in `js/ytplay.js`**

- [ ] **Step 3: Add `Edit groups on your phone` to `playlistActions` in `js/view-settings.js`**

Show a QR dialog with live status (`"Waiting for your phone…"`), apply selected groups when submitted, refresh `local:iptv` rows, and restart `EPG.start(playlist.id)`.

- [ ] **Step 4: Test locally via `python3 -m http.server 8080` + mock/Node test**

Run: `node tests/run.js`
Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add service/index.js js/ytplay.js js/view-settings.js tests/run.js
git commit -m "feat(iptv): add phone QR group curation page matching APL TV workflow"
```

---

### Task 5: Xtream Catch-Up (`tv_archive`) & In-Player `Now / Next` Live Channel Drawer

**Files:**
- Modify: `js/iptv.js` (store optional `archiveOffsetHours` on playlist; add `catchupUrl(channel, prog)` helper returning `{base}/timeshift/{user}/{pass}/{durationMin}/{YYYY-MM-DD:HH-MM}/{streamId}.{ts|m3u8}` when `channel.archive && within archiveDays`)
- Modify: `js/view-guide.js` (`draw()`, `pick()`, `hold()` — badge catch-up-capable past programs with `↺`, allow OK / `▶ Watch catch-up` on aired programs within `archiveDays`, launching player with `isLive: false` and `title: prog.title + ' · ' + ch.name`)
- Modify: `js/view-settings.js` (add `Catch-up time offset` in `playlistActions` for Xtream accounts: `UTC (0h)` / `-12h..+14h`)
- Modify: `js/player-controls.js`, `js/player-core.js`, `css/style.css` (add Live Channel & EPG Drawer: press `LEFT` or `UP › ≡ Channels` while watching Live TV to open a translucent left-side channel/group/EPG drawer without stopping playback; `↑/↓` scrolls channels with `Now / Next` titles, `←/→` switches groups/`★ Favorites`, `OK` zaps cleanly!)

**Interfaces:**
- Produces in `js/iptv.js`:
  - `IPTV.catchupUrl(channelId, progStartSec, progStopSec) -> string | ''`
  - `IPTV.setArchiveOffset(playlistId, hours) -> boolean`
- Produces in `js/player-controls.js`:
  - `openChannelDrawer()` / `closeChannelDrawer()`, hooked into `UP` bar (`if (S.isLive)`) and `LEFT` when `S.isLive && !menuOpen() && !barOpen()`.

- [ ] **Step 1: Add unit tests in `tests/run.js` for `catchupUrl` formatting & archive window bounds**

Assert:
- Program inside `archiveDays` produces `http://host:port/timeshift/user/pass/45/2026-11-16:18-00/12345.ts` (respecting `archiveOffsetHours`).
- Program older than `archiveDays` or currently airing/future returns `''`.

- [ ] **Step 2: Implement `catchupUrl` + `setArchiveOffset` in `js/iptv.js` and hook into `js/view-guide.js` + `js/view-settings.js`**

- [ ] **Step 3: Implement the In-Player Live Channel & EPG Drawer in `js/player-controls.js` and `css/style.css`**

Keep layout lightweight (DOM windowing `12` visible channel rows at a time, batching `EPG.want(...)` for visible rows) so zapping stays 60fps on Tizen.

- [ ] **Step 4: Run tests & verify UI in browser**

Run: `node tests/run.js`
Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add js/iptv.js js/view-guide.js js/view-settings.js js/player-controls.js js/player-core.js css/style.css tests/run.js
git commit -m "feat(iptv): add Xtream catch-up playback and in-player Now/Next channel drawer"
```

---

### Task 6: Docs, Localization Strings, Fork Packaging & S90D TV Verification

**Files:**
- Modify: `docs/SETTINGS.md`, `docs/TECHNICAL-REFERENCE.md`, `docs/USER-GUIDE.md`, `CHANGELOG.md`
- Modify: `translations/template.json` (+ `js/lang/tr.js`, `translations/tr.json` for user-visible strings)
- Verify: `package.json`, `config.xml`, `index.html`, `tizenbrew.html`

- [ ] **Step 1: Update documentation & translation keys for all new IPTV settings and features**

Follow `docs/DEVELOPER-GUIDE.md` rules (American spelling, concise tables, exact UI menu paths).

- [ ] **Step 2: Run full ES5 & unit test suite**

Run: `node tests/run.js`
Expected: All tests PASS with 0 ES6 violations.

- [ ] **Step 3: Package `.wgt` and sideload to Samsung S90D (`192.168.178.222`) via `apps2samsung-cli`** *(outside `zx-pi` blackout windows `15:25–22:05` / `23:55–01:35 CET`)*

```bash
cd ~/Downloads/PERS/TV/StremioK
zip -r ../tizen-tools/StremioK-iptv-dev.wgt index.html css js service icon.png config.xml
~/Downloads/PERS/TV/tizen-tools/apps2samsung-cli install ~/Downloads/PERS/TV/tizen-tools/StremioK-iptv-dev.wgt --tv 192.168.178.222
```
*(Verify certificate compatibility before overwriting `StremioK01`; if author cert differs from `TV-Store`, test with a temporary `package="StremioK02"` ID or reinstall cleanly after exporting `stremiok-backup.txt`.)*

- [ ] **Step 4: End-to-end verification on S90D**
  - Add 250K Xtream account (`Live TV only: On`) -> confirm fast load with zero `QuotaExceededError`.
  - Scan phone QR -> curate groups (`TR`, `UK`, `Sports`) -> confirm Home/IPTV/Guide show only selected groups.
  - Open Guide -> play past Catch-Up show (`↺`) -> confirm seekable playback.
  - Watch Live channel -> press `LEFT` / `UP › ≡ Channels` -> browse `Now / Next` and zap channels while stream continues behind drawer.

- [ ] **Step 5: Commit docs & prepare upstream-ready PR branches**

```bash
git add docs/ CHANGELOG.md translations/ js/lang/
git commit -m "docs: document Xtream Live API, streaming M3U, phone group editor, catch-up, and channel drawer"
```
