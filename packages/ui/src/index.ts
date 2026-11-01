/**
 * Pulse design tokens (https://github.com/itsnothyun/Pulse, DESIGN.md, MIT).
 * The complete token set: colours, typography, radii, spacing, shadows,
 * motion and component recipes. Mirrors apps/web/src/styles/index.css for
 * code that draws outside CSS (canvas, Tauri chrome). Strictly achromatic;
 * state is expressed by brightness only (on, mid, dim, off).
 */
export { GLYPHS } from './glyphs';

export const PULSE_COLORS = {
  ground: '#090909',
  groundRaised: '#0e0e0e',
  well: '#0f0f0e',
  wallpaper: '#121211',
  pixelOn: '#f2f2ed',
  pixelOnHover: '#ffffff',
  pixelMid: '#b3b3ad',
  textDim: '#8c8c88',
  pixelDim: '#757573',
  edgeStrong: '#4a4a47',
  ruleDotted: '#3a3a37',
  rule: '#303030',
  edge: '#2a2a28',
  pixelOff: '#262626',
  menu: '#181817',
} as const;

export const PULSE_TYPOGRAPHY = {
  displayPixel: { dot: 12, capHeight: '84px' },
  headlinePixel: { dot: 6, capHeight: '42px' },
  lede: { fontSize: 'clamp(20px, 2.1vw, 24px)', fontWeight: 400, lineHeight: 1.45 },
  title: { fontSize: '18px', fontWeight: 600, lineHeight: 1.35, letterSpacing: '-0.005em' },
  body: { fontSize: '18px', fontWeight: 400, lineHeight: 1.6 },
  label: { fontSize: '14px', fontWeight: 400, lineHeight: 1.4 },
  mono: { fontSize: '12.5px', fontWeight: 400, lineHeight: 1.7 },
} as const;

export const PULSE_FONTS = {
  sans: '"Schibsted Grotesk", ui-sans-serif, system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
} as const;

/** Glyph metrics: 6-column advance (5 lit + 1 blank), 3-dot line gap. */
export const PULSE_GLYPH_METRICS = {
  rows: 7,
  cols: 5,
  advance: 6,
  lineGapDots: 3,
  /** Dots of 6px and up get a gap of 12% of the dot. */
  gapThreshold: 6,
  gapRatio: 0.12,
  minDot: 1.5,
} as const;

export const PULSE_RADII = {
  hair: '2px',
  key: '3px',
  button: '4px',
  control: '6px',
  panel: '8px',
  mini: '10px',
  screen: '12px',
  widget: '14px',
} as const;

export const PULSE_SPACING = {
  gutter: 'clamp(16px, 4vw, 40px)',
  section: 'clamp(96px, 13vw, 176px)',
  wrap: '1180px',
  wrapWide: '1320px',
  widgetPad: '18px',
  widgetWidth: '320px',
  tilePad: '10px',
  rowGap: '14px',
} as const;

/** Desktop objects only: screens, windows, the widget, menus. */
export const PULSE_SHADOWS = {
  screenBezel: '0 30px 60px -30px rgba(0,0,0,0.9), 0 0 0 6px #111110, 0 0 0 7px #232321',
  windowLift: '0 24px 40px -18px rgba(0,0,0,0.85)',
  widgetDrop: 'drop-shadow(0 18px 24px rgba(0,0,0,0.6))',
  menu: '0 18px 40px -12px rgba(0,0,0,0.9)',
  navScrolled: '0 1px 0 #303030, 0 10px 24px -12px rgba(0,0,0,0.8)',
} as const;

export const PULSE_MOTION = {
  ease: 'cubic-bezier(0.16, 1, 0.3, 1)',
  press: '120ms',
  hover: '180ms',
  fade: '260ms',
  headlineAssembly: '420ms',
  scannerBeat: '0.16s',
  scannerBeatHot: '0.07s',
  pipBreathe: '1.3s',
  crtSweep: '9s',
  barTween: '0.45s',
  caretBlink: '1.1s',
} as const;

export const PULSE_SCANLINES = {
  page: 'repeating-linear-gradient(to bottom, rgba(242,242,237,0.018) 0 1px, transparent 1px 3px)',
  widget: 'repeating-linear-gradient(to bottom, rgba(242,242,237,0.02) 0 1px, transparent 1px 3px)',
} as const;

const c = PULSE_COLORS;
const r = PULSE_RADII;

export const PULSE_COMPONENTS = {
  buttonPrimary: { background: c.pixelOn, color: c.ground, radius: r.button, padding: '0 22px', height: '52px', font: '600 15px/1' },
  buttonPrimaryHover: { background: c.pixelOnHover, color: c.ground },
  buttonGhost: { background: 'transparent', color: c.pixelOn, border: c.edgeStrong, radius: r.button, padding: '0 22px', height: '52px' },
  buttonSmall: { radius: r.button, padding: '0 14px', height: '40px' },
  segmentedControl: { background: 'transparent', color: c.pixelMid, border: c.rule, radius: r.control, padding: '3px' },
  segmentedControlActive: { background: c.pixelOn, color: c.ground, radius: r.key, height: '40px' },
  widgetPanel: { background: c.ground, color: c.pixelOn, radius: r.widget, padding: PULSE_SPACING.widgetPad, width: PULSE_SPACING.widgetWidth },
  widgetPanelMini: { background: c.ground, radius: r.mini, padding: '9px 12px' },
  widgetTile: { background: c.ground, color: c.pixelOn, radius: '0', padding: PULSE_SPACING.tilePad, border: c.rule },
  board: { background: c.groundRaised, radius: r.widget, padding: 'clamp(24px, 3vw, 40px)', border: c.edge },
  commandWell: { background: c.well, color: c.pixelOn, radius: r.control, padding: '12px 14px', border: c.edge },
  contextMenu: { background: c.menu, color: c.pixelOn, radius: r.panel, padding: '6px', border: c.ruleDotted },
  contextMenuItemHover: { background: c.pixelOn, color: c.ground, radius: r.button, height: '34px' },
} as const;

/** Legacy shape kept for existing consumers. */
export interface DesignTokens {
  accentColor: string;
  surfaceDark: string;
  surfaceLight: string;
  borderRadius: string;
}

export const OMNIVIEW_THEME_TOKENS: DesignTokens = {
  accentColor: c.pixelOn,
  surfaceDark: c.ground,
  surfaceLight: c.pixelOn,
  borderRadius: r.control,
};
