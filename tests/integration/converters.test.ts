import { describe, expect, it } from 'vitest';
import { gunzipSync, zipSync } from 'fflate';
import { convert, getTargets, outputName, uniqueName, type ResolvedTarget } from '../../apps/web/src/converters/registry';
import { readArchive, readTar, safeEntryName, writeTar } from '../../apps/web/src/converters/archive';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const info = (extension: string, category = 'unknown') => ({ extension, category });
const pick = (ext: string, id: string): ResolvedTarget => {
  const t = getTargets(info(ext)).find((x) => x.id === id);
  if (!t) throw new Error(`no target ${id} for .${ext}`);
  return t;
};
const run = (ext: string, id: string, bytes: Uint8Array, level: 'small' | 'balanced' | 'best' = 'balanced') =>
  convert(pick(ext, id), { bytes, info: info(ext), name: `file.${ext}`, level });

describe('converter registry', () => {
  it('only offers conversions that exist for the file type', () => {
    const ids = (ext: string) => getTargets(info(ext)).map((t) => t.id);
    expect(ids('png')).toEqual(expect.arrayContaining(['jpg', 'webp', 'bmp', 'pdf', 'compress']));
    expect(ids('png')).not.toContain('png');
    expect(ids('pdf')).toEqual(expect.arrayContaining(['png', 'jpg', 'txt', 'compress']));
    expect(ids('docx')).toEqual(expect.arrayContaining(['txt', 'pdf', 'compress']));
    expect(ids('zip')).toEqual(expect.arrayContaining(['tar', 'tgz', 'compress']));
    expect(ids('zip')).not.toContain('zip');
    expect(ids('csv')).toEqual(expect.arrayContaining(['json', 'yaml', 'xlsx', 'tsv']));
    expect(ids('mp4')).toEqual(expect.arrayContaining(['webm', 'mp3', 'compress']));
    expect(ids('flac')).toEqual(expect.arrayContaining(['mp3', 'wav', 'compress']));
    expect(ids('bin')).toEqual([]);
  });

  it('puts Compress last so it has a stable slot', () => {
    for (const ext of ['png', 'pdf', 'zip', 'json']) {
      const list = getTargets(info(ext));
      expect(list[list.length - 1].compress).toBe(true);
    }
  });
});

