#!/usr/bin/env python3
"""
Writes the scanned-resume fixtures for the OCR tests and the deployed
self-test:

    python3 src/server/ocr/__tests__/fixtures/make-ocr-fixtures.py
    node src/server/ocr/__tests__/fixtures/make-selftest.mjs

A fictional resume is drawn as an image (Pillow, with the macOS Arial fonts)
and roughed up like a scan, then wrapped in a PDF with no text layer, the way
a scanner or a fax service writes one. Python because rasterizing text needs
a font renderer, which Node doesn't have without canvas; the outputs are
committed, so nothing else ever runs this.

    scan-letter.pdf   half a letter page, 300 dpi bilevel, CCITT G4: what an
                      office scanner writes, and the self-test's document
    scan-photo.jpg    a phone photo of a few lines, as an image file

`--bench DIR` also writes full-page variants for measuring recall and speed
(office scan, fax, phone photo, sideways page, a text PDF with a logo).
"""
import io
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'

HEADER = [
    ('name', 'ROWAN Q. TESTPERSON'),
    ('role', 'Senior Data Engineer'),
    ('body', 'rowan.testperson@example.com  |  +1 (555) 010-4477  |  Portland, Oregon'),
    ('body', 'linkedin.com/in/rowan-testperson'),
    ('gap', ''),
    ('head', 'SUMMARY'),
    ('body', 'Data engineer with nine years of experience building reliable pipelines,'),
    ('body', 'warehouses and streaming systems for logistics and healthcare companies.'),
    ('gap', ''),
    ('head', 'EXPERIENCE'),
    ('bold', 'Lumen Freight Analytics - Senior Data Engineer, 2019 - Present'),
    ('body', '- Designed a streaming ingestion platform processing 40 million shipment events a day.'),
    ('body', '- Cut warehouse costs by 35 percent by partitioning and clustering the largest tables.'),
]

REST = [
    ('body', '- Mentored six engineers and led the move from nightly batch jobs to hourly loads.'),
    ('gap', ''),
    ('bold', 'Cedar Health Partners - Data Engineer, 2015 - 2019'),
    ('body', '- Built compliant ETL for claims data from twelve regional insurers.'),
    ('body', '- Automated data quality checks that caught billing errors before month-end close.'),
    ('gap', ''),
    ('head', 'EDUCATION'),
    ('body', 'Oregon State University - B.S. Computer Science, 2015'),
    ('gap', ''),
    ('head', 'SKILLS'),
    ('body', 'Python, SQL, Kafka, Airflow, dbt, Spark, Terraform, PostgreSQL'),
]

SIZES = {'name': 20, 'role': 13, 'head': 12, 'bold': 10.5, 'body': 10.5, 'gap': 6}


def render(lines, dpi_x, dpi_y, width_in, height_in, margin_in=0.75):
    """Black text on white, 8-bit gray, at the given resolution."""
    w, h = round(width_in * dpi_x), round(height_in * dpi_y)
    # Draw at the horizontal resolution, then squash vertically for fax's 204x196.
    img = Image.new('L', (w, round(height_in * dpi_x)), 255)
    draw = ImageDraw.Draw(img)
    y = margin_in * dpi_x
    for style, text in lines:
        size = SIZES[style] * dpi_x / 72
        if text:
            font = ImageFont.truetype(BOLD if style in ('name', 'head', 'bold') else FONT, round(size))
            draw.text((margin_in * dpi_x, y), text, fill=0, font=font)
        y += size * 1.45
    return img.resize((w, h), Image.LANCZOS) if h != img.height else img


