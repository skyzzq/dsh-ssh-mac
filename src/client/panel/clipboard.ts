/**
 * Clipboard bridge between the browser and the remote shell.
 *
 * The panel runs on the loopback origin the harness prints, which browsers
 * treat as a secure context, so `navigator.clipboard` is normally available.
 * When it is not (older engine, permission denied, focus lost), both
 * directions fall back to the selection/execCommand pair so copy and paste
 * still work rather than failing silently.
 */

/**
 * Read plain text from the system clipboard.
 *
 * Resolves to the text, to `''` when the clipboard really is empty, and to
 * `undefined` when the browser refused to hand it over (no clipboard-read
 * permission, document not focused). Callers can then tell "nothing to paste"
 * apart from "paste is blocked here" instead of blaming an empty clipboard.
 */
export async function readClipboardText(): Promise<string | undefined> {
  const clipboard = navigator.clipboard
  if (clipboard !== undefined && typeof clipboard.readText === 'function') {
    try {
      return await clipboard.readText()
    } catch {
      // Permission or focus refused it; try the execCommand bridge below.
    }
  }
  return readViaExecCommand()
}

/** Legacy clipboard read: a focused textarea plus `document.execCommand('paste')`. */
function readViaExecCommand(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const area = document.createElement('textarea')
  area.setAttribute('readonly', 'true')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.focus()
  area.select()
  let text: string | undefined
  try {
    text = document.execCommand('paste') ? area.value : undefined
  } catch {
    text = undefined
  }
  area.remove()
  return text
}

/** Write plain text to the system clipboard, returning whether it landed. */
export async function writeClipboardText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard
  if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the textarea trick.
    }
  }
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', 'true')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

/**
 * Copy the terminal's current selection. Returns the copied length, or 0 when
 * nothing was selected.
 */
export async function copySelection(term: { getSelection(): string }): Promise<number> {
  const text = term.getSelection()
  if (text === '') return 0
  const ok = await writeClipboardText(text)
  return ok ? text.length : 0
}
