#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Режим Джарвиса: голосовой разговор с Мэймэй без внешних сервисов.

🎙 — распознавание речи встроено в браузер (SpeechRecognition, ru-RU);
высказанное уходит в чат как обычный вопрос. 🔊 — автоозвучка: Мэймэй
сама читает ответы (speakRu, тем же голосом, что и уроки), выбор
запоминается. Если браузер не умеет распознавать речь — честная
подсказка, чат не ломается. «Джарвис» с GitHub не встраивался: там
нужны ключи OpenAI/HuggingFace и Python-стек — не подходит сайту.
"""

import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Сценарий 1: браузер без SpeechRecognition (как jsdom) — честная подсказка.
DOM_SCRIPT = r"""
const fs = require('fs');
const {JSDOM} = require(process.argv[2] + '/jsdom/lib/api.js');
const dom = new JSDOM(fs.readFileSync(process.argv[1], 'utf8'), {
  runScripts: 'dangerously', url: 'http://127.0.0.1/', pretendToBeVisual: true,
  beforeParse(w) {
    w.matchMedia = () => ({matches: false, addEventListener(){}, removeEventListener(){}});
    w.HTMLMediaElement.prototype.play = () => Promise.resolve();
    w.speechSynthesis = {speak(){}, cancel(){}, getVoices: () => []};
    w.SpeechSynthesisUtterance = function (text) { this.text = text; };
    w.scrollTo = () => {};
    w.fetch = () => Promise.reject(new Error('offline'));
    w.localStorage.setItem('zh_tutor_voice', '1'); /* автоозвучка включена */
  }
});
const w = dom.window;
setTimeout(() => {
  const host = w.document.createElement('div');
  host.id = 'tv-host';
  w.document.body.appendChild(host);
  w.eval("window.__host = document.getElementById('tv-host'); renderTutor(window.__host)");
  const q = (s) => host.querySelector(s);
  const out = {};

  out.mic = !!q('.t-mic');
  out.autovoiceOn = q('.t-autovoice') ? q('.t-autovoice').textContent : '';
  out.micNoteHidden = q('.t-mic-note') ? q('.t-mic-note').hidden : null;

  /* Микрофон без поддержки браузера: подсказка, а не ошибка */
  q('.t-mic').click();
  out.micNoteShown = q('.t-mic-note') ? !q('.t-mic-note').hidden : null;
  out.micNoteText = q('.t-mic-note') ? q('.t-mic-note').textContent.slice(0, 60) : '';

  /* Автоозвучка: ответ агента читается голосом сама */
  let spoken = 0;
  w.speechSynthesis.speak = () => { spoken++; };
  w.speechSynthesis.cancel = () => {};
  w.eval("window.__host.querySelector('.t-chips button').click()");
  setTimeout(() => {
    out.spoken = spoken;
    out.badge = !!q('.t-mode-local, .t-mode-ai, .t-mode-sources');
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }, 400);
}, 900);
"""


def read(*parts) -> str:
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


class TutorVoiceWiring(unittest.TestCase):
    """Микрофон, автоозвучка и запоминание выбора подключены в коде."""

    def test_voice_code_present(self):
        app = read("src", "app.js")
        self.assertIn("webkitSpeechRecognition", app, "нет распознавания речи браузера")
        self.assertIn("recog.lang = 'ru-RU'", app, "распознавание должно быть на русском")
        self.assertIn("window.self !== window.top", app,
                      "нет определения встроенного окна — в предпросмотре микрофон молчал")
        self.assertIn("Микрофон запрещён", app, "нет честного сообщения при отказе доступа")
        self.assertIn("'no-speech'", app, "нет сообщения, когда речи не услышали")
        self.assertIn("micAborted", app, "ручной стоп должен отменять отправку")
        self.assertIn("micAskPermission", app, "нет предварительного запроса микрофона")
        self.assertIn("getUserMedia({ audio: true })", app, "нет запроса разрешения через getUserMedia")
        self.assertIn("Настройки сайтов", app, "нет мобильного пути настройки")
        self.assertIn("service-not-allowed", app, "нет подсказки для телефонов без сервисов Google")
        self.assertIn("voiceBtn.type = 'button'", app, "кнопка голоса отправляла форму")
        self.assertIn("if (said) sendMsg(said);", app, "сказанное не уходит в чат")
        self.assertIn("'zh_tutor_voice'", app, "выбор автоозвучки не запоминается")
        self.assertIn("speakRu(replyObj.sayRu, 0.95);", app, "автоозвучка не вызывает speakRu")
        self.assertIn("как с Джарвисом", app, "нет приглашения в подзаголовке")

    def test_readme_describes_jarvis_mode(self):
        readme = read("README.md")
        self.assertIn("Режим Джарвиса", readme)
        self.assertIn("встроенная в браузер", readme, "должно быть видно, что без внешних сервисов")

    def test_css_styles_mic(self):
        css = read("src", "styles.css")
        for cls in (".t-mic-live", ".t-mic-note", "t-mic-pulse"):
            self.assertIn(cls, css, f"в styles.css нет {cls}")


DOM_SCRIPT2 = r"""
const fs = require('fs');
const {JSDOM} = require(process.argv[2] + '/jsdom/lib/api.js');
const dom = new JSDOM(fs.readFileSync(process.argv[1], 'utf8'), {
  runScripts: 'dangerously', url: 'http://127.0.0.1/', pretendToBeVisual: true,
  beforeParse(w) {
    w.matchMedia = () => ({matches: false, addEventListener(){}, removeEventListener(){}});
    w.HTMLMediaElement.prototype.play = () => Promise.resolve();
    w.speechSynthesis = {speak(){}, cancel(){}, getVoices: () => []};
    w.SpeechSynthesisUtterance = function (text) { this.text = text; };
    w.scrollTo = () => {};
    w.fetch = () => Promise.reject(new Error('offline'));
    /* Фейковый распознаватель: поведение задаётся w.__srMode. */
    w.SpeechRecognition = class {
      start() {
        const mode = w.__srMode;
        setTimeout(() => {
          if (mode === 'deny') { this.onerror && this.onerror({error: 'not-allowed'}); return; }
          if (mode === 'silence') { this.onend && this.onend(); return; }
          if (mode === 'hold') { return; } /* слушает молча, до ручного стопа */
          this.onresult && this.onresult({resultIndex: 0, results: [[{transcript: mode}]]});
          this.onend && this.onend();
        }, 30);
      }
      stop() { setTimeout(() => { this.onend && this.onend(); }, 10); }
    };
    /* Стаб запроса микрофона: поведение задаётся w.__micMode. */
    Object.defineProperty(w.navigator, 'mediaDevices', {
      value: {
        getUserMedia: () => {
          if (w.__micMode === 'deny') {
            return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
          }
          if (w.__micMode === 'nodev') {
            return Promise.reject(Object.assign(new Error('x'), { name: 'NotFoundError' }));
          }
          return Promise.resolve({ getTracks: () => [] });
        }
      },
      configurable: true
    });
  }
});
const w = dom.window;
setTimeout(() => {
  const host = w.document.createElement('div');
  host.id = 'tv2-host';
  w.document.body.appendChild(host);
  w.eval("window.__host = document.getElementById('tv2-host'); renderTutor(window.__host)");
  const q = (s) => host.querySelector(s);
  const note = () => (q('.t-mic-note') && !q('.t-mic-note').hidden) ? q('.t-mic-note').textContent : '';
  const userMsgs = () => host.querySelectorAll('.t-msg.t-user').length;
  const out = {};
  const mic = q('.t-mic');

  /* A. Отказ доступа: честная инструкция, а не тишина */
  w.__micMode = 'deny';
  w.__srMode = 'deny';
  mic.click();
  setTimeout(() => {
    out.deny = { note: note().slice(0, 400) };
    /* B2. Микрофона нет вовсе */
    w.__micMode = 'nodev';
    mic.click();
    setTimeout(() => {
      out.nodev = { note: note().slice(0, 90) };
      /* B. Тишина: подсказка говорить ближе, вопрос не отправляется */
      w.__micMode = 'ok';
      w.__srMode = 'silence';
      mic.click();
      setTimeout(() => {
        out.silence = { note: note().slice(0, 90), userMsgs: userMsgs() };
        /* C. Услышанная речь уходит в чат и получает ответ */
        w.__srMode = 'привет';
        mic.click();
        setTimeout(() => {
          out.spoken = { userMsgs: userMsgs(),
            userText: q('.t-msg.t-user') ? q('.t-msg.t-user').textContent.slice(0, 40) : '',
            gotReply: host.querySelectorAll('.t-msg.t-bot').length > 1 };
          /* D. Ручной стоп: недосказанное не уходит в чат */
          w.__srMode = 'hold'; /* слушает молча */
          mic.click();
          setTimeout(() => {
            const before = userMsgs();
            mic.click(); /* стоп вручную */
            setTimeout(() => {
              out.stop = { userMsgs: userMsgs(), unchanged: userMsgs() === before,
                stoppedNote: note().length === 0 };
              process.stdout.write(JSON.stringify(out));
              process.exit(0);
            }, 120);
          }, 100);
        }, 200);
      }, 120);
    }, 120);
  }, 120);
}, 900);
"""


class TutorVoiceMic(unittest.TestCase):
    """jsdom с фейковым распознавателем: все сценарии кнопки 🎙 честные."""

    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("нет node — нечего проверять в браузере")
        if not os.path.isdir(os.path.join(ROOT, "node_modules", "jsdom")):
            raise unittest.SkipTest("нет jsdom — браузерные проверки пропущены")
        index = os.path.join(ROOT, "index.html")
        if not os.path.exists(index):
            raise unittest.SkipTest("нет index.html — сначала сборка")
        res = subprocess.run([node, "-e", DOM_SCRIPT2, index,
                              os.path.join(ROOT, "node_modules")],
                             capture_output=True, text=True, timeout=180)
        if res.returncode != 0:
            raise AssertionError("jsdom упал: " + res.stderr[-800:])
        cls.out = json.loads(res.stdout)

    def test_denied_mic_gets_instruction(self):
        self.assertIn("Микрофон запрещён", self.out["deny"]["note"],
                      "при отказе доступа была тишина: " + self.out["deny"]["note"])
        self.assertIn("Разрешения", self.out["deny"]["note"],
                      "в инструкции нет пути включения через разрешения сайта")
        self.assertIn("текстом", self.out["deny"]["note"],
                      "нет запасного пути — писать текстом")

    def test_no_mic_device_explained(self):
        self.assertIn("не найден", self.out["nodev"]["note"].lower(),
                      "отсутствие микрофона не объяснено")

    def test_silence_gets_hint(self):
        self.assertIn("не услышала", self.out["silence"]["note"].lower(),
                      "при тишине нет подсказки")
        self.assertEqual(self.out["silence"]["userMsgs"], 0, "тишина не должна отправлять вопрос")

    def test_spoken_words_become_question(self):
        st = self.out["spoken"]
        self.assertGreater(st["userMsgs"], 0, "сказанное не попало в чат")
        self.assertIn("привет", st["userText"].lower())
        self.assertTrue(st["gotReply"], "на сказанное нет ответа Мэймэй")

    def test_manual_stop_does_not_send(self):
        st = self.out["stop"]
        self.assertTrue(st["unchanged"], "ручной стоп отправил недосказанное")
        self.assertTrue(st["stoppedNote"], "после стопа висит лишнее сообщение")


class TutorVoiceDom(unittest.TestCase):
    """jsdom: микрофон честно предупреждает, автоозвучка реально звучит."""

    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("нет node — нечего проверять в браузере")
        if not os.path.isdir(os.path.join(ROOT, "node_modules", "jsdom")):
            raise unittest.SkipTest("нет jsdom — браузерные проверки пропущены")
        index = os.path.join(ROOT, "index.html")
        if not os.path.exists(index):
            raise unittest.SkipTest("нет index.html — сначала сборка")
        res = subprocess.run([node, "-e", DOM_SCRIPT, index,
                              os.path.join(ROOT, "node_modules")],
                             capture_output=True, text=True, timeout=180)
        if res.returncode != 0:
            raise AssertionError("jsdom упал: " + res.stderr[-800:])
        cls.out = json.loads(res.stdout)

    def test_mic_button_exists(self):
        self.assertTrue(self.out["mic"], "кнопка 🎙 не отрисовалась")

    def test_autovoice_restored_from_storage(self):
        self.assertIn("🔊", self.out["autovoiceOn"],
                      "автоозвучка не восстановилась из localStorage (zh_tutor_voice=1)")

    def test_unsupported_browser_gets_honest_note(self):
        self.assertTrue(self.out["micNoteShown"],
                        "без SpeechRecognition должна появиться подсказка")
        self.assertIn("Chrome", self.out["micNoteText"],
                      "в подсказке должны быть браузеры, где микрофон работает")

    def test_answer_spoken_automatically(self):
        self.assertGreater(self.out["spoken"], 0,
                           "автоозвучка не вызвала speechSynthesis.speak")
        self.assertTrue(self.out["badge"], "у ответа нет бейджа источника")


if __name__ == "__main__":
    unittest.main()
