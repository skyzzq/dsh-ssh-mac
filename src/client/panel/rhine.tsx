/**
 * Visual assets reused from RhineLabUI (LBEILC/RhineLabUI, MIT).
 *
 * The mark, the wordmark and the palette below are taken from that project's
 * `src/brand.ts` and `src/theme-ui.ts` so this panel reads as part of the same
 * design family instead of an imitation of it. Only the parts that survive as
 * vector geometry or plain colour values are reused; the upstream font stack
 * (MiSans, 753 @font-face shards) is referenced by name and falls back to the
 * surrounding GUI font, because vendoring ~9 MB of woff2 into a plugin bundle
 * is not a trade this panel should make.
 */

/** The warm paper-and-ink palette, mirrored in `panel.module.css`. */
export const RHINE_PALETTE = {
  light: {
    ink: '#080a08',
    muted: '#77756d',
    line: '#aaa59a',
    paper: '#eae5e1',
    panel: '#edebe4',
    field: '#e7e3d9',
    accent: '#9b7247',
  },
  dark: {
    ink: '#e0e3dc',
    muted: '#a6b0b1',
    line: '#536166',
    paper: '#11181b',
    panel: '#202a2f',
    field: '#2a363b',
    accent: '#c5a16b',
  },
} as const

/** The interlocking double-ring mark, drawn from the upstream path data. */
const MARK_PATHS: ReadonlyArray<{ d: string; width: string }> = [
  {
    d: 'M156 75C127 48 103 15 70 15C37 15 15 39 15 70S38 128 70 128C103 128 127 96 176 52M155 75C182 99 208 128 240 128C273 128 295 105 295 73S273 15 240 15C221 15 207 23 192 38',
    width: '26',
  },
  {
    d: 'M44 70h50M69 45v50M219 70h44',
    width: '15',
  },
]

/** Props of the brand mark. */
export interface RhineMarkProps {
  /** Rendered height in px; the viewBox keeps the 310:185 ratio. */
  size?: number
  /** Accessible label; omit for a decorative mark beside text. */
  title?: string
}

/**
 * The RhineLab double-ring mark. Strokes are `currentColor`, so the mark takes
 * the ink colour of whatever surface it sits on.
 */
export function RhineMark({ size = 18, title }: RhineMarkProps) {
  return (
    <svg
      viewBox="0 0 310 185"
      height={size}
      width={Math.round((size * 310) / 185)}
      role={title === undefined ? 'presentation' : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
      focusable="false"
    >
      {MARK_PATHS.map(path => (
        <path key={path.d} d={path.d} fill="none" stroke="currentColor" strokeWidth={path.width} />
      ))}
    </svg>
  )
}

/**
 * The mark plus the spaced-out RHINE·LAB wordmark, used as the panel's
 * identity block. The letter-spacing mirrors the upstream lockup.
 */
export function RhineWordmark() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
      <RhineMark size={14} />
      <span
        style={{
          fontFamily: 'MiSans, var(--dsw-font-family)',
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
        }}
      >
        RHINE·LAB
      </span>
    </span>
  )
}
