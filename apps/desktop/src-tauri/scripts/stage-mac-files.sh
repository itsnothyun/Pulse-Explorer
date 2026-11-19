#!/bin/bash
# macOS: builds the native Mac rustyfiles (apps/files/macos) and stages it, in Pulse's name and icon, where
# tauri.macos.conf.json bundles it from (src-tauri/files/). Usage: stage-mac-files.sh [--no-build]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FILES="$HERE/../../files"

[ "${1:-}" = "--no-build" ] || "$FILES/macos/build.sh" release

SRC="$FILES/macos/build/rustyfiles.app"
OUT="$HERE/files"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$SRC" "$OUT/rustyfiles.app"
cp "$FILES/LICENSE" "$OUT/LICENSE"

APP="$OUT/rustyfiles.app"
PL="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Pulse Explorer" \
    -c "Set :CFBundleDisplayName Pulse Explorer" \
    -c "Set :CFBundleIdentifier app.pulse.explorer.files" "$PL"
cp "$HERE/icons/icon.icns" "$APP/Contents/Resources/AppIcon.icns"
# The dev build (`pnpm desktop:tauri`) uses the same branded copy.
rm -rf "$SRC" && cp -R "$APP" "$SRC"
codesign --force --sign - "$APP" >/dev/null
codesign --force --sign - "$SRC" >/dev/null
echo "$APP"
