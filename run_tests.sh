#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if command -v godot >/dev/null 2>&1; then
  GODOT=godot
elif command -v godot4 >/dev/null 2>&1; then
  GODOT=godot4
elif [ -x "/tmp/Godot.app/Contents/MacOS/Godot" ]; then
  GODOT="/tmp/Godot.app/Contents/MacOS/Godot"
elif [ -x "/Applications/Godot.app/Contents/MacOS/Godot" ]; then
  GODOT="/Applications/Godot.app/Contents/MacOS/Godot"
else
  echo "Godot not found. Install from https://godotengine.org/download"
  exit 1
fi

echo "Using Godot: $GODOT"
"$GODOT" --headless --path "$PROJECT_DIR" -s res://tests/run_tests.gd "$@"
