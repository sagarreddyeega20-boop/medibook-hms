/**
 * A tiny PDF writer for receipts and invoices (A4, Helvetica / Helvetica-Bold, text, lines, filled boxes).
 * No dependency: the standard-14 fonts need no embedding, and the documents are a page or two of text.
 * Coordinates are in points from the TOP-left corner (converted to PDF's bottom-left origin here).
 */

const A4 = { w: 595.28, h: 841.89 };

/* Glyph widths (1/1000 em) for ASCII 32–126, from the Adobe AFM files. */
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

/** Standard fonts only cover Latin-1; map the typographic characters we use and drop anything else. */
export function pdfSafe(s: string): string {
  return s
    .replace(/₹\s?/g, 'Rs. ')
    .replace(/[–—]/g, '-')
    .replace(/×/g, 'x')
    .replace(/·/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e]/g, '');
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const n = (v: number) => (Math.round(v * 100) / 100).toString();
const rgb = (hex: string) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => n(parseInt(h.slice(i, i + 2), 16) / 255)).join(' ');
};

export interface TextOpts {
  size?: number;
  bold?: boolean;
  color?: string; // #rrggbb
  align?: 'left' | 'right' | 'center';
}

export class PdfDoc {
  readonly width = A4.w;
  readonly height = A4.h;
  private pages: string[][] = [];

  constructor() {
    this.addPage();
  }

  addPage() {
    this.pages.push([]);
    return this;
  }

  private get ops() {
    return this.pages[this.pages.length - 1]!;
  }

  textWidth(s: string, size = 10, bold = false) {
    const table = bold ? HELVETICA_BOLD : HELVETICA;
    let w = 0;
    for (const ch of pdfSafe(s)) w += table[ch.charCodeAt(0) - 32] ?? 556;
    return (w * size) / 1000;
  }

  /** Cuts `s` with "..." so it fits in `maxWidth` points. */
  fit(s: string, maxWidth: number, size = 10, bold = false) {
    let out = pdfSafe(s);
    if (this.textWidth(out, size, bold) <= maxWidth) return out;
    while (out.length > 1 && this.textWidth(`${out}...`, size, bold) > maxWidth) out = out.slice(0, -1);
    return `${out.trimEnd()}...`;
  }

  text(x: number, y: number, s: string, o: TextOpts = {}) {
    const size = o.size ?? 10;
    const str = pdfSafe(s);
    const w = this.textWidth(str, size, o.bold);
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${o.bold ? 'F2' : 'F1'} ${size} Tf ${rgb(o.color ?? '#1f2937')} rg ${n(left)} ${n(this.height - y - size)} Td (${esc(str)}) Tj ET`);
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, color = '#e5e7eb', width = 0.75, dash = false) {
    this.ops.push(`q ${rgb(color)} RG ${n(width)} w ${dash ? '[3 3] 0 d ' : ''}${n(x1)} ${n(this.height - y1)} m ${n(x2)} ${n(this.height - y2)} l S Q`);
    return this;
  }

  rect(x: number, y: number, w: number, h: number, fill: string) {
    this.ops.push(`q ${rgb(fill)} rg ${n(x)} ${n(this.height - y - h)} ${n(w)} ${n(h)} re f Q`);
    return this;
  }

  toBuffer(): Buffer {
    const objects: string[] = [];
    const add = (body: string) => objects.push(body); // object number = index + 1
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(''); // pages, filled below
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    for (const ops of this.pages) {
      const content = ops.join('\n');
      add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      const contentRef = objects.length;
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(this.width)} ${n(this.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentRef} 0 R >>`);
      kids.push(objects.length);
    }
    objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
