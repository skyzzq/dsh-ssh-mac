/**
 * Terminal tab: a row of xterm panes over the host's WebSocket terminal route,
 * with a tab strip over host-side PTY sessions.
 *
 * Session ownership stays on the Host (`src/engine/terminal-sessions.ts`): a
 * pane that goes away detaches its socket, and the host keeps the shell plus a
 * bounded scrollback that a reattach replays. That is what lets the strip hold
 * many tabs while the view shows only the panes the user put there: every tab's
 * alias, host session id, status and pending challenge lives in the panel
 * controller, because the layout unmounts this page whenever another panel is
 * selected.
 *
 * The row is explicit, not implied: a tab joins the row when it is opened or
 * selected, and a connected tab that is not shown can be added by hand with
 * the split control on its strip entry. The last pane cannot be removed, so the
 * view always has somewhere to put output.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SshApi } from '../api.ts'
import type { SshHostSummary } from '../../protocol.ts'
import { MAX_PANES, type PanelController } from './controller.ts'
import { TerminalPane, tabStateLabel } from './TerminalPane.tsx'
import { errorMessage, tt, type TerminalFontSource } from './helpers.ts'
import css from './panel.module.css'

/** Terminal tab props. */
export interface TerminalTabProps {
  api: SshApi
  /** The panel controller that owns the tabs and their host session ids. */
  controller: PanelController
  /** Alias preselected by a "connect" action from the hosts tab. */
  presetAlias?: string
  /**
   * Live terminal-font setting source (issue #577). Absent in tests and
   * legacy mounts: the font then comes from the CSS custom-property chain.
   */
  terminalFont?: TerminalFontSource
}

