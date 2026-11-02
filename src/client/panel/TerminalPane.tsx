/**
 * One terminal pane: a single xterm.js view bound to one tab's host session.
 *
 * A pane owns exactly one tab for its whole life, which is what makes the
 * side-by-side layout cheap: no rebinding, no screen clearing between tabs,
 * and input always lands on the socket of the pane the user is typing in.
 * Session ownership stays on the Host: closing or unmounting a pane detaches
 * its socket (or adopts it while it connects) so the shell outlives the view.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SshApi, TerminalConnection } from '../api.ts'
import type { PanelController, TerminalTabRecord } from './controller.ts'
import { ensureXtermCss } from './xterm-runtime.ts'
import { copySelection, readClipboardText } from './clipboard.ts'
import { resolveTerminalFontFamily, tt, type TerminalFontSource } from './helpers.ts'
import css from './panel.module.css'

/** Props for one pane. */
export interface TerminalPaneProps {
  api: SshApi
  controller: PanelController
  /** The tab this pane shows; it never changes for the life of the pane. */
  tab: TerminalTabRecord
  /** Whether this pane currently owns the keyboard and the toolbar. */
  active: boolean
  /** Whether the pane may be taken out of the row (the last one may not). */
  canRemove: boolean
  /** Focus this pane's tab. */
  onFocus: (tabId: string) => void
  /** Take this tab out of the row, leaving its session alive. */
  onHide: (tabId: string) => void
  /** Close the tab behind this pane: the host session ends with it. */
  onClose: (tabId: string) => void
  /** Live terminal-font setting source. */
  terminalFont?: TerminalFontSource
}

/** No-op source stand-in so the hook order stays stable without the prop. */
const NO_FONT_SOURCE: TerminalFontSource = {
  get: () => undefined,
  subscribe: () => () => undefined,
}

/** The state word a pane's header shows, if any. */
function paneStateLabel(tab: TerminalTabRecord): string | undefined {
  return tabStateLabel(tab)
}

