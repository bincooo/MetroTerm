#!/usr/bin/env node
// The notes of one release, from the changelogs.
//
//   node scripts/release-notes.mjs v1.2.3             English, then Chinese
//   node scripts/release-notes.mjs v1.2.3 --lang zh   one language (en | zh)
//   node scripts/release-notes.mjs v1.2.3 --check     fail unless both languages have notes
//
// CHANGELOG.md (English) and CHANGELOG.zh-CN.md (中文) follow Keep a Changelog: one
// `## [1.2.3] - 2026-11-16` heading per release, newest first; everything up to the next `## `
// heading is that release's notes. The release workflow checks them before it builds anything — a
// release whose notes were never written is a release nobody can decide about — and the Chinese part
// becomes the body of the GitHub release.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = { en: 'CHANGELOG.md', zh: 'CHANGELOG.zh-CN.md' };

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The body under `## [version]` (or `## version` / `## v1.2.3`), trimmed; null when absent. */
export function section(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const escaped = version.replace(/\./g, '\\.');
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`);
  const start = lines.findIndex(line => heading.test(line));
  if (start < 0) return null;
  let end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  // Link reference definitions at the bottom of the file (`[1.2.3]: https://…`) are not notes.
  const body = lines
    .slice(start + 1, end)
    .filter(line => !/^\[[^\]]+\]:\s*\S+/.test(line))
    .join('\n')
    .trim();
  return body;
}

function notes(lang, version) {
  const file = FILES[lang];
  const path = join(root, file);
  if (!existsSync(path)) return { file, body: null };
  return { file, body: section(readFileSync(path, 'utf8'), version) };
}

const args = process.argv.slice(2);
const tag = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--lang');
if (!tag) fail('usage: node scripts/release-notes.mjs vX.Y.Z [--lang en|zh] [--check]');
const version = tag.replace(/^v/, '');
const langAt = args.indexOf('--lang');
const lang = langAt >= 0 ? args[langAt + 1] : undefined;
if (lang !== undefined && !(lang in FILES)) fail(`--lang must be one of: ${Object.keys(FILES).join(', ')}`);

if (args.includes('--check')) {
  let ok = true;
  for (const each of Object.keys(FILES)) {
    const { file, body } = notes(each, version);
    if (body === null) console.error(`${file}: no "## [${version}]" section`);
    else if (!body) console.error(`${file}: the "## [${version}]" section is empty`);
    else console.log(`ok  ${file}: ${body.split('\n').filter(line => line.trim()).length} lines of notes for ${version}`);
    ok &&= Boolean(body);
  }
  if (!ok) fail(`write the notes of ${version} before tagging it`);
} else {
  const parts = (lang ? [lang] : Object.keys(FILES)).map(each => {
    const { file, body } = notes(each, version);
    if (!body) fail(`${file}: no notes for ${version}`);
    return body;
  });
  console.log(parts.join('\n\n---\n\n'));
}
