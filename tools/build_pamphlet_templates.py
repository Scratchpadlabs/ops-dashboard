"""Build the blank Student Pamphlet templates from the filled Canva samples.

The pamphlets are designed in Canva and exported per school with one
student's details typed in. This strips everything that changes per student
or per school — the name/roll/class header, the QR code, the website, the
User ID / Password values and the school name in the footer — and records
where each one sat, so the dashboard (src/utils/studentPamphletPDF.js) can
stamp real values back in the same place, in the same fonts and sizes.

Redaction actually removes the text and QR paths from the page content (a
white box drawn over them would leave "sss0001" selectable underneath).

Usage, when the Canva design changes — export each design with ANY sample
student filled in, then:

    pip install pymupdf
    python3 tools/build_pamphlet_templates.py \
        --foundational Foundational-pamphlete-Hindi.pdf \
        --middle MiddlePrep.pdf \
        --marathi Foundational-pamphlete-Hindi_2.pdf   # page 2 is Marathi

Writes public/pamphlets/{foundational,middle,foundational-marathi}.pdf and
src/utils/pamphletLayout.js. Middle/Prep samples are exported without the
User ID / Password values and without the name header; their slots are taken
from the Foundational design, which shares that block (shifted with the QR).
"""
import argparse
import json
import os

import pymupdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PDF_DIR = os.path.join(ROOT, 'public', 'pamphlets')
OUT_LAYOUT = os.path.join(ROOT, 'src', 'utils', 'pamphletLayout.js')


def spans(page):
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            for span in line['spans']:
                if span['text'].strip():
                    yield span


def qr_rect(page):
    """The QR is vector art: the union of the paths in the SCAN panel's
    left-hand square (the only drawings in that area)."""
    area = pymupdf.Rect(80, 220, 230, 380)
    rects = [d['rect'] for d in page.get_drawings() if d['rect'] in area]
    if not rects:
        return None
    r = rects[0]
    for x in rects[1:]:
        r |= x
    # Pages without a QR still have the odd icon in that area.
    return r if r.width > 80 and abs(r.width - r.height) < 5 else None


def rgb(color_int):
    return [((color_int >> s) & 255) / 255 for s in (16, 8, 0)]


def text_slot(span, page_h, align='center'):
    x0, _, x1, _ = span['bbox']
    slot = {
        'baseline': round(page_h - span['origin'][1], 2),
        'size': round(span['size'], 2),
        'color': rgb(span['color']),
    }
    if align == 'center':
        slot['cx'] = round((x0 + x1) / 2, 2)
    else:
        slot['x'] = round(x0, 2)
    return slot


def blank_page(page, is_sample_value):
    """Find and redact the variable bits of one page; return their slots."""
    h = page.rect.height
    found = {}
    for s in spans(page):
        t = s['text'].strip()
        if t.startswith('Name:'):
            found['header'] = s
        elif 'myhpc.app' in t:
            found['url'] = s
        elif is_sample_value(t) and s['size'] > 15:
            # User ID first (higher on the page), then Password.
            found.setdefault('values', []).append(s)
        elif s['bbox'][1] > h - 40 and t.isupper():
            found['footer'] = s

    slots, redact = {}, []
    if 'header' in found:
        s = found['header']
        slots['header'] = text_slot(s, h)
        redact.append(pymupdf.Rect(s['bbox']))
    q = qr_rect(page)
    if q:
        slots['qr'] = {'x': round(q.x0, 2), 'y': round(h - q.y1, 2), 'size': round(q.width, 2)}
        redact.append(q + (-1, -1, 1, 1))
    if 'url' in found:
        s = found['url']
        slots['url'] = text_slot(s, h)
        # The underline is a separate filled bar just under the text.
        redact.append(pymupdf.Rect(s['bbox']) + (-2, -2, 2, 2))
    values = sorted(found.get('values', []), key=lambda s: s['bbox'][1])
    for key, s in zip(('userId', 'password'), values):
        slots[key] = text_slot(s, h, align='left')
        # Stop above the rule the value sits on so the rule survives.
        x0, y0, x1, y1 = s['bbox']
        redact.append(pymupdf.Rect(x0 - 1, y0, x1 + 1, s['origin'][1] + 1))
    if 'footer' in found:
        s = found['footer']
        slots['footer'] = text_slot(s, h)
        redact.append(pymupdf.Rect(s['bbox']))

    for r in redact:
        page.add_redact_annot(r)
    page.apply_redactions(
        images=pymupdf.PDF_REDACT_IMAGE_NONE,
        graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
        text=pymupdf.PDF_REDACT_TEXT_REMOVE,
    )
    return slots


def build(src, name, is_sample_value, keep=None):
    doc = pymupdf.open(src)
    if keep is not None:
        doc.select(keep)
    pages = [blank_page(p, is_sample_value) for p in doc]
    doc.set_metadata({'title': f'Student pamphlet template ({name})', 'author': 'scratchpad Labs'})
    os.makedirs(OUT_PDF_DIR, exist_ok=True)
    doc.save(os.path.join(OUT_PDF_DIR, f'{name}.pdf'), garbage=4, deflate=True, clean=True)
    return {'width': round(doc[0].rect.width, 2), 'height': round(doc[0].rect.height, 2), 'pages': pages}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--foundational', required=True)
    ap.add_argument('--middle', required=True)
    ap.add_argument('--marathi', required=True,
                    help='Foundational sample whose Marathi page replaces the Hindi back')
    ap.add_argument('--marathi-page', type=int, default=2,
                    help='1-based page number of the Marathi page in --marathi (default 2)')
    ap.add_argument('--sample-id', default='sss0001', help='User ID typed into the samples')
    args = ap.parse_args()
    is_sample = lambda t: t == args.sample_id

    foundational = build(args.foundational, 'foundational', is_sample)
    middle = build(args.middle, 'middle', is_sample)
    # Only the Marathi page: the English front is shared with foundational.pdf.
    marathi = build(args.marathi, 'foundational-marathi', is_sample, keep=[args.marathi_page - 1])

    # Middle/Prep is exported without header and ID values: borrow them from
    # Foundational's first page, shifted by however far the QR moved.
    f0, m0 = foundational['pages'][0], middle['pages'][0]
    dy = m0['qr']['y'] - f0['qr']['y']
    m0.setdefault('header', f0['header'])
    for key in ('userId', 'password'):
        if key not in m0:
            m0[key] = {**f0[key], 'baseline': round(f0[key]['baseline'] + dy, 2)}

    with open(OUT_LAYOUT, 'w') as fh:
        fh.write('// Generated by tools/build_pamphlet_templates.py — do not edit by hand.\n')
        fh.write('// PDF points, origin bottom-left (pdf-lib); one entry per template page.\n')
        fh.write('export default ')
        json.dump({'foundational': foundational, 'middle': middle, 'foundationalMarathi': marathi}, fh, indent=2)
        fh.write('\n')
    print(f'Wrote {OUT_PDF_DIR}/*.pdf and {OUT_LAYOUT}')


if __name__ == '__main__':
    main()
