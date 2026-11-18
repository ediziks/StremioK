#!/usr/bin/env bash
# Real-TV dev loop (development only; not packed into the .wgt).
#   tools/tv.sh connect   sdb connection to the TV (SDB_PORT 26101: the TV's Developer Mode host
#                         is this computer; 26201: TV-Store's relay, host 127.0.0.1, no debug)
#   tools/tv.sh debug     start StremioK in debug mode, its inspector forwarded to
#                         http://127.0.0.1:$INSPECT_PORT (then: node tools/tv-cdp.js ...)
#   tools/tv.sh build     tests, translations check, .wgt
#   tools/tv.sh deploy    build, then install on the TV
#   tools/tv.sh launch    start StremioK on the TV
# Settings in tools/tv.local (not in git), e.g.:
#   TV_IP=…  LOCAL_IP=…  SDB=…/sdb  A2S=…/apps2samsung-cli  WGT=…/StremioK-dev.wgt
#   NO_TOUCH="1525-2205 2355-0135"   (local times when the TV is left alone; FORCE=1 overrides)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f tools/tv.local ] && . tools/tv.local
: "${TV_IP:?set TV_IP in tools/tv.local}"
SDB=${SDB:-sdb}; A2S=${A2S:-apps2samsung-cli}; APP_ID=${APP_ID:-StremioK01.StremioK}
SDB_PORT=${SDB_PORT:-26101}; INSPECT_PORT=${INSPECT_PORT:-9222}; WGT=${WGT:-$PWD/StremioK-dev.wgt}
SERIAL="$TV_IP:$SDB_PORT"

in_no_touch() {   # NO_TOUCH: "HHMM-HHMM ..." (a window may run past midnight)
    local now w a b; now=$((10#$(date +%H%M)))
    for w in ${NO_TOUCH:-}; do
        a=$((10#${w%-*})); b=$((10#${w#*-}))
        if [ "$a" -le "$b" ]; then [ "$now" -ge "$a" ] && [ "$now" -lt "$b" ] && return 0
        else { [ "$now" -ge "$a" ] || [ "$now" -lt "$b" ]; } && return 0; fi
    done
    return 1
}
guard() {
    if in_no_touch && [ "${FORCE:-}" != 1 ]; then
        echo "Now ($(date +%H:%M)) is in a no-touch window ($NO_TOUCH): the TV is left alone. FORCE=1 to override." >&2
        exit 2
    fi
}
wake() { ping -c 3 "$TV_IP" >/dev/null 2>&1 || true; }   # (the TV's idle Wi-Fi answers after a ping)
connect() { wake; "$SDB" connect "$SERIAL" | tail -1; }
build() {
    node tests/run.js | tail -1
    node translations/build.js --check | tail -1
    rm -f "$WGT"
    zip -rq "$WGT" index.html tizenbrew.html icon.png config.xml css js service -x "*.DS_Store" "*__MACOSX*"
    echo "Built $WGT"
}

case "${1:-}" in
    connect) connect ;;
    debug)
        guard; connect
        out=$("$SDB" -s "$SERIAL" shell 0 debug "$APP_ID" 2>&1 || true)
        echo "$out"
        port=$(printf '%s\n' "$out" | grep -oiE 'port: *[0-9]+' | grep -oE '[0-9]+' | tail -1 || true)
        [ -n "$port" ] || { echo "No inspector port in the answer above." >&2; exit 1; }
        "$SDB" -s "$SERIAL" forward --remove "tcp:$INSPECT_PORT" >/dev/null 2>&1 || true
        "$SDB" -s "$SERIAL" forward "tcp:$INSPECT_PORT" "tcp:$port"
        echo "Inspector: http://127.0.0.1:$INSPECT_PORT/json (TV port $port)"
        ;;
    build) build ;;
    deploy) build; guard; wake; "$A2S" install "$WGT" --tv "$TV_IP" --local-ip "${LOCAL_IP:?set LOCAL_IP in tools/tv.local}" ;;
    launch) guard; wake; "$A2S" launch "$APP_ID" --tv "$TV_IP" ;;
    *) sed -n '2,13p' "$0"; exit 1 ;;
esac
