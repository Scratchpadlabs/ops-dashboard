"""Give the Student Pamphlet front pages a school band (logo + name) at the top.

The new design (Canva sample "Middle+Prep", Oct 2026) moves the school from
the footer to a white band above the student strip:

    ┌──────────────── page border ────────────────┐
    │        [logo]  School Name                  │  school band   (y  5 – 57)
    ├──────────────────────────────────────────────┤
    │   Name: …   Roll No.: …   Class: …           │  student strip (y 60 – 112)
    ├──────────────────────────────────────────────┤
    │   LOGIN DETAILS FOR HOLISTIC PROGRESS CARD   │
    │   …                                          │

This rebuilds public/pamphlets/{foundational,middle}.pdf and
src/utils/pamphletLayout.js from what is there now:

  * A front page exported from Canva in the new layout (--middle-canva /
    --foundational-canva, any school and student filled in) has the sample
    school, QR and website stripped, exactly like build_pamphlet_templates.py
    does for the old layout.
  * A front page still in the old layout is re-flowed into the new frame:
    the student strip moves down to make room for the band, the larger
    blank gaps between sections are tightened, and whatever is still short
    is taken up by a vertical scale of under 2% (invisible in print).
    Nothing is clipped or shrunk sideways, so the artwork stays flush with
    the page border.

Back pages are kept as they are. The footer slot (school name at the bottom)
is dropped everywhere: the name now lives in the band.

Usage:

    pip install pymupdf
    python3 tools/add_pamphlet_school_band.py --middle-canva Main.pdf

Running it again is safe: a page that already has the band is left alone.
"""
import argparse
import json
import os

import pymupdf

from build_pamphlet_templates import OUT_LAYOUT, OUT_PDF_DIR, blank_page, spans

# The new frame, measured from the Canva sample (PyMuPDF coords: y down).
BORDER = pymupdf.Rect(21.3, -13.6, 574.2, 832.6)
BORDER_W = 3.0
BORDER_COLOR = (0.1765, 0.1529, 0.1529)
STRIP = pymupdf.Rect(-9.1, 59.8, 612.2, 111.8)
STRIP_FILL = (1.0, 0.9961, 0.9804)
STRIP_LINE_W = 0.75
BAND_TOP, BAND_BOTTOM = 5, 57          # where the logo + name may go
BAND_X0, BAND_X1 = 30, 565
# Old frame: strip -3.5 – 48.6, border bottom 809.
OLD_STRIP_BOTTOM = 48.6
# The student line sits this far below the strip's middle (as in the old
# templates: baseline 37.56 in a strip centred on 22.55).
HEADER_BELOW_STRIP_MIDDLE = 15.01
TIGHT_GAP = 8                           # blank gaps above this are tightened to it
QR_AREA_NEW = (60, 260, 260, 480)

BLACK = [0.0, 0.0, 0.0]


def has_band(page):
    return any(d.get('fill') and d['rect'].width > 600 and abs(d['rect'].y0 - STRIP.y0) < 2
               for d in page.get_drawings())


def strip_of(page):
    for d in page.get_drawings():
        if d.get('fill') and d['rect'].width > 600 and d['rect'].y0 < 150:
            return d['rect']
    return None


def school_and_header_slots(h, strip):
    mid = (strip.y0 + strip.y1) / 2
    return {
        'school': {'x0': BAND_X0, 'x1': BAND_X1, 'top': round(h - BAND_TOP, 2),
                   'bottom': round(h - min(BAND_BOTTOM, strip.y0 - 3), 2)},
        'header': {'baseline': round(h - (mid + HEADER_BELOW_STRIP_MIDDLE), 2), 'size': 19.0,
                   'color': BLACK, 'cx': round((BORDER.x0 + BORDER.x1) / 2, 2)},
    }


def rules(page):
    """Short horizontal lines: the User ID / Password write-in rules."""
    return [d['rect'] for d in page.get_drawings()
            if d['rect'].height < 3 and 80 < d['rect'].width < 220 and d['rect'].x0 < 220]


