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
# third-party notices the MIT licences ask to ship with the app (the terminal tabs' SwiftTerm)
ST="$FILES/macos/Vendor/SwiftTerm/LICENSE"
[ -f "$ST" ] && cp "$ST" "$OUT/LICENSE-SwiftTerm" && chmod u+w "$OUT/LICENSE-SwiftTerm"  # (a read-only copy stops the next build from replacing it)

PL="$APP/Contents/Info.plist"
mv "$APP/Contents/MacOS/RustyFiles" "$APP/Contents/MacOS/Pulse Explorer"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Pulse Explorer" \
    -c "Set :CFBundleDisplayName Pulse Explorer" \
    -c "Set :CFBundleExecutable Pulse Explorer" \
    -c "Set :CFBundleIdentifier app.pulse.explorer.files" \
    -c "Set :NSLocalNetworkUsageDescription Ferry finds Pulse Explorer on your other devices on this network, to send files to them." "$PL"
cp "$HERE/icons/icon.icns" "$APP/Contents/Resources/AppIcon.icns"
# A stable signature keeps what macOS let the app do (Desktop, Documents, Downloads…) across rebuilds: an ad-hoc one is a new
# app to macOS every build, and it asks again. The first Apple Development / Developer ID certificate in the keychain, or
# PULSE_SIGN_ID; ad-hoc only when there is none.
SIGN_ID="${PULSE_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null | awk '/Apple Development|Developer ID Application/ {print $2; exit}')}"
codesign --force --sign "${SIGN_ID:--}" "$APP" >/dev/null
# The dev build (`pnpm desktop:tauri`) uses the same copy.
DEV="$FILES/macos/build/Pulse Explorer.app"
rm -rf "$DEV" && cp -R "$APP" "$DEV"
echo "$APP"
