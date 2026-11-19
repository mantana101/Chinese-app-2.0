/* Кадр целиком: рисунок + титры. Рисунок — вложенный SVG (800×420),
   титры — в пикселях кадра 1280×672. */
const {at} = require('./animate.js');
const W = 1280, H = 672;
const CAST_LIFT = 78;   // героев поднимаем, чтобы лица не прятались под титрами
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/* перенос по словам: подбираем размер шрифта под ширину */
function fit(text, maxW, size, minSize){
  let s = size;
  while (s > minSize && measure(text, s) > maxW) s -= 1;
  return s;
}
function measure(text, size){ return String(text).length * size * 0.55; }

function wrap(text, maxW, size){
  const words = String(text).split(/\s+/);
  const lines = []; let cur = '';
  for (const w of words){
    const next = cur ? cur + ' ' + w : w;
    if (measure(next, size) <= maxW || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function art(scene, t){
  // вырезаем внутренности исходного <svg>, чтобы вложить их со своим viewBox
  let s = at(scene, t, W, H);
  s = s.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  s = s.replace(/ id="(vs[A-Za-z]+)"/g, ' id="$1x"')
       .replace(/url\(#(vs[A-Za-z]+)\)/g, 'url(#$1x)');
  s = s.replace(/<rect width="800" height="420" filter="url\(#vsGrainx?\)"[^>]*><\/rect>/g, '');
  s = s.replace(/<ellipse class="vs-cast-shadow"[^>]*><\/ellipse>/g, '');
  s = s.replace(/transform="translate\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)( scale\([^)]*\))?">\s*<g class="vs-bob"/g,
    (m, x, y, sc) => `transform="translate(${x} ${(parseFloat(y) - CAST_LIFT).toFixed(1)})${sc || ''}"><g class="vs-bob"`);
  return `<svg x="0" y="0" width="${W}" height="${H}" viewBox="0 0 800 420"
            preserveAspectRatio="none">${s}</svg>`;
}

function card(scene, t){
  const appear = Math.min(1, Math.max(0, (t - 0.15) / 0.5));
  const rise = (1 - appear) * 16;
  const CW = 892, CX = (W - CW) / 2;
  const pad = 30;

  const whoSize = 22;
  const hanziSize = fit(scene.hanzi, CW - pad*2, 54, 32);
  const hanziLines = wrap(scene.hanzi, CW - pad*2, hanziSize);
  const pinyinSize = fit(scene.pinyin, CW - pad*2, 26, 17);
  const pinyinLines = wrap(scene.pinyin, CW - pad*2, pinyinSize);
  const ruSize = 27;
  const ruLines = wrap(scene.ru, CW - pad*2, ruSize);
  const sub = scene.sub || '';
  const subLines = sub ? wrap(sub, CW - pad*2 - 44, 19) : [];

  // считаем высоту заранее
  let hh = pad;
  hh += 24;                 // who
  hh += 4;
  hh += hanziLines.length * (hanziSize + 8);
  hh += 8 + pinyinLines.length * (pinyinSize + 6);
  hh += 8 + ruLines.length * (ruSize + 8);
  if (subLines.length) hh += 18 + subLines.length * 25;
  hh += pad + 6;

  const CH = Math.round(hh);
  const CY = H - CH - 14;

  let y = CY + pad + 20;
  let body = '';
  body += `<text x="${W/2}" y="${y}" text-anchor="middle" font-family="DejaVu Sans" font-size="${whoSize}"
            letter-spacing="6" font-weight="bold" fill="#9a7434">${esc((scene.who||'').toUpperCase())}</text>`;
  y += 6;
  for (const ln of hanziLines) {
    y += hanziSize + 8;
    body += `<text x="${W/2}" y="${y}" text-anchor="middle" font-family="Noto Sans SC" font-size="${hanziSize}"
              letter-spacing="3" fill="#23301f">${esc(ln)}</text>`;
  }
  y += 10;
  for (const ln of pinyinLines) {
    y += pinyinSize + 6;
    body += `<text x="${W/2}" y="${y}" text-anchor="middle" font-family="DejaVu Sans" font-size="${pinyinSize}"
              letter-spacing="1" font-weight="bold" fill="#8a6a2e">${esc(ln)}</text>`;
  }
  y += 10;
  for (const ln of ruLines) {
    y += ruSize + 8;
    body += `<text x="${W/2}" y="${y}" text-anchor="middle" font-family="DejaVu Sans" font-size="${ruSize}"
              fill="#3a4436">${esc(ln)}</text>`;
  }
  if (subLines.length) {
    y += 18;
    body += `<rect x="${CX + 26}" y="${y - 18}" width="${CW - 52}" height="${subLines.length*25 + 10}" rx="14"
              fill="#7ba06a" fill-opacity=".14" stroke="#5c7f4e" stroke-opacity=".22" stroke-width="2"/>`;
    for (const ln of subLines){
      y += 25;
      body += `<text x="${W/2}" y="${y - 9}" text-anchor="middle" font-family="DejaVu Sans" font-size="19"
                fill="#4a5c44">${esc(ln)}</text>`;
    }
  }

  return `<g opacity="${appear.toFixed(3)}" transform="translate(0 ${rise.toFixed(1)})">
    <rect x="${CX}" y="${CY}" width="${CW}" height="${CH}" rx="30" fill="#fffcf3" fill-opacity="1"
          stroke="#1f2d26" stroke-opacity=".16" stroke-width="3"/>
    ${body}
  </g>`;
}

function chips(scene){
  const loc = (scene.loc || '').toUpperCase();
  const lw = measure(loc, 21) + 40;
  return `<g opacity=".96">
    <rect x="36" y="30" width="${lw}" height="46" rx="23" fill="#101a14" fill-opacity=".42"/>
    <text x="${36 + lw/2}" y="61" text-anchor="middle" font-family="DejaVu Sans" font-size="21"
          letter-spacing="3" fill="#fff8ea">${esc(loc)}</text>
  </g>`;
}

function compose(scene, t, opts = {}){
  const parts = [`<rect width="${W}" height="${H}" fill="#0d1512"/>`, art(scene, t)];
  if (opts.showText !== false) parts.push(card(scene, t));
  if (opts.showChips !== false) parts.push(chips(scene));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

module.exports = {compose, W, H};
