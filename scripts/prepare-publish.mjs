#!/usr/bin/env node
/**
 * Prepare the publishable artefacts for dsh-ssh-mac.
 *
 *   node scripts/prepare-publish.mjs --owner <github-user> [--repo dsh-ssh-mac]
 *
 * Writes the GitHub coordinates into package.json, regenerates the
 * awesome-dsh-plugin entry file, and packs a release tarball with a
 * version-free asset name (the marketplace's `latest/download/` URL takes the
 * filename literally, so a versioned name rots on the next release).
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const owner = arg('owner')
const repo = arg('repo', 'dsh-ssh-mac')
if (!owner || owner.startsWith('--')) {
  console.error('usage: node scripts/prepare-publish.mjs --owner <github-user> [--repo dsh-ssh-mac]')
  process.exit(2)
}

const manifestPath = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const slug = `https://github.com/${owner}/${repo}`

manifest.repository = { type: 'git', url: `git+${slug}.git` }
manifest.homepage = `${slug}#readme`
manifest.bugs = { url: `${slug}/issues` }
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`package.json -> ${slug}`)

// The awesome-dsh-plugin entry: one file, one entry, exact URL match.
const entryDir = join(root, 'docs')
mkdirSync(entryDir, { recursive: true })
const entry = `url: ${slug}
name: ${owner}/${repo}
category: remote
description:
  en: Resolves an SSH host by its NIC MAC address before dialing, so DHCP address changes stop breaking saved hosts.
  zh: 建链前先按网卡 MAC 把主机解析成当前 IP，DHCP 换号不用改配置。
`
writeFileSync(join(entryDir, `awesome-entry-${owner}__${repo}.yml`), entry)
console.log(`entry -> docs/awesome-entry-${owner}__${repo}.yml`)

// The marketplace installs from a tarball attachment when there is no npm package.
for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
  if (!existsSync(join(root, required))) {
    console.error(`missing build output: ${required} — run "npm run build:all" first`)
    process.exit(1)
  }
}

const releaseDir = join(root, 'release')
mkdirSync(releaseDir, { recursive: true })
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', releaseDir], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  // npm is a .cmd shim on Windows; spawning it without a shell raises EINVAL.
  shell: process.platform === 'win32',
})

const packed = `dsh-ssh-mac-${manifest.version}.tgz`
const target = join(releaseDir, 'dsh-ssh-mac.tgz')
if (existsSync(join(releaseDir, packed))) {
  renameSync(join(releaseDir, packed), target)
}
const digest = createHash('sha256').update(readFileSync(target)).digest('hex')
console.log(`tarball -> release/dsh-ssh-mac.tgz  sha256 ${digest}`)
console.log(`
next:
  gh repo create ${owner}/${repo} --public --source . --push   # or push by hand
  gh repo edit ${owner}/${repo} --add-topic dsh-plugin
  gh release create v${manifest.version} release/dsh-ssh-mac.tgz --title v${manifest.version}
  PR against awesome-dsh-plugin adding data/plugins/${owner}__${repo}.yml
`)
