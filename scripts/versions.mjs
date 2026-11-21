#!/usr/bin/env node
// The version every manifest carries, kept in one place.
//
//   node scripts/versions.mjs verify [--tag v1.2.3]   every manifest agrees (and names the tag)
//   node scripts/versions.mjs sync 1.2.3              write 1.2.3 into all of them
//   (npm run verify:versions / npm run sync:versions -- 1.2.3)
//
// package.json is the source of truth. The others are copies the tools read on their own:
// package-lock.json (npm), src-rust/Cargo.toml and src-rust/Cargo.lock (Cargo, the binary's
// `--version`), src-rust/tauri.conf.json (the installers' file names and metadata). A release whose
// installers say one version and whose `--version` says another cannot be repaired after the fact,
// so the release workflow refuses to build until they agree.
//
// A version is numbers and periods only (MAJOR.MINOR.PATCH): a candidate is a prerelease of this
// version on GitHub, not a suffix — an MSI cannot carry a non-numeric pre-release identifier.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^\d+\.\d+\.\d+$/;

const read = path => readFileSync(join(root, path), 'utf8');
const write = (path, text) => writeFileSync(join(root, path), text);

/** Each manifest: how to read its version, and how to write one. */
const manifests = [
  {
    path: 'package.json',
    get: text => JSON.parse(text).version,
    set: (text, version) => text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`),
  },
  {
    path: 'package-lock.json',
    get: text => {
      const lock = JSON.parse(text);
      const own = lock.packages?.['']?.version;
      return own === lock.version ? lock.version : `${lock.version} / packages[""] ${own}`;
    },
    set: (text, version) => {
      const lock = JSON.parse(text);
      lock.version = version;
      if (lock.packages?.['']) lock.packages[''].version = version;
      return `${JSON.stringify(lock, null, 2)}\n`;
    },
  },
  {
    path: 'src-rust/Cargo.toml',
    // The first `version =` of the [package] table (dependencies use inline tables).
    get: text => /^\[package\][^[]*?^version\s*=\s*"([^"]*)"/ms.exec(text)?.[1],
    set: (text, version) => text.replace(/^(\[package\][^[]*?^version\s*=\s*")[^"]*(")/ms, `$1${version}$2`),
  },
  {
    path: 'src-rust/Cargo.lock',
    get: text => /^name = "metroterm"\nversion = "([^"]*)"/m.exec(text)?.[1],
    set: (text, version) => text.replace(/^(name = "metroterm"\nversion = ")[^"]*(")/m, `$1${version}$2`),
  },
  {
    path: 'src-rust/tauri.conf.json',
    get: text => JSON.parse(text).version,
    set: (text, version) => text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`),
  },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function verify(tag) {
  const versions = manifests.map(manifest => ({ path: manifest.path, version: manifest.get(read(manifest.path)) }));
  const expected = versions[0].version;
  let ok = VERSION.test(expected ?? '');
  if (!ok) console.error(`package.json: "${expected}" is not MAJOR.MINOR.PATCH (numbers and periods only)`);
  for (const { path, version } of versions) {
    const same = version === expected;
    ok &&= same;
    console.log(`${same ? 'ok  ' : 'DIFF'}  ${path.padEnd(26)} ${version ?? '(not found)'}`);
  }
  if (tag !== undefined && tag !== `v${expected}`) {
    console.error(`the tag is ${tag} and package.json says ${expected}`);
    console.error('bump the version with `npm run sync:versions -- X.Y.Z`, commit, and tag that commit');
    ok = false;
  }
  if (!ok) fail('the manifests do not agree — fix them with `npm run sync:versions -- X.Y.Z`');
  console.log(`all manifests carry ${expected}${tag ? `, as the tag ${tag} says` : ''}`);
}

function sync(version) {
  if (!VERSION.test(version ?? '')) fail(`usage: sync MAJOR.MINOR.PATCH (got "${version ?? ''}")`);
  for (const manifest of manifests) {
    const before = read(manifest.path);
    const after = manifest.set(before, version);
    if (manifest.get(after) !== version) fail(`${manifest.path}: could not write the version`);
    if (after !== before) write(manifest.path, after);
    console.log(`${manifest.path.padEnd(26)} ${version}`);
  }
  console.log(`next: add a "## [${version}]" section to CHANGELOG.md and CHANGELOG.zh-CN.md, commit, tag v${version}`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'verify') {
  const at = rest.indexOf('--tag');
  verify(at >= 0 ? rest[at + 1] : undefined);
} else if (command === 'sync') {
  sync(rest[0]);
} else {
  fail('usage: node scripts/versions.mjs verify [--tag vX.Y.Z] | sync X.Y.Z');
}
