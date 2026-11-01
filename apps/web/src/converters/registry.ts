import { archiveTargets, dataTargets, imageTargets, mediaTargets, officeTargets, pdfTargets } from './targets';
import { ConvertError, type ConvertInput, type ConvertOutput, type ConvertTarget, type Converter, type FileInfo } from './types';

interface Entry {
  id: string;
  targets: (info: FileInfo) => ConvertTarget[];
  /** Engines pull in large libraries, so they load only when a conversion actually runs. */
  load: () => Promise<Converter>;
}

/** Every converter, in the order their targets appear around the circle. */
const ENTRIES: Entry[] = [
  { id: 'pdf', targets: pdfTargets, load: () => import('./pdf').then((m) => m.pdfConverter) },
  { id: 'image', targets: imageTargets, load: () => import('./image').then((m) => m.imageConverter) },
  { id: 'office', targets: officeTargets, load: () => import('./office').then((m) => m.officeConverter) },
  { id: 'data', targets: dataTargets, load: () => import('./data').then((m) => m.dataConverter) },
  { id: 'media', targets: mediaTargets, load: () => import('./media').then((m) => m.mediaConverter) },
  { id: 'archive', targets: archiveTargets, load: () => import('./archive').then((m) => m.archiveConverter) },
];

export interface ResolvedTarget extends ConvertTarget {
  converterId: string;
}

/** What can this file become? Only conversions that actually work on-device are listed. */
export function getTargets(info: FileInfo): ResolvedTarget[] {
  const out: ResolvedTarget[] = [];
  const seen = new Set<string>();
  for (const entry of ENTRIES) {
    for (const t of entry.targets(info)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ ...t, converterId: entry.id });
    }
  }
  // Keep Compress last so it sits at a predictable spot.
  return out.sort((a, b) => Number(Boolean(a.compress)) - Number(Boolean(b.compress)));
}

export async function convert(target: ResolvedTarget, input: ConvertInput): Promise<ConvertOutput> {
  const entry = ENTRIES.find((c) => c.id === target.converterId);
  if (!entry) throw new ConvertError('No converter is available for this file.');
  const converter = await entry.load();
  const out = await converter.run(target, input);
  if (target.compress && out.bytes.length >= input.bytes.length) {
    throw new ConvertError('Already as small as it can get at this level. Try the Smallest setting.');
  }
  return out;
}

export * from './types';
export { LEVELS, LEVEL_LABELS, formatBytes, outputName, uniqueName } from './util';
