# Tier 1 Design Spec: APL TV-Class Live TV UI/UX & Smart Playlist Tidier

**Date:** 2026-11-16  
**Branch:** `feat/apltv-iptv-parity`  
**Target Repo:** `/Users/ediz/Downloads/PERS/TV/StremioK`  
**Status:** Reviewed (Builder Check resolved — ready for implementation plan)

---

## 1. Intent & Scope

Upgrade StremioK's Live TV (`IPTV` and `Guide` tabs, plus live playback HUD/OSD) from generic horizontal VOD poster carousels into an **APL TV-inspired Live TV experience** tailored for Samsung Tizen TVs (specifically S90D OLED on Tizen 9, while gracefully degrading on Tizen 3–5):

1. **Smart Playlist Tidier & Variant Merger** (`js/iptv.js`, `js/stremio.js`, `js/view-settings.js`): clean noisy provider channel/group names, strip visual separators, optionally hide adult/XXX groups, prioritize preferred countries (`TR`, `UK`, `NL` by default), and collapse `4K` / `FHD` / `HEVC` / `HD` / `SD` / `Backup` duplicates into one channel with multi-source fallback.
2. **Live Video Behind Frosted Glass** (`js/player-core.js`, `js/player-controls.js`, `js/player.js`, `js/app.js`, `js/view-core.js`, `js/views.js`, `css/style.css`, `css/modern.css`): keep `<object id="av-player">` (or HTML5 `<video>` fallback in desktop testing) actively decoding fullscreen video behind a translucent, frosted `#app` overlay (`body.live-behind`) so users browse channels and the EPG grid while watching live TV uninterrupted.
3. **3-Pane Split Live TV Browser (`IPTV` Tab)** (`js/view-iptv.js`, `js/view-home.js`, `js/views.js`, `index.html`, `css/style.css`, `css/modern.css`): replace generic card carousels on `_homeTab === 'tv'` with a fast windowed 3-pane layout (**Categories Rail** | **Windowed Channel List with EPG `Now` & progress** | **Inspector: Program Synopsis, `Next`, Source Variants, Actions**).
4. **Frosted Glass `Guide` Grid Over Live Video** (`js/view-guide.js`, `js/app.js`, `css/style.css`, `css/modern.css`): restyle the EPG grid as frosted dark glass floating over active live video (`GUIDE` key or Guide tab), preserving `↺` Catch-Up and guide-only addon lookup.
5. **OLED Burn-In Protection & Live `Res / Codec / FPS` OSD Polish** (`js/player-core.js`, `js/player-controls.js`, `js/player.js`, `js/stremio.js`, `js/util.js`, `js/view-settings.js`, `css/style.css`): periodic sub-pixel orbit (`±2px` CSS transform) on static HUD/glass chrome, pause overlay dimming after idle, and clean decoded video/audio pills in `#osd-tags` + live mini-HUD.

### Explicitly Deferred (Out of Scope for Tier 1)
- **Tier 2:** Phone Companion "Channel Studio" over LAN (drag-and-drop custom categories, group renames, pin/hide channels, backup URL editor via QR). Note: Tier 1 keeps existing per-playlist group filtering (`setPlaylistGroups`) intact.
- **Tier 3:** True multi-stream hardware Multiview, live Sports Match/Scoreboard HUD, Timeshift ring-buffer DVR / recording, and Live Audio-to-Subtitle AI captioning.

---

## 2. Explicit Defaults Applied

Because the user skipped design Q&A with `"go for it"`, the following product defaults are baked in and reversible via Settings or header pills:

1. **Dual-OK Live Interaction (`browseOverLive`, default `on`):**
   - When idle on the `IPTV` 3-pane browser or `Guide` tab, moving focus changes selection only (no auto-tune on scroll — avoids hammering IPTV server connection limits across 2,000+ channels).
   - Pressing **`OK`** on a channel starts (or zaps to) live playback **behind the frosted browser** (`body.live-behind`) while keeping cursor focus in the UI.
   - Pressing **`OK` a second time** on the *already-playing* channel (or pressing remote **`PLAY`** / selecting **`Fullscreen`** in the Right Inspector) dismisses the frosted overlay into **Fullscreen Video** (`#app.hidden`).
   - Pressing **`BACK`** during Fullscreen Live Video opened from `IPTV`/`Guide` returns to the frosted browser on the active playing channel (without stopping playback), unless `liveBrowseMode` is disabled in Settings.
2. **Preferred Country/Language Boost (`TR`, `UK`, `NL`):** Default order `TR,UK,NL`; user-configurable in `Settings > Content > IPTV` (`Off`, `TR · UK · NL`, `NL · UK · DE`, `US · UK · CA`, `DE · AT · CH`, or custom comma-separated entry via phone/keyboard).
3. **Tidier Defaults (`iptvTidy: true`, `iptvHideAdult: true`, `iptvCollapseVariants: true`):** Clean playlist mode is active out of the box, with a one-click **`Tidy / Raw`** toggle chip right inside the `IPTV` 3-pane header bar AND inside `Settings > Content > IPTV` — switching is instantaneous in memory with zero network refetch.
4. **OLED Shift (`oledShift: 'auto'`):** Active whenever `look === 'modern'` or `bg` is `'dark'`/`'black'` (all non-light OLED/dark setups) and during player pause/OSD display.

---

## 3. Codebase Invariants & Technical Constraints

- **Pure ES5 Only (`js/`, `service/`):** `var` only; zero `let`, `const`, arrow functions, template literals, classes, destructuring, spread, default params, `async`/`await`. Verified by `scanES5` in `tests/run.js`.
- **No Build Step / Script Order (`index.html` & `package.json`):** `package.json` packages the entire `js/` directory automatically (no separate file list script exists). Any new file (`js/view-iptv.js`) must be added to `index.html` *after* `js/view-guide.js` and *before* `js/views.js` with matching `?v=2.4.4` (or `?v=2.4.3` matching release bump) cache-bust query strings.
- **Internationalization (`U.t`):** Every user-facing string in JS uses `U.t(...)` / `U.tn(...)`.
- **Bounded DOM & Memory (`2,000+` channels / `50+` groups):** Neither the Left Categories Rail (`MAX_GROUP_ROWS = 11`) nor the Center Channel List (`CHANNEL_ROWS = 10`) may render all channels into the DOM. Both panes render a fixed window of DOM nodes (`idx` windowed) just like `js/view-guide.js`.
- **Theme & Look Compatibility:**
  - `body.look-modern.fx-full` (Tizen 6+ / S90D OLED): full `-webkit-backdrop-filter: blur(...)` + smooth CSS transforms.
  - `body.look-modern` without `fx-full` / `Classic` look (Tizen 3–5): translucent solid dark fills (`rgba(11, 15, 24, 0.90)`) without blur so older TVs stay responsive.
  - Light themes (`bg-light` Gray/White): when `body.live-behind` is active, frosted live overlays always force dark frosted chrome (`color: #fff` over live video) so text over video never turns unreadable dark-on-dark (matching `js/util.js` `keep` rule `"not over video"`).

---

## 4. Module Specifications

