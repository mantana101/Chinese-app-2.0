#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Голосовой учитель-панда в каждом уроке.

Мэймэй — панда-учитель: в каждом уроке есть панель с её объяснением
материала. Кнопка «Объяснить урок» (или клик по панде) читает текст
русским голосом (ru-RU, отдельная дорожка — speak() всегда говорит
по-китайски). Во время речи у панды анимируется рот.

Ученики читают только с пиньинем, поэтому объяснение показывается
текстом рядом с аватаром: ребёнок слушает и следит глазами.
"""

import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "src", "data.js")
INDEX = os.path.join(ROOT, "index.html")

READ_SCRIPT = r"""
const fs = require('fs');
const { LESSONS } =
  new Function(fs.readFileSync(process.argv[1], 'utf8') + '\nreturn { LESSONS };')();
process.stdout.write(JSON.stringify(Object.entries(LESSONS).map(([id, l]) => ({
  id, title: l.title, teacher: l.teacher || ''
}))));
"""

DOM_SCRIPT = r"""
const fs = require('fs');
const {JSDOM} = require(process.argv[2] + '/jsdom/lib/api.js');
const spoken = [];
const playedAudio = [];
const dom = new JSDOM(fs.readFileSync(process.argv[1], 'utf8'), {
  runScripts: 'dangerously', url: 'http://127.0.0.1/', pretendToBeVisual: true,
  beforeParse(w) {
    w.matchMedia = () => ({matches: false, addEventListener(){}, removeEventListener(){}});
    // Трекаем попытки воспроизведения записей: jsdom не умеет играть аудио.
    w.HTMLMediaElement.prototype.play = function () {
      playedAudio.push((this.currentSrc || this.src || '').split('/').pop());
      if (this.onplay) this.onplay();
      return Promise.resolve();
    };
    w.speechSynthesis = {
      speak(u){ spoken.push({lang: u.lang, text: u.text}); },
      cancel(){}, getVoices: () => []
    };
    // В настоящем браузере этот класс есть; jsdom его не знает.
    w.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text; this.lang = ''; this.onend = null; this.onerror = null; }
    };
    w.scrollTo = () => {};
    w.fetch = () => Promise.reject(new Error('offline'));
  }
});
const w = dom.window;
setTimeout(() => {
  w.eval("window.__r = document.createElement('div'); window.__r.id='r'; document.body.appendChild(window.__r); renderLesson(window.__r, ['l1'])");
  const r = w.document.getElementById('r');
  const pan = r.querySelector('.panda-teacher');
  const out = { spoken, playedAudio };
  const q = (s) => Array.from(r.querySelectorAll(s));
  out.teacherPanel = !!pan;
  out.pandaSvg = !!r.querySelector('.pa-svg');
  out.mouthOpen = !!r.querySelector('.pa-mouth-open');
  out.mouthClosed = !!r.querySelector('.pa-mouth-closed');
  out.eyes = pan ? pan.querySelectorAll('.pa-eye').length : 0;
  out.aria = pan ? (pan.querySelector('.pa-wrap').getAttribute('aria-label') || '') : '';
  out.sayBtn = pan ? !!pan.querySelector('.pa-say') : false;
  out.slowBtn = pan ? !!pan.querySelector('.pa-slow') : false;
  out.name = pan ? (pan.querySelector('.pa-name').textContent.includes('Мэймэй')) : false;
  out.shown = pan ? pan.querySelector('.pa-text').textContent.length : 0;
  // Модульные проверки речевых помощников (чистые функции).
  out.segs = w.eval("JSON.stringify(segmentsForSpeech('你好， «ни-хао», и учимся'))");
  out.toneStrip = w.eval("stripToneMarks('nǐ hǎo má')");
  out.voicePick = w.eval("VOICES = [{lang:'ru-RU', name:'Elena', localService:true}, {lang:'ru-RU', name:'Google Milena', localService:false}, {lang:'zh-CN', name:'Microsoft Xiaoxiao', localService:false}]; pickVoice('ru').name + '|' + pickVoice('zh').name");
  if (pan) {
    pan.querySelector('.pa-say').click();
  }
  out.chips = q('.step-chip').length;
  out.chipTitles = q('.step-chip .sc-t').map(n => n.textContent).join('|');
  out.tips = q('.pa-tip').length;
  out.exampleCard = q('.pa-example').length;
  out.exampleP = q('.pex-p').length ? q('.pex-p')[0].textContent : '';
  out.hintBtns = q('.hint-btn').length;
  const hintBtn = r.querySelector('.hint-btn');
  if (hintBtn) hintBtn.click();
  out.hintBubbleOpen = !!r.querySelector('.q-hint-bubble.open');
  out.hintText = r.querySelector('.q-hint-bubble') ? r.querySelector('.q-hint-bubble').textContent.trim() : '';
  const quizChip = r.querySelector('.step-chip[data-step="quiz"]');
  if (quizChip) quizChip.click();
  out.quizChipClicked = true;
  out.spokenAfterFirst = spoken.length;
  out.spokenLang = spoken.length ? spoken[0].lang : '';
  out.firstText = spoken.length ? spoken[0].text : '';
  out.zhTexts = JSON.stringify(spoken.filter(s => s.lang === 'zh-CN').map(s => s.text));
  out.ruWithHanzi = spoken.filter(s => s.lang === 'ru-RU' && /[一-鿿]/.test(s.text)).length;
  out.talking = pan ? pan.classList.contains('talking') : false;
  // Клик по самой панде тоже запускает объяснение.
  pan.querySelector('.pa-wrap').click();
  out.spokenAfterAvatarClick = spoken.length;
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}, 900);
"""


def read(*parts) -> str:
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def load_teachers():
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("нет node — нечем разобрать data.js")
    res = subprocess.run([node, "-e", READ_SCRIPT, DATA],
                         capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        raise AssertionError("data.js не разбирается: " + res.stderr[-500:])
    return json.loads(res.stdout)


class TeacherScripts(unittest.TestCase):
    """У каждого урока есть живое объяснение от Мэймэй."""

    @classmethod
    def setUpClass(cls):
        cls.lessons = load_teachers()

    def test_every_lesson_has_teacher(self):
        self.assertEqual(len(self.lessons), 15, "в курсе 15 уроков")
        for l in self.lessons:
            self.assertGreaterEqual(len(l["teacher"]), 120,
                                    f"{l['id']}: объяснение слишком короткое")

    def test_scripts_talk_to_the_child(self):
        """Объяснения — на «ты», с примерами слов урока."""
        for l in self.lessons:
            t = l["teacher"]
            self.assertRegex(t.lower(),
                             r"(ты|теб|тво|слушай|посчитай|нарисуй|подумай|расскажи"
                             r"|тренируйся|попробуй|скажи|опиши|представь|спроси|болей|нажми|закажи"
                             r"|открой|уверяю|готов|верю|проверю|проверь|повтори|смотри|жми"
                             r"|начни|разбирай|составляй|делай|подпиши)",
                             f"{l['id']}: обращение к ребёнку («ты» или просьба-императив)")
            self.assertRegex(t, r"[一-鿿]|[а-яё]+-[а-яё]+",
                             f"{l['id']}: есть слова урока — иероглифами или транскрипцией")
            self.assertIn("!", t, f"{l['id']}: объяснение живое, не сухая справка")

    def test_first_lesson_explains_tones_and_pinyin(self):
        t1 = next(l for l in self.lessons if l["id"] == "l1")["teacher"]
        self.assertIn("тон", t1.lower(), "в l1 Мэймэй объясняет тоны")
        self.assertIn("пиньин", t1.lower(), "в l1 Мэймэй объясняет пиньинь")
        self.assertIn("ни-хао", t1, "и показывает русское чтение")


class TeacherWiring(unittest.TestCase):
    """Рендер, озвучка и анимация рта подключены."""

    def test_app_has_teacher_helpers(self):
        app = read("src", "app.js")
        for name in ("speakRu", "pandaSVG", "renderTeacher", "ru-RU",
                     "panda-teacher", "talking", "pa-mouth-open"):
            self.assertIn(name, app, f"в app.js нет {name}")

    def test_russian_voice_is_separate_from_chinese(self):
        app = read("src", "app.js")
        self.assertIn("u.lang = 'ru-RU'", app,
                      "объяснение учителя должно идти русским голосом")
        self.assertIn("u.lang = 'zh-CN'", app,
                      "китайские слова озвучиваются отдельной дорожкой")
        for name in ("segmentsForSpeech", "stripToneMarks", "pickVoice", "VOICE_PREF"):
            self.assertIn(name, app, f"в app.js нет {name}")
        self.assertIn("natural|neural|google", app,
                      "предпочтение живым голосам (Google/нейро), не «роботам»")
        self.assertIn("xiaoxiao|yunxi|yunyang|tingting", app,
                      "для китайского — известные живые голоса")
        self.assertIn("u.pitch = 1.06", app, "русский голос чуть выше — так дружелюбнее")

    def test_speech_stops_on_navigation(self):
        app = read("src", "app.js")
        self.assertIn("speechSynthesis.cancel()", app.split("hashchange")[1],
                      "уходя со страницы, Мэймэй должна замолчать")

    def test_css_animates_mouth_and_respects_reduced_motion(self):
        css = read("src", "styles.css")
        for cls in (".panda-teacher", ".pa-svg", ".pa-mouth-open", "@keyframes paTalk"):
            self.assertIn(cls, css, f"в styles.css нет {cls}")
        self.assertIn("@keyframes paBlink", css, "панда должна моргать в покое")
        self.assertIn("prefers-reduced-motion", css,
                      "анимации отключаются для тех, кому движение мешает")

    def test_lesson_places_teacher_panel(self):
        app = read("src", "app.js")
        m = app[app.index("function renderLesson"):]
        head = m.index("lesson-head")
        teacher = m.index("renderTeacher(l, id)")
        goals = m.index("Цели урока")
        self.assertTrue(head < teacher < goals,
                        "учитель должен стоять после заголовка и до целей")


class CacheBustingAndMentor(unittest.TestCase):
    """Обновление записей должно доходить до браузера пользователя.

    Аудио отдаётся с «вечным» кэшем (immutable), поэтому при замене
    записей URL обязан меняться: сборка считает AUDIO_VER из хэшей всех
    mp3 и подставляет ?v=... в каждый адрес. Плюс панель Мэймэй и её
    ступеньки — один блок-помощник, а не две отдельные панели."""

    def test_app_urls_have_version(self):
        app = read("src", "app.js")
        self.assertIn("audioUrl", app, "нет помощника адресов аудио")
        self.assertEqual(app.count("audioUrl("), 2,
                         "оба места воспроизведения (объяснение урока, ступеньки) идут через audioUrl")
        self.assertIn("const audioUrl = (path)", app, "объявление помощника адресов")
        self.assertIn("'?v='", app)

    def test_build_injects_audio_version(self):
        html_path = os.path.join(ROOT, "index.html")
        if not os.path.exists(html_path):
            self.skipTest("нет index.html — сначала сборка")
        html = read("index.html")
        import re
        m = re.search(r"window\.AUDIO_VER = \"([0-9a-f]{10})\"", html)
        self.assertIsNotNone(m, "сборка не инжектит window.AUDIO_VER")
        self.assertNotEqual(m.group(1), "0" * 10, "AUDIO_VER должен считаться из mp3")

    def test_mentor_is_one_block(self):
        app = read("src", "app.js")
        self.assertIn("mentor.appendChild(renderSteps(l))",
                      app, "ступеньки должны жить внутри панели Мэймэй")
        self.assertIn("steps-path steps-block", app, "класс объединённого блока")
        # Панель ступенек больше не отдельная
        self.assertNotIn("const pan = el('div', 'panel steps-path');", app)

    def test_css_wraps_mentor(self):
        css = read("src", "styles.css")
        self.assertIn(".steps-block", css)
        self.assertIn("flex-wrap: wrap", css, "панель должна переносить ступеньки на новую строку")


class StepAudioWired(unittest.TestCase):
    """Ступеньки обязаны играть записи, а не молча падать в синтез.

    Раньше у объектов PANDA_STEPS пропал audio: — правка текстов затёрла
    поле, и ступеньки во всех уроках молча говорили голосом браузера.
    Пользователь слышал «тот же голос», хотя записи обновлялись."""

    def test_every_step_has_audio_and_file(self):
        import re as _re
        app = read("src", "app.js")
        block = app[app.index("const PANDA_STEPS = ["):app.index("];", app.index("const PANDA_STEPS = ["))]
        paths = _re.findall(r"audio: '([^']+)'", block)
        self.assertEqual(len(paths), 7,
                         f"у каждой из 7 ступенек должна быть запись, найдено {len(paths)}")
        for path in paths:
            self.assertTrue(os.path.exists(os.path.join(ROOT, path)),
                            f"нет файла записи: {path}")

    def test_homework_tip_uses_recording(self):
        hw = read("src", "homework.js")
        self.assertIn("audio: 'audio/step-hw-v3.mp3'", hw)

    def test_voice_tag_on_filenames(self):
        app = read("src", "app.js")
        self.assertIn("VOICE_TAG", app)
        self.assertIn("VOICE_TAG = 'v3'", app, "метка голоса — v3")
        self.assertIn("+ '-' + VOICE_TAG + '.mp3'", app,
                      "объяснение урока строит имя с меткой голоса")

    def test_no_probe_race_before_play(self):
        """Запись должна играть СРАЗУ, без предварительной HEAD-пробы.

        Проба на медленной сети не успевала к клику — playStudio
        возвращал false, и Мэймэй молча переходила на синтез даже там,
        где запись есть. Теперь играем сразу: ошибку ловит onerror."""
        app = read("src", "app.js")
        self.assertNotIn("probeStudio", app,
                         "HEAD-проба удалена — она создавала гонку")
        self.assertIn("a.onerror", app, "ошибку записи ловит Audio.onerror")

    def test_teacher_receives_lesson_id(self):
        """«Объяснить урок» строит имя записи из id урока.

        У объектов LESSONS нет поля id (это ключ объекта): передача
        l.id давала audio/undefined-v3.mp3 -> 404 -> молча синтез.
        Самая дорогая ошибка всей истории голоса — проверяем её."""
        app = read("src", "app.js")
        self.assertIn("function renderTeacher(l, id)", app,
                      "renderTeacher должен получать id урока")
        self.assertIn("playStudio(id, rate)", app,
                      "имя записи строится из id, а не из l.id")
        self.assertNotIn("playStudio(l.id", app,
                         "l.id не существует — это давало undefined в имени файла")
        self.assertIn("renderTeacher(l, id)", app,
                      "вызов передаёт id")

    def test_synth_fallback_is_visible(self):
        app = read("src", "app.js")
        self.assertIn("studioMissingNote", app,
                      "фолбэк на синтез обязан быть виден пользователю")
        css = read("src", "styles.css")
        self.assertIn(".pa-synth-note", css)
        self.assertIn(".pa-voice-badge", css, "бейдж источника голоса должен быть стилизован")


class StalePageAutoReload(unittest.TestCase):
    """Устаревшая копия страницы сама перезагружается один раз.

    Дети не жмут кнопку на баннере «Доступна новая версия» — раньше
    они могли месяцами сидеть на старой странице со старым голосом."""

    def test_auth_reloads_automatically_once(self):
        auth = read("src", "auth.js")
        self.assertIn("sessionStorage.setItem(key, '1')", auth)
        self.assertIn("hardReload()", auth.split("function checkBuildFreshness")[1].split("function hardReload")[0],
                      "перезагрузка должна идти из проверки свежести")


class DockerShipsAudio(unittest.TestCase):
    """Записи голоса обязаны доехать до production.

    Dockerfile собирает контейнер Render: если папки audio в образе нет,
    /audio/*.mp3 отвечает 404 и Мэймэй молча падает на браузерный синтез
    — пользователь слышит «тот же голос», хотя все записи обновлены.
    Этот тест не даёт повториться самой дорогой ошибке проекта."""

    def test_dockerfile_copies_audio_before_build(self):
        docker = read("Dockerfile")
        self.assertIn("COPY audio ./audio", docker,
                      "аудио должно копироваться в образ")
        copy_audio = docker.index("COPY audio ./audio")
        build = docker.index("python3 build.py")
        self.assertLess(copy_audio, build,
                        "аудио должно попасть в образ ДО сборки, иначе AUDIO_VER посчитается без файлов")

    def test_dockerignore_keeps_audio(self):
        di = read(".dockerignore")
        self.assertNotIn("audio", di.replace("аудио", ""),
                         ".dockerignore не должен исключать аудио")


class TeacherInBrowser(unittest.TestCase):
    """Панда рисуется и говорит по-русски — проверяем настоящий DOM."""

    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("нет node — нечего проверять в браузере")
        if not os.path.isdir(os.path.join(ROOT, "node_modules", "jsdom")):
            raise unittest.SkipTest("нет jsdom — браузерные проверки пропущены")
        if not os.path.exists(INDEX):
            raise unittest.SkipTest("нет index.html — сначала сборка")
        res = subprocess.run([node, "-e", DOM_SCRIPT, INDEX,
                              os.path.join(ROOT, "node_modules")],
                             capture_output=True, text=True, timeout=180)
        if res.returncode != 0:
            raise AssertionError("jsdom упал: " + res.stderr[-800:])
        cls.out = json.loads(res.stdout)

    def test_panel_renders_with_panda(self):
        self.assertTrue(self.out["teacherPanel"], "панели учителя нет в уроке")
        self.assertTrue(self.out["pandaSvg"], "SVG-панды нет")
        self.assertTrue(self.out["mouthOpen"] and self.out["mouthClosed"],
                        "нужны оба состояния рта: закрытый и открытый")
        self.assertEqual(self.out["eyes"], 2, "у панды два глаза")

    def test_avatar_is_labelled(self):
        self.assertIn("Мэймэй", self.out["aria"], "аватар подписан для скринридера")
        self.assertTrue(self.out["name"], "имя учителя показано в панели")

    def test_buttons_and_text(self):
        self.assertTrue(self.out["sayBtn"], "нет кнопки «Объяснить урок»")
        self.assertTrue(self.out["slowBtn"], "нет медленного объяснения")
        self.assertGreater(self.out["shown"], 120,
                           "текст объяснения должен быть показан ребёнку целиком")

    def test_learning_path_renders(self):
        """Ступеньки, подсказки у разделов, пример и кнопка «Подсказка»."""
        self.assertGreaterEqual(self.out["chips"], 6,
                                "в детском уроке должно быть 6–7 ступенек")
        self.assertIn("Учитель", self.out["chipTitles"])
        self.assertIn("Практика", self.out["chipTitles"])
        self.assertIn("Домашка", self.out["chipTitles"])
        self.assertGreaterEqual(self.out["tips"], 4,
                                "подсказки Мэймэй должны стоять у словаря, грамматики, диалога и практики")
        self.assertEqual(self.out["exampleCard"], 1, "карточка «Пример от Мэймэй» — одна")
        self.assertEqual(self.out["exampleP"], "wǒ jiào Xiǎo Míng.",
                         "в l1 пример — «Меня зовут Сяо Мин»")
        self.assertGreaterEqual(self.out["hintBtns"], 1,
                                "в практике должна быть кнопка «Подсказка»")

    def test_hint_button_opens_bubble(self):
        self.assertTrue(self.out["hintBubbleOpen"], "клик по «Подсказка» показывает подсказку")
        self.assertIn("nǐ hǎo", self.out["hintText"], "подсказка первого вопроса содержит чтение")

    def test_click_plays_studio_recording(self):
        """Клик по кнопке и по панде играет студийную запись урока."""
        self.assertGreaterEqual(len(self.out["playedAudio"]), 2,
                                "кнопка «Объяснить» и клик по панде — оба должны играть запись")
        self.assertIn("l1-v3.mp3", self.out["playedAudio"][0],
                      f"первое воспроизведение — запись урока, было: {self.out['playedAudio'][0]}")
        self.assertTrue(self.out["talking"], "во время речи панда получает .talking")

    def test_chinese_words_go_to_chinese_voice(self):
        """Китайские слова из объяснения читает zh-CN голос, а не русский."""
        zh = json.loads(self.out["zhTexts"])
        self.assertTrue(zh, "в речи Мэймэй должны быть китайские фразы")
        self.assertTrue(all("/[一-鿿]/" and any("\u4e00" <= c <= "\u9fff" for c in s) for s in zh),
                        f"китайские реплики состоят из иероглифов: {zh}")
        self.assertIn("你好", "".join(zh), "в l1 Мэймэй произносит 你 по-настоящему")
        self.assertEqual(self.out["ruWithHanzi"], 0,
                         "русский голос не должен читать иероглифы")

    def test_speech_helpers(self):
        """Сегментация, снятие тоновых значков и выбор голоса."""
        segs = json.loads(self.out["segs"])
        self.assertEqual(segs, [
            {"lang": "zh", "text": "你好，"},
            {"lang": "ru", "text": "«ни-хао», и учимся"}
        ], f"текст режется на языковые фразы, получено: {segs}")
        self.assertEqual(self.out["toneStrip"], "ni hao ma",
                         "значки тонов снимаются: русский голос читает буквы")
        self.assertEqual(self.out["voicePick"], "Google Milena|Microsoft Xiaoxiao",
                         "из списка берутся предпочтительные живые голоса")


if __name__ == "__main__":
    unittest.main()


class StudioAudio(unittest.TestCase):
    """Студийная озвучка объяснений: файл на урок, сервер отдаёт.

    Записанный голос звучит живее браузерного синтеза, поэтому объяснения
    Мэймэй хранятся файлами audio/lN.mp3. Сценарии — в audio/narration.json,
    они обязаны покрывать все уроки (без пропусков) и совпадать по смыслу:
    каждый сценарий объясняет материал своего урока на «ты»."""

    def test_every_lesson_has_audio_file(self):
        import re
        node = shutil.which("node")
        if not node:
            self.skipTest("нет node — нечем разобрать data.js")
        res = subprocess.run([node, "-e", READ_SCRIPT, DATA],
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(res.returncode, 0, res.stderr[-300:])
        ids = json.loads(res.stdout) and [l["id"] for l in json.loads(res.stdout)]
        self.assertTrue(ids)
        for lid in ids:
            f = os.path.join(ROOT, "audio", lid + "-v3.mp3")
            self.assertTrue(os.path.exists(f), f"нет студийной озвучки {f}")
            size = os.path.getsize(f)
            self.assertGreater(size, 50_000, f"{lid}: файл слишком короткий ({size} Б)")
            with open(f, "rb") as fh:
                head = fh.read(3)
            self.assertTrue(head == b"ID3" or head[:2] == b"\xff\xfb",
                            f"{lid}: это не MP3")

    def test_narration_scripts_cover_all_lessons(self):
        import re
        with open(os.path.join(ROOT, "audio", "narration.json"), encoding="utf-8") as f:
            scripts = json.load(f)
        for key in ("_comment", "_voice", "steps"):
            scripts.pop(key, None)
        node = shutil.which("node")
        if not node:
            self.skipTest("нет node — нечем разобрать data.js")
        res = subprocess.run([node, "-e", READ_SCRIPT, DATA],
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(res.returncode, 0, res.stderr[-300:])
        ids = [l["id"] for l in json.loads(res.stdout)]
        self.assertEqual(sorted(scripts), sorted(ids),
                         "сценарии озвучки должны покрывать все уроки и только их")
        for lid, text in scripts.items():
            self.assertGreaterEqual(len(text), 120, f"{lid}: сценарий слишком короткий")
            self.assertRegex(text.lower(),
                             r"(ты|теб|тво|посчитай|нарисуй|подумай|расскажи|тренируйся"
                             r"|попробуй|скажи|опиши|представь|спроси|болей|нажми|закажи"
                             r"|открой|уверяю|готов|верю|проверю|проверь|повтори|смотри|жми"
                             r"|начни|разбирай|составляй|делай|подпиши)",
                             f"{lid}: сценарий обращается к ребёнку")



class LearningPath(unittest.TestCase):
    """Ступеньки урока: Мэймэй ведёт по разделам, подсказывает и даёт пример.

    В каждом уроке есть путь-«лесенка» (Учитель → Слова → … → Домашка),
    у каждого раздела — подсказка Мэймэй с озвучкой, в панели учителя —
    живой пример фразы урока, в практике — кнопка «Подсказка» до ответа.
    Шаги озвучены студийной записью audio/step-*.mp3, общей для уроков.
    """

    @classmethod
    def setUpClass(cls):
        cls.lessons = load_teachers()

    def test_example_present_and_hanzi(self):
        import re as _re
        for l in self.lessons:
            pass  # примеры проверяются через READ_SCRIPT_EXT ниже
        src = read("src", "data.js")
        for lid, ex in (("l1", "我叫小明"), ("l2", "多少钱"), ("l8", "喝茶吗"),
                        ("l10", "把书放进"), ("l15", "明年我想去中国")):
            self.assertIn(ex, src, f"в {lid} нет примера «{ex}»")
        # У каждого урока есть строка example со всеми тремя полями.
        count = len(_re.findall(r"example: \{ h: '[^']+', p: '[^']+', r: '[^']+' \}", src))
        self.assertGreaterEqual(count, 15, "example есть не во всех уроках")

    def test_step_recordings_exist(self):
        import json as _json
        with open(os.path.join(ROOT, "audio", "narration.json"), encoding="utf-8") as f:
            narr = _json.load(f)
        steps = narr.get("steps") or {}
        self.assertEqual(len(steps), 7, "в сценарии должны быть все 7 подсказок-ступенек")
        for key, text in steps.items():
            self.assertGreater(len(text), 30, f"step {key}: текст слишком короткий")
            f = os.path.join(ROOT, "audio", f"step-{key}-v3.mp3")
            self.assertTrue(os.path.exists(f), f"нет записи {f}")
            with open(f, "rb") as fh:
                head = fh.read(3)
            self.assertTrue(head == b"ID3" or head[:2] == b"\xff\xfb", f"{key}: это не MP3")
            self.assertGreater(os.path.getsize(f), 20_000, f"step-{key}: запись слишком короткая")

    def test_steps_and_tips_wired(self):
        app = read("src", "app.js")
        for name in ("PANDA_STEPS", "renderSteps", "pandaTip", "playStepAudio",
                     "stepsForLesson", "sec-teacher", "sec-quiz", "hint-btn",
                     "q-hint-bubble", "window.pandaTip"):
            self.assertIn(name, app, f"в app.js нет {name}")
        self.assertIn("location.hash = '#/homework/'", app,
                      "ступенька «Домашка» должна вести на домашку")
        self.assertIn("scrollIntoView", app, "переход к разделу — плавный скролл")

    def test_homework_shows_panda_tip(self):
        hw = read("src", "homework.js")
        self.assertIn("window.pandaTip", hw,
                      "в домашке должна быть подсказка Мэймэй")

    def test_css_styles_path_and_hints(self):
        css = read("src", "styles.css")
        for cls in (".steps-path", ".step-chip", ".pa-tip", ".pa-example",
                    ".hint-btn", ".q-hint-bubble", ".sc-num", ".pex-p"):
            self.assertIn(cls, css, f"в styles.css нет {cls}")
