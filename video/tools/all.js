const {collect}=require('./data.js');
const narr=require('./narr.json');
const {build}=require('./render.js');
const fs=require('fs');
const path=require('path');
const OUT=path.resolve(__dirname,'../out');
fs.mkdirSync(OUT,{recursive:true});
// без шрифта иероглифы выйдут квадратиками — лучше остановиться сразу
const FONT=path.join(__dirname,'out/hz.ttf');
if(!fs.existsSync(FONT)){
  console.error('Нет шрифта: '+FONT+'\nСоберите его: python3 tools/mkfont.py "$(cat tools/hzchars.txt)"');
  process.exit(1);
}
collect().then(async r=>{
  const done=[];
  for(let i=0;i<r.lessons.length;i++){
    const out=path.join(OUT,`lesson-${i+1}.mp4`);
    if(fs.existsSync(out) && fs.statSync(out).size>200000 && process.env.FORCE!=='1'){
      console.log('пропуск', out); continue;
    }
    const res=await build(i,r.lessons[i],narr[i],out);
    done.push([out,res.dur,res.frames]);
  }
  console.log('ГОТОВО', JSON.stringify(done));
  process.exit(0);
}).catch(e=>{console.error('ОШИБКА',e.message);process.exit(1)});