### Module 1: Smart Playlist Tidier, Country/Language Sorter & Variant Merger (`js/iptv.js`, `js/stremio.js`, `js/view-settings.js`)

#### 1.1 Preferences & Single Source of Truth (`stremiok.prefs`)
Treat `stremiok.prefs` (accessed via `Stremio.getPrefs()` / `Stremio.setPref()` in `js/stremio.js`) as the canonical single source of truth. Extend `Stremio.getPrefs()` with six persisted keys (5 IPTV/Live + 1 Appearance):
- `iptvTidy`: boolean (`p.iptvTidy !== false`, default `true`) — master toggle between Tidied and Raw channel tree.
- `iptvHideAdult`: boolean (`p.iptvHideAdult !== false`, default `true`) — hide XXX / 18+ / Adult groups & channels when tidying is active.
- `iptvCollapseVariants`: boolean (`p.iptvCollapseVariants !== false`, default `true`) — merge quality/backup variants of the same channel.
- `iptvCountries`: string (`typeof p.iptvCountries === 'string' ? p.iptvCountries : 'TR,UK,NL'`, normalized uppercase CSV, max 8 2-letter codes; `''` disables country boosting).
- `liveBrowseMode`: boolean (`p.liveBrowseMode !== false`, default `true`) — `OK` opens live behind glass / `BACK` from fullscreen returns to frosted browser.
- `oledShift`: string (`p.oledShift === 'on' || p.oledShift === 'off' ? p.oledShift : 'auto'`, default `'auto'`) — OLED pixel shift + idle dimmer mode.

Provide helpers `IPTV.getTidyCfg()` and `IPTV.setTidyCfg(partial)` inside `js/iptv.js`:
- When `typeof Stremio !== 'undefined' && Stremio.getPrefs` is loaded, delegate reads/writes directly to `Stremio.getPrefs()` / `Stremio.setPref()` (`stremiok.prefs`).
- When `Stremio` is not defined (e.g., standalone `tests/run.js` Node sandbox loading `js/iptv.js`), read and write the same canonical `'stremiok.prefs'` storage key directly via `U.store.get('stremiok.prefs', {})` / `U.store.set('stremiok.prefs', ...)`, so there is never a dual-store split between UI settings and `IPTV`.
- Expose `IPTV.rebuild()` to synchronously recompute `_cache` from `_rawByPlaylist` when any tidier setting changes (plus calling `Stremio` addon refresh if loaded).

