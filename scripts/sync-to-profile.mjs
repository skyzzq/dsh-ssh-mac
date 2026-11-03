// Mirror the built package into the desktop profile's node_modules.
//
// Deliberately copies only package.json, cordis.patch.yml and lib/: the
// profile must resolve ssh2 / ws / @deepseek-ai/* from the host, and copying
// this package's own node_modules would give those packages a second instance
// (two cordis Context objects, mismatched schemastery).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const target = 'C:/Users/zhaozhongqi/.dsh/profiles/desktop/node_modules/dsh-ssh-mac'

if (!existsSync(join(root, 'lib/index.js'))) {
  throw new Error('lib/index.js missing — run `npm run build` first')
}

mkdirSync(dirname(target), { recursive: true })
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

for (const file of ['package.json', 'cordis.patch.yml', 'README.md']) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(target, file))
}
cpSync(join(root, 'lib'), join(target, 'lib'), { recursive: true })
if (existsSync(join(root, 'locale'))) cpSync(join(root, 'locale'), join(target, 'locale'), { recursive: true })

console.log('synced ->', target)
