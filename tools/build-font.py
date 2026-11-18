#!/usr/bin/env python3
"""Build BenchZero Segment, the app's own display face, from a segment table.

Every glyph is a set of bevelled bars on a 3 x 3 point grid (like a bench meter's segment
display), slanted 7 degrees. The output is fonts/benchzero-segment.woff2. This is a dev tool
only; the app itself ships the generated file and needs no build step.

Usage: python3 tools/build-font.py   (needs fontTools and brotli)
"""
import math
import os

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

UPM = 1000
ADV = 600          # monospaced advance for every glyph except the narrow ones
NARROW = 300       # space, period, colon
T = 92             # bar thickness
GAP = 16           # gap between bars at a joint
SLANT = math.tan(math.radians(7))
L, M, R = 70, 290, 510
B, H, X, TOP = 0, 350, 350, 700

P = {
    'TL': (L, TOP), 'TC': (M, TOP), 'TR': (R, TOP),
    'ML': (L, H), 'MC': (M, H), 'MR': (R, H),
    'BL': (L, B), 'BC': (M, B), 'BR': (R, B),
    'DL': (L, -190), 'DR': (R, -190), 'DC': (M, -190),
    'QL': (L, 175), 'QR': (R, 175), 'UL': (L, 525), 'UR': (R, 525),
    'TL2': (L + 110, TOP), 'TR2': (R - 110, TOP), 'BL2': (L + 110, B), 'BR2': (R - 110, B),
    'ML2': (L + 110, H), 'MR2': (R - 110, H),
}

# Segment strings: "A-B" bars, "dot@x,y" squares.
S = {
    '0': 'TL-TR TR-MR MR-BR BL-BR BL-ML ML-TL BL2-TR2',
    '1': 'TR-MR MR-BR',
    '2': 'TL-TR TR-MR ML-MR ML-BL BL-BR',
    '3': 'TL-TR TR-MR MR-BR BL-BR ML2-MR',
    '4': 'TL-ML ML-MR TR-MR MR-BR',
    '5': 'TL-TR TL-ML ML-MR MR-BR BL-BR',
    '6': 'TL-TR TL-ML ML-BL BL-BR MR-BR ML-MR',
    '7': 'TL-TR TR-MR MR-BR',
    '8': 'TL-TR TR-MR MR-BR BL-BR BL-ML ML-TL ML-MR',
    '9': 'TL-TR TR-MR MR-BR BL-BR ML-TL ML-MR',
    'A': 'TL-TR TR-MR MR-BR BL-ML ML-TL ML-MR',
    'B': 'TL-TR2 TR2-UR UR-MR MR-QR QR-BR2 BR2-BL BL-ML ML-TL ML-MR',
    'C': 'TL-TR TL-ML ML-BL BL-BR',
    'D': 'TL-TR2 TR2-UR UR-MR MR-QR QR-BR2 BR2-BL BL-ML ML-TL',
    'E': 'TL-TR TL-ML ML-BL BL-BR ML-MR2',
    'F': 'TL-TR TL-ML ML-BL ML-MR2',
    'G': 'TL-TR TL-ML ML-BL BL-BR BR-MR MC-MR',
    'H': 'TL-ML ML-BL TR-MR MR-BR ML-MR',
    'I': 'TL-TR TC-MC MC-BC BL-BR',
    'J': 'TR-MR MR-BR BL-BR BL-QL',
    'K': 'TL-ML ML-BL ML-MC MC-TR MC-BR',
    'L': 'TL-ML ML-BL BL-BR',
    'M': 'TL-ML ML-BL TR-MR MR-BR TL-MC MC-TR',
    'N': 'TL-ML ML-BL TR-MR MR-BR TL-BR',
    'O': 'TL-TR TR-MR MR-BR BL-BR BL-ML ML-TL',
    'P': 'TL-TR TR-MR TL-ML ML-BL ML-MR',
    'Q': 'TL-TR TR-MR MR-BR BL-BR BL-ML ML-TL MC-BR',
    'R': 'TL-TR TR-MR TL-ML ML-BL ML-MR MC-BR',
    'S': 'TL-TR TL-ML ML-MR MR-BR BL-BR',
    'T': 'TL-TR TC-MC MC-BC',
    'U': 'TL-ML ML-BL TR-MR MR-BR BL-BR',
    'V': 'TL-BC TR-BC',
    'W': 'TL-ML ML-BL TR-MR MR-BR BL-MC MC-BR',
    'X': 'TL-BR TR-BL',
    'Y': 'TL-MC TR-MC MC-BC',
    'Z': 'TL-TR TR-BL BL-BR',
    'a': 'ML-MR MR-BR BL-BR BL-QL QL-QR',
    'b': 'TL-ML ML-BL BL-BR MR-BR ML-MR',
    'c': 'ML-MR ML-BL BL-BR',
    'd': 'TR-MR MR-BR BL-BR BL-ML ML-MR',
    'e': 'ML-MR MR-QR QL-QR ML-BL BL-BR',
    'f': 'TC-TR TC-MC MC-BC ML-MR2',
    'g': 'ML-MR MR-BR BR-DR DL-DR ML-QL QL-QR',
    'h': 'TL-ML ML-BL ML-MR MR-BR',
    'i': 'MC-BC dot@290,520',
    'j': 'MR-BR BR-DR DL-DR dot@510,520',
    'k': 'TL-ML ML-BL QL-MR QL-BR',
    'l': 'TC-MC MC-BC BC-BR2',
    'm': 'ML-BL ML-MR MR-BR MC-BC',
    'n': 'ML-BL ML-MR MR-BR',
    'o': 'ML-MR MR-BR BL-BR BL-ML',
    'p': 'ML-MR MR-QR QL-QR ML-DL',
    'q': 'ML-MR ML-QL QL-QR MR-DR',
    'r': 'ML-BL ML-MR',
    's': 'ML-MR ML-QL QL-QR QR-BR BL-BR',
    't': 'TC-MC MC-BC BC-BR2 ML-MR',
    'u': 'ML-BL BL-BR MR-BR',
    'v': 'ML-BC MR-BC',
    'w': 'ML-BL BL-BR MR-BR MC-BC',
    'x': 'ML-BR MR-BL',
    'y': 'ML-QL QL-QR MR-BR BR-DR DL-DR',
    'z': 'ML-MR MR-BL BL-BR',
    'µ': 'ML-DL BL-BR MR-BR',
    'μ': 'ML-DL BL-BR MR-BR',
    'Ω': 'TL-TR TL-ML TR-MR ML-QL MR-QR BL-BL2 BR2-BR',
    'Ω': 'TL-TR TL-ML TR-MR ML-QL MR-QR BL-BL2 BR2-BR',
    '-': 'ML2-MR2',
    '+': 'ML2-MR2 MC-UC MC-QC',
    '/': 'BL-TR',
    '%': 'BL-TR dot@120,610 dot@460,90',
    '(': 'TC-TR2 TC-MC MC-BC BC-BR2',
    ')': 'TL2-TC TC-MC MC-BC BL2-BC',
    '°': 'UL2-UR2 UL2-TL2 UR2-TR2 TL2-TR2',
    '×': 'QL2-UR2 UL2-QR2',
    '=': 'ML2-MR2 QL2-QR2',
}
P.update({
    'UC': (M, 545), 'QC': (M, 155), 'UL2': (L + 110, 470), 'UR2': (R - 110, 470),
    'QL2': (L + 110, 175), 'QR2': (R - 110, 175),
})
S['.'] = 'dot@150,0'
S[':'] = 'dot@150,0 dot@150,330'
S[','] = 'dot@150,0'
S[' '] = ''
NARROW_SET = {' ', '.', ':', ','}