#### 1.2 Pipeline Architecture (Pure Synchronous Post-Parse Stage)
Keep raw parsed channels intact per playlist in `_rawByPlaylist[playlistId] = channels.slice(0)` alongside `_cache`. When `buildView()` (replacing direct `build(all)` for display) runs:
1. Concatenate enabled playlists in playlist order (applying existing `sourceOf` provenance).
2. If `!tidyCfg.enabled` (Raw mode): skip tidying, still build standard `_cache` cleanly (with stable IDs so playing channel IDs continue working if toggled, see §1.6).
3. If `tidyCfg.enabled`: run deterministic **4-stage pure pipeline** `IPTV.tidyChannels(rawList, tidyCfg)`:
   - **Stage A — Separator & Adult Filter (`filterChannel`):**
     - **Separators:** drop channel entries whose `c.name` (trimmed) contains zero ASCII/Unicode letters or digits (e.g. `---`, `===`, `***`, `##### SPORT #####` wait — watch out!):
       - Pure separator line: `/^[\s\-=_*#|┃│─═•·.+~<>\/\\\[\]()]+$/`.
       - Decorative divider header masquerading as a channel (`### --- TR ULUSAL --- ###`, `===== VIP CHANNELS =====`): matches `/^(?:[=#*\-─═┃]{2,}|#{2,})\s*[^A-Za-z0-9]*(?:.*?)\s*(?:[=#*\-─═┃]{2,}|#{2,})$/` ONLY if `url` also looks fake/duplicate OR name contains 3+ repeated symbol runs wrapping uppercase words and `/(?:^|\s)(?:section|divider|kategori|---|\*\*\*)/i`? Careful rule: NEVER drop a channel just because a provider wrote `*** TRT 1 HD ***`! Instead:
         1. Strip surrounding symbol runs (`/^[\s\-=_*#|┃│─═•·]+|[\s\-=_*#|┃│─═•·]+$/g`) FIRST.
         2. Drop ONLY if: (a) remaining core is empty, OR (b) remaining core has no alphanumeric characters, OR (c) name matches `/^(?:information|expired|renewal|subscribe|expiry|update playlist|telegram|whatsapp)\b/i`? No — don't censor info channels silently except pure separator lines (`/^[=\-*#_│┃─═.\s]{3,}$/` after removing up to one word if BOTH sides have 3+ `=`/`-`/`#`/`*` like `===== ULUSAL =====`? Even better: check if removing `/^[=\-*#_│┃─═•·\s]+$/` is empty OR wrapped in `==== ... ====` / `---- ... ----` / `#### ... ####` with `===+` / `---+` on BOTH ends AND no TV/channel digits like `TV8`/`TRT 1`? Wait: safest rule so no real channel is ever lost: strip leading/trailing decorative runs on ALL channels, and drop ONLY if after stripping decorations (`= - _ * # | ┃ │ ─ ═ • · +`), the string is empty OR consists solely of separator punctuation OR matches an explicit dummy placeholder `url` ending in `/0.ts`? No URL assumptions!). So Stage A drops:
            - Empty / symbol-only channel names (`/^[\s\-=_*#|┃│─═•·.+~<>\/\\\[\]()]+$/`), e.g. `--- === ---`, `***`, `|`.
            - Channels matching adult filter when `tidyCfg.hideAdult` is true: test BOTH `c.group` and `c.name` against `/\b(?:xxx|adult|18\+|porn|porno|erotic|erotik|nsfw|sex|brazzers|playboy|hustler|redlight|dorcel|venus)\b/i` or `(?:\+18|18\+|₊₁₈)` (`\b18\b` excluded so e.g. `Channel 18` isn't falsely hidden!).
   - **Stage B — Country, Group & Channel Name Tidying (`normalizeChannelMeta`):**
     - **Country Extraction (`extractCountry(group, name)`):**
       - Check leading group prefix or channel prefix against normalized map:
         - Patterns checked on `group` then `name`: leading `XX:`, `XX |`, `XX -`, `[XX]`, `(XX)`, `|XX|`, `┃XX┃`, or leading country keyword:
           - `TR`, `TUR`, `TURK`, `TURKIYE`, `TURKEY` -> `'TR'`
           - `UK`, `GB`, `ENG`, `EN`, `UNITED KINGDOM`, `BRITISH` -> `'UK'`
           - `NL`, `NED`, `NLD`, `DUTCH`, `NEDERLAND`, `HOLLAND` -> `'NL'`
           - `DE`, `GER`, `GERMANY`, `DEUTSCH` -> `'DE'`
           - `US`, `USA`, `AMERICA` -> `'US'`
           - `FR`, `FRA`, `FRANCE`, `FRENCH` -> `'FR'`
           - `ES`, `ESP`, `SPAIN`, `SPANISH` -> `'ES'`
           - `IT`, `ITA`, `ITALY`, `ITALIAN` -> `'IT'`
           - `AR`, `ARB`, `ARAB`, `ARABIC` -> `'AR'`
           - Generic 2-letter ISO code prefix `^[A-Z]{2}\s*[:|\-┃\/]` (excluding TV acronyms `TV`, `HD`, `SD`, `4K`, `8K`, `IP`, `FX`!).
     - **Group Cleaning (`cleanGroup(group, country)`):**
       - Strip leading `VIP`, `RAW`, `HEVC`, repeated `|`, `┃`, `:`, `-`, `#`, `*`, `>>>` wrappers (e.g. `TR | ✦ ULUSAL VIP ✦` -> `TR · Ulusal` or `TR · ULUSAL` if all-caps -> title-aware trim preserving known acronyms like `TR`, `UK`, `NL`, `VIP`, `TV`, `HD`, `UHD`, `4K`, `FHD`, `NBA`, `UFC`, `F1`, `PPV`).
       - Preserve distinct clean group label (`c._cleanGroup`) while retaining `c._rawGroup`.
       - Drop empty groups after filtering.
     - **Quality / Codec / Tag Extraction (`extractQuality(rawName)`):**
       - Scan BEFORE stripping so metadata isn't lost! Record:
         - `resLabel`: `'4K'` (`/\b(?:4k|uhd|2160p?)\b/i`), `'FHD'` (`/\b(?:fhd|1080p?|full\s*hd)\b/i`), `'HD'` (`/\b(?:hd|720p)\b/i`), `'SD'` (`/\b(?:sd|480p|360p|lq)\b/i`), or `''`.
         - `isHevc`: `/\b(?:hevc|h\.?265|x265)\b/i`
         - `fpsTag`: `/\b(50|60)\s*fps\b/i` (extracted as number `50`/`60`)
         - `isBackup`: `/\b(?:backup|bak|alt|mirror|spare|yedek|link\s*\d+)\b/i`
         - `isVip`: `/\b(?:vip|raw|gold|prime)\b/i` (tag stripped from display name, treated carefully: only strip `VIP`/`RAW` when standalone prefix/suffix or inside brackets `[VIP]`/`(RAW)`, NOT inside a network name like `VIP Movies` if `Movies` follows!). Wait: safest rule for `VIP` / `RAW`: strip ONLY `[VIP]`, `(VIP)`, trailing `VIP`, leading `VIP |`/`VIP:`/`RAW |`, NEVER bare `"VIP"` mid-name like `"VIP Cinema"`.
       - Compute quality score (`_qScore`):
         - Resolution base: `4K = 400`, `FHD = 300`, `HD = 200`, `untagged = 100`, `SD = 50`
         - Modifiers: `+30` if `50fps`/`60fps`, `+25` if `HEVC` (hardware-decoded on Samsung OLED, lower bandwidth buffer), `-150` if `isBackup`.
       - Build compact badge string `_qBadge`: e.g. `'4K HEVC'`, `'4K'`, `'FHD 50'`, `'FHD'`, `'HEVC'`, `'HD'`, `'SD'`, or `'Backup'`.
     - **Channel Display Name Cleaning (`cleanChannelName(rawName, country)`):**
       - Remove bracketed provider tags `\[[^\]]{1,24}\]` and trailing parenthetical quality/region tags `\((?:hd|fhd|uhd|4k|sd|hevc|h\.?26[45]|tr|uk|nl|de|us|fr|raw|vip|backup|yedek|1080p|720p|50fps|60fps)\)` (IMPORTANT: do NOT strip `(2)`, `(US)`, `(+1)` wait — keep `+1` / `+2`!). Wait: if someone has `CNN (US)` vs `CNN (TR)`, stripping `(US)` should only happen when country is ALREADY extracted as `US`! And keep timeshift `+1` / `+2` intact.
       - Strip leading country prefix (`TR:`, `TR |`, `TR -`, `UK:`, `NL |`, etc.).
       - Strip trailing/standalone codec & quality tokens (`4K UHD`, `UHD 4K`, `UHD`, `4K`, `FULL HD`, `FHD`, `HEVC`, `H.265`, `H265`, `H.264`, `H264`, `1080P`, `720P`, `480P`, `50FPS`, `60FPS`, `RAW`, `BACKUP`, `YEDEK`, `HD`, `SD`) EXCEPT when stripping leaves nothing (e.g. a channel literally named `"HD+"` or `"4K"`)!
       - Clean stray trailing separators (`|`, `-`, `:`, `/`, `*`, `•`), collapse multi-whitespace. Preserve `c._rawName`.

   - **Stage C — Variant Collapsing (`collapseVariants` when `tidyCfg.collapseVariants`):**
     - Build deterministic merge key per channel:
       - `normKey = cleanName.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim()` —Wait: Turkish/Cyrillic/Greek/Arabic Unicode letters! Don't drop non-ASCII letters with `[^a-z0-9]`! That would collapse Cyrillic/Arabic names!
       - Correct ES5 Unicode-safe normalization: lowercase, collapse whitespace, strip punctuation `['’".,!?:;()\[\]|┃\-_/*•·]+` while KEEPING `+` (so `Channel 4 +1` !== `Channel 4`) and keeping non-ASCII Unicode characters (`Ü`, `Ş`, `İ`, `Ç`, `Ö`, `Ğ`, Cyrillic, Arabic, etc.) intact!
       - Scope key: `(c.type || 'tv') + '|' + (c._country || c._cleanGroup || '').toLowerCase() + '|' + normKey`.
         - Wait: why include `_country || _cleanGroup`?
           - Inside country `'TR'`, `TRT 1 FHD` (in `TR | Ulusal`) and `TRT 1 4K` (in `TR | 4K UHD` or `TR | Ulusal`) HAVE the same `_country = 'TR'` AND same `normKey = 'trt 1'`, so they collapse into ONE channel `TRT 1` with 2 sources (`4K`, `FHD`)!
           - Meanwhile `MTV` in `UK` (`_country = 'UK'`) and `MTV` in `NL` (`_country = 'NL'`) have DIFFERENT `_country`, so they stay distinct!
           - And channels with NO detected country scope against `c._cleanGroup`, preventing accidental cross-bouquet collisions on generic names.
     - Variant Group Assembly:
       - Sort member variants descending by `_qScore` (tie-breaker: original playlist index ascending, keeping first-seen playlist order).
       - Elect highest-scored variant (`best`) as primary channel object; prefer non-dedicated-4K group name when multiple groups contributed (`TR · Ulusal` preferred over `TR · HEVC` or `TR · 4K` if present among variants, or keep `best._cleanGroup`).
       - Preserve `best.logo` (fallback to first non-empty `logo` among variants) and `best.tvgId` (fallback to first non-empty `tvgId` among variants).
       - Set `primary.variants` = ordered array of compact variant records (`{ id, name, rawName, badge, score, url, group, ua, ref, cookie, drm, archive, archiveDays, _yt, vod, _playlistId }`).
       - Set `primary._mergedIds` = array of every member variant's raw `id` so `byId[rawId]` resolves cleanly to `primary`!
         - Wait: what about favorites (`IPTV.isFavorite` / `IPTV.setFavorite`)? If user favorited `TRT 1 FHD` before variant collapsing or after, `isFavorite(id)` checks `id` AND `primary._mergedIds` if present, and `setFavorite(primary.id, on)` sets `primary.id` (and clears/updates `_mergedIds`), ensuring `★ Favorites` never breaks across `Tidy <-> Raw` switches!
       - Preserve `primary.archive` (`true` if primary OR first archive-capable variant has `archive`; if `best` lacks `archive` but a `FHD`/`HD` variant has `archive`, catch-up uses the first variant with `archive` cleanly!).

   - **Stage D — Country & Group Ordering:**
     - Rank groups using `tidyCfg.countries` (e.g. `['TR', 'UK', 'NL']`):
       - Groups with detected `_country` matching index `i` get rank `i`; unmatched country groups get rank `1000` (keeping original relative order); `guideOnly` unaffected on `Guide` tab (and guide-only channels excluded from playable variants).
     - Rebuild `_cache` (`channels`, `groups`, `byId`, `byGroup`, `catalogs`, `favCatalog`), setting `primary.name = c._cleanName` and `primary.group = c._cleanGroup` while retaining `c._rawName` / `c._rawGroup`.
     - **Important Compatibility Check (`IPTV.streams(id)`):**
       - When `IPTV.streams(id)` is called for a collapsed channel:
         - Resolve all entries in `c.variants` (usually 1–6 variants) into playable stream items via existing `plainStreams` / `stalkerStreams` / `youTubeEnd` paths (only running `youTubeEnd` probe on the chosen stream or primary — don't stall playback probing 5 variants sequentially!).
         - Actually, better: run `streamsForVariant(v)` cleanly: if `c.variants.length > 1`, map each non-YouTube variant directly using `plainStreams(v)` (with `title: (v.badge ? v.badge + ' · ' : '') + v.rawName + (from ? ' · ' + from : '')`) while preserving `youTubeEnd` check for variant 0 (`v._yt` or primary Xtream live check). That guarantees instant stream selection AND automatic `nextOnFail` fallback + `YELLOW` Source menu listing `[4K HEVC] TRT 1 UHD`, `[FHD] TRT 1 FHD`, `[HD] TRT 1 Backup`!

---

### Module 2: Live Video Behind Frosted Glass (`js/player-core.js`, `js/player-controls.js`, `js/player.js`, `js/app.js`, `js/view-core.js`, `js/views.js`, `css/style.css`, `css/modern.css`)

#### 2.1 Player State & Public API
In `js/player-core.js`, `js/player-controls.js`, and explicit export table in `js/player.js`:
- Track `S.browseOverlay = false` alongside `S.active`, `S.isLive`.
- Exported methods on `Player` (added explicitly to `js/player.js`'s return object):
  - `Player.isLivePlaying()`: returns `!!(S.active && S.isLive && !S.stopping)`.
  - `Player.isBrowseOverlay()`: returns `!!(S.active && S.isLive && S.browseOverlay)`.
  - `Player.currentLiveId()`: returns `(S.active && S.isLive && S.ctx && S.ctx.id) ? S.ctx.id : ''`.
  - `Player.liveMeta()`: returns `{ id, name, codec, width, height, fps, bitrate, audio, channels, tags }` for active live stream (or `null` if inactive).
  - `Player.onLiveMetaChange(fn)`: registers listener notified whenever live stream telemetry (`S.actual` / tags) updates (matching `EPG.onChange(fn)` pattern, deduplicated).
  - `Player.togglePlay()`: exposes existing private `togglePlay` in `js/player-controls.js` onto `P.togglePlay` and `Player.togglePlay`.
  - `Player.setBrowseOverlay(on)`:
    - Guard: if `!S.active || !S.isLive`, set `S.browseOverlay = false`, remove `body.live-behind`, return.
    - When `on === true`:
      - Set `S.browseOverlay = true`.
      - Close player overlays cleanly (`P.closeControls()` / `showOSD(false)` / `closeChannelDrawer(true)` — never leave OSD or channel drawer floating on top of the frosted home UI!).
      - Set `U.byId('app').className = ''` and `document.body.style.background = 'transparent'`.
      - Add CSS class `'live-behind'` to `document.body` (`document.body.classList.add('live-behind')`).
      - Notify live meta / browse listeners cleanly.
    - When `on === false`:
      - Set `S.browseOverlay = false`.
      - Remove CSS class `'live-behind'` from `document.body` (`document.body.classList.remove('live-behind')`).
      - Set `U.byId('app').className = 'hidden'` and `document.body.style.background = 'transparent'`.
      - Call `showOSD(true)` (show live EPG/OSD strip briefly when entering fullscreen) and clear focus/modal confusion.
- Update `Player.play(ctx, onExit)`:
  - Support `ctx.browseOverlay === true` and `ctx.fromHome === true` options: on player start, if `ctx.browseOverlay`, set `S.browseOverlay = true`, keep `#app` visible (`U.byId('app').className = ''`, `document.body.classList.add('live-behind')`), suppress `showOSD(true)`, and suppress fullscreen `#spinner` dimming while still incrementing `_gen` to cancel prior opens cleanly on rapid zapping.
- Update `stopLiveLook()` / `exit()` in `js/player-core.js`:
  - Always remove `document.body.classList.remove('live-behind')`, clear `S.browseOverlay = false`, reset OLED orbit `transform` styles, and clear live meta cleanly inside `exit()` before restoring `#app`!

#### 2.2 Background Zapping, `Views.zapLiveChannel`, Return-to-Browse & `App.back()` (`js/view-core.js`, `js/views.js`, `js/app.js`, `js/player-controls.js`)
- **Self-contained Live Zapping (`V.zapLiveChannel` in `js/view-core.js`, exported as `Views.zapLiveChannel` in `js/views.js`):**
  - Unlike `view-detail.js`'s `zapToId` (which depends on detail-screen state `_d && _d.live`), `V.zapLiveChannel(ch, opts)` works completely standalone from `#screen-home` (`IPTV` 3-pane or `Guide` grid) without navigating to `screen-detail`:
  - Signature: `zapLiveChannel(ch, opts)` where `opts = { browseOverlay: boolean, channels: Array, idx: number, playBest: boolean, onZapped: Function }`.
  - Behavior: resolves `Stremio.getStreams(ch.type || 'tv', ch.id)` (incorporating merged `ch.variants` in order cleanly), picks stream[0] (respecting `skipSourceList`/best quality), and calls `Player.play(ctx, onExit)` directly where `ctx` sets `fromHome: true`, `browseOverlay: !!opts.browseOverlay`, `channel: ch`, `variants: ch.variants || []`, and attaches **self-contained closures**:
    - `ctx.zap(dir)`: increments/wraps `opts.idx` across `opts.channels`, skipping `guideOnly`, and recursively tunes via `zapLiveChannel(nextCh, { browseOverlay: Player.isBrowseOverlay(), channels: opts.channels, idx: nextIdx, onZapped: opts.onZapped })`.
    - `ctx.zapToId(targetCh)`: finds `targetCh` in `opts.channels` (or plays standalone `[targetCh]`) and tunes via `zapLiveChannel`!
    - `ctx.zapTo(num)`: 1-based channel number jump into `opts.channels`.
    - `onExit`: restores Home screen state and calls `Views.syncLiveBrowse(ctx.id)` so focus lands cleanly on the channel you ended on (`V.iptvBackOn` or `V.guideBackOn`)!
- **Explicit Namespace Exports (`js/views.js`):**
  - Export on `Views`: `zapLiveChannel: V.zapLiveChannel`, `syncLiveBrowse: V.syncLiveBrowse`, `iptvBackOn: V.iptvBackOn`, `backInIptv: V.backInIptv` (`iptvBrowser` / `iptvLeave` shared via `ViewParts` `V` directly for `js/view-home.js`).
- **Standardized Return-to-Browse Contract:**
  - `V.iptvBackOn(id)` in `js/view-iptv.js`: locates channel matching `id` (or `_mergedIds` alias), scrolls/updates `winTop`, updates Right Inspector, and returns the focused channel row DOM node (mirroring `V.guideBackOn(id)`).
  - `V.syncLiveBrowse(id)` in `js/view-home.js` / `js/view-core.js` (exported on `Views.syncLiveBrowse`):
    ```js
    function syncLiveBrowse(id) {
        if (_homeTab === 'tv' && V.iptvBackOn) { return V.iptvBackOn(id); }
        if (_homeTab === 'guide' && V.guideBackOn) { return V.guideBackOn(id); }
        return null;
    }
    ```
  - Update `App.goHome(tab, liveId)` (`js/app.js`) to accept optional 2nd parameter `liveId`, returning focus via `Views.syncLiveBrowse(liveId)` after rendering Home.
  - Update `App.returnFromLive(focusNode, liveId)` (`js/app.js`) to check `Views.syncLiveBrowse(liveId)` (covering BOTH `'tv'` and `'guide'`) instead of only `'guide'`.
- **Key Routing Matrix (`App.onKey` in `js/app.js` + `Player.handleKey` in `js/player-controls.js`):**
  - **Rule 1 (`Player.isActive() && !Player.isBrowseOverlay()` -> Fullscreen Player Mode):**
    - `BACK`: if no player overlay (`_menuOpen`, `_drawer`, `_cast`, `_barOpen`, `_scrub`) is open AND `S.isLive` AND `S.ctx.fromHome` AND `Stremio.getPrefs().liveBrowseMode` is true -> call `Player.setBrowseOverlay(true)` + `var n = Views.syncLiveBrowse(S.ctx.id); if (n) { Focus.setScope(scr('home'), n); }` instead of `Player.exit()`! Otherwise `Player.exit()` runs normally.
    - `GUIDE`: if `S.isLive` and `liveBrowseMode` is true -> call `Player.setBrowseOverlay(true)` + `App.goHome('guide', S.ctx.id)`.
    - `STOP`: ALWAYS stops playback completely (`Player.exit()`).
  - **Rule 2 (`Player.isActive() && Player.isBrowseOverlay()` -> Frosted Browse Mode):**
    - `App.onKey(action)` does **NOT** unconditionally call `Player.handleKey(action)`! Instead:
      - Global media keys: `STOP` (`Player.exit()`), `PAUSE`/`PLAYPAUSE` (`Player.togglePlay()`), `PLAY` (`Player.setBrowseOverlay(false)`), `CHUP`/`CHDOWN` (calls `S.ctx.zap(+1/-1)` and refreshes `Views.syncLiveBrowse`), `GUIDE` (toggles between `'tv'` and `'guide'` tab cleanly while keeping video playing!), `BLUE` (toggles `#stream-info` stats HUD via `Player`).
      - All D-pad keys (`UP`, `DOWN`, `LEFT`, `RIGHT`, `OK`, `OK_LONG`), `NUM0..9`, `RED`/`GREEN`/`YELLOW`, and `BACK` route normally through `#app` navigation (`Focus`, `Views`, `App.back`).
- **Guarded `App.back()` Ordering (`js/app.js`):**
  1. `if (Player.isActive() && !Player.isBrowseOverlay()) { Player.exit(); return; }` (ONLY exit unconditionally when NOT in browse overlay!)
  2. `if (Views.isModalOpen()) { Views.closeModal(); return; }` (closes Filter / PickList / Variant modals WITHOUT stopping live video!)
  3. `if (_current === 'detail' && Views.backInDetail()) { return; }`
  4. `if (_current === 'settings' && Views.backInSettings()) { return; }`
  5. `if (_current === 'home' && Views.backInLocal && Views.backInLocal()) { return; }`
  6. `if (_current === 'home' && Views.backInIptv && Views.backInIptv()) { return; }` (steps Center/Inspector back to Categories Rail cleanly)
  7. `if (toTopMenu()) { return; }` (moves focus from grid/list to Top Menu header)
  8. `if (Player.isBrowseOverlay && Player.isBrowseOverlay()) { Player.exit(); return; }` (`BACK` while already on Top Menu cleanly stops live playback and stays on Home — never opens `askExit()` while live stream is active!)
  9. `var f = _stack.pop(); if (!f) { askExit(); return; }` ...
- **Automatic Stop on Leaving Live Context (`js/view-home.js` & `js/app.js`):**
  - Leaving `'tv'` / `'guide'` for any non-live tab (`Movies`, `Series`, `Continue`, `Calendar`, `YouTube`, `Local`, `Radio`, `Sports`) or leaving `'home'` for `Discover`, `Search`, `Settings`, `Detail`: calls `Player.exit()` automatically when `Player.isBrowseOverlay()` is active so AVPlay hardware decoder never leaks into VOD/trailers.

#### 2.3 Frosted Glass Visual System (`css/modern.css` & `css/style.css`)
When `body.live-behind` is set:
- `body.live-behind, body.live-behind #app, body.live-behind #screen-home, body.live-behind .home-bg`:
  - `background: transparent !important;` (overriding both `css/style.css`, `css/modern.css`, and `#theme-override` dark/black backgrounds!).
  - Render `.home-bg` only as a subtle radial edge scrim (`background: radial-gradient(ellipse at 70% 45%, rgba(8,12,20,0.22) 0%, rgba(8,12,20,0.62) 100%)`) so foreground text stays legible over bright daylight TV scenes without muddying the picture.
- Shared frosted surface class `.glass-pane`:
  - Fallback (Classic / `fx-light` / older Tizen): `background: rgba(13, 17, 26, 0.90); border: 1px solid rgba(255, 255, 255, 0.12);`
  - Modern + `fx-full` (`body.look-modern.fx-full .glass-pane`): `background: rgba(15, 20, 31, 0.68); -webkit-backdrop-filter: blur(22px) saturate(1.25); backdrop-filter: blur(22px) saturate(1.25); border: 1px solid rgba(255, 255, 255, 0.14);`
- Never blur `<object id="av-player">` itself — `#av-player` remains full crisp `1080p`/`4K` behind `#app`, visible clearly through gaps, transparent backdrop region, and frosted glass panels!

---

### Module 3: 3-Pane Split Live TV Browser on `IPTV` Tab (`js/view-iptv.js`, `js/view-home.js`, `js/views.js`, `index.html`, `css/style.css`, `css/modern.css`)

#### 3.1 `js/view-home.js` & `#screen-home` Integration
- Add `'tv'` to `ownTab(t)` (`return t === 'continue' || t === 'calendar' || t === 'guide' || t === 'local' || t === 'tv';`).
- In `renderHome()`:
  - When `_homeTab === 'tv'`, add class `'tab-tv'` on `#screen-home` (`s.className = 'screen tab-tv'`) AND suppress appending `<div class="home-info">` (the built-in Right Inspector replaces the generic details strip!).
  - CSS: `#screen-home.tab-tv .rows { top: 104px; }` (`body.look-classic` or base `style.css`: `top: 96px;`), giving the 3-pane browser full `1920x976` canvas without `.home-info` pushing `.rows` down to `274px`.
  - In `renderHome()`'s special-tab branch: `else if (_homeTab === 'tv') { if (V.iptvBrowser) { V.iptvBrowser(rowsEl); } }` where `rowsEl` is `<div class="rows">` (note: there is no `#home-rows` ID in StremioK).
  - In tab-switch cleanup (`setHomeTab` / `openDetail` / `openSettings` / `openDiscover` / `openSearch` / leaving `home` screen):
    - If switching from `'tv'` or `'guide'` to a tab other than `'tv'` or `'guide'`, call `if (typeof Player !== 'undefined' && Player.isBrowseOverlay && Player.isBrowseOverlay()) { Player.exit(); }`.
    - Call `if (V.iptvLeave) { V.iptvLeave(); }` when switching off `'tv'`.
- Preserve `NO_HERO` (`tv: 1` already disabled generic top hero strip in `view-home.js`), keeping `.home-header` compact at top (`height: 104px` in Modern / `96px` in Classic).
- Return-to-browse focus uses `V.iptvBackOn(liveId)` and `Views.syncLiveBrowse(liveId)` (paired with `V.guideBackOn(liveId)`).

#### 3.2 Layout Architecture (`1920x1080` Canvas)
Mounted directly inside `#screen-home .rows` via `V.iptvBrowser(rows)`:

```
+-----------------------------------------------------------------------------------+
| [Top Menu: ... Movies | Series | IPTV* | Guide | Search | Settings]               |
+-----------------------------------------------------------------------------------+
| .iptv-toolbar (height: 52px):                                                     |
|  [🔍 Filter]  [✨ Tidied · TR/UK/NL (or Raw)]  [★ Favs] [🕒 Recent] [📺 All]       |
|                                        Right: [● LIVE · TRT 1 · 1080p50 ⛶ Full  ⏹]|
+--------------------+----------------------------------+---------------------------+
| LEFT: Categories   | CENTER: Channels (10 visible)    | RIGHT: Inspector          |
| width: 320px       | flex: 1 (~880px)                 | width: 540px              |
| .glass-pane        | .glass-pane                      | .glass-pane               |
|                    |                                  |                           |
| ★ Favorites   (14) | 001 [Logo] TRT 1 ★  ↺   [4K]    | [Big Logo] TRT 1          |
| 🕒 Recent      (8)  |     20:00Haber · ████░░░ 62%     | TR · Ulusal (+3 sources)  |
| 📺 All      (1840) | 002 [Logo] ATV      ↺  [FHD]    |                           |
| ------------------ |     20:15 Dizi  · ██░░░░░ 28%    | [▶ Watch] [★ Fav] [🔀 Src] |
| TR · Ulusal  (42)  | 003 [Logo] Show TV     [FHD]    |                           |
| TR · Spor    (28)  | ...                              | NOW 20:00–21:30           |
| UK · Ent     (65)  |                                  | Program Title             |
| NL · Live    (51)  |                                  | ████░░░░░ 45 min left     |
| ... (windowed 11)  |                                  | Synopsis line 1..4...     |
|                    |                                  |                           |
|                    |                                  | UP NEXT                   |
|                    |                                  | 21:30 Next Show           |
|                    |                                  | 22:45 Late Show           |
+--------------------+----------------------------------+---------------------------+
```

#### 3.3 Exact State, Windowing & Zero-Lag D-Pad Rules (`js/view-iptv.js`)
Maintain module state `_st = { groupKey, chanIdx, winTop, catTop, filterText, filterTimer, recents, liveId, mounted }`:
- **Built-in Virtual Categories (always top):**
  1. `__fav__`: `★ Favorites` (dynamic from `IPTV.isFavorite`) — omitted only if 0 favorites? Better: keep visible `(0)` or show as first group if `favs.length > 0`, placing `★ Favorites`, `🕒 Recent (N)`, `📺 All Channels (N)` in a clean top section followed by country-ordered playlist groups! If 0 favorites or 0 recents, either omit `★ Favorites` / `🕒 Recent` until non-empty so users land immediately on useful lists (matching existing `buildDrawerGroups` / `GUIDE`). Yes: show `★ Favorites` when `favs.length > 0`, `🕒 Recent` when `recents.length > 0`, `📺 All Channels` always, then playlist groups.
- **Persistent Recent Channels (`stremiok.iptv.recent`):** LRU list of last 25 tuned channel IDs (`unshift` on tune, persisted via `U.store.set`).
- **Quick Search / Filter (`Filter` button in toolbar or remote typing / modal):**
  - Selecting `🔍 Filter` opens `App.openEntry({ title: U.t('Filter IPTV channels'), ... })` or compact inline filter entry, setting `_st.filterText` and narrowing center channel list instantaneously across the selected category (or across All if user toggles filter), with `[✕ Clear "<query>"]` chip shown in toolbar!
- **Tidy / Raw Chip (`Tidied` / `Raw`):**
  - Clicking toggles `IPTV.setTidyCfg({ enabled: !cfg.enabled })`, rebuilds IPTV catalog synchronously (`IPTV.rebuild()`), restores nearest matching category/channel cleanly, and updates pill label (`✨ Tidied` vs `Raw`).
- **Channel List DOM Windowing (`CHAN_ROWS = 10`):**
  - Render ONLY `channels.slice(winTop, winTop + 10)` DOM rows into `.iptv-chan-list`.
  - Use a pool or fast keyed rebuild on window change ONLY (when focusing a row ALREADY inside `[winTop, winTop + 10)`, **ZERO DOM rebuild** — just `Focus.set` moves `.focused` CSS class cleanly in `<1ms`!).
  - Only when `UP` at `winTop` or `DOWN` at `winTop + CHAN_ROWS - 1` scrolls past the window edge does `redrawChannelWindow()` shift `winTop` by 1 row and keep focus on the newly aligned row!
  - `EPG.want(visibleIds)` runs debounced (`40ms`) only for the `10` visible rows (+ 6 rows ahead), and `EPG.onChange` updates ONLY the EPG text/progress bars inside currently visible DOM rows (`updateVisibleEpg()`) without tearing down DOM or breaking focus!
- **Category Rail Windowing (`CAT_ROWS = 11`):**
  - Same windowed pattern (`catTop`, max 11 rows rendered).
  - Moving `UP/DOWN` in Left Category Rail updates active group in Center Pane via a `70ms` debounce (so rapid holding `DOWN` across 40 categories does zero wasted work until the user pauses 70ms or presses `RIGHT`/`OK`!).
- **Explicit Spatial Navigation (`Focus.__go*` hooks):**
  - **Toolbar chips** (`Filter`, `Tidy/Raw`, `Fav`, `Recent`, `All`, `Mini-HUD Fullscreen`, `Mini-HUD Stop`):
    - `UP` -> Top Menu active `.tab-pill` (via `Focus.headerTarget()` or `.home-header .tab-pill.active`)
    - `DOWN` -> Active focus inside Center Channel List (or Left Category Rail)
    - `LEFT` / `RIGHT` -> adjacent toolbar chips
  - **Left Category Rail rows:**
    - `UP` (at `idx === 0`) -> Toolbar first chip
    - `UP` / `DOWN` -> previous / next category (wrapping/scrolling window)
    - `RIGHT` / `OK` -> Center Channel List at remembered index for this category (`__lastChan[groupKey] || 0`)
    - `LEFT` -> `false` (no edge wrap)
  - **Center Channel List rows:**
    - `UP` (at `idx === 0`) -> Toolbar
    - `UP` / `DOWN` -> previous / next channel (updating Right Inspector cleanly)
    - `LEFT` -> Left Category Rail (focuses currently selected category row!)
    - `RIGHT` -> Right Inspector primary action button (`▶ Watch` / `⛶ Fullscreen`)
    - `OK` ->
      - If `Player.isLivePlaying()` AND current channel matches `S.ctx.id` (including merged variant IDs) AND `Player.isBrowseOverlay()`: `Player.setBrowseOverlay(false)` (enter **Fullscreen**!).
      - Else: tune channel! If `liveBrowseMode` is `true`, tune with `{ browseOverlay: true, fromHome: true, channels, idx }` (video plays **behind glass**, cursor stays on channel row!). If `liveBrowseMode` is `false`, tune directly in Fullscreen.
    - `PLAY` -> tune immediately into Fullscreen (even if `liveBrowseMode` is `true`).
    - `OK_LONG` -> modal action list (`pickList`): `▶ Watch Fullscreen`, `★ Add/Remove Favorite`, `🔀 Choose Source (<N>)` (if `variants.length > 1`, opens variant sub-list showing each `4K / FHD / HEVC / Backup` variant URL/group), `↺ Catch-up Archive` (if `c.archive`, opens recent aired shows picker using `EPG.schedule(c.id)` + `IPTV.catchupUrl`), `📺 Channel Guide`.
    - `NUM0..9` -> quick channel number jump banner (`3` digits timeout `1.2s`) within active channel list (`1`-based index)!
  - **Right Inspector Action Buttons (`[▶ Play / ⛶ Fullscreen]`, `[★ Favorite]`, `[🔀 Sources (N)]`, `[↺ Catch-up]`):**
    - `LEFT` -> active row in Center Channel List!
    - `UP` / `DOWN` or `LEFT`/`RIGHT` between buttons -> cycles inspector buttons cleanly (`Focus` neighbors explicitly wired).
- **Logo Monogram Fallback:**
  - Every logo `<img>` loads lazily with `decoding="async"`. On empty `logo` or `onerror`, hide `<img>` cleanly and display a 2-letter color-hashed monogram tile (deterministic palette from channel name hash, e.g. `TR` / `BB` / `NP`) — never a blank space or broken image icon.

---

### Module 4: Frosted Glass `Guide` Grid Over Live Video (`js/view-guide.js`, `js/app.js`, `css/style.css`, `css/modern.css`)

#### 4.1 Seamless Live Video Behind Guide
- Update `App.guideKey()` (`js/app.js`):
  - If `Player.isActive()` is `true` and `S.isLive` and `liveBrowseMode` is enabled:
    - Do **NOT** call `Player.exit()`! Instead call `Player.setBrowseOverlay(true)`, switch home screen into view (`showScreen('home')`), and call `Views.setHomeTab('guide'); Views.renderHome();` (focusing the active channel via `Views.guideBackOn(liveId)`!).
  - Pressing `GUIDE` again (or `PLAY` / `OK` on the currently playing program in `Guide`): enters Fullscreen (`Player.setBrowseOverlay(false)`) without tearing down AVPlay!
- Update `playChannel(g, r, best)` inside `js/view-guide.js`:
  - Respect `liveBrowseMode`: when `OK` (`!best`) is pressed on a *currently airing* program:
    - If THAT channel is already playing behind glass -> go Fullscreen (`Player.setBrowseOverlay(false)`).
    - Else tune that channel in `browseOverlay: true` mode so the user can channel-surf straight inside the frosted EPG grid while watching live TV underneath! (Pressing `PLAY` (`best = true`) goes straight Fullscreen.)
  - When `OK` is pressed on a past aired program with `↺` Catch-Up (`catchupFor(c, p)`): `Player.exit()` any live stream first cleanly (or `Player.play` replaces active stream) and launch catch-up VOD fullscreen.
- Preserve existing `REUSE_MS` / `guideBackOn(id)` / `hold(g, r, p)` / `findInAddons(p)` functionality 100%.

#### 4.2 Frosted Glass Guide Styling (`css/style.css` + `css/modern.css`)
- Under `body.live-behind`:
  - `.guide` wrapped inside translucent frosted backing (`background: rgba(12, 16, 25, 0.72)` / `backdrop-filter: blur(20px)` on `fx-full`, `border-radius: 14px`, padding adjustments so `.home-info` at bottom & `.guide` cells don't collide).
  - `.guide-ch`: translucent slate (`rgba(18, 24, 36, 0.78)`), subtle playing channel highlight (`border-left: 4px solid #34d399` or accent + `●` dot when matching `Player.currentLiveId()`).
  - `.guide-track`: transparent dark lane (`rgba(10, 14, 22, 0.45)`).
  - `.guide-prog`: crisp dark glass tile (`rgba(22, 28, 42, 0.72)`), `.guide-prog.now`: elevated (`rgba(36, 48, 72, 0.84)`), `.guide-prog.catchup`: subtle accent indicator + `↺` glyph.
  - `#home-info` under `body.live-behind`: frosted bottom synopsis card (`background: rgba(10, 14, 22, 0.76)` with `backdrop-filter`).

---

### Module 5: OLED Burn-In Protection & Live `Res / Codec / FPS` OSD Polish (`js/player-core.js`, `js/player-controls.js`, `js/stremio.js`, `js/util.js`, `js/view-settings.js`, `css/style.css`)

#### 5.1 Live Stream Telemetry (`playerFormats()` & `Stremio.formatTags()`)
- In `js/player-core.js` -> `playerFormats()`:
  - Extract from AVPlay `VIDEO` track `extra_info` JSON:
    - `width`: `+(e.Width || e.width) || 0`
    - `height`: `+(e.Height || e.height) || 0`
    - `codec`: `e.fourCC || e.codec || ''`
    - `fps`: new helper `parseFps(e.FrameRate || e.frameRate || e.fps || e.framerate)`:
      - Handles numbers (`50`), strings (`"50"`, `"59.94"`, `"25.000"`), and rational `"N/D"` strings (`"50/1"`, `"60000/1001"` -> `Math.round((num / den) * 10) / 10`, snapping `59.94 -> 60` or `29.97 -> 30` or `23.976 -> 24` ONLY? Wait: cinephiles appreciate knowing `23.98`/`24`/`25`/`50`/`60`; formatting `59.9..60` -> `60` or `Math.round(val)` for broadcast live TV `25/30/50/60` cleanly gives crisp `50fps` / `60fps` badges while VOD stays accurate e.g. `24fps`). Use `Math.round(v)` when `Math.abs(v - Math.round(v)) < 0.1` else `(Math.round(v * 100) / 100)` (`>= 10 && <= 120` guard).
    - `bitrate`: `+(e.Bit_rate || e.bit_rate || e.bitrate || 0)`
  - Extract from HTML5 `<video>` fallback: `width = S.videoEl.videoWidth || 0`, `height = S.videoEl.videoHeight || 0`.
  - Expose `Player.liveMeta()` returning current `{ id, name, codec, width, height, fps, bitrate, audio, channels, tags }` and `Player.onLiveMetaChange(fn)` (exported in `js/player.js`) so both `#osd-tags` AND the 3-Pane `IPTV` mini-HUD share live technical updates cleanly.
  - Ensure `playerFormats()` re-polls once `2500ms` after stream start if `S.actual` initially lacked `height` or `fps` (many HLS/TS IPTV streams decode SPS/PPS headers a moment after `onstreamstarted`), calling `renderOSD()` and firing `Player.onLiveMetaChange` subscribers.
- In `js/stremio.js` -> `formatTags(info, actual)` & `js/player-core.js` -> `renderTags()`:
  - Keep `formatTags(info, actual)` returning `'·'`-joined string (compatible with all callers and existing tests!). Include `fps` if `actual && actual.fps`: emit crisp tokens (`['4K', 'HEVC', '50fps', 'DD+ · 5.1', '14.2 Mbps', 'HLS']`, formatting bitrate `(bps / 1000000).toFixed(1) + ' Mbps'` when `bitrate > 100000`).
  - Upgrade `#osd-tags` in `renderTags()` & `css/style.css` so each tag token renders inside a clean `.osd-tag-pill` badge, styled dark translucent with accent highlight for `4K` / `HEVC` / `HDR` / `50fps`.

#### 5.2 OLED Burn-In Protection (`U.oled` helper + `css/style.css` + `js/player-controls.js`)
- Canonical `oledShift` pref in `Stremio.getPrefs()` (`'auto'` | `'on'` | `'off'`, default `'auto'`), surfaced in `Settings > Appearance`.
- Under `'auto'`: enabled whenever `a.bg === 'dark' || a.bg === 'black'` (explicitly disabled on Light Gray/White unless overridden with `'on'`).
- Mechanism (Zero layout thrash, GPU composite-only):
  - Deterministic 8-step orbit array `[[0,0], [2,0], [2,2], [0,2], [-2,2], [-2,0], [-2,-2], [0,-2]]` (`±2px` maximum travel, imperceptible to viewers).
  - Step advances every **60 seconds** via `U.startOledOrbit()` ONLY when HUD overlays (`#player-osd`, `#player-bar`, `#stream-info`, `#sub-menu`) OR `body.live-behind` floating panes (`.iptv-shell`, `.guide`) are active, applying `transform: translate3d(x + 'px', y + 'px', 0)` to that explicit selector list (`['#player-osd', '#player-bar', '#stream-info', '#sub-menu', '.iptv-shell', '.guide']`) — NEVER shifting `<object id="av-player">`, and resetting `style.transform = ''` on `Player.exit()`, tab exit, or `'off'`.
  - **Pause Dimmer (`js/player-controls.js`):** when `S.active && S.paused`, start a `120s` idle timer on `PAUSE` (reset on any key press); after `120s` without remote input while paused, add `.oled-dim` class to `#player-osd` & `#player-bar` (`opacity: 0.35; transition: opacity 1.5s ease`), immediately clearing `.oled-dim` on any key press or resume.

---

## 5. Settings Integration Summary (`js/view-settings.js`)

1. **`Settings > Content > IPTV`:**
   - **Playlist Tidier** (`on` / `off`, default `On`): strip tags, sort preferred countries, hide separators
   - **Preferred Countries** (`TR · UK · NL`, `NL · UK · DE`, `US · UK · CA`, `DE · AT · CH`, `Off`, `Custom…`): reorders matching groups/channels first
   - **Collapse Quality Variants** (`on` / `off`, default `On`): merges `4K` / `FHD` / `HEVC` / `HD` / `SD` / `Backup` duplicates into one channel with multi-source fallback
   - **Hide Adult (XXX / 18+)** (`on` / `off`, default `On` when tidier active)
   - **Browse Over Live Video** (`on` / `off`, default `On`): keeps TV playing behind frosted UI when `OK` or `BACK` is pressed on Live TV / Guide
2. **`Settings > Appearance`:**
   - **OLED Pixel Shift** (`auto` / `on` / `off`, default `Auto (dark & black)`): shifts static HUD and glass panels ±2px every 60s and dims paused overlays after 2 min idle.

---

## 6. Verification Plan (Design Level)

1. **Automated Unit & ES5 Checks (`node tests/run.js`):**
   - Pass `{ Date: Date }` into `loadBrowserScript`'s extra VM globals for the existing `catchupUrl` test so it remains deterministic regardless of wall-clock time-of-day.
   - `scanES5` passes with 0 violations across all modified and new JS files (`js/view-iptv.js` included).
   - Pure unit tests covering `IPTV.tidyChannels`: separator dropping without dropping `*** TRT 1 HD ***`, adult category filtering, `TR`/`UK`/`NL` priority ranking, `+1` timeshift separation, cross-country collision safety (`FOX (TR)` vs `FOX (US)`), variant score ranking (`4K` > `FHD` > `HEVC` > `HD` > `SD` > `Backup`), favorite ID resolution across `Tidy <-> Raw` rebuilds, and `IPTV.streams(id)` returning ordered fallback variants.
   - Unit tests covering `Stremio.formatTags` with `fps` and `bitrate` fields, plus `Player.setBrowseOverlay` / `App.back` state transitions in a lightweight mock sandbox.
2. **Desktop Headless / Chrome DevTools Visual Verification (`http://localhost:8080`, `1920x1080`):**
   - Inspect 3-pane `IPTV` split layout, `live-behind` frosted glass over simulated HTML5 `<video>`, `Guide` translucent overlay, keyboard (`UP`/`DOWN`/`LEFT`/`RIGHT`/`OK`/`BACK`) focus transitions, windowed row recycling (`<= 10` DOM channel nodes rendered even with `2,000+` mock channels), and `#osd-tags` pills.
3. **Device Build Verification:**
   - Package `.wgt`, verify `unzip -l` includes `js/view-iptv.js` and updated `index.html`, ready to sideload to Samsung S90D when user approves.
