#!/bin/bash
# Cross-compile the macOS app on Linux → release/MetroTerm_<version>_<arch>.dmg (MetroTerm.app + Applications link).
#   scripts/build-macos.sh              → universal (Apple silicon + Intel in one app)
#   scripts/build-macos.sh arm64        → only Apple silicon (aarch64)      x64 likewise (Intel)
#
# One-time setup (paths can be changed with the variables below):
#   apt install clang lld llvm                     clang, ld64.lld, llvm-lipo, llvm-ar
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
#   MACOS_SDK   a macOS SDK (MacOSX15.5.sdk). Apple's SDK license only allows using it on Apple
#               hardware: extract it from Xcode yourself (Xcode.app/Contents/Developer/Platforms/
#               MacOSX.platform/Developer/SDKs) and copy it here.
#   MAC_TOOLS   a directory with
#                 newfs_hfs          creates the empty HFS+ volume   (github.com/glaubitz/hfs, branch linux: make)
#                 hfsplus, dmg       fill it / compress it to UDZO   (github.com/mozilla/libdmg-hfsplus: cmake)
#                 rcodesign          ad-hoc signs the app            (github.com/indygreg/apple-platform-rs releases)
# The app is ad-hoc signed, not signed with a Developer ID or notarized: on first launch macOS
# blocks it — right-click → Open, or `xattr -dr com.apple.quarantine /Applications/MetroTerm.app`.
# The GitHub workflow (.github/workflows/release.yml) builds the same app natively on macOS.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./src-rust/tauri.conf.json').productName")
IDENTIFIER=$(node -p "require('./src-rust/tauri.conf.json').identifier")
ARCH=${1:-universal}

export RUSTUP_HOME=${RUSTUP_HOME:-/opt/rust/rustup} CARGO_HOME=${CARGO_HOME:-/opt/rust/cargo}
export SDKROOT=${MACOS_SDK:-/opt/macsdk/MacOSX15.5.sdk}
MAC_TOOLS=${MAC_TOOLS:-/opt/mactools/bin}
LLVM_BIN=${LLVM_BIN:-$(dirname "$(readlink -f "$(command -v ld64.lld || echo /usr/lib/llvm-19/bin/ld64.lld)")")}
export PATH=$CARGO_HOME/bin:$MAC_TOOLS:$LLVM_BIN:$PATH
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/opt/build/mac} CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}

case "$ARCH" in
  universal) TARGETS=(aarch64-apple-darwin x86_64-apple-darwin); LABEL=universal; MIN_OS=10.15 ;;
  arm64 | aarch64) TARGETS=(aarch64-apple-darwin); LABEL=aarch64; MIN_OS=11.0 ;;
  x64 | x86_64) TARGETS=(x86_64-apple-darwin); LABEL=x64; MIN_OS=10.15 ;;
  *) echo "usage: $0 [universal|arm64|x64]" >&2; exit 2 ;;
esac
[ -d "$SDKROOT/System/Library/Frameworks/WebKit.framework" ] || { echo "macOS SDK not found: $SDKROOT (set MACOS_SDK)" >&2; exit 1; }
for tool in newfs_hfs hfsplus dmg rcodesign ld64.lld llvm-lipo llvm-ar clang; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool (see the setup notes at the top of $0)" >&2; exit 1; }
done

# clang driver per target: the SDK as sysroot, LLVM's Mach-O linker (it also ad-hoc signs arm64 output).
# A fixed path: a new one every run would make cargo rebuild every crate with C code (CC_* changed).
WRAP=$CARGO_TARGET_DIR/clang-wrappers
mkdir -p "$WRAP"
for target in "${TARGETS[@]}"; do
  arch=${target%%-*}; [ "$arch" = aarch64 ] && arch=arm64
  min=10.15; [ "$arch" = arm64 ] && min=11.0
  for tool in clang clang++; do
    printf '#!/bin/bash\nexec %s --target=%s-apple-macos%s -isysroot "$SDKROOT" -fuse-ld=lld "$@"\n' \
      "$(command -v $tool)" "$arch" "$min" >"$WRAP/$target-$tool"
    chmod +x "$WRAP/$target-$tool"
  done
done

npm run build # frontend → dist/ (embedded into the binary)
BINS=()
for target in "${TARGETS[@]}"; do
  echo "=== $target"
  env_target=${target//-/_}
  min=10.15; [ "${target%%-*}" = aarch64 ] && min=11.0
  (
    export "CC_$env_target=$WRAP/$target-clang" "CXX_$env_target=$WRAP/$target-clang++" "AR_$env_target=llvm-ar"
    export "CARGO_TARGET_${env_target^^}_LINKER=$WRAP/$target-clang" MACOSX_DEPLOYMENT_TARGET=$min
    node node_modules/@tauri-apps/cli/tauri.js build --target "$target" --no-bundle \
      --config '{"build":{"beforeBuildCommand":""}}'
  )
  BINS+=("$CARGO_TARGET_DIR/$target/release/metroterm")
done

# MetroTerm.app
STAGE=$CARGO_TARGET_DIR/dmg-$LABEL
APP=$STAGE/$NAME.app
rm -rf "$STAGE"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
if [ ${#BINS[@]} -gt 1 ]; then
  llvm-lipo -create "${BINS[@]}" -output "$APP/Contents/MacOS/metroterm"
else
  cp "${BINS[0]}" "$APP/Contents/MacOS/metroterm"
fi
chmod 755 "$APP/Contents/MacOS/metroterm"
cp src-rust/icons/icon.icns "$APP/Contents/Resources/icon.icns"
printf 'APPL????' >"$APP/Contents/PkgInfo"
cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>English</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>metroterm</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundleIdentifier</key><string>$IDENTIFIER</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CSResourcesFileMapped</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_OS</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>MetroTerm $VERSION</string>
</dict>
</plist>
EOF
rcodesign sign "$APP" # no certificate → ad-hoc signature (executable + Info.plist + resources sealed)
# `rcodesign verify` expects a certificate (CMS) and fails on ad-hoc signatures: check the flags instead.
rcodesign print-signature-info "$APP/Contents/MacOS/metroterm" | grep -q 'CodeSignatureFlags(ADHOC)'

# .dmg: HFS+ volume with the app and an Applications link, compressed (UDZO).
IMG=$CARGO_TARGET_DIR/$NAME-$LABEL.hfs
size_mb=$(($(du -sm "$STAGE" | cut -f1) + 16))
rm -f "$IMG"
dd if=/dev/zero of="$IMG" bs=1M count="$size_mb" status=none
newfs_hfs -v "$NAME" "$IMG" >/dev/null
hfsplus "$IMG" addall "$STAGE" >/dev/null # keeps the file modes (the executable stays 755)
hfsplus "$IMG" symlink /Applications /Applications
DMG=${NAME}_${VERSION}_$LABEL.dmg
mkdir -p release
dmg build "$IMG" "release/$DMG" >/dev/null
rm -f "$IMG"
echo "→ release/$DMG ($(du -h "release/$DMG" | cut -f1))"
