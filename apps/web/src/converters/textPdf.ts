import { PDFDocument, StandardFonts } from 'pdf-lib';

interface TextPdfOptions {
  font: 'Helvetica' | 'Courier';
  size?: number;
  landscape?: boolean;
  /** Start a new page for each string instead of flowing continuously. */
  pageBreakEach?: boolean;
}

/** The standard PDF fonts only cover WinAnsi; anything else becomes `?` instead of throwing. */
const winAnsi = (s: string) => s.replace(/\t/g, '    ').replace(/[^\x20-\x7E\xA0-\xFF‘’“”–—•€]/g, '?');

/** Lays plain text onto A4 pages with word wrapping. */
export async function textToPdf(sections: string[], opts: TextPdfOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(opts.font === 'Courier' ? StandardFonts.Courier : StandardFonts.Helvetica);
  const size = opts.size ?? 11;
  const lead = size * 1.4;
  const [pw, ph] = opts.landscape ? [841.89, 595.28] : [595.28, 841.89];
  const margin = 48;
  const maxWidth = pw - margin * 2;

  let page = pdf.addPage([pw, ph]);
  let y = ph - margin;
  const newPage = () => {
    page = pdf.addPage([pw, ph]);
    y = ph - margin;
  };

  const wrap = (line: string): string[] => {
    const words = line.split(' ');
    const out: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) {
        cur = next;
        continue;
      }
      if (cur) out.push(cur);
      // A single word wider than the page is split by characters.
      let rest = w;
      while (font.widthOfTextAtSize(rest, size) > maxWidth) {
        let n = rest.length;
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxWidth) n--;
        out.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      cur = rest;
    }
    out.push(cur);
    return out;
  };

  sections.forEach((section, i) => {
    if (opts.pageBreakEach && i > 0) newPage();
    for (const raw of winAnsi(section).split('\n')) {
      for (const line of wrap(raw)) {
        if (y < margin) newPage();
        if (line) page.drawText(line, { x: margin, y, size, font });
        y -= lead;
      }
    }
  });

  return pdf.save();
}
