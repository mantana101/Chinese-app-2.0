/* Оживляем кадр под момент времени t:
   — говорящий (is-live) открывает рот циклами,
   — оба героя моргают,
   — облака плывут, камера чуть «дышит». */
function splitBusts(svg){
  const parts = svg.split(/(?=<g class="vs-bust)/);
  return parts;
}
function joinBusts(parts){ return parts.join(''); }

function mouth(frag, open){
  if (open){
    return frag
      .replace(/class="vs-mouth-open"/g, 'class="vs-mouth-open" opacity="1"')
      .replace(/class="vs-mouth-closed"/g, 'class="vs-mouth-closed" opacity="0"');
  }
  return frag
    .replace(/class="vs-mouth-open"/g, 'class="vs-mouth-open" opacity="0"')
    .replace(/class="vs-mouth-closed"/g, 'class="vs-mouth-closed" opacity="1"');
}

function blink(frag, closed){
  return frag.replace(/class="vs-lid"/g, `class="vs-lid"${closed ? ' opacity="1"' : ' opacity="0"'}`);
}

function at(scene, t, W = 1280, H = 672){
  let svg = scene.art;

  /* --- герои --- */
  const parts = splitBusts(svg);
  const live = parts.findIndex(p => /class="vs-bust[^"]*is-live/.test(p.split('<g class="vs-bob"')[0] || p));

  /* рот: только у того, кто говорит */
  const talkOpen = (t % 0.72) < 0.44;
  parts.forEach((p, i) => {
    if (!p.startsWith('<g class="vs-bust')) return;
    const isLive = /class="vs-bust[^"]*is-live/.test(p.slice(0, 120));
    parts[i] = mouth(p, isLive ? talkOpen : false);
  });

  /* моргание: оба, с разной фазой */
  const closedA = (t % 4.3) > 4.12;
  const closedB = ((t + 1.7) % 5.1) > 4.93;
  let seen = 0;
  for (let i = 0; i < parts.length; i++){
    if (!parts[i].startsWith('<g class="vs-bust')) continue;
    parts[i] = blink(parts[i], seen === 0 ? closedA : closedB);
    seen++;
  }
  svg = joinBusts(parts);

  /* облака плывут */
  const drift = Math.sin(t * 0.22) * 7;
  svg = svg.replace('<g class="vs-sky-clouds">', `<g class="vs-sky-clouds" transform="translate(${drift.toFixed(2)} 0)">`);

  /* «дыхание» камеры */
  const zoom = 1 + Math.sin(t * 0.35) * 0.005;
  svg = svg.replace(/(viewBox="0 0 800 420")/,
    `$1 transform="scale(${zoom.toFixed(4)}) translate(${((1 - zoom) * 400).toFixed(2)} ${((1 - zoom) * 210).toFixed(2)})"`);

  svg = svg.replace('<svg class="vs-art" viewBox="0 0 800 420"',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" class="vs-art" viewBox="0 0 800 420"`);
  return svg;
}
module.exports = {at};
