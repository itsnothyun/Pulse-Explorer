import * as XLSX from 'xlsx';
import YAML from 'yaml';
import { gzipSync } from 'fflate';
import { ConvertError, type ConvertInput, type ConvertOutput, type Converter } from './types';
import { mimeFor, textDecode, textEncode } from './util';

type Row = Record<string, unknown>;
interface Sheet {
  name: string;
  rows: Row[];
}

const safeSheetName = (n: string, i: number) => n.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;

function arraysToRows(arr: unknown[][]): Row[] {
  return arr.map((cells) => Object.fromEntries(cells.map((c, i) => [`col${i + 1}`, c])));
}

/** Normalizes any parsed JSON/YAML value into sheets of rows. */
function valueToSheets(value: unknown): Sheet[] {
  if (Array.isArray(value)) {
    if (value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) return [{ name: 'Sheet1', rows: value as Row[] }];
    if (value.every(Array.isArray)) return [{ name: 'Sheet1', rows: arraysToRows(value as unknown[][]) }];
    return [{ name: 'Sheet1', rows: value.map((v) => ({ value: v })) }];
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 0 && entries.every(([, v]) => Array.isArray(v) && v.every((r) => r && typeof r === 'object'))) {
      return entries.map(([name, rows], i) => ({ name: safeSheetName(name, i), rows: rows as Row[] }));
    }
    return [{ name: 'Sheet1', rows: [value as Row] }];
  }
  throw new ConvertError('This file has no rows or records to convert.');
}

function readSheets(input: ConvertInput): Sheet[] {
  const ext = input.info.extension.toLowerCase();
  if (ext === 'json') {
    try {
      return valueToSheets(JSON.parse(textDecode(input.bytes)));
    } catch (e) {
      if (e instanceof ConvertError) throw e;
      throw new ConvertError('The JSON is invalid and could not be parsed.');
    }
  }
  if (ext === 'yaml' || ext === 'yml') {
    try {
      return valueToSheets(YAML.parse(textDecode(input.bytes)));
    } catch (e) {
      if (e instanceof ConvertError) throw e;
      throw new ConvertError('The YAML is invalid and could not be parsed.');
    }
  }
  const wb =
    ext === 'tsv'
      ? XLSX.read(textDecode(input.bytes), { type: 'string', FS: '\t' } as XLSX.ParsingOptions)
      : XLSX.read(input.bytes, { type: 'array' });
  const sheets = wb.SheetNames.map((name, i) => ({
    name: safeSheetName(name, i),
    rows: XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { defval: '' }),
  }));
  if (sheets.length === 0) throw new ConvertError('The spreadsheet has no sheets.');
  return sheets;
}

function writeBook(sheets: Sheet[], bookType: 'xlsx' | 'ods'): Uint8Array {
  const wb = XLSX.utils.book_new();
  sheets.forEach((s, i) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.rows), safeSheetName(s.name, i)));
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType }) as ArrayBuffer);
}

const treeOf = (sheets: Sheet[]) =>
  sheets.length === 1 ? sheets[0].rows : Object.fromEntries(sheets.map((s) => [s.name, s.rows]));

export const dataConverter: Converter = {
  id: 'data',

  async run(target, input): Promise<ConvertOutput> {
    const ext = input.info.extension.toLowerCase();
    if (target.id === 'gz') {
      return { bytes: gzipSync(input.bytes, { level: 9 }), ext: target.ext, mime: mimeFor('gz') };
    }
    if (target.compress) {
      try {
        return { bytes: textEncode(JSON.stringify(JSON.parse(textDecode(input.bytes)))), ext: 'json', mime: mimeFor('json') };
      } catch {
        throw new ConvertError('The JSON is invalid and could not be minified.');
      }
    }
    const sheets = readSheets(input);
    let bytes: Uint8Array;
    let note: string | undefined;
    switch (target.id) {
      case 'csv':
      case 'tsv': {
        const ws = XLSX.utils.json_to_sheet(sheets[0].rows);
        bytes = textEncode(XLSX.utils.sheet_to_csv(ws, { FS: target.id === 'tsv' ? '\t' : ',' }));
        if (sheets.length > 1) note = `Only the first sheet (${sheets[0].name}) was exported.`;
        break;
      }
      case 'json':
        bytes = textEncode(JSON.stringify(treeOf(sheets), null, 2));
        break;
      case 'yaml':
        bytes = textEncode(YAML.stringify(treeOf(sheets)));
        break;
      case 'xlsx':
      case 'ods':
        bytes = writeBook(sheets, target.id);
        break;
      default:
        throw new ConvertError(`Unsupported target: ${target.id}`);
    }
    return { bytes, ext: target.ext, mime: mimeFor(target.ext), note };
  },
};