def add_value_room(page, slots):
    """maxWidth for User ID / Password: up to the end of the rule they sit on."""
    h = page.rect.height
    for key in ('userId', 'password'):
        slot = slots.get(key)
        if not slot:
            continue
        y = h - slot['baseline']
        under = [r for r in rules(page) if 0 <= r.y0 - y < 8 and r.x0 <= slot['x'] + 12]
        if under:
            slot['maxWidth'] = round(max(r.x1 for r in under) - slot['x'] - 2, 2)


def value_slots_from_rules(page):
    """A Canva export without sample IDs: put the values on the rules right
    of the "User ID:" / "Password:" labels."""
    h = page.rect.height
    labels = {s['text'].strip().rstrip(':'): s for s in spans(page)
              if s['text'].strip() in ('User ID:', 'Password:')}
    out = {}
    for key, label in (('userId', 'User ID'), ('password', 'Password')):
        s = labels.get(label)
        if not s:
            continue
        y = s['origin'][1]
        rule = next((r for r in rules(page) if abs(r.y0 - y) < 6 and r.x0 >= s['bbox'][2] - 2), None)
        if not rule:
            continue
        x = rule.x0 + 5
        out[key] = {'baseline': round(h - rule.y0 + 3.5, 2), 'size': round(s['size'] * 1.19, 2),
                    'color': BLACK, 'x': round(x, 2), 'maxWidth': round(rule.x1 - x - 2, 2)}
    return out


def from_canva(path, sample_id):
    """Front page of a Canva export already in the new layout."""
    src = pymupdf.open(path)
    page = src[0]
    h = page.rect.height
    # The sample school (name, address, logo) sits above the strip.
    page.add_redact_annot(pymupdf.Rect(BORDER.x0 + 2.5, 0, BORDER.x1 - 2.5, STRIP.y0 - 1.5))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_REMOVE,
                          graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                          text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    slots = blank_page(page, lambda t: t == sample_id, qr_area=QR_AREA_NEW)
    slots.pop('footer', None)
    for key, slot in value_slots_from_rules(page).items():
        slots.setdefault(key, slot)
    add_value_room(page, slots)
    slots.update(school_and_header_slots(h, strip_of(page)))
    return src, slots


def blank_gaps(page, y0, y1):
    """Blank horizontal gaps (inside the border) between y0 and y1."""
    clip = pymupdf.Rect(BORDER.x0 + 3, y0, BORDER.x1 - 3, y1)
    pix = page.get_pixmap(dpi=144, clip=clip)
    w, n, s = pix.width, pix.n, pix.samples
    per = (y1 - y0) / pix.height
    gaps, start = [], None
    for row in range(pix.height + 1):
        blank = row < pix.height and min(s[row * w * n:(row + 1) * w * n]) > 235
        if blank and start is None:
            start = row
        if not blank and start is not None:
            a, b = y0 + start * per, y0 + row * per
            if a > y0 + 1 and b < y1 - 1 and b - a > TIGHT_GAP:
                gaps.append((a, b))
            start = None
    return gaps


