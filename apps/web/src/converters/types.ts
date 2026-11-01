/** Shared contract for every converter. Converters run fully on-device. */

export type Level = 'small' | 'balanced' | 'best';

export interface FileInfo {
  extension: string;
  category: string;
}

export interface ConvertTarget {
  /** Unique within one file's target list, e.g. `png` or `compress`. */
  id: string;
  /** Short zone label, e.g. `WEBP` or `Compress`. */
  label: string;
  /** Extension of the produced file. */
  ext: string;
  /** Same-format size reduction; rejected when it does not make the file smaller. */
  compress?: boolean;
  /** Honest caveat shown before running, e.g. "text only". */
  note?: string;
}

export interface ConvertInput {
  bytes: Uint8Array;
  info: FileInfo;
  /** Original file name, used by converters that need a base name. */
  name: string;
  level: Level;
  onProgress?: (fraction: number) => void;
}

export interface ConvertOutput {
  bytes: Uint8Array;
  ext: string;
  mime: string;
  note?: string;
}

export interface Converter {
  id: string;
  run(target: ConvertTarget, input: ConvertInput): Promise<ConvertOutput>;
}

/** Thrown for expected, user-readable failures. */
export class ConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvertError';
  }
}
