#!/usr/bin/env node
/**
 * Publish dsh-ssh-mac to the dsh plugin market, end to end.
 *
 *   GH_TOKEN=<github token with repo scope> node scripts/publish-github.mjs --owner <login>
 *
 * Does, in order:
 *   1. creates the public repo (skipped when it already exists)
 *   2. commits the working tree and pushes it
 *   3. adds the `dsh-plugin` topic
 *   4. cuts a release and attaches release/dsh-ssh-mac.tgz (version-free asset name)
 *   5. opens a PR against awesome-dsh-plugin adding data/plugins/<owner>__<repo>.yml
 *
 * Step 5 is skipped unless the repo is at least a day old — the marketplace CI
 * rejects entries whose repository was created minutes before the PR.
 * Re-run the same command the next day to finish.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://api.github.com'
const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
const repoName = 'dsh-ssh-mac'
const sshUrl = `git@github.com:${process.argv[process.argv.indexOf('--owner') + 1] ?? 'skyzzq'}/${repoName}.git`

const dryRun = process.argv.includes('--dry-run')

if (dryRun) {
  const entry = join(root, 'docs', `awesome-entry-skyzzq__${repoName}.yml`)
  const tarball = join(root, 'release', 'dsh-ssh-mac.tgz')
  const lines = [
    `version       ${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`,
    `bundle patch  ${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dsh?.bundle?.patch ?? '(missing!)'}`,
    `entry file    ${existsSync(entry) ? entry : '(missing!)'}`,
    `tarball       ${existsSync(tarball) ? `${tarball} ${readFileSync(tarball).length} bytes` : '(missing — npm run pack:release --owner skyzzq)'}`,
    existsSync(join(root, '.git')) ? `branch        ${git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()}` : 'branch        (no .git)',
  ]
  if (existsSync(entry)) lines.push('', '--- entry payload ---', readFileSync(entry, 'utf8').trimEnd())
  console.log(lines.join(String.fromCharCode(10)))
  console.log(String.fromCharCode(10) + 'dry run: no network call, no push, no release, no PR.')
  process.exit(0)
}

if (!token) {
  // No API credential: push over SSH and leave the three web actions explicit.
  console.log('GH_TOKEN is not set — pushing over SSH and stopping before the API steps.')
  if (!existsSync(join(root, '.git'))) git(['init', '-b', 'main'])
  git(['add', '-A'])
  try {
    git(['commit', '-m', `dsh-ssh-mac ${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`])
  } catch {
    console.log('nothing new to commit')
  }
  git(['-c', 'credential.helper=', 'push', sshUrl, 'HEAD:refs/heads/main'], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  console.log(`pushed to ${sshUrl}

still manual (need a browser or a token):
  1. Settings -> topics: add \`dsh-plugin\`
  2. Releases -> draft v1.0.0, attach release/dsh-ssh-mac.tgz
  3. fork awesome-dsh-plugin, add data/plugins/<owner>__${repoName}.yml, open the PR`)
  process.exit(0)
}

let owner = process.argv[process.argv.indexOf('--owner') + 1]
if (process.argv.indexOf('--owner') === -1) {
  const me = await api('GET', '/user')
  owner = me.login
}

let manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

async function api(method, path, body) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-ssh-mac-publish',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok && res.status !== 404) {
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`)
  }
  return res.status === 404 ? undefined : text ? JSON.parse(text) : undefined
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

// 1. repository
let repo = await api('GET', `/repos/${owner}/${repoName}`)
if (!repo) {
  repo = await api('POST', '/user/repos', {
    name: repoName,
    description: manifest.description,
    homepage: `https://github.com/${owner}/${repoName}`,
    has_issues: true,
    has_wiki: false,
  })
  console.log(`created ${repo.html_url}`)
} else {
  console.log(`repo exists: ${repo.html_url}`)
}

// 2. push — the token goes on the command line only, never into .git/config
const tokenUrl = `https://x-access-token:${token}@github.com/${owner}/${repoName}.git`
if (!existsSync(join(root, '.git'))) {
  git(['init', '-b', 'main'])
}
git(['add', '-A'])
try {
  git(['commit', '-m', `dsh-ssh-mac ${manifest.version}`])
} catch {
  console.log('nothing new to commit')
}
git(['-c', 'credential.helper=', 'push', tokenUrl, 'HEAD:refs/heads/main'], {
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
})
console.log('pushed main')

// 3. topic
const topics = new Set(repo.topics ?? [])
topics.add('dsh-plugin')
await api('PUT', `/repos/${owner}/${repoName}/topics`, { names: [...topics] })
console.log('topic dsh-plugin set')

// 4. release + tarball
const tag = `v${manifest.version}`
const tarball = join(root, 'release', 'dsh-ssh-mac.tgz')
let release = await api('GET', `/repos/${owner}/${repoName}/releases/tags/${tag}`)
if (!release) {
  release = await api('POST', `/repos/${owner}/${repoName}/releases`, {
    tag_name: tag,
    name: tag,
    body: readFileSync(join(root, 'README.md'), 'utf8').split('\n').slice(0, 12).join('\n'),
  })
  console.log(`release ${tag} created`)
}
if (existsSync(tarball) && !(release.assets ?? []).some(asset => asset.name === 'dsh-ssh-mac.tgz')) {
  const upload = await fetch(`https://uploads.github.com/repos/${owner}/${repoName}/releases/${release.id}/assets?name=dsh-ssh-mac.tgz`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/gzip',
      'user-agent': 'dsh-ssh-mac-publish',
    },
    body: readFileSync(tarball),
  })
  console.log(upload.ok ? 'tarball uploaded' : `tarball upload failed: ${upload.status} ${await upload.text()}`)
}

// 5. marketplace PR — blocked until the repo is a day old
const ageMs = Date.now() - Date.parse(repo.created_at)
if (ageMs < 24 * 60 * 60 * 1000) {
  const hours = Math.ceil((24 * 60 * 60 * 1000 - ageMs) / 3_600_000)
  console.log(`repo is ${(ageMs / 3_600_000).toFixed(1)}h old; re-run in ~${hours}h to open the marketplace PR`)
  process.exit(0)
}

const entryPath = `data/plugins/${owner}__${repoName}.yml`
const entryFile = join(root, 'docs', `awesome-entry-${owner}__${repoName}.yml`)
if (!existsSync(entryFile)) {
  throw new Error(`missing ${entryFile} — run scripts/prepare-publish.mjs first`)
}

const fork = await api('POST', `/repos/${UPSTREAM}/forks`, { default_branch_only: true })
const login = (await api('GET', '/user')).login
const head = 'add-' + repoName
const mainRef = await api('GET', `/repos/${login}/awesome-dsh-plugin/git/ref/heads/main`)
await api('POST', `/repos/${login}/awesome-dsh-plugin/git/refs`, {
  ref: `refs/heads/${head}`,
  sha: mainRef.object.sha,
}).catch(() => console.log('branch already exists'))
await api('PUT', `/repos/${login}/awesome-dsh-plugin/contents/${entryPath}`, {
  message: `add ${owner}/${repoName}`,
  content: readFileSync(entryFile).toString('base64'),
  branch: head,
}).catch(error => {
  if (/(409|422)/.test(String(error))) return console.log('entry already on the branch')
  throw error
})
const existing = await api('GET', `/repos/${UPSTREAM}/pulls?head=${login}:${head}&state=all`)
if (Array.isArray(existing) && existing.length > 0) {
  console.log(`PR already open: ${existing[0].html_url}`)
  process.exit(0)
}
const pr = await api('POST', `/repos/${UPSTREAM}/pulls`, {
  title: `add ${owner}/${repoName}`,
  head: `${login}:${head}`,
  base: 'main',
  body: [
    `Adds ${owner}/${repoName} — ${manifest.description}.`,
    '',
    `- repo: https://github.com/${owner}/${repoName}`,
    `- category: remote (SSH host management)`,
    `- declares dsh.bundle in package.json, ships prebuilt lib/, tarball attached to ${tag}`,
  ].join('\n'),
})
console.log(`PR opened: ${pr.html_url} (fork ${fork.full_name})`)
