#!/bin/bash
# Cross-compile the Windows installers on Linux → release/MetroTerm_<version>_<arch>-setup.exe (NSIS).
#   scripts/build-windows.sh            → x64 and arm64
#   scripts/build-windows.sh x64        → only x64      (arm64 likewise)
#
# One-time setup:
#   apt install nsis clang lld llvm                 (makensis, clang-cl, lld-link, llvm-rc, llvm-lib)
#   ln -s clang /usr/bin/clang-cl                   (if the distro has no clang-cl link)
#   cargo-xwin in PATH (prebuilt: github.com/rust-cross/cargo-xwin/releases)
#   rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc
# The first run downloads the MSVC CRT + Windows SDK (Microsoft license, accepted through
# XWIN_ACCEPT_LICENSE) into ~/.cache/cargo-xwin (about 1 GB after unpacking; 2 GB more while it unpacks).
# Memory: the `windows` crate needs more than 2 GB RAM with 2 jobs — add swap on small machines.
# MSI packages need WiX (Windows only); the GitHub workflow (.github/workflows/release.yml) builds them.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
if [ $# -eq 0 ]; then ARCHES=(x64 arm64); else ARCHES=("$@"); fi

export RUSTUP_HOME=${RUSTUP_HOME:-/opt/rust/rustup} CARGO_HOME=${CARGO_HOME:-/opt/rust/cargo}
export PATH=$CARGO_HOME/bin:$PATH
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/opt/build/win} CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
export XWIN_ACCEPT_LICENSE=1

npm run build # frontend → dist/
mkdir -p release
for arch in "${ARCHES[@]}"; do
  case "$arch" in
    x64) target=x86_64-pc-windows-msvc ;;
    arm64)
      target=aarch64-pc-windows-msvc
      # ring builds its aarch64 Windows C / assembly with plain clang, but cargo-xwin passes the
      # MSVC include dirs clang-cl style (`/imsvc DIR`): a clang wrapper maps them to -isystem.
      wrap=$(mktemp -d)
      cat >"$wrap/clang" <<'EOF'
#!/bin/bash
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    /imsvc) args+=(-isystem "$2"); shift 2 ;;
    /imsvc*) args+=(-isystem "${1#/imsvc}"); shift ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /usr/bin/clang "${args[@]}"
EOF
      chmod +x "$wrap/clang"
      ;;
    *) echo "usage: $0 [x64] [arm64]" >&2; exit 2 ;;
  esac
  echo "=== $target"
  (
    [ "$arch" = arm64 ] && export PATH=$wrap:$PATH
    node node_modules/@tauri-apps/cli/tauri.js build --runner cargo-xwin --target "$target" --bundles nsis \
      --config '{"build":{"beforeBuildCommand":""}}'
  )
  EXE="MetroTerm_${VERSION}_${arch}-setup.exe"
  cp "$CARGO_TARGET_DIR/$target/release/bundle/nsis/$EXE" release/
  echo "→ release/$EXE"
done
