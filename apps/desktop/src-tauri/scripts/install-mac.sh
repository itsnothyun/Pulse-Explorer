#!/bin/bash
# macOS: builds Pulse Explorer, installs it in /Applications and leaves no other copy behind.
#
# A build makes several app bundles on the way (the file manager's own build, its staged copy, Tauri's copies of its
# resources in target/*/files, the finished bundle). macOS registers every bundle it finds, so without this each build
# added more "Pulse Explorer" entries to Open With, Spotlight and Launchpad. Usage: install-mac.sh [--no-build]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$HERE/../../.."
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
DEST="/Applications/Pulse Explorer.app"
BUNDLE="$HERE/target/release/bundle/macos/Pulse Explorer.app"

if [ "${1:-}" != "--no-build" ]; then
    bash "$HERE/scripts/stage-mac-files.sh"
    (cd "$ROOT" && pnpm --filter @omniview/web build)
    (cd "$HERE/.." && pnpm tauri:build)
fi
[ -d "$BUNDLE" ] || { echo "no bundle at $BUNDLE"; exit 1; }

# a running copy would keep the old files open
pkill -f "Pulse Explorer.app/Contents/MacOS" 2>/dev/null || true
sleep 1
codesign --force --deep --sign - "$BUNDLE" >/dev/null 2>&1
rm -rf "$DEST"
cp -R "$BUNDLE" "$DEST"

# every other bundle the build left: unregistered and removed (they are made again by the next build)
for app in \
    "$HERE/target/release/bundle/macos/Pulse Explorer.app" \
    "$HERE/target/release/files/"*.app \
    "$HERE/target/debug/files/"*.app \
    "$HERE/files/"*.app \
    "$ROOT/apps/files/macos/build/"*.app; do
    [ -e "$app" ] || continue
    "$LSR" -u "$app" >/dev/null 2>&1 || true
    rm -rf "$app"
done
"$LSR" -f -R "$DEST" >/dev/null 2>&1
echo "$DEST"
