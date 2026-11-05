/**
 * SshFloatingWindow: Floating window container for the entire SSH panel.
 *
 * Implements a resizable, draggable floating window that hovers over the DSH
 * application views.
 *
 * Requirements:
 * - Resizable ("浮窗应可调节大小") in all 8 directions with min bounds and resize grip.
 * - Draggable titlebar, clamped within viewport bounds.
 * - Defaults to pinned over the DSH app ("默认常浮于dsh应用上").
 * - Follows DSH minimize and close ("跟随dsh缩小关闭") by living in DSH's DOM.
 * - When switched to "不常浮" (unpinned): clicking DSH's main interface hides the window
 *   underneath DSH; clicking the left sidebar SSH icon summons it back out.
 * - Supports collapse/minimize to titlebar, dock back to center column, and close.
 * - Preserves window position and dimensions across browser sessions via localStorage.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { SshApi } from '../api.ts'
import { SSH_PANEL_ID, type PanelController } from './controller.ts'
import { tt, type TerminalFontSource } from './helpers.ts'
import { RhineMark } from './rhine.tsx'
import { SshPanel } from './SshPanel.tsx'
import css from './panel.module.css'

export interface SshFloatingWindowProps {
  controller: PanelController
  api: SshApi
  terminalFont?: TerminalFontSource
}

interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

const STORAGE_KEY = 'dsh-ssh:floating-rect'
const PINNED_STORAGE_KEY = 'dsh-ssh:floating-pinned'
const MIN_WIDTH = 440
const MIN_HEIGHT = 280

/** Clamp rectangle so it stays visible and within viewport boundaries. */
function clampBounds(rect: WindowRect): WindowRect {
  const vpWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vpHeight = typeof window !== 'undefined' ? window.innerHeight : 800

  const width = Math.max(MIN_WIDTH, Math.min(rect.width, vpWidth - 20))
  const height = Math.max(MIN_HEIGHT, Math.min(rect.height, vpHeight - 20))
  const x = Math.max(0, Math.min(rect.x, vpWidth - 100))
  const y = Math.max(0, Math.min(rect.y, vpHeight - 40))

  return { x, y, width, height }
}

/** Get initial window geometry from storage or calculate sensible defaults. */
function getInitialBounds(): WindowRect {
  const vpWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vpHeight = typeof window !== 'undefined' ? window.innerHeight : 800

  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<WindowRect>
      if (
        typeof parsed.x === 'number' &&
        typeof parsed.y === 'number' &&
        typeof parsed.width === 'number' &&
        typeof parsed.height === 'number'
      ) {
        return clampBounds(parsed as WindowRect)
      }
    }
  } catch {
    // Ignore storage parse error
  }

  const defaultWidth = Math.min(840, Math.max(520, Math.floor(vpWidth * 0.65)))
  const defaultHeight = Math.min(560, Math.max(380, Math.floor(vpHeight * 0.65)))
  const defaultX = Math.max(20, vpWidth - defaultWidth - 32)
  const defaultY = Math.max(30, Math.floor((vpHeight - defaultHeight) / 2))

  return { x: defaultX, y: defaultY, width: defaultWidth, height: defaultHeight }
}

type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

