/**
 * 7x7 pixel icons in Pulse's square-pixel grammar (crisp edges, no curves).
 * Each glyph is 7 rows; bit 0x40 is the leftmost column.
 */
const GLYPHS = {
  open: [8, 28, 42, 8, 8, 65, 127],
  download: [8, 8, 42, 28, 8, 65, 127],
  plus: [0, 8, 8, 62, 8, 8, 0],
  close: [65, 34, 20, 8, 20, 34, 65],
  home: [8, 28, 62, 127, 34, 38, 38],
  library: [31, 17, 125, 69, 71, 68, 124],
  recent: [28, 34, 73, 77, 65, 34, 28],
  star: [8, 8, 127, 62, 28, 54, 65],
  trash: [28, 127, 34, 42, 42, 34, 62],
  folder: [112, 79, 65, 65, 65, 127, 0],
  search: [60, 66, 66, 66, 60, 6, 3],
  settings: [20, 62, 119, 99, 119, 62, 20],
  chevronDown: [0, 0, 65, 34, 20, 8, 0],
  chevronRight: [0, 16, 8, 4, 8, 16, 0],
  arrowRight: [0, 4, 2, 127, 2, 4, 0],
  globe: [28, 42, 127, 42, 127, 42, 28],
  keyboard: [0, 127, 85, 65, 93, 127, 0],
  sun: [8, 73, 28, 127, 28, 73, 8],
  moon: [14, 28, 56, 56, 56, 28, 14],
  check: [0, 1, 2, 68, 40, 16, 0],
  sidebar: [127, 81, 81, 81, 81, 81, 127],
  details: [127, 69, 69, 69, 69, 69, 127],
  motion: [0, 96, 48, 24, 48, 96, 0],
  info: [8, 0, 24, 8, 8, 8, 28],
  warning: [8, 8, 20, 20, 42, 34, 127],
  cloud: [0, 24, 38, 65, 65, 62, 0],
  device: [127, 65, 65, 65, 127, 8, 62],
  // file types
  doc: [60, 38, 34, 46, 34, 46, 62],
  slides: [127, 65, 65, 65, 127, 8, 28],
  sheet: [127, 73, 127, 73, 127, 73, 127],
  book: [54, 73, 73, 73, 73, 127, 0],
  image: [127, 65, 69, 65, 73, 85, 127],
  code: [0, 20, 34, 65, 34, 20, 0],
  audio: [15, 9, 9, 9, 57, 121, 48],
  video: [127, 65, 81, 89, 81, 65, 127],
  archive: [127, 65, 127, 65, 73, 65, 127],
  file: [60, 38, 34, 34, 34, 34, 62],
} as const;

export type PixelIconName = keyof typeof GLYPHS;

const pathCache = new Map<PixelIconName, string>();

function pathFor(name: PixelIconName): string {
  const cached = pathCache.get(name);
  if (cached) return cached;
  let d = '';
  GLYPHS[name].forEach((row, r) => {
    for (let c = 0; c < 7; c++) if (row & (0x40 >> c)) d += `M${c} ${r}h1v1h-1z`;
  });
  pathCache.set(name, d);
  return d;
}

interface PixelIconProps {
  name: PixelIconName;
  /** Rendered size in px; multiples of 7 stay perfectly crisp (7, 14, 21). */
  size?: number;
  className?: string;
}

export function PixelIcon({ name, size = 14, className = '' }: PixelIconProps) {
  return (
    <svg
      viewBox="0 0 7 7"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path d={pathFor(name)} />
    </svg>
  );
}

const CATEGORY_GLYPH: Record<string, PixelIconName> = {
  pdf: 'doc',
  word: 'doc',
  presentation: 'slides',
  spreadsheet: 'sheet',
  ebook: 'book',
  image: 'image',
  code: 'code',
  audio: 'audio',
  video: 'video',
  archive: 'archive',
};

export const categoryGlyph = (category: string): PixelIconName => CATEGORY_GLYPH[category] ?? 'file';