def scanned(img, angle=0.35, seed=7, threshold=150):
    """A flatbed scan: a hair of blur and skew, speckles, then bilevel."""
    rnd = random.Random(seed)
    img = img.filter(ImageFilter.GaussianBlur(0.7)).rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=255)
    px = img.load()
    for _ in range(img.width * img.height // 4000):
        px[rnd.randrange(img.width), rnd.randrange(img.height)] = 0
    return img.point(lambda v: 255 if v > threshold else 0).convert('1')


def photographed(img, seed=11):
    """A phone photo: uneven light, a slight tilt, sensor noise, color JPEG."""
    rnd = random.Random(seed)
    img = img.rotate(-1.2, resample=Image.BICUBIC, expand=True, fillcolor=235)
    w, h = img.size
    shade = Image.linear_gradient('L').resize((w, h)).point(lambda v: 205 + v * 40 // 255)
    img = Image.composite(img, shade, img.point(lambda v: 255 if v < 128 else 0))
    noise = Image.effect_noise((w, h), 14)
    img = Image.blend(img, noise, 0.12).filter(ImageFilter.GaussianBlur(0.8))
    rgb = Image.merge('RGB', (img, img.point(lambda v: max(0, v - 6)), img.point(lambda v: max(0, v - 14))))
    return rgb


def g4(img):
    """CCITT Group 4 bytes of a bilevel image, and whether 1 bits are black (as Pillow's own PDF writer sets it)."""
    buf = io.BytesIO()
    img.save(buf, 'TIFF', compression='group4', strip_size=math.ceil(img.width / 8) * img.height)
    tif = Image.open(io.BytesIO(buf.getvalue()))
    offsets, counts = tif.tag_v2[273], tif.tag_v2[279]
    assert len(offsets) == 1, 'one strip'
    raw = buf.getvalue()[offsets[0] : offsets[0] + counts[0]]
    return raw, tif.tag_v2[262] == 1  # libtiff inverts BlackIsZero data before coding it


def jpeg(img, quality=72):
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=quality)
    return buf.getvalue()


class Pdf:
    """Just enough PDF: pages of images placed with a matrix, and optional text."""

    def __init__(self):
        self.objects = []

    def add(self, body):
        self.objects.append(body)
        return len(self.objects)

    def image(self, img, fmt):
        if fmt == 'g4':
            data, black1 = g4(img)
            dict_ = (
                f'/Type /XObject /Subtype /Image /Width {img.width} /Height {img.height} /ColorSpace /DeviceGray '
                f'/BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns {img.width} '
                f'/Rows {img.height} /BlackIs1 {"true" if black1 else "false"} >>'
            )
        else:
            data = jpeg(img)
            cs = '/DeviceRGB' if img.mode == 'RGB' else '/DeviceGray'
            dict_ = f'/Type /XObject /Subtype /Image /Width {img.width} /Height {img.height} /ColorSpace {cs} /BitsPerComponent 8 /Filter /DCTDecode'
        return self.add((f'<< {dict_} /Length {len(data)} >>', data))

    def write(self, path, pages):
        """pages: [(width_pt, height_pt, [(image_obj, a, b, c, d, e, f)], text_ops)]"""
        font = self.add(('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', None))
        pages_obj = len(self.objects) + 1 + 2 * len(pages)
        kids = []
        for w, h, images, text in pages:
            ops = ''.join(f'q {a} {b} {c} {d} {e} {f} cm /Im{i} Do Q\n' for i, (_, a, b, c, d, e, f) in enumerate(images)) + text
            content = self.add((f'<< /Length {len(ops)} >>', ops.encode('latin-1')))
            xobjects = ' '.join(f'/Im{i} {obj} 0 R' for i, (obj, *_rest) in enumerate(images))
            kids.append(
                self.add(
                    (
                        f'<< /Type /Page /Parent {pages_obj} 0 R /MediaBox [0 0 {w} {h}] /Contents {content} 0 R '
                        f'/Resources << /XObject << {xobjects} >> /Font << /F1 {font} 0 R >> >> >>',
                        None,
                    )
                )
            )
        assert self.add((f'<< /Type /Pages /Kids [{" ".join(f"{k} 0 R" for k in kids)}] /Count {len(kids)} >>', None)) == pages_obj
        catalog = self.add(('<< /Type /Catalog /Pages %d 0 R >>' % pages_obj, None))
        out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
        offsets = []
        for i, (dict_, stream) in enumerate(self.objects, 1):
            offsets.append(len(out))
            out += f'{i} 0 obj\n{dict_}\n'.encode('latin-1')
            if stream is not None:
                out += b'stream\n' + stream + b'\nendstream\n'
            out += b'endobj\n'
        xref = len(out)
        out += f'xref\n0 {len(self.objects) + 1}\n0000000000 65535 f \n'.encode()
        for off in offsets:
            out += f'{off:010d} 00000 n \n'.encode()
        out += f'trailer\n<< /Size {len(self.objects) + 1} /Root {catalog} 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
        Path(path).write_bytes(out)
        print(f'{path}: {len(out):,} bytes')


def full_page(img, pdf, fmt='g4'):
    return (612, 792, [(pdf.image(img, fmt), 612, 0, 0, 792, 0, 0)], '')


def main():
    here = Path(__file__).parent

    # Half a letter page (8.5 x 5.5 in), so the self-test OCRs one small page.
    pdf = Pdf()
    half = scanned(render(HEADER, 300, 300, 8.5, 5.5))
    pdf.write(here / 'scan-letter.pdf', [(612, 396, [(pdf.image(half, 'g4'), 612, 0, 0, 396, 0, 0)], '')])

    photo = photographed(render(HEADER[:4], 200, 200, 6.5, 1.6, margin_in=0.4)).resize((1100, 330), Image.LANCZOS)
    buf = io.BytesIO()
    photo.save(buf, 'JPEG', quality=70)
    (here / 'scan-photo.jpg').write_bytes(buf.getvalue())
    print(f'{here / "scan-photo.jpg"}: {len(buf.getvalue()):,} bytes')

    if '--bench' not in sys.argv:
        return
    out = Path(sys.argv[sys.argv.index('--bench') + 1])
    out.mkdir(parents=True, exist_ok=True)
    everything = HEADER + REST
    (out / 'truth.txt').write_text('\n'.join(t for _, t in everything if t) + '\n')

    pdf = Pdf()
    pdf.write(out / 'office-300.pdf', [full_page(scanned(render(everything, 300, 300, 8.5, 11)), pdf)])
    pdf = Pdf()
    pdf.write(out / 'office-200.pdf', [full_page(scanned(render(everything, 200, 200, 8.5, 11), angle=0.8), pdf)])
    pdf = Pdf()
    fax = scanned(render(everything, 204, 196, 8.5, 11), angle=0.6, threshold=140)
    pdf.write(out / 'fax.pdf', [full_page(fax, pdf)])
    pdf = Pdf()
    phone = photographed(render(everything, 250, 250, 8.5, 11))
    pdf.write(out / 'phone.pdf', [full_page(phone, pdf, 'jpeg')])
    pdf = Pdf()
    sideways = scanned(render(everything, 300, 300, 8.5, 11)).rotate(90, expand=True)
    pdf.write(out / 'sideways.pdf', [(792, 612, [(pdf.image(sideways, 'g4'), 792, 0, 0, 612, 0, 0)], '')])
    pdf = Pdf()
    upside = scanned(render(everything, 300, 300, 8.5, 11)).rotate(180)
    pdf.write(out / 'upside-down.pdf', [full_page(upside, pdf)])
    # Two scanned pages.
    pdf = Pdf()
    p1 = scanned(render(HEADER, 300, 300, 8.5, 11))
    p2 = scanned(render(REST, 300, 300, 8.5, 11), seed=9)
    pdf.write(out / 'two-pages.pdf', [full_page(p1, pdf), full_page(p2, pdf)])
    # A born-digital resume with a big photo: the text layer rules it out.
    pdf = Pdf()
    logo = scanned(render([('name', 'LOGO')], 300, 300, 3, 3))
    text = 'BT /F1 11 Tf 54 700 Td (' + ') Tj 0 -14 Td ('.join(t.replace('(', '').replace(')', '') for _, t in everything if t) + ') Tj ET\n'
    pdf.write(out / 'text-with-logo.pdf', [(612, 792, [(pdf.image(logo, 'g4'), 400, 0, 0, 400, 100, 200)], text)])
    # Image files, as imports bring them.
    scanned(render(everything, 300, 300, 8.5, 11)).convert('L').save(out / 'office.png', optimize=True)
    phone.save(out / 'phone.jpg', quality=80)
    # A phone photo stored on its side with EXIF orientation 6 (rotate 90 CW to view).
    exif = Image.Exif()
    exif[0x0112] = 6
    phone.rotate(90, expand=True).save(out / 'phone-exif6.jpg', quality=80, exif=exif)
    phone.save(out / 'phone.webp', quality=80)
    scanned(render(everything, 300, 300, 8.5, 11)).save(out / 'office.tiff', compression='group4')
    phone.convert('L').save(out / 'phone.bmp')
    phone.convert('P', palette=Image.ADAPTIVE).save(out / 'phone.gif')


main()