/** The terminal view with its tab strip and pane row. */
export function TerminalTab({ api, controller, presetAlias, terminalFont }: TerminalTabProps) {
  const { terminalTabs, activeTerminalTabId, draftAlias, panes } = useSyncExternalStore(
    useCallback(listener => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
  )
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [listError, setListError] = useState<string | undefined>(undefined)
  /** Tabs with a background close in flight, so one click cannot open two. */
  const closingRef = useRef<Set<string>>(new Set())
  const activeTab = terminalTabs.find(tab => tab.id === activeTerminalTabId)

  // Fetch the host list on tab activation.
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const list = await api.listHosts()
        if (!disposed) setHosts(list)
      } catch (cause) {
        if (!disposed) setListError(errorMessage(cause))
      }
    })()
    return () => { disposed = true }
  }, [api])

  // A hosts-tab connect action preselects its alias in the toolbar.
  useEffect(() => {
    if (presetAlias === undefined || presetAlias === '') return
    controller.setDraftAlias(presetAlias)
  }, [presetAlias, controller])

  /** Open a tab on the toolbar's host (the "+"/Connect control). */
  const connect = (): void => {
    const target = draftAlias
    if (target === '') return
    controller.openTerminalTab(target)
  }

  /**
   * Close one tab. A session that exists is ended over one short-lived attach,
   * so this works for a tab shown in a pane and for one that is not; a close
   * that cannot be delivered keeps the tab instead of pretending it is gone.
   * @param tabId - the tab to close.
   */
  /**
   * End the pooled connection for a server once its last terminal window is
   * gone: closing a window must not leave a shell sitting on the remote side.
   * @param alias - the server the closed tab was connected to.
   */
  const dropAliasIfLast = (alias: string): void => {
    const stillOpen = controller.getSnapshot().terminalTabs.some(tab => tab.alias === alias)
    if (stillOpen) return
    void api.disconnectHost(alias).catch(() => undefined)
  }

  const closeTab = (tabId: string): void => {
    const tab = controller.terminalTab(tabId)
    if (tab === undefined) return
    if (tab.status === 'connected' && tab.sessionId !== undefined) {
      // One attempt at a time: a second click while the attach is in flight
      // would open another socket for the same session and could report the
      // later outcome over the earlier one.
      if (closingRef.current.has(tabId)) return
      closingRef.current.add(tabId)
      const sessionId = tab.sessionId
      void (async () => {
        try {
          const gone = await api.closeTerminalSession(sessionId)
          if (gone) {
            controller.closeTerminalTab(tabId)
            dropAliasIfLast(tab.alias)
            return
          }
          // Not delivered: the session may still be running, so the tab stays
          // with its session id. Recovery is the same control (retry).
          controller.markTerminalCloseFailed(tabId, 'undelivered')
        } finally {
          closingRef.current.delete(tabId)
        }
      })()
      return
    }
    // connecting / exited / error: nothing to end over HTTP. A connecting pane
    // hands its socket to the controller on unmount, which closes the session
    // the moment the host reports it — no PTY is left without an owner.
    controller.closeTerminalTab(tabId)
    dropAliasIfLast(tab.alias)
  }

  const paneTabs = panes.flatMap(id => {
    const tab = controller.terminalTab(id)
    return tab === undefined ? [] : [tab]
  })
  const atCapacity = panes.length >= MAX_PANES
  const stateLabel = activeTab === undefined ? undefined : tabStateLabel(activeTab)

  // One line of connection state for the right edge of the command row. The
  // banners below are reserved for failures that need a line of their own.
  const connection = ((): { kind: string; text: string } | undefined => {
    if (activeTab === undefined) return undefined
    if (activeTab.status === 'connecting') return { kind: 'info', text: tt('terminal.connecting') }
    if (activeTab.status === 'connected' && stateLabel === undefined) return { kind: 'ok', text: tt('terminal.ready', { alias: activeTab.alias }) }
    if (activeTab.status === 'exited') return { kind: 'info', text: tt('terminal.exited', { alias: activeTab.alias }) + (activeTab.detail !== undefined ? ' (' + activeTab.detail + ')' : '') }
    if (activeTab.status === 'error') return { kind: 'error', text: tt('terminal.error', { error: activeTab.detail ?? '' }) }
    return undefined
  })()

  return (
    <div className={css.termBody}>
      <div className={css.termTabs} role="tablist" aria-label={tt('terminal.tabs')} data-dsh-part="tab-bar" data-empty={terminalTabs.length === 0 ? '' : undefined}>
          {terminalTabs.map(tab => {
            const label = tabStateLabel(tab)
            const shown = panes.includes(tab.id)
            return (
              <div key={tab.id} className={css.termTab} data-active={tab.id === activeTab?.id ? '' : undefined} data-shown={shown || undefined}>
                <button
                  type="button"
                  role="tab"
                  className={css.termTabLabel}
                  aria-selected={tab.id === activeTab?.id}
                  data-dsh-part="tab"
                  title={tab.alias}
                  onClick={() => { controller.setActiveTerminalTab(tab.id) }}
                >
                  <span className={css.termTabAlias}>{tab.alias}</span>
                  {label !== undefined && <span className={css.termTabState} data-state={tab.status}>{label}</span>}
                </button>
                <button
                  type="button"
                  className={css.termTabClose}
                  aria-label={tt('terminal.closeTab')}
                  title={tt('terminal.closeTab')}
                  onClick={() => { closeTab(tab.id) }}
                >
                  <span aria-hidden="true">{'\u00d7'}</span>
                </button>
              </div>
            )
          })}
        </div>
      <div className={css.controls}>
        <select className={css.input} value={draftAlias} onChange={event => { controller.setDraftAlias(event.target.value) }}>
          <option value="">{tt('terminal.selectHost')}</option>
          {hosts.map(host => <option key={host.alias} value={host.alias}>{host.alias} ({host.host})</option>)}
        </select>
        <button type="button" className={css.primaryButton} disabled={draftAlias === ''} onClick={connect}>{tt('terminal.connect')}</button>
        <button type="button" className={css.ghostButton} disabled={activeTab === undefined} onClick={() => { if (activeTab !== undefined) closeTab(activeTab.id) }}>{tt('terminal.disconnect')}</button>
        <span className={css.toolbarSpacer} />
        {connection !== undefined && (
          <span className={css.connStatus} data-kind={connection.kind} title={connection.text}>{connection.text}</span>
        )}
      </div>
      {activeTab?.closeError !== undefined && <div className={css.banner} data-kind="error">{tt('terminal.closeFailed')}</div>}
      {listError !== undefined && <div className={css.banner} data-kind="error">{tt('terminal.error', { error: listError })}</div>}
      <div className={css.termWrap}>
        {paneTabs.length > 0 && (
          <div className={css.termPanes} data-count={paneTabs.length}>
            {paneTabs.map(tab => (
              <TerminalPane
                key={tab.id}
                api={api}
                controller={controller}
                tab={tab}
                active={tab.id === activeTerminalTabId}
                canRemove={paneTabs.length > 1}
                onFocus={id => { controller.setActiveTerminalTab(id) }}
                onHide={id => { controller.hideTerminalPane(id) }}
                onClose={id => { closeTab(id) }}
                terminalFont={terminalFont}
              />
            ))}
          </div>
        )}
        {paneTabs.length === 0 && (
          <div className={css.termPlaceholder}>{hosts.length === 0 ? tt('hosts.empty') : tt('terminal.placeholder')}</div>
        )}
      </div>
    </div>
  )
}
