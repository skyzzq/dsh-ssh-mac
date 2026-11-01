/**
 * Style channel for the browser half.
 *
 * The CSS-module loader hands every `*.module.css` file to `pushStyle` at
 * module evaluation time, which is deliberately side-effect free: the factory
 * runs during client-module loading, and a plugin must not touch the document
 * before its `apply` runs. `installStyles` is what actually mounts the sheet,
 * called from `apply` inside `ctx.effect` so unmounting removes it again.
 */

/** Collected CSS, in module evaluation order. */
const queued: string[] = []

/** Queue one stylesheet's text. Safe to call before `apply`. */
export function pushStyle(css: string): void {
  queued.push(css)
}

/**
 * Mount the queued CSS as one scoped <style> element.
 * @returns the disposer that removes the element again.
 */
export function installStyles(): () => void {
  if (queued.length === 0) return () => {}
  const tag = document.createElement('style')
  tag.setAttribute('data-dsh-plugin', 'dsh-ssh-mac')
  tag.textContent = queued.join('\n')
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}