def reflow(src_doc, pno, slots):
    """Re-flow an old-layout front page into the new frame. Returns a
    one-page document and the moved slots."""
    page = src_doc[pno]
    h = page.rect.height
    old_top = OLD_STRIP_BOTTOM
    old_bottom = max(r.y1 for r in [d['rect'] for d in page.get_drawings()]
                     if r.width > 500 and r.x0 > 15 and r.y1 < h) - BORDER_W / 2
    new_top, new_bottom = STRIP.y1, BORDER.y1 - BORDER_W / 2

    gaps = blank_gaps(page, old_top, old_bottom)
    cuts = [old_top] + [y for g in gaps for y in g] + [old_bottom]
    segments = list(zip(cuts[0::2], cuts[1::2]))
    content = sum(b - a for a, b in segments)
    scale = (new_bottom - new_top - TIGHT_GAP * len(gaps)) / content
    if not 0.95 < scale <= 1:
        raise SystemExit(f'Page {pno + 1}: would need a {scale:.3f} scale — re-export it from Canva instead')

    # old y -> new y, piecewise: segments scale, gaps collapse to TIGHT_GAP.
    pieces, y = [], new_top
    for i, (a, b) in enumerate(segments):
        pieces.append((a, b, y, y + (b - a) * scale))
        y += (b - a) * scale
        if i < len(gaps):
            ga, gb = gaps[i]
            pieces.append((ga, gb, y, y + TIGHT_GAP))
            y += TIGHT_GAP

    def move(old):
        for a, b, na, nb in pieces:
            if a <= old <= b:
                return na + (old - a) * (nb - na) / (b - a)
        return old

    out = pymupdf.open()
    new = out.new_page(width=page.rect.width, height=h)
    new.set_mediabox(page.mediabox)
    inner_x0, inner_x1 = BORDER.x0 + BORDER_W / 2, BORDER.x1 - BORDER_W / 2
    for a, b, na, nb in pieces[0::2]:
        new.show_pdf_page(pymupdf.Rect(inner_x0, na, inner_x1, nb), src_doc, pno,
                          clip=pymupdf.Rect(inner_x0, a, inner_x1, b), keep_proportion=False)
    new.draw_rect(STRIP, color=(0, 0, 0), fill=STRIP_FILL, width=STRIP_LINE_W)
    new.draw_rect(BORDER, color=BORDER_COLOR, width=BORDER_W)

    moved = {}
    for key, slot in slots.items():
        if key in ('header', 'footer'):
            continue
        slot = dict(slot)
        if key == 'qr':
            top, bottom = move(h - slot['y'] - slot['size']), move(h - slot['y'])
            size = bottom - top
            slot.update(x=round(slot['x'] + (slot['size'] - size) / 2, 2),
                        y=round(h - bottom, 2), size=round(size, 2))
        else:
            slot['baseline'] = round(h - move(h - slot['baseline']), 2)
        moved[key] = slot
    moved.update(school_and_header_slots(h, STRIP))
    print(f'  page {pno + 1}: {len(gaps)} gaps tightened, vertical scale {scale:.4f}')
    return out, moved


def load_layout():
    with open(OUT_LAYOUT) as fh:
        text = fh.read()
    return json.loads(text[text.index('export default ') + len('export default '):])


def build_design(name, layout, canva, sample_id):
    path = os.path.join(OUT_PDF_DIR, f'{name}.pdf')
    current = pymupdf.open(path)
    pages = layout[name]['pages']
    print(name)
    if canva:
        front, front_slots = from_canva(canva, sample_id)
    elif has_band(current[0]):
        print('  front page already has the school band')
        front, front_slots = None, pages[0]
    else:
        front, front_slots = reflow(current, 0, pages[0])

    out = pymupdf.open()
    out.insert_pdf(front if front else current, from_page=0, to_page=0)
    out.insert_pdf(current, from_page=1)
    slots = [front_slots]
    for i, back in enumerate(pages[1:], start=1):
        back = {k: v for k, v in back.items() if k != 'footer'}
        add_value_room(current[i], back)
        slots.append(back)
    add_value_room(out[0], slots[0])

    out.set_metadata({'title': f'Student pamphlet template ({name})', 'author': 'scratchpad Labs'})
    tmp = path + '.tmp'
    out.save(tmp, garbage=4, deflate=True, clean=True)
    current.close()
    os.replace(tmp, path)
    layout[name]['pages'] = slots


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--middle-canva', help='Middle/Prep front page exported from Canva in the new layout')
    ap.add_argument('--foundational-canva', help='Foundational front page exported from Canva in the new layout')
    ap.add_argument('--sample-id', default='sss0001', help='User ID typed into the samples')
    args = ap.parse_args()

    layout = load_layout()
    build_design('foundational', layout, args.foundational_canva, args.sample_id)
    build_design('middle', layout, args.middle_canva, args.sample_id)

    with open(OUT_LAYOUT, 'w') as fh:
        fh.write('// Generated by tools/build_pamphlet_templates.py + tools/add_pamphlet_school_band.py\n')
        fh.write('// — do not edit by hand. PDF points, origin bottom-left (pdf-lib); one entry per template page.\n')
        fh.write('export default ')
        json.dump(layout, fh, indent=2)
        fh.write('\n')
    print(f'Wrote {OUT_PDF_DIR}/*.pdf and {OUT_LAYOUT}')


if __name__ == '__main__':
    main()
