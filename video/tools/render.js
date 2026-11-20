/* Рендер одного урока в MP4: кадры SVG→PNG через resvg, звук из mp3, сборка ffmpeg */
const fs = require('fs');
const path = require('path');
const os = require('os');
const {spawnSync} = require('child_process');
const {Resvg} = require('@resvg/resvg-js');
const {compose, W, H} = require('./frame.js');

const FPS = 24;
const ROOT = path.resolve(__dirname, '..');
const FF = process.env.FFMPEG || 'ffmpeg';   // можно указать свой путь: FFMPEG=/путь/ffmpeg
const FONT = path.join(ROOT, 'tools/out/hz.ttf');
const AUDIO = path.join(ROOT, 'audio');

const resvgOpts = {
  fitTo: {mode: 'width', value: W},
  font: {fontFiles: [FONT], loadSystemFonts: true, defaultFontFamily: 'Noto Sans SC'},
  background: '#0d1512'
};

function audioDuration(file){
  const out = spawnSync(FF, ['-hide_banner', '-i', file], {encoding: 'utf8'});
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(out.stderr || '');
  if (!m) throw new Error('не прочитал длительность ' + file);
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

/* когда начинается каждая сцена: пропорционально объёму её реплики,
   с паузой на титульную заставку */
function schedule(sceneCount, weights, total, leadIn){
  const usable = total - leadIn - 0.6; // 0.6 с хвоста, чтобы кадр не обрывался
  const starts = [];
  let acc = leadIn;
  for (let i = 0; i < sceneCount; i++){
    starts.push(acc);
    acc += usable * weights[i];
  }
  return starts;
}

function titleCard(lesson, t, dur){
  const a = Math.min(1, t / 0.5, Math.max(0, (dur - t) / 0.5));
  const kind = lesson.head.split('.')[0];
  const rest = lesson.head.split('.').slice(1).join('.').trim();
  // подгоняем размер заголовка под ширину кадра
  let size = 60;
  while (size > 30 && rest.length * size * 0.56 > W - 160) size -= 2;
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#22332b"></stop>
        <stop offset=".55" stop-color="#182720"></stop>
        <stop offset="1" stop-color="#0e1814"></stop>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#tg)"/>
    <g opacity=".10" fill="none" stroke="#cfe6d4" stroke-width="2">
      ${Array.from({length: 9}, (_, i) => `<path d="M${-200 + i*180} ${H+40} C ${-120 + i*180} ${H-220} ${80 + i*180} ${160} ${260 + i*180} ${-60}"/>`).join('')}
    </g>
    <g opacity="${a.toFixed(3)}">
      <text x="${W/2}" y="${H/2 - 74}" text-anchor="middle" font-family="DejaVu Sans" font-size="24"
            letter-spacing="9" fill="#8fbf9b">${kind.toUpperCase()}</text>
      <text x="${W/2}" y="${H/2 + 4}" text-anchor="middle" font-family="DejaVu Sans" font-size="${size}"
            letter-spacing="1" fill="#fff8ea">${rest.replace(/&/g,'&amp;')}</text>
      <rect x="${W/2 - 70}" y="${H/2 + 46}" width="140" height="4" rx="2" fill="#d0453a"/>
      <text x="${W/2}" y="${H/2 + 108}" text-anchor="middle" font-family="DejaVu Sans" font-size="22"
            letter-spacing="4" fill="#93a89a">汉语学习 · РУССКАЯ ОЗВУЧКА</text>
    </g>
  </svg>`;
}

/* основной цикл: пишем PNG прямо в stdin ffmpeg */
async function build(lessonIdx, lessonData, narr, outFile){
  const audio = path.join(AUDIO, `n${lessonIdx}.mp3`);
  const dur = audioDuration(audio);
  const scenes = lessonData.scenes;
  const leadIn = 3.2;
  const starts = schedule(scenes.length, narr.weights, dur, leadIn);
  const frames = Math.ceil(dur * FPS);

  const ff = require('child_process').spawn(FF, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-i', audio,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-shortest', '-movflags', '+faststart', outFile
  ], {stdio: ['pipe', 'inherit', 'inherit']});

  const write = buf => new Promise(res => {
    if (ff.stdin.write(buf)) res(); else ff.stdin.once('drain', res);
  });
  const done = new Promise((res, rej) => {
    ff.on('close', code => code === 0 ? res() : rej(new Error('ffmpeg вышел с кодом ' + code)));
  });

  for (let f = 0; f < frames; f++){
    const t = f / FPS;
    let svg;
    let sceneIdx = -1;
    for (let i = 0; i < scenes.length; i++) if (t >= starts[i]) sceneIdx = i;
    if (sceneIdx < 0) {
      svg = titleCard({head: narr.head}, t, leadIn);
    } else {
      const local = t - starts[sceneIdx];
      const sc = scenes[sceneIdx];
      const idxInScene = sceneIdx;
      // в первые 0.5 с после смены — плавное появление титров (внутри compose)
      svg = compose(sc, local, {});
    }
    const png = new Resvg(svg, resvgOpts).render().asPng();
    await write(png);
    if (f % 240 === 0) process.stdout.write(`\rурок ${lessonIdx+1}: кадр ${f}/${frames}`);
  }
  ff.stdin.end();
  await done;
  process.stdout.write(`\rурок ${lessonIdx+1}: готово, ${frames} кадров, ${dur.toFixed(1)} с\n`);
  return {dur, frames};
}

module.exports = {build, audioDuration};
