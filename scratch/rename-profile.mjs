import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const profile = 'C:/Users/zhaozhongqi/.dsh/profiles/desktop'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

// package.json: swap the dependency key and the bundle entry.
const pkgPath = `${profile}/package.json`
copyFileSync(pkgPath, `${pkgPath}.bak-${stamp}`)
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const deps = pkg.dependencies ?? {}
if (deps['@local/dsh-ssh-mac'] !== undefined) {
  deps['dsh-ssh-mac'] = deps['@local/dsh-ssh-mac']
  delete deps['@local/dsh-ssh-mac']
  pkg.dependencies = deps
}
const bundles = pkg.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  const at = bundles.indexOf('@local/dsh-ssh-mac')
  if (at >= 0) bundles[at] = 'dsh-ssh-mac'
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

// cordis.patch.yml: pin the row to the renamed package.
const patchPath = `${profile}/cordis.patch.yml`
copyFileSync(patchPath, `${patchPath}.bak-${stamp}`)
const patch = readFileSync(patchPath, 'utf8')
const next = patch.replace(
  /- id: ssh-mac\n(\s*)disabled: false/,
  '- id: ssh-mac\n$1name: dsh-ssh-mac\n$1disabled: false',
)
writeFileSync(patchPath, next)

console.log('deps key:', Object.keys(pkg.dependencies).filter(k => k.includes('ssh')))
console.log('bundle entry:', bundles.filter(b => b.includes('ssh')))
console.log('patch row:', /- id: ssh-mac\n\s+name: dsh-ssh-mac/.test(next))
