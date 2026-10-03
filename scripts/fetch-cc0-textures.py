#!/usr/bin/env python3
"""
Fetch the CC0 PBR texture sets used by src/render/materials/assets.ts from Poly Haven (1K JPG) and
re-encode them as WebP into src/render/materials/cc0/<id>/{albedo,normal,arm}.webp (Vite emits them as
hashed assets, so the web, PWA and native builds all ship them).

Poly Haven assets are CC0 1.0 (https://polyhaven.com/license). Re-run after changing SETS; the
budget test (tests/unit/asset-budget.test.ts) fails if the folder grows past its limits.
Usage: python3 scripts/fetch-cc0-textures.py   (needs Pillow with WebP support)
"""
import io
import json
import os
import subprocess
import sys

from PIL import Image

SETS = [
    'concrete_floor_worn_001',
    'red_brick',
    'wood_floor',
    'asphalt_02',
    'leafy_grass',
    'painted_plaster_wall',
    'bark_brown_02',
]
MAPS = {'Diffuse': ('albedo', 80), 'nor_gl': ('normal', 88), 'arm': ('arm', 82)}
RES = '1k'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'render', 'materials', 'cc0')


def get(url: str) -> bytes:
    # curl uses the system trust store; python.org builds of Python often lack one
    return subprocess.run(['curl', '-fsSL', '-A', 'drone-sim-asset-fetch/1.0', url], check=True, capture_output=True).stdout


def main() -> int:
    credits = []
    for asset in SETS:
        files = json.loads(get(f'https://api.polyhaven.com/files/{asset}'))
        info = json.loads(get(f'https://api.polyhaven.com/info/{asset}'))
        out = os.path.join(ROOT, asset)
        os.makedirs(out, exist_ok=True)
        for key, (name, quality) in MAPS.items():
            url = files[key][RES]['jpg']['url']
            img = Image.open(io.BytesIO(get(url))).convert('RGB')
            img.save(os.path.join(out, f'{name}.webp'), 'WEBP', quality=quality, method=6)
        authors = ', '.join(sorted(info.get('authors', {}).keys()))
        credits.append(f'{asset}: "{info.get("name", asset)}" by {authors}, https://polyhaven.com/a/{asset}')
        print('ok', asset)
    print('\n'.join(credits))
    return 0


if __name__ == '__main__':
    sys.exit(main())
