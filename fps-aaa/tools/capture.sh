#!/usr/bin/env bash
# Capture the standard review set into /tmp/fpsshots/<cycle>/
# Usage: tools/capture.sh <cycle-name>
set -u
CYCLE="${1:-cycle}"
DIR="/tmp/fpsshots/$CYCLE"
mkdir -p "$DIR"
cd "$(dirname "$0")/.."

shot () { # name  query  [extra args...]
  local name="$1"; shift
  local query="$1"; shift
  python3 tools/shoot.py "$DIR/$name.png" "$query" --settle 2.5 "$@" 2>&1 | sed "s/^/[$name] /"
}

shot 01-menu            ""                                    --settle 3
shot 02-spawn-hud       "shot=0&enemies=6"
shot 03-lane-mid        "shot=1&enemies=6"
shot 04-interior        "shot=2&enemies=6"
shot 05-overlook        "shot=3&enemies=6"
shot 06-lane-far        "shot=4&enemies=6"
shot 07-ads             "shot=1&enemies=6" --eval "window.__fpsDebug.forceAds && window.__fpsDebug.forceAds(true)"
shot 08-firefight       "shot=1&enemies=8" --eval "window.__fpsDebug.burst && window.__fpsDebug.burst()"
shot 09-clean-nohud     "shot=2&enemies=6&hud=0"

echo
echo "Captured to $DIR"
ls -la "$DIR"
