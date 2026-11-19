import sys, os, re, io
from fontTools.ttLib import TTFont
from fontTools.merge import Merger

need = set(sys.argv[1])
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
files_dir = os.path.join(ROOT, 'tools/node_modules/@fontsource/noto-sans-sc/files')
css = open(os.path.join(ROOT, 'tools/node_modules/@fontsource/noto-sans-sc/400.css'), encoding='utf-8').read()

# карта unicode-range -> файл
subs = []
for m in re.finditer(r'src: url\(\./files/([^)]+\.woff2)\)[^;]*;[\s\S]*?unicode-range: ([^;]+);', css):
    subs.append((m.group(1), [r.strip() for r in m.group(2).split(',')]))

def in_range(cp, r):
    if not r.startswith('U+'): return False
    body = r[2:]
    if '?' in body:
        lo = int(body.replace('?', '0'), 16); hi = int(body.replace('?', 'f'), 16)
        return lo <= cp <= hi
    parts = body.split('-')
    lo = int(parts[0], 16); hi = int(parts[1], 16) if len(parts) > 1 else lo
    return lo <= cp <= hi

chosen = []
for ch in need:
    cp = ord(ch)
    for f, ranges in subs:
        if any(in_range(cp, r) for r in ranges):
            chosen.append(f); break
chosen = sorted(set(chosen))
print('подмножеств:', len(chosen))

paths = [os.path.join(files_dir, f) for f in chosen]
if len(paths) == 1:
    out = TTFont(paths[0])
else:
    out = Merger().merge(paths)

os.makedirs(os.path.join(ROOT, 'tools/out'), exist_ok=True)
out.save(os.path.join(ROOT, 'tools/out/hz.ttf'))
sz = os.path.getsize(os.path.join(ROOT, 'tools/out/hz.ttf'))
print('готово:', round(sz/1048576, 2), 'МБ')
# проверим, что иероглифы есть
cmap = out.getBestCmap()
missing = [c for c in need if ord(c) not in cmap]
print('нет глифов:', ''.join(missing) if missing else 'все на месте')