export function SshFloatingWindow({ controller, api, terminalFont }: SshFloatingWindowProps) {
  const snapshot = useSyncExternalStore(
    useCallback(listener => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
  )

  const [rect, setRect] = useState<WindowRect>(getInitialBounds)
  const [isInteracting, setIsInteracting] = useState(false)
  const [flashFocus, setFlashFocus] = useState(false)
  const rectRef = useRef(rect)
  rectRef.current = rect
  const windowRef = useRef<HTMLDivElement | null>(null)

  const lastFocusTickRef = useRef(controller.getFocusTick())

  // Initialize pinned state from localStorage on mount.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PINNED_STORAGE_KEY)
      if (saved !== null) {
        controller.setPinned(saved === 'true')
      }
    } catch {
      // Storage unavailable
    }
  }, [controller])

  // Save pinned preference on change.
  useEffect(() => {
    try {
      localStorage.setItem(PINNED_STORAGE_KEY, String(snapshot.isPinned))
    } catch {
      // Storage unavailable
    }
  }, [snapshot.isPinned])

  // Focus effect: brief flash when requested from main view or sidebar summon.
  useEffect(() => {
    const tick = controller.getFocusTick()
    if (tick !== lastFocusTickRef.current) {
      lastFocusTickRef.current = tick
      setFlashFocus(true)
      const timer = window.setTimeout(() => setFlashFocus(false), 900)
      return () => window.clearTimeout(timer)
    }
  }, [snapshot, controller])

  // "不常浮" mode: when user clicks DSH's main interface outside the floating window,
  // hide the floating window under DSH until summoned again.
  useEffect(() => {
    if (!snapshot.isFloating || snapshot.isPinned || snapshot.isFloatHidden) return

    const handleDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target === null) return

      // Clicks inside the floating window stay in focus
      if (windowRef.current?.contains(target)) return

      // Clicks on the sidebar SSH panel entry summon/focus instead of hiding
      if (target.closest(`[data-dsh-panel-entry="${SSH_PANEL_ID}"]`)) return

      // Clicked on DSH main interface: hide under DSH!
      controller.hideFloatUnderDsh()
    }

    // Capture phase so we catch clicks before any stopPropagation in DSH
    document.addEventListener('mousedown', handleDocMouseDown, true)
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown, true)
    }
  }, [snapshot.isFloating, snapshot.isPinned, snapshot.isFloatHidden, controller])

  // Save bounds to localStorage on change.
  const saveBounds = useCallback((next: WindowRect) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Storage unavailable
    }
  }, [])

  // Start dragging by the header.
  const startDrag = useCallback((e: React.MouseEvent) => {
    // Ignore if clicked on a button or interactive child.
    const target = e.target as HTMLElement | null
    if (target?.closest('button') || target?.closest('[role="button"]')) return

    e.preventDefault()
    setIsInteracting(true)

    const startMouseX = e.clientX
    const startMouseY = e.clientY
    const startX = rectRef.current.x
    const startY = rectRef.current.y

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startMouseX
      const deltaY = moveEvent.clientY - startMouseY
      const vpWidth = window.innerWidth
      const vpHeight = window.innerHeight

      const nextX = Math.max(0, Math.min(startX + deltaX, vpWidth - 100))
      const nextY = Math.max(0, Math.min(startY + deltaY, vpHeight - 38))

      const updated = { ...rectRef.current, x: nextX, y: nextY }
      setRect(updated)
    }

    const onMouseUp = () => {
      setIsInteracting(false)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      saveBounds(rectRef.current)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [saveBounds])

  // Start resizing from one of the handles.
  const startResize = useCallback((e: React.MouseEvent, dir: ResizeDirection) => {
    e.preventDefault()
    e.stopPropagation()
    setIsInteracting(true)

    const startMouseX = e.clientX
    const startMouseY = e.clientY
    const startRect = { ...rectRef.current }

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startMouseX
      const deltaY = moveEvent.clientY - startMouseY
      const vpWidth = window.innerWidth
      const vpHeight = window.innerHeight

      let nextX = startRect.x
      let nextY = startRect.y
      let nextWidth = startRect.width
      let nextHeight = startRect.height

      if (dir.includes('e')) {
        nextWidth = Math.max(MIN_WIDTH, Math.min(startRect.width + deltaX, vpWidth - nextX - 12))
      }
      if (dir.includes('s')) {
        nextHeight = Math.max(MIN_HEIGHT, Math.min(startRect.height + deltaY, vpHeight - nextY - 12))
      }
      if (dir.includes('w')) {
        const potentialWidth = startRect.width - deltaX
        if (potentialWidth >= MIN_WIDTH) {
          nextX = Math.max(0, startRect.x + deltaX)
          nextWidth = startRect.width + (startRect.x - nextX)
        } else {
          nextWidth = MIN_WIDTH
          nextX = startRect.x + (startRect.width - MIN_WIDTH)
        }
      }
      if (dir.includes('n')) {
        const potentialHeight = startRect.height - deltaY
        if (potentialHeight >= MIN_HEIGHT) {
          nextY = Math.max(0, startRect.y + deltaY)
          nextHeight = startRect.height + (startRect.y - nextY)
        } else {
          nextHeight = MIN_HEIGHT
          nextY = startRect.y + (startRect.height - MIN_HEIGHT)
        }
      }

      const updated = { x: nextX, y: nextY, width: nextWidth, height: nextHeight }
      setRect(updated)
    }

    const onMouseUp = () => {
      setIsInteracting(false)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      saveBounds(rectRef.current)
      window.dispatchEvent(new Event('resize'))
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [saveBounds])

  // Keep inside viewport on window resize.
  useEffect(() => {
    const handleWindowResize = () => {
      setRect(prev => clampBounds(prev))
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [])

  if (!snapshot.isFloating) return null

  const isMinimized = snapshot.isMinimized
  const isHidden = snapshot.isFloatHidden
  const windowStyle: React.CSSProperties = {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: isMinimized ? '38px' : `${rect.height}px`,
    zIndex: snapshot.isPinned ? 1100 : 900,
    visibility: isHidden ? 'hidden' : 'visible',
    opacity: isHidden ? 0 : 1,
    pointerEvents: isHidden ? 'none' : 'auto',
  }

  const content = (
    <div
      ref={windowRef}
      className={`${css.floatingWindow} ${flashFocus ? css.floatingFlash : ''}`}
      style={windowStyle}
      data-floating-window=""
      data-minimized={isMinimized ? '' : undefined}
      data-interacting={isInteracting ? '' : undefined}
      data-hidden-under={isHidden ? '' : undefined}
      aria-hidden={isHidden ? 'true' : undefined}
    >
      {/* Title bar / drag handle */}
      <div className={css.floatingHeader} onMouseDown={startDrag}>
        <div className={css.floatingTitle}>
          <span className={css.panelMark} aria-hidden="true">
            <RhineMark size={14} />
          </span>
          <span className={css.floatingTitleText}>{tt('panel.title')}</span>
          <span className={css.floatBadge}>{tt('float.badge')}</span>
        </div>

        <div className={css.floatingControls}>
          {/* Always on top / pin toggle ("常浮于应用上") */}
          <button
            type="button"
            className={`${css.floatingControlBtn} ${snapshot.isPinned ? css.floatingControlBtnActive : ''}`}
            title={snapshot.isPinned ? tt('float.unpin') : tt('float.pin')}
            aria-label={snapshot.isPinned ? tt('float.unpin') : tt('float.pin')}
            onClick={() => controller.togglePinned()}
          >
            {snapshot.isPinned ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.988-1.666.541-.447-.447.346-1.47.54-1.666l3.183-3.182-2.829-2.828a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.109-1.022.589-1.503a.5.5 0 0 1 .353-.146z" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.988-1.666.541-.447-.447.346-1.47.54-1.666l3.183-3.182-2.829-2.828a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.109-1.022.589-1.503a.5.5 0 0 1 .353-.146z" />
                <line x1="2" y1="14" x2="14" y2="2" strokeWidth="1.7" stroke="currentColor" />
              </svg>
            )}
          </button>

          {/* Minimize / Fold button */}
          <button
            type="button"
            className={css.floatingControlBtn}
            title={isMinimized ? tt('float.expand') : tt('float.minimize')}
            aria-label={isMinimized ? tt('float.expand') : tt('float.minimize')}
            onClick={() => controller.toggleMinimized()}
          >
            {isMinimized ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M3 8h10" />
              </svg>
            )}
          </button>

          {/* Dock back to main panel */}
          <button
            type="button"
            className={css.floatingControlBtn}
            title={tt('float.dock')}
            aria-label={tt('float.dock')}
            onClick={() => controller.dock()}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <rect x="2" y="2" width="12" height="12" rx="1.5" />
              <path d="M10 6l-4 4m0 0h3.5m-3.5 0v-3.5" />
            </svg>
          </button>

          {/* Close float */}
          <button
            type="button"
            className={`${css.floatingControlBtn} ${css.floatingCloseBtn}`}
            title={tt('float.close')}
            aria-label={tt('float.close')}
            onClick={() => controller.closeFloat()}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>

      {/* Main panel body (hidden when folded/minimized) */}
      {!isMinimized && (
        <div className={css.floatingBody}>
          <SshPanel controller={controller} api={api} terminalFont={terminalFont} isFloating={true} />
        </div>
      )}

      {/* Resize handles in 8 directions (only when not minimized) */}
      {!isMinimized && (
        <>
          <div className={`${css.resizeHandle} ${css.resizeTop}`} onMouseDown={e => startResize(e, 'n')} />
          <div className={`${css.resizeHandle} ${css.resizeBottom}`} onMouseDown={e => startResize(e, 's')} />
          <div className={`${css.resizeHandle} ${css.resizeLeft}`} onMouseDown={e => startResize(e, 'w')} />
          <div className={`${css.resizeHandle} ${css.resizeRight}`} onMouseDown={e => startResize(e, 'e')} />
          <div className={`${css.resizeHandle} ${css.resizeTopLeft}`} onMouseDown={e => startResize(e, 'nw')} />
          <div className={`${css.resizeHandle} ${css.resizeTopRight}`} onMouseDown={e => startResize(e, 'ne')} />
          <div className={`${css.resizeHandle} ${css.resizeBottomLeft}`} onMouseDown={e => startResize(e, 'sw')} />
          <div
            className={`${css.resizeHandle} ${css.resizeBottomRight} ${css.resizeGrip}`}
            onMouseDown={e => startResize(e, 'se')}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" className={css.gripIcon} aria-hidden="true">
              <circle cx="7" cy="1" r="0.9" />
              <circle cx="7" cy="4" r="0.9" />
              <circle cx="7" cy="7" r="0.9" />
              <circle cx="4" cy="4" r="0.9" />
              <circle cx="4" cy="7" r="0.9" />
              <circle cx="1" cy="7" r="0.9" />
            </svg>
          </div>
        </>
      )}

      {/* Transparent overlay during drag/resize so mouse doesn't get trapped by xterm */}
      {isInteracting && <div className={css.floatingDragOverlay} />}
    </div>
  )

  if (typeof document === 'undefined') return content
  return createPortal(content, document.body)
}
