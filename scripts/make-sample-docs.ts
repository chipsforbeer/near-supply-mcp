import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simplePdf } from '../src/seed/simple-pdf.ts';

// Fictional supplier replies for the demo walkthrough: what would arrive by email as attachments.
// Usage: npm run sample-docs [-- <folder>]   (default ./sample-docs)
export const SAMPLE_DOCS: Record<string, string[]> = {
  'quote-example-mill-direct.pdf': [
    'Example Mill Direct - Quotation Q-5531 (fictional sample)',
    'To: Northbeck Metalworks purchasing',
    'Item: 304/304L dual certified stainless sheet, 1.5 mm, 2B, 1219 x 2438 mm',
    'Quantity: 2 bundles (40 sheets, 1,416 kg)',
    'Price: 2.95 USD per kg, DAP your works',
    'Freight: 60 USD per delivery',
    'Lead time: 12 days from order',
    'Certificate: EN 10204 3.1 mill certificate supplied with each heat',
    'Valid for 30 days',
  ],
  'quote-example-stainless-stockholders.pdf': [
    'Example Stainless Stockholders - Quote 7781 (fictional sample)',
    'Item: 304 stainless sheet 1.4 mm 2B, 1219 x 2438 mm (1.5 mm out of stock)',
    'Quantity: 2 bundles',
    'Price: 2.80 USD per kg delivered',
    'Lead time: 7 days',
    'Certificate: EN 10204 2.2 test report',
  ],
  'mill-cert-heat-5531-77.pdf': [
    'EN 10204 3.1 Inspection Certificate (fictional sample)',
    'Producer: Example Mill Direct',
    'Heat: 5531-77   Grade: 304/304L   Finish: 2B',
    'Thickness measured: 1.49 / 1.51 / 1.50 mm',
    'C 0.021  Cr 18.2  Ni 8.1  (wt %)',
  ],
};

export async function writeSampleDocs(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const out: string[] = [];
  for (const [name, lines] of Object.entries(SAMPLE_DOCS)) {
    const file = path.join(dir, name);
    await writeFile(file, simplePdf(lines, name));
    out.push(file);
  }
  return out;
}

// Run only as a command, not when imported by tests.
if (process.argv[1]?.endsWith('make-sample-docs.ts')) {
  const dir = path.resolve(process.argv[2] ?? 'sample-docs');
  for (const f of await writeSampleDocs(dir)) console.log(f);
}
