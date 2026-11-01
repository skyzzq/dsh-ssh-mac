import { defineConfig } from 'tsdown'

/**
 * Host half only. The browser half is the upstream-built lib/client.js kept
 * verbatim (id patched to our package name): rebuilding it would need the
 * React/xterm/css-modules toolchain and the __ModuleLoader__ plugin that the
 * host checkout does not ship, while the host half is a plain transpile.
 *
 * `clean: false` is deliberate — `tsdown` must not delete lib/client.js.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: false,
  sourcemap: true,
  // The package is `type: module`, so the host loads lib/index.js; tsdown would
  // otherwise emit index.mjs.
  outExtensions: () => ({ js: '.js' }),
  // Everything the host provides at runtime stays a bare import: node builtins,
  // the ssh/ws transports, and the @deepseek-ai platform packages (dsh-tools,
  // schemastery, dsh-llm types).
  external: [/^node:/, 'ssh2', 'ws', /^@deepseek-ai\//],
})
