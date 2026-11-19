/* Достаём сцены прямо из собранного приложения: гоняем index.html в jsdom
   и читаем то, что показывает плеер уроков. Так видео всегда совпадает
   с тем, что видит ученик в приложении. */
const fs = require('fs');
const path = require('path');
const {JSDOM} = require('jsdom');

const ROOT = path.resolve(__dirname, '../..');

function boot(){
  const errs = [];
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:8080/',
    beforeParse(w){
      w.addEventListener('error', e => errs.push(String((e.error && e.error.stack) || e.message)));
      w.fetch = () => Promise.resolve({ok: true, status: 200, headers: {get: () => 'json'}, json: async () => ({})});
      w.scrollTo = () => {};
      w.requestAnimationFrame = cb => setTimeout(() => cb(0), 16);
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
        get: (t, k) => k === 'measureText' ? () => ({width: 10}) : () => {},
        set: () => true
      });
      w.speechSynthesis = {getVoices: () => [], speak: () => {}};
    }
  });
  return {dom, w: dom.window, errs};
}

/* Список уроков: {title, scenes:[{who,hanzi,pinyin,ru,sub,loc,art}]} */
function collect(){
  const {w, errs} = boot();
  return new Promise(res => setTimeout(() => {
    const doc = w.document;
    w.location.hash = '#/videos';
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    const items = [...doc.querySelectorAll('.vid-item')];
    const out = [];
    items.forEach(it => {
      it.dispatchEvent(new w.MouseEvent('click', {bubbles: true}));
      const time = (doc.querySelector('.vid-time') || {}).textContent || '/0';
      const n = Number(time.match(/\/\s*(\d+)/)[1]);
      const title = it.textContent.replace(/\s+/g, ' ').trim();
      const scenes = [];
      for (let s = 0; s < n; s++){
        const st = doc.querySelector('.vid-stage');
        scenes.push({
          who: st.querySelector('.vs-who').textContent.trim(),
          hanzi: st.querySelector('.vs-hanzi').textContent.trim(),
          pinyin: st.querySelector('.vs-pinyin').textContent.trim(),
          ru: st.querySelector('.vs-ru').textContent.trim(),
          sub: (st.querySelector('.vs-sub') || {textContent: ''}).textContent.trim(),
          loc: st.querySelector('.vs-loc').textContent.trim(),
          art: st.querySelector('.vs-art').outerHTML
        });
        doc.querySelectorAll('.vid-ctr .btn')[2].dispatchEvent(new w.MouseEvent('click', {bubbles: true}));
      }
      out.push({title, scenes});
    });
    res({lessons: out, errs, w});
  }, 1500));
}

module.exports = {collect, boot};
