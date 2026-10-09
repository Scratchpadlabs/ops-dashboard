"""Build the blank Teacher Certificate template from the Canva export.

The certificate is designed in Canva ("Certificate of Completion — Holistic
Progress Card Workshop"). Its blank export still carries one school's name and
academic year in the body ("as part of <School>, during the academic year
<Year>"), so this paints those two lines out with the page background and
saves the result as public/certificates/teacher.png. The dashboard
(src/utils/teacherCertificatePDF.js) prints the teacher's name, the school and
the year back in, in the same fonts (Cinzel Decorative, Raleway).

Everything else — heading, the first two body lines, signatures, stamp,
artwork — stays exactly as exported.

Usage, when the Canva design changes (export PNG, 2000 x 1414, no name):

    pip install pillow
    python3 tools/build_teacher_certificate_template.py Blank-certificate.png

If the layout moves, update the pixel positions in teacherCertificatePDF.js
(LAYOUT) to match.
"""
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'certificates', 'teacher.png')

# Pixel box (2000 x 1414 export) holding "as part of <School>, during the
# academic year" and the year line under it.
SCHOOL_LINES = (720, 866, 1720, 948)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    img = Image.open(sys.argv[1]).convert('RGB')
    if img.size != (2000, 1414):
        sys.exit(f'Expected a 2000 x 1414 export, got {img.size}')
    background = img.getpixel((1200, 600))
    ImageDraw.Draw(img).rectangle(SCHOOL_LINES, fill=background)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, optimize=True)
    print(f'Wrote {OUT} (background {background})')


if __name__ == '__main__':
    main()
