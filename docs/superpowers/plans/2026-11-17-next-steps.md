# Next steps after the APL TV parity work (ranked)

**Date:** 2026-11-17
**Branch:** `feat/apltv-iptv-parity`
**Status (2026-11-17):** Waves 0.1, 0.4 and 1–4 done (not yet tested on the TV). Still open: 0.2 personal fork, 0.3 TV test, Wave 5.
**Inputs:** the high-effort code review, three focused read-only reviews (live playback, IPTV data and service, UI), and the source-list and ranking check.

Size: S = under an hour, M = a few hours, L = a day or more.
"Confirmed" means the defect was confirmed by reading the code. Nothing here was run on the TV.

---

## Wave 0 — Housekeeping (do first)

| # | Change | Size |
|---|---|---|
| 0.1 | Commit the 22 review fixes. | S |
| 0.2 | Create a personal GitHub fork and push the branch to it. Today the branch exists only on the Mac, and `origin` is upstream. | S |
| 0.3 | Install the review build on the TV outside the no-touch windows. Run a short checklist: OK-OK, BACK, CH±, holding DOWN, a channel with no audio, catch-up. | S |
| 0.4 | Log channel-change timing: time from OK to the first picture and from OK to sound, written to the Diagnostics log. | S |

## Wave 1 — Breaks playback or loses data

| # | Defect | Where | Fix | Size |
|---|---|---|---|---|
| 1.1 | The service's 60 s request deadline cuts off the first read of a big Xtream or M3U list: the user gets a 504 and 0 channels. | `service/index.js:2332` | Exempt `/xtlive/*` and `/m3u/*`; their own 6 min limits apply. | S |
| 1.2 | A channel change that resolves after BACK or STOP starts playback again. | `view-core.js` `zapLiveChannel` | Bump `_zapToken` on player exit and check that the player is still wanted. | S |
| 1.3 | A source fallback or reconnect forgets whether the channel was in fullscreen or behind the menus. | `player-core.js` `setBrowseOverlay` / `play` | Store the mode on `S.ctx` as it changes. | S |
| 1.4 | The in-player source list shows only "Source", and picking an entry drops headers, breaks YouTube versions and disables fallback. | `view-core.js` `zapLiveChannel` | One shared builder for live source entries: label, headers, YouTube resolver, `stream`. | M |
| 1.5 | The cleaner deletes channels whose names are only in Hebrew, Thai, Korean, Japanese or Devanagari script. | `iptv.js` `isSeparatorName` | Treat a name as a divider only when it contains no letters or digits in any script. | S |
| 1.6 | Group filters fail in four ways: group names with spaces around them never match; 2048-character URL limits; many groups give 414; and the TV applies the channel cap before the group filter. | `iptv.js`, `service/index.js` | Trim names in the parsers; send groups in a POST body (or raise the limit); filter before applying the cap. | M |
| 1.7 | Xtream ignores the "Largest playlist" limit (up to 100k channels on old TVs). | `iptv.js` `finish()` Xtream branch | Apply `maxChannels()` and count the rest as dropped. | S |
| 1.8 | A playlist read by the service has no saved copy on the TV, and a failed category read is still saved on the TV. | `iptv.js` `serviceM3ULoad`, `xtliveText` | Keep a saved copy as the old path did; skip saving when `at === 0`. | M |
| 1.9 | Export and import lose groups, noVod and archiveOffset; imported favorites point at old playlist ids; `iptv.size` is not exported. | `stremio.js` export/import | Export the new fields; map old playlist ids to new ones in favorites on import; add `iptv.size`. | M |
| 1.10 | Editing a playlist's URL or account keeps its old groups, so it then loads 0 channels. | `iptv.js` `updatePlaylist` | Clear groups, genres and archiveOffset when the server or account changes. | S |
| 1.11 | The service's saved `xtl-*`/`m3u-*` files (which contain credentials) stay for up to 3 days after you remove a playlist. | `service/index.js`, `iptv.js` | Delete them when a playlist is removed. | S |

## Wave 2 — Remote and focus correctness in Live TV

| # | Defect | Size |
|---|---|---|
| 2.1 | A channel change from an inspector button, and a favorite toggle from the long-press menu, leave focus on nothing. | S |
| 2.2 | The exit callbacks (`onExited`, `onBrowseRet`) force focus onto Home even after you left Home. BACK from the top menu moves focus into the list. | S |
| 2.3 | Toolbar chips (Favorites, Recent, All) and the Recent group go stale after a group change or a channel change. | S |
| 2.4 | The selection jumps to the top of the window on toolbar DOWN, and does not follow CH+/CH− in the overlay. The change list goes stale after a filter or cleaner redraw. | M |
| 2.5 | Keys behind the menus: Play on another row is swallowed; number keys switch tabs instead of tuning; colour keys and PREV/NEXT do nothing. | M |
| 2.6 | CH+/CH− stop working after you pick a channel outside the current group from the in-player channel list; fast CH+ presses skip channels. | M |
| 2.7 | The "Opening stream…" message stays on screen when you go back to the menus. | S |
| 2.8 | Number-key input carries over when you leave the tab. The "Open settings / Clear filter" button on an empty list cannot be reached. | S |
| 2.9 | Guide and IPTV channel changes differ: the Guide does not record Recent, and the Play key takes a different path. | S |

## Wave 3 — Old TVs (Tizen 3), translations, look

| # | Change | Size |
|---|---|---|
| 3.1 | Replace CSS flex `gap` (not in Chromium 47) with margins. | S |
| 3.2 | Add about 49 missing translation keys: Turkish and English at least; mark the rest for translators. | M |
| 3.3 | Replace emoji and glyphs that Tizen 3 fonts likely lack (⛶ ⏹ ✨ 🕒 📺 🔀); rename the translation keys that contain them. | S |
| 3.4 | Fix low contrast with the light theme over the frosted panes. | S |
| 3.5 | Make the OLED pause-dim also cover pauses behind the menus. Show the inspector's Catch-up button only when the channel has a guide. | S |

## Wave 4 — Version ranking and guide quality

| # | Change | Size |
|---|---|---|
| 4.1 | Read quality words from the group name when the channel name has none. | S |
| 4.2 | Learn the real resolution and frame rate of each version once it plays, and rank by that. | M |
| 4.3 | Show the measured quality in the source lists. | S |
| 4.4 | Guide for merged channels: use the guide and tvg-id of any version, not only the first. | M |
| 4.5 | Let merged Stalker and YouTube versions take part in fallback. | M |

## Wave 5 — Features ("next level")

| # | Feature | Size |
|---|---|---|
| 5.1 | Faster channel changes: show the channel name and program at once, fetch neighbours' sources ahead, a last-channel key, number keys in fullscreen. Measure with 0.4. | M |
| 5.2 | Tune the cleaner on your real playlist: export names only, as a test fixture. | M |
| 5.3 | Curate channels from your phone ("Tier 2"): rename, hide, reorder and pin; fix wrong merges by hand. | L |
| 5.4 | A second guide source (iptv-org / epg.pw) and logos for channels without them. | M |
| 5.5 | Split the work into upstream PRs: fixes, Xtream Live, large playlists, UI. | M |
| 5.6 | Tier 3 feasibility: pausing live TV through a buffer on the Pi; sports scores. Multiview is probably impossible with one AVPlay. | M |

## Low priority / upstream behaviour
- `markLiveFromDuration` marks any playback with zero duration as live. This is upstream code; watch for it with catch-up.
- `sameKey` deduplication keeps the copy from the first playlist, so reordering playlists can change ids.
- The service sends the whole list in one response; the TV rejects it above 48 MB.