describe('data conversion', () => {
  const csv = enc('name,age\nAda,36\nLinus,54\n');

  it('csv -> json -> yaml -> csv keeps the rows', async () => {
    const json = await run('csv', 'json', csv);
    expect(JSON.parse(dec(json.bytes))).toEqual([{ name: 'Ada', age: 36 }, { name: 'Linus', age: 54 }]);
    const yaml = await run('json', 'yaml', json.bytes);
    expect(dec(yaml.bytes)).toContain('name: Ada');
    const back = await run('yaml', 'csv', yaml.bytes);
    expect(dec(back.bytes).trim().split(/\r?\n/)).toEqual(['name,age', 'Ada,36', 'Linus,54']);
  });

  it('csv -> xlsx produces a zip container that reads back', async () => {
    const xlsx = await run('csv', 'xlsx', csv);
    expect(Array.from(xlsx.bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
    const json = await run('xlsx', 'json', xlsx.bytes);
    expect(JSON.parse(dec(json.bytes))).toHaveLength(2);
  });

  it('minifies JSON and refuses when nothing is saved', async () => {
    const pretty = enc(JSON.stringify({ a: [1, 2, 3], b: 'x' }, null, 4));
    const out = await run('json', 'compress', pretty);
    expect(dec(out.bytes)).toBe('{"a":[1,2,3],"b":"x"}');
    await expect(run('json', 'compress', out.bytes)).rejects.toThrow(/already as small/i);
  });

  it('reports invalid JSON in plain words', async () => {
    await expect(run('json', 'yaml', enc('{nope'))).rejects.toThrow(/invalid/i);
  });

  it('gzips plain text', async () => {
    const text = enc('hello world\n'.repeat(500));
    const out = await run('txt', 'gz', text);
    expect(out.ext).toBe('txt.gz');
    expect(dec(gunzipSync(out.bytes))).toBe(dec(text));
  });
});

describe('archive conversion', () => {
  const files = { 'a.txt': enc('alpha '.repeat(2000)), 'dir/b.txt': enc('beta '.repeat(2000)) };

  it('zip -> tar -> tgz -> zip round-trips every file', async () => {
    const zip = zipSync({ 'a.txt': [files['a.txt'], { level: 0 }], 'dir/b.txt': [files['dir/b.txt'], { level: 0 }] });
    const tar = await run('zip', 'tar', zip);
    expect(Object.keys(readTar(tar.bytes)).sort()).toEqual(['a.txt', 'dir/b.txt']);
    const tgz = await run('tar', 'tgz', tar.bytes);
    expect(tgz.bytes.length).toBeLessThan(tar.bytes.length);
    const back = await convert(pick('tgz', 'zip'), { bytes: tgz.bytes, info: info('tgz'), name: 'x.tgz', level: 'balanced' });
    const entries = readArchive(back.bytes, info('zip'), 'x.zip');
    expect(dec(entries['dir/b.txt'])).toBe(dec(files['dir/b.txt']));
  });

  it('compress shrinks a stored zip and rejects an already-tight one', async () => {
    const stored = zipSync({ 'a.txt': [files['a.txt'], { level: 0 }] });
    const small = await run('zip', 'compress', stored);
    expect(small.bytes.length).toBeLessThan(stored.length);
    await expect(run('zip', 'compress', small.bytes)).rejects.toThrow(/already as small/i);
  });

  it('drops zip-slip paths', () => {
    expect(safeEntryName('../evil.txt')).toBeNull();
    expect(safeEntryName('a/../../evil')).toBeNull();
    expect(safeEntryName('/etc/passwd')).toBeNull();
    expect(safeEntryName('C:\\x')).toBeNull();
    expect(safeEntryName('ok/file.txt')).toBe('ok/file.txt');
    const tar = writeTar({ 'safe.txt': enc('x') });
    expect(Object.keys(readTar(tar))).toEqual(['safe.txt']);
  });

  it('handles long tar paths through the ustar prefix field', () => {
    const name = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(60)}.txt`;
    expect(Object.keys(readTar(writeTar({ [name]: enc('hi') })))).toEqual([name]);
  });
});

describe('office conversion', () => {
  const docx = zipSync({
    'word/document.xml': enc(
      '<w:document><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Second line</w:t></w:r></w:p></w:body></w:document>'
    ),
  });

  it('extracts docx text', async () => {
    const out = await run('docx', 'txt', docx);
    expect(dec(out.bytes)).toBe('Hello & welcome\nSecond line');
  });

  it('writes a real PDF from docx text', async () => {
    const out = await run('docx', 'pdf', docx);
    expect(dec(out.bytes.slice(0, 5))).toBe('%PDF-');
    expect(out.note).toMatch(/text only/i);
  });

  it('rejects a docx with no document part', async () => {
    await expect(run('docx', 'txt', zipSync({ 'x.txt': enc('x') }))).rejects.toThrow(/not a valid \.docx/i);
  });

  it('repacks an office zip smaller', async () => {
    const big = zipSync({ 'word/document.xml': [enc('<w:p><w:t>x</w:t></w:p>'.repeat(5000)), { level: 0 }] });
    const out = await run('docx', 'compress', big);
    expect(out.bytes.length).toBeLessThan(big.length);
  });
});

describe('file naming', () => {
  it('names outputs', () => {
    expect(outputName('photo.png', 'webp', false)).toBe('photo.webp');
    expect(outputName('photo.png', 'png', true)).toBe('photo (compressed).png');
    expect(outputName('bundle.tar.gz', 'zip', false)).toBe('bundle.zip');
  });

  it('avoids collisions in the target folder', () => {
    expect(uniqueName('a.png', ['b.png'])).toBe('a.png');
    expect(uniqueName('a.png', ['A.PNG'])).toBe('a (2).png');
    expect(uniqueName('a.png', ['a.png', 'a (2).png'])).toBe('a (3).png');
  });
});
