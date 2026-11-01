import { readFileSync, writeFileSync } from 'node:fs'

const OLD = '@local/dsh-ssh-mac'
const NEW = 'dsh-ssh-mac'

const files = [
  'package.json',
  'package-lock.json',
  'cordis.patch.yml',
  'src/index.ts',
  'src/client/index.ts',
  'scripts/sync-to-profile.mjs',
]

for (const file of files) {
  const before = readFileSync(file, 'utf8')
  const after = before.split(OLD).join(NEW)
  if (after !== before) {
    writeFileSync(file, after)
    console.log(`renamed in ${file}`)
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
pkg.version = '1.0.0'
pkg.description = 'MAC-first SSH plugin for DeepSeek Harness: resolves a host by NIC address before dialing'
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
console.log('package', pkg.name, pkg.version)
