/**
 * Browser-half build: bundles src/client into the client-module envelope the
 * dsh web shell expects (`window.__ModuleLoader__.load({ id, factory })`).
 *
 * Two things a generic bundler does not give us for free:
 *   - CSS modules. esbuild has no notion of them, so this onLoad plugin scopes
 *     the class selectors and routes the sheet text through the plugin's own
 *     style channel (src/client/style-runtime.ts) instead of emitting a file
 *     the loader would have to fetch separately.
 *   - The envelope. The factory must be lazy and must register under the
 *     package name: the web client keys its module table by that id and fails
 *     the row when a bundle registers nothing.
 *
 * React and react/jsx-runtime stay external — the browser module table already
 * holds them, and a second copy would break hooks.
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const packageName = packageJson.name
const entry = path.join(root, 'src/client/index.ts')
const outfile = path.join(root, 'lib/client.js')
const runtimePath = JSON.stringify(path.join(root, 'src/client/style-runtime.ts'))

/** Class-name prefix: short, stable, identical in dev and release. */
const CLASS_PREFIX = 'sshx'

/** Scope every class selector in a module sheet and return the name table. */
function scopeCss(source) {
  const table = new Map()
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const css = body.replace(/(?<![\w-])\.([A-Za-z_][A-Za-z0-9_-]*)/g, (_match, name) => {
    const scoped = CLASS_PREFIX + '_' + name
    table.set(name, scoped)
    return '.' + scoped
  })
  return { css, table }
}

/** Load a stylesheet: module sheets also export their scoped class table. */
const cssModules = {
  name: 'css-modules',
  setup(pluginBuild) {
    // esbuild filters are Go regexes (no lookbehind), so one filter branches here.
    pluginBuild.onLoad({ filter: /\.css$/ }, async args => {
      const source = await readFile(args.path, 'utf8')
      const resolveDir = path.dirname(args.path)
      const header = 'import { pushStyle } from ' + runtimePath + ';'
      if (!args.path.endsWith('.module.css')) {
        return {
          contents: header + '\npushStyle(' + JSON.stringify(source) + ');',
          resolveDir,
          loader: 'js',
        }
      }
      const { css, table } = scopeCss(source)
      const contents = [
        header,
        'pushStyle(' + JSON.stringify(css) + ');',
        'export default ' + JSON.stringify(Object.fromEntries(table)) + ';',
      ].join('\n')
      return { contents, resolveDir, loader: 'js' }
    })
  },
}

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  plugins: [cssModules],
  define: { 'process.env.NODE_ENV': '"production"' },
})

// write:false without an outdir labels the single chunk '<stdout>'.
const code = result.outputFiles[0]?.text ?? ''
if (code === '') throw new Error('esbuild produced no JavaScript output')

const envelope = [
  'window.__ModuleLoader__.load({',
  '\tid: ' + JSON.stringify(packageName) + ',',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  indent(code, 4),
  '\t\treturn module.exports;',
  '\t},',
  '});',
  '',
].join('\n')

mkdirSync(path.dirname(outfile), { recursive: true })
writeFileSync(outfile, envelope)
console.log('client bundle -> lib/client.js (' + (envelope.length / 1024).toFixed(1) + ' kB)')

function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map(line => (line.trim() === '' ? '' : pad + line))
    .join('\n')
}
