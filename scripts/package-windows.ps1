# The two Windows formats Tauri does not make itself, from the binary `tauri build` just built
# (release.yml, Windows legs): a portable zip, and (x64 only) an installer that embeds the WebView2
# runtime. Tauri embeds the x64 runtime for x64 and the x86 one for every other target, so an
# ARM64 offline installer would carry the wrong architecture; Windows 11 on ARM ships WebView2.
#   pwsh scripts/package-windows.ps1 -Target x86_64-pc-windows-msvc -Arch x64
# Writes into release-artifacts/ and can be run again (release.yml retries it once).
param(
  [Parameter(Mandatory)] [string] $Target,
  [Parameter(Mandatory)] [string] $Arch
)
$ErrorActionPreference = "Stop"
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$release = "src-rust/target/$Target/release"
New-Item -ItemType Directory -Force -Path release-artifacts | Out-Null

if ($Arch -eq "x64") {
  # The normal NSIS installer is already in release-artifacts; this bundle run replaces it in the
  # target tree, so the newer file is the offline one.
  $bundleDir = "$release/bundle/nsis"
  $since = Get-Date
  npx tauri bundle --bundles nsis --target $Target --config src-rust/tauri.webview2-offline.conf.json
  if ($LASTEXITCODE -ne 0) { throw "tauri bundle (offline installer) failed" }
  $offline = Get-ChildItem $bundleDir -Filter "*.exe" | Where-Object { $_.LastWriteTime -ge $since } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (!$offline) { throw "Missing WebView2 offline installer in $bundleDir" }
  Copy-Item $offline.FullName "release-artifacts/MetroTerm_${version}_${Arch}-offline-setup.exe" -Force
}

$portableDir = "portable/MetroTerm_${version}_${Arch}"
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null
# The crate's own binary name; the installer renames it to the product name.
$binary = @("$release/MetroTerm.exe", "$release/metroterm.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$binary) { throw "Missing Windows executable for $Target" }
Copy-Item $binary "$portableDir/MetroTerm.exe" -Force
Copy-Item LICENSE, README.md $portableDir -Force
# The marker moves settings, sessions, known hosts and logs into the copy's own data folder
# (src-rust/src/common/config.rs, PORTABLE_MARKER).
Set-Content -Path "$portableDir/portable.metroterm" -Value "" -NoNewline
Set-Content -Path "$portableDir/README-portable.txt" -Encoding utf8NoBOM -Value @(
  "MetroTerm portable build",
  "",
  "Run MetroTerm.exe. Settings, sessions, known hosts and logs are kept in the data folder beside it.",
  "Remembered passwords are encrypted for this computer and user: on another computer, enter them again.",
  "The Microsoft Edge WebView2 runtime is required; it is part of Windows 11 and of current Windows 10.",
  "",
  "便携版：运行 MetroTerm.exe。设置、会话、已知主机和日志保存在旁边的 data 文件夹里。",
  "记住的密码按这台电脑和用户加密，换一台电脑需要重新输入。需要 Microsoft Edge WebView2（Windows 11 和较新的 Windows 10 自带）。"
)
Compress-Archive -Path "$portableDir/*" -DestinationPath "release-artifacts/MetroTerm_${version}_${Arch}-portable.zip" -Force

Get-ChildItem release-artifacts | Format-Table Name, Length
