#!/bin/bash
# macOS: builds the native Mac file manager (apps/files/macos) and stages it as Pulse Explorer (name, executable,
# icon) where tauri.macos.conf.json bundles it from (src-tauri/files/). Usage: stage-mac-files.sh [--no-build]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FILES="$HERE/../../files"

[ "${1:-}" = "--no-build" ] || "$FILES/macos/build.sh" release

SRC="$FILES/macos/build/rustyfiles.app"
OUT="$HERE/files"
rm -rf "$OUT"
mkdir -p "$OUT"
APP="$OUT/Pulse Explorer.app"
cp -R "$SRC" "$APP"
cp "$FILES/LICENSE" "$OUT/LICENSE"

PL="$APP/Contents/Info.plist"
mv "$APP/Contents/MacOS/RustyFiles" "$APP/Contents/MacOS/Pulse Explorer"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Pulse Explorer" \
    -c "Set :CFBundleDisplayName Pulse Explorer" \
    -c "Set :CFBundleExecutable Pulse Explorer" \
    -c "Set :CFBundleIdentifier app.pulse.explorer.files" \
    -c "Set :NSLocalNetworkUsageDescription Ferry finds Pulse Explorer on your other devices on this network, to send files to them." "$PL"
cp "$HERE/icons/icon.icns" "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP" >/dev/null
# The dev build (`pnpm desktop:tauri`) uses the same copy.
DEV="$FILES/macos/build/Pulse Explorer.app"
rm -rf "$DEV" && cp -R "$APP" "$DEV"
echo "$APP"