/** A terminal bound to one tab. */
export function TerminalPane({ api, controller, tab, active, canRemove, onFocus, onHide, onClose, terminalFont }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const linkRef = useRef<TerminalConnection | null>(null)
  const fontSource = terminalFont ?? NO_FONT_SOURCE
  const fontOverride = useSyncExternalStore(fontSource.subscribe, fontSource.get)
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>(undefined)
  const [toast, setToast] = useState<string | undefined>(undefined)
  const toastTimer = useRef<number | undefined>(undefined)

  /** Say something brief above the screen: copy and paste need an answer. */
  const flash = (text: string): void => {
    setToast(text)
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => {
      setToast(undefined)
      toastTimer.current = undefined
    }, 1400)
  }

  /** Copy this pane's selection to the local clipboard. */
  const doCopy = async (): Promise<void> => {
    const term = termRef.current
    if (term === null) return
    const length = await copySelection(term)
    flash(length === 0 ? tt('terminal.copyEmpty') : tt('terminal.copied').replace('{count}', String(length)))
  }

  /** Paste the local clipboard into this pane's remote shell. */
  const doPaste = async (): Promise<void> => {
    const term = termRef.current
    if (term === null) return
    const text = await readClipboardText()
    if (text === '') {
      flash(tt('terminal.pasteEmpty'))
      return
    }
    // term.paste keeps bracketed-paste framing, so multi-line text cannot
    // execute early in an editor or a sudo prompt.
    term.paste(text)
    term.focus()
    flash(tt('terminal.pasted').replace('{count}', String(text.length)))
  }

  useEffect(() => { ensureXtermCss() }, [])

  /** Build this pane's xterm instance once. */
  const ensureTerm = (): { term: Terminal; fit: FitAddon } | undefined => {
    const openTerm = termRef.current
    const openFit = fitRef.current
    if (openTerm !== null && openFit !== null) return { term: openTerm, fit: openFit }
    const container = containerRef.current
    if (container === null) return undefined
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: resolveTerminalFontFamily(fontOverride),
      theme: { background: '#0b0e14', foreground: '#d8dee9', cursor: '#a3b8d0' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    // Clipboard keys and Tab routing for this pane. Returning false stops
    // xterm from also forwarding the key, so a copy never types ^C into the
    // shell. Tab is deliberately left alone: bash, zsh and fish all do their
    // own path completion, and that needs the raw 0x09 byte.
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true
      const key = event.key.toLowerCase()
      if (event.ctrlKey && event.shiftKey && key === 'c') { void doCopy(); return false }
      if (event.ctrlKey && event.shiftKey && key === 'v') { void doPaste(); return false }
      if (event.ctrlKey && key === 'insert') { void doCopy(); return false }
      if (event.shiftKey && key === 'insert') { void doPaste(); return false }
      // Windows-terminal habit: Ctrl+V pastes, Ctrl+C only copies when there
      // is a selection and otherwise keeps sending SIGINT.
      if (event.ctrlKey && !event.shiftKey && !event.altKey && key === 'v') { void doPaste(); return false }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && key === 'c' && term.hasSelection()) {
        void doCopy()
        return false
      }
      return true
    })
    term.onData(data => { linkRef.current?.send(data) })
    termRef.current = term
    fitRef.current = fit
    return { term, fit }
  }

  /**
   * Drop the socket this pane holds. A tab that never reported its session id
   * cannot be detached by id, so the controller adopts it; everything else is
   * detached and left running on the host.
   * @param intent - close the session instead of detaching it.
   */
  const releaseLink = (intent: 'detach' | 'close' = 'detach'): void => {
    const connection = linkRef.current
    linkRef.current = null
    if (connection === null) return
    connection.onReady = undefined
    connection.onOutput = undefined
    connection.onExit = undefined
    connection.onAuthPrompt = undefined
    const current = controller.terminalTab(tab.id)
    if (current === undefined) {
      // The tab is gone: its session was ended over HTTP. A socket that never
      // reported an id is still adopted so a late ready frame closes it too
      // instead of leaving a host PTY without an owner.
      if (tab.status === 'connecting') controller.adoptTerminalLink(tab.id, connection, 'close')
      else connection.close()
      return
    }
    if (current.status === 'connecting' || intent === 'close') {
      controller.adoptTerminalLink(tab.id, connection, intent)
      return
    }
    connection.detach()
  }

  /** Route one connection's frames onto this pane's screen. */
  const bind = (connection: TerminalConnection, replay: string, term: Terminal): void => {
    linkRef.current = connection
    term.options.disableStdin = false
    if (replay !== '') term.write(replay)
    connection.onReady = sessionId => {
      controller.clearTerminalAuthPrompt(tab.id)
      controller.readyTerminalTab(tab.id, sessionId)
    }
    connection.onOutput = data => {
      term.write(data)
      controller.appendTerminalOutput(tab.id, data)
    }
    connection.onAuthPrompt = (name, instructions, prompts) => {
      controller.setTerminalAuthPrompt(tab.id, { name, instructions, prompts })
    }
    connection.onExit = (_code, error) => {
      const wasBound = linkRef.current === connection
      if (wasBound) linkRef.current = null
      connection.onReady = undefined
      connection.onOutput = undefined
      connection.onAuthPrompt = undefined
      connection.onExit = undefined
      term.options.disableStdin = true
      if (wasBound) controller.exitTerminalTab(tab.id, error)
    }
  }

  // Open or reattach this pane's session. Status changes re-run it; a socket
  // that is already bound is left alone so a reconnect never doubles a PTY.
  useEffect(() => {
    const view = ensureTerm()
    if (view === undefined) return
    if (linkRef.current !== null) return
    const adopted = controller.reclaimTerminalLink(tab.id)
    if (adopted !== undefined) {
      // The socket kept reporting while the tab was hidden; draw what it
      // retained before the live frames resume rather than showing a gap.
      bind(adopted, controller.readTerminalOutput(tab.id), view.term)
      return
    }
    if (tab.status === 'connecting') {
      view.term.reset()
      controller.clearTerminalOutput(tab.id)
      bind(api.openTerminal(tab.alias, view.term.cols, view.term.rows), '', view.term)
      return
    }
    if (tab.status === 'connected' && tab.sessionId !== undefined) {
      view.term.reset()
      controller.clearTerminalOutput(tab.id)
      bind(api.attachTerminal(tab.sessionId, view.term.cols, view.term.rows), '', view.term)
      return
    }
    // exited / error: keep the screen it last showed under the placeholder.
    view.term.options.disableStdin = true
    view.term.reset()
    view.term.write(controller.readTerminalOutput(tab.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.status, tab.sessionId, tab.alias])

  // Re-apply a live font change: xterm re-measures on the options write, and a
  // refit keeps cols/rows aligned plus tells the remote PTY the new size.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    const next = resolveTerminalFontFamily(fontOverride)
    if (term.options.fontFamily === next) return
    term.options.fontFamily = next
    fitRef.current?.fit()
    linkRef.current?.resize(term.cols, term.rows)
  }, [fontOverride])

  // Fit to the pane. A window resize is only one trigger: a pane entering or
  // leaving the row, the status banner, and panel resizes all change the box
  // without a window event, so the container itself is observed.
  useEffect(() => {
    let lastCols = -1
    let lastRows = -1
    const sync = (): void => {
      const term = termRef.current
      const fit = fitRef.current
      if (term === null || fit === null) return
      fit.fit()
      if (linkRef.current !== null && (term.cols !== lastCols || term.rows !== lastRows)) {
        lastCols = term.cols
        lastRows = term.rows
        linkRef.current.resize(term.cols, term.rows)
      }
    }
    const raf = typeof requestAnimationFrame === 'undefined' ? undefined : requestAnimationFrame(sync)
    window.addEventListener('resize', sync)
    const container = containerRef.current
    const observer = container !== null && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { sync() }) : undefined
    observer?.observe(container as Element)
    return () => {
      if (raf !== undefined && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf)
      observer?.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [])

  // Leaving the row or the panel detaches rather than kills: the host keeps
  // the shell, and re-adding the pane reattaches by session id.
  useEffect(() => () => {
    releaseLink()
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current)
  }, [])

  // Any click elsewhere, scroll or Escape dismisses the context menu.
  useEffect(() => {
    if (menu === undefined) return
    const close = (): void => { setMenu(undefined) }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', close)
    }
  }, [menu])

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  const label = paneStateLabel(tab)

  return (
    <section
      className={css.termPane}
      data-active={active || undefined}
      onMouseDown={() => { onFocus(tab.id) }}
      onContextMenu={event => {
        event.preventDefault()
        onFocus(tab.id)
        setMenu({ x: event.clientX, y: event.clientY })
      }}
      onKeyDownCapture={event => {
        // Focus drifted off the xterm textarea (pane chrome, auth form): send
        // the key to the shell instead of letting the browser move focus, so
        // Tab still completes a path wherever the caret looks like it is.
        if (event.key !== 'Tab') return
        const term = termRef.current
        if (term === null) return
        const target = event.target as HTMLElement | null
        if (target !== null && target.closest('.xterm') !== null) return
        // Buttons and form fields keep normal Tab order: only the bare pane
        // background hands the key to the shell.
        if (target !== null && target.closest('button, input, textarea, select, a') !== null) return
        event.preventDefault()
        event.stopPropagation()
        linkRef.current?.send(event.shiftKey ? '\u001b[Z' : '\t')
        term.focus()
      }}
    >
      <header className={css.termPaneHead}>
        <span className={css.termPaneAlias} title={tab.alias}>{tab.alias}</span>
        {label !== undefined && <span className={css.termTabState} data-state={tab.status}>{label}</span>}
        <span className={css.hostSpacer} />
        {active && <span className={css.termPaneFocus} aria-hidden="true" />}
        <button
          type="button"
          className={css.termPaneHide}
          disabled={!canRemove}
          aria-label={tt('terminal.hidePane')}
          title={canRemove ? tt('terminal.hidePane') : tt('terminal.lastPane')}
          onClick={event => {
            event.stopPropagation()
            onHide(tab.id)
          }}
        >
          <span aria-hidden="true">{'\u2013'}</span>
        </button>
        <button
          type="button"
          className={css.termPaneRemove}
          aria-label={tt('terminal.closeTab')}
          title={tt('terminal.closeTab')}
          onClick={event => {
            event.stopPropagation()
            onClose(tab.id)
          }}
        >
          <span aria-hidden="true">{'\u00d7'}</span>
        </button>
      </header>
      <div className={css.termPaneFill}>
        <div ref={containerRef} className={css.termPaneView} data-dsh-part="terminal" />
        {tab.authPrompt !== undefined && (
          // The challenge is answered on this pane's own socket, right where it
          // was asked: a prompt in a background pane must not answer through
          // the foreground one.
          <form
            className={css.paneAuth}
            onSubmit={event => {
              event.preventDefault()
              const connection = linkRef.current
              if (connection === null) return
              connection.sendAuthResponse(tab.authAnswers ?? [])
              controller.clearTerminalAuthPrompt(tab.id)
            }}
          >
            <span className={css.paneAuthTitle}>{tab.authPrompt.name || tt('terminal.auth.title')}</span>
            <span className={css.hint}>{tab.authPrompt.instructions || tt('terminal.auth.hint')}</span>
            {tab.authPrompt.prompts.map((prompt, index) => (
              <input
                key={index}
                autoFocus={index === 0}
                className={css.input}
                type={prompt.echo ? 'text' : 'password'}
                aria-label={prompt.prompt.trim() || tt('terminal.auth.title')}
                placeholder={prompt.prompt.trim() || tt('terminal.auth.placeholder')}
                value={tab.authAnswers?.[index] ?? ''}
                onChange={event => { controller.setTerminalAuthAnswer(tab.id, index, event.target.value) }}
              />
            ))}
            <div className={css.paneAuthActions}>
              <button type="button" className={css.ghostButton} onClick={() => { onClose(tab.id) }}>{tt('terminal.auth.cancel')}</button>
              <button type="submit" className={css.primaryButton}>{tt('terminal.auth.submit')}</button>
            </div>
          </form>
        )}
      </div>
      {toast !== undefined && <span className={css.paneToast}>{toast}</span>}
      {menu !== undefined && (
        <div
          className={css.paneMenu}
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onMouseDown={event => { event.stopPropagation() }}
        >
          <button
            type="button"
            role="menuitem"
            className={css.paneMenuItem}
            disabled={termRef.current?.hasSelection() !== true}
            onClick={() => { setMenu(undefined); void doCopy() }}
          >
            {tt('terminal.menu.copy')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.paneMenuItem}
            onClick={() => { setMenu(undefined); void doPaste() }}
          >
            {tt('terminal.menu.paste')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.paneMenuItem}
            onClick={() => { setMenu(undefined); termRef.current?.selectAll() }}
          >
            {tt('terminal.menu.selectAll')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.paneMenuItem}
            onClick={() => { setMenu(undefined); termRef.current?.clear(); termRef.current?.focus() }}
          >
            {tt('terminal.menu.clear')}
          </button>
        </div>
      )}
    </section>
  )
}

/** The state word a tab shows in the strip, or undefined when it is simply up. */
export function tabStateLabel(tab: TerminalTabRecord): string | undefined {
  if (tab.authPrompt !== undefined) return tt('terminal.authPending')
  if (tab.status === 'connecting') return tt('terminal.connecting')
  if (tab.status === 'exited') return tt('terminal.tabExited')
  if (tab.closeError !== undefined) return tt('terminal.tabError')
  if (tab.status === 'error') return tt('terminal.tabError')
  return undefined
}