def bar(pen, a, b):
    (x1, y1), (x2, y2) = a, b
    dx, dy = x2 - x1, y2 - y1
    ln = math.hypot(dx, dy)
    ux, uy = dx / ln, dy / ln
    nx, ny = -uy, ux
    h = T / 2
    g = GAP
    pts = [
        (x1 + ux * g, y1 + uy * g),
        (x1 + ux * (g + h) - nx * h, y1 + uy * (g + h) - ny * h),
        (x2 - ux * (g + h) - nx * h, y2 - uy * (g + h) - ny * h),
        (x2 - ux * g, y2 - uy * g),
        (x2 - ux * (g + h) + nx * h, y2 - uy * (g + h) + ny * h),
        (x1 + ux * (g + h) + nx * h, y1 + uy * (g + h) + ny * h),
    ]
    poly(pen, pts)


def dot(pen, x, y):
    s = T * 1.05
    poly(pen, [(x, y), (x + s, y), (x + s, y + s), (x, y + s)])


def poly(pen, pts):
    # Slant, round, and wind clockwise (TrueType outer contours are clockwise).
    pts = [(round(x + y * SLANT), round(y)) for x, y in pts]
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    if area > 0:
        pts = pts[::-1]
    pen.moveTo(pts[0])
    for p in pts[1:]:
        pen.lineTo(p)
    pen.closePath()


def glyph_name(ch):
    if ch == ' ':
        return 'space'
    if ch.isascii() and ch.isalnum():
        return ch if not ch.isdigit() else f'digit{ch}'
    return f'uni{ord(ch):04X}'


def build(out):
    names = ['.notdef']
    cmap = {}
    glyphs = {}
    metrics = {}
    pen = TTGlyphPen(None)
    poly(pen, [(60, 0), (540, 0), (540, 700), (60, 700)])
    glyphs['.notdef'] = pen.glyph()
    metrics['.notdef'] = (ADV, 60)
    for ch, spec in S.items():
        name = glyph_name(ch)
        pen = TTGlyphPen(None)
        for tok in spec.split():
            if tok.startswith('dot@'):
                x, y = (float(v) for v in tok[4:].split(','))
                dot(pen, x, y)
            else:
                a, b = tok.split('-')
                bar(pen, P[a], P[b])
        g = pen.glyph()
        glyphs[name] = g
        names.append(name)
        cmap[ord(ch)] = name
        metrics[name] = (NARROW if ch in NARROW_SET else ADV, 0)
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    glyf = fb.font['glyf']
    hmtx = {}
    for n in names:
        g = glyf[n]
        g.recalcBounds(glyf)
        hmtx[n] = (metrics[n][0], getattr(g, 'xMin', 0) if g.numberOfContours else 0)
    fb.setupHorizontalMetrics(hmtx)
    fb.setupHorizontalHeader(ascent=820, descent=-230)
    fb.setupNameTable({
        'familyName': 'BenchZero Segment',
        'styleName': 'Regular',
        'uniqueFontIdentifier': 'BenchZero Segment Regular 1.0',
        'fullName': 'BenchZero Segment Regular',
        'psName': 'BenchZeroSegment-Regular',
        'version': 'Version 1.000',
        'licenseDescription': 'MIT License. Drawn for the BenchZero project.',
    })
    fb.setupOS2(sTypoAscender=820, sTypoDescender=-230, usWinAscent=880, usWinDescent=260,
                sxHeight=X, sCapHeight=TOP, achVendID='BNCZ', fsType=0)
    fb.setupPost(isFixedPitch=0)
    fb.font.flavor = 'woff2'
    fb.save(out)
    return len(names)


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, '..', 'fonts', 'benchzero-segment.woff2')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    n = build(out)
    print(f'wrote {os.path.normpath(out)} with {n} glyphs, {os.path.getsize(out)} bytes')
