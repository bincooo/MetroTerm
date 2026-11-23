#!/bin/bash
# Build dist/MetroTerm_<version>_<arch>.deb for Ubuntu 22.04 and newer.
#   scripts/build-deb.sh          → amd64 (native, chroot /opt/jammy)
#   scripts/build-deb.sh arm64    → arm64 (cross-compiled, chroot /opt/jammy-arm64)
#
# The app is compiled inside an Ubuntu 22.04 (jammy) chroot, so the binary needs only glibc 2.35
# (building on a newer distro would require that distro's glibc). One-time chroot setup (root):
#   debootstrap --variant=minbase --components=main,universe --include=ca-certificates \
#     jammy /opt/jammy http://archive.ubuntu.com/ubuntu
#   chroot /opt/jammy apt-get install -y --no-install-recommends build-essential pkg-config file \
#     curl xz-utils libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev libayatana-appindicator3-dev
#   Node.js (official linux-x64 tarball) in /opt/jammy/opt/node, a user with the same uid as yours,
#   and a writable /opt/jammy/build-target. Rust comes from the host's /opt/rust (bind-mounted).
# arm64: a copy of that chroot (/opt/jammy-arm64) with `dpkg --add-architecture arm64`, the arm64
#   lines of ports.ubuntu.com in sources.list (`deb [arch=arm64] …`), and
#     apt-get install crossbuild-essential-arm64 libwebkit2gtk-4.1-dev:arm64 libgtk-3-dev:arm64 \
#       librsvg2-dev:arm64 libssl-dev:arm64 libayatana-appindicator3-dev:arm64
#   (this replaces the amd64 -dev packages — their gir files can't be installed for two
#   architectures — hence the separate chroot), plus `rustup target add aarch64-unknown-linux-gnu`.
set -euo pipefail
ARCH=${1:-amd64}
case "$ARCH" in
  amd64) ROOT=/opt/jammy TARGET="" OUT=release ;;
  arm64) ROOT=/opt/jammy-arm64 TARGET=aarch64-unknown-linux-gnu OUT=aarch64-unknown-linux-gnu/release ;;
  *) echo "usage: $0 [amd64|arm64]" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")

npm run build                     # frontend → dist/ (vite empties dist/ first)

sudo bash -c "
  for d in proc sys dev dev/pts; do mountpoint -q $ROOT/\$d || mount --bind /\$d $ROOT/\$d; done
  mkdir -p $ROOT/opt/rust $ROOT/home/user
  mountpoint -q $ROOT/opt/rust || mount --bind /opt/rust $ROOT/opt/rust
  mountpoint -q $ROOT/home/user || mount --bind $PWD $ROOT/home/user
  cp /etc/resolv.conf $ROOT/etc/resolv.conf
"
trap 'sudo umount $ROOT/home/user $ROOT/opt/rust $ROOT/dev/pts $ROOT/dev $ROOT/sys $ROOT/proc 2>/dev/null || true' EXIT

sudo chroot --userspec="$(id -u):$(id -g)" "$ROOT" env HOME=/home/user TARGET="$TARGET" bash -c '
  set -euo pipefail
  export RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo
  export PATH=/opt/rust/cargo/bin:/opt/node/bin:/usr/bin:/bin
  export CARGO_TARGET_DIR=/build-target CARGO_BUILD_JOBS=2
  args=()
  if [ -n "$TARGET" ]; then
    # Cross-compile: aarch64 gcc as compiler / linker, pkg-config looks at the arm64 libraries.
    export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
    export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
    export PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_SYSROOT_DIR=/
    export PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig
    args=(--target "$TARGET")
  fi
  cd /home/user
  node node_modules/@tauri-apps/cli/tauri.js build "${args[@]}" --bundles deb --config "{\"build\":{\"beforeBuildCommand\":\"\"}}"
'

DEB="MetroTerm_${VERSION}_${ARCH}.deb"
cp "$ROOT/build-target/$OUT/bundle/deb/$DEB" dist/
mkdir -p release && cp "dist/$DEB" release/   # dist/ is rebuilt by every `npm run build`
echo "→ dist/$DEB"
