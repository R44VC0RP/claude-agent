#!/bin/sh
# Builds "Claude Limits.app", a menu bar item that shows each Claude account's plan limits.
# Usage: menubar/build.sh [output folder, default ~/Applications]
set -eu

root=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$HOME/Applications"}
app="$out/Claude Limits.app"

# An app started at login has a bare PATH, so record where bun and claude are now.
bun=$(command -v bun) || { echo "bun is not installed" >&2; exit 1; }
claude=$(command -v claude) || { echo "Claude Code is not installed" >&2; exit 1; }

swift build -c release --package-path "$root"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$root/.build/release/ClaudeLimits" "$app/Contents/MacOS/ClaudeLimits"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>ClaudeLimits</string>
  <key>CFBundleIdentifier</key><string>dev.vogel.claude-limits</string>
  <key>CFBundleName</key><string>Claude Limits</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>LimitsCommand</key>
  <array>
    <string>/usr/bin/env</string>
    <string>PATH=$(dirname "$bun"):$(dirname "$claude"):/usr/bin:/bin</string>
    <string>$bun</string>
    <string>$root/limits.ts</string>
  </array>
</dict>
</plist>
EOF
codesign --force --sign - "$app"
echo "$app"
