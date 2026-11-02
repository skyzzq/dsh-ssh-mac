/**
 * One-time xterm stylesheet injection, shared by every terminal pane.
 *
 * The panel can hold several terminals at once, so this lives outside any
 * component: the first pane to mount injects the tag, the rest reuse it.
 */
import { XTERM_CSS } from './xterm.css.ts'

let injected = false

/** Inject xterm's stylesheet once per page load. */
export function ensureXtermCss(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  if (document.querySelector('style[data-dsh-ssh-xterm]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshSshXterm = ''
  style.textContent = XTERM_CSS
  document.head.appendChild(style)
}
