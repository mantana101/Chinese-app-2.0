#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Режим Джарвиса: комната голосового разговора с Мэймэй.

Кнопка 🎙 открывает комнату: аватар Мэймэй появляется сразу, она
слушает речь (SpeechRecognition браузера, без внешних сервисов),
отвечает вслух (speakRu) и сама продолжает диалог. Состояние микрофона
узнаётся заранее (Permissions API): если сайту уже запрещено — диалог
браузера не показывается вовсе, и комната честно объясняет, как
вернуть доступ. Ручной стоп не отправляет недосказанное.
"""

import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Сценарий 1: браузер без SpeechRecognition — комната всё равно
# открывается (аватар есть!), честно объясняя, что микрофон недоступен.
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

  /* 🎙 открывает комнату с аватаром — даже без поддержки микрофона */
  q('.t-mic').click();
  setTimeout(() => {
    const room = w.document.getElementById('t-room');
    out.room = {
      exists: !!room,
      avatar: room ? !!room.querySelector('.t-room-avatar svg') : false,
      pandaVisible: room ? !!room.querySelector('.t-room-avatar') : false,
      status: room ? room.querySelector('.t-room-status').textContent.slice(0, 120) : ''
    };

    /* Автоозвучка: ответ агента читается голосом сама */
    let spoken = 0;
    w.speechSynthesis.speak = () => { spoken++; };
    w.speechSynthesis.cancel = () => { };
    w.eval("window.__host.querySelector('.t-chips button').click()");
    setTimeout(() => {
      out.spoken = spoken;
      out.badge = !!q('.t-mode-local, .t-mode-ai, .t-mode-sources');
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    }, 400);
  }, 150);
}, 900);
"""

# Сценарий 2: фейковые Permissions, getUserMedia и SpeechRecognition —
# весь жизненный цикл комнаты: запрет, нет устройства, диалог, речь,
# ручной стоп, закрытие.
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
    /* Permissions API: состояние задаётся w.__permState. */
    Object.defineProperty(w.navigator, 'permissions', {
      value: { query: () => Promise.resolve({ state: w.__permState || 'prompt' }) },
      configurable: true
    });
    /* Запрос микрофона: поведение задаётся w.__micMode. */
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
  }
});
const w = dom.window;
setTimeout(() => {
  const host = w.document.createElement('div');
  host.id = 'tv2-host';
  w.document.body.appendChild(host);
  w.eval("window.__host = document.getElementById('tv2-host'); renderTutor(window.__host)");
  const q = (s) => host.querySelector(s);
  const room = () => w.document.getElementById('t-room');
  const status = () => room() ? room().querySelector('.t-room-status').textContent : '';
  const userMsgs = () => host.querySelectorAll('.t-msg.t-user').length;
  const openRoom = () => q('.t-mic').click();
  const closeRoom = () => room() && room().querySelector('.t-room-x').click();
  const out = {};

  /* A. Сайту запрещено навсегда: диалога не будет — комната объясняет */
  w.__permState = 'denied';
  openRoom();
  setTimeout(() => {
    out.deny = {
      avatar: !!room().querySelector('.t-room-avatar svg'),
      note: status().slice(0, 400)
    };
    closeRoom();
    /* B2. Микрофона нет вовсе */
    w.__permState = 'prompt';
    w.__micMode = 'nodev';
    openRoom();
    setTimeout(() => {
      out.nodev = { note: status().slice(0, 200) };
      closeRoom();
      /* B. Разрешение спрашиваем: диалог появится, но пока тишина */
      w.__micMode = 'ok';
      w.__srMode = 'silence';
      openRoom();
      setTimeout(() => {
        out.silence = { note: status().slice(0, 200), userMsgs: userMsgs() };
        /* C. Услышанная речь: вопрос в чат и в комнату, ответ голосом и текстом */
        w.__srMode = 'привет';
        closeRoom();
        openRoom();
        setTimeout(() => {
          out.spoken = {
            q: room().querySelector('.tr-q') ? room().querySelector('.tr-q').textContent : '',
            a: !!room().querySelector('.tr-a'),
            chatUserMsgs: userMsgs(),
            chatReply: host.querySelectorAll('.t-msg.t-bot').length > 1
          };
          /* D. Ручной стоп: недосказанное не уходит в чат */
          w.__permState = 'granted';
          w.__srMode = 'hold';
          closeRoom();
          openRoom();
          setTimeout(() => {
            const before = userMsgs();
            room().querySelector('.t-room-mic').click(); /* ⏹ стоп */
            setTimeout(() => {
              out.stop = { userMsgs: userMsgs(), unchanged: userMsgs() === before };
              /* E. Закрытие убирает комнату */
              closeRoom();
              out.closed = !w.document.getElementById('t-room');
              process.stdout.write(JSON.stringify(out));
              process.exit(0);
            }, 120);
          }, 120);
        }, 350);
      }, 200);
    }, 150);
  }, 150);
}, 900);
"""


def read(*parts) -> str:
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


class TutorVoiceWiring(unittest.TestCase):
    """Комната, состояние микрофона и голосовой цикл подключены в коде."""

    def test_voice_code_present(self):
        app = read("src", "app.js")
        self.assertIn("webkitSpeechRecognition", app, "нет распознавания речи браузера")
        self.assertIn("recog.lang = 'ru-RU'", app, "распознавание должно быть на русском")
        self.assertIn("await sendMsg(text);", app, "сказанное не проходит через чат")
        self.assertIn("'zh_tutor_voice'", app, "выбор автоозвучки не запоминается")
        self.assertIn("speakRu(replyObj.sayRu, 0.95);", app, "автоозвучка не вызывает speakRu")
        self.assertIn("как с Джарвисом", app, "нет приглашения в подзаголовке")
        self.assertIn("window.self !== window.top", app,
                      "нет определения встроенного окна — в предпросмотре микрофон молчал")
        self.assertIn("Микрофон запрещён", app, "нет честного сообщения при отказе доступа")
        self.assertIn("no-speech", app, "нет сообщения, когда речи не услышали")
        self.assertIn("service-not-allowed", app, "нет подсказки для телефонов без сервисов Google")
        self.assertIn("micAborted", app, "ручной стоп должен отменять отправку")
        self.assertIn("voiceBtn.type = 'button'", app, "кнопка голоса отправляла форму")
        self.assertIn("micAskPermission", app, "нет предварительного запроса микрофона")
        self.assertIn("getUserMedia({ audio: true })", app, "нет запроса разрешения через getUserMedia")
        self.assertIn("Настройки сайтов", app, "нет мобильного пути настройки")
        self.assertIn("navigator.permissions.query", app, "нет проверки состояния микрофона")
        self.assertIn("Диалога разрешения нет", app, "нет объяснения молчаливого запрета")
        self.assertIn("Сейчас появится запрос", app, "нет предупреждения перед диалогом")

    def test_voice_room_exists(self):
        app = read("src", "app.js")
        self.assertIn("function openVoiceRoom", app, "нет комнаты голосового разговора")
        self.assertIn("mic.onclick = openVoiceRoom;", app, "🎙 не открывает комнату")
        self.assertIn("t-room-avatar", app, "в комнате нет аватара Мэймэй")
        self.assertIn("pandaSVG()", app.split("function openVoiceRoom")[1].split("mic.onclick")[0],
                      "аватар комнаты — не панда")
        self.assertIn("Слушаю… говори!", app, "нет статуса слушания")

    def test_readme_describes_jarvis_mode(self):
        readme = read("README.md")
        self.assertIn("Режим Джарвиса", readme)
        self.assertIn("аватаром", readme, "в README не сказано про аватар")
        self.assertIn("встроенная в браузер", readme, "должно быть видно, что без внешних сервисов")

    def test_css_styles_room(self):
        css = read("src", "styles.css")
        for cls in (".t-room", ".t-room-avatar", ".t-room-status", "t-room-pulse", "t-room-bounce"):
            self.assertIn(cls, css, f"в styles.css нет {cls}")


class TutorVoiceDom(unittest.TestCase):
    """jsdom без микрофона: комната всё равно открывается с аватаром."""

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

    def test_room_opens_with_panda_even_without_mic(self):
        r = self.out["room"]
        self.assertTrue(r["exists"], "комната не открылась")
        self.assertTrue(r["avatar"], "в комнате нет аватара панды (svg)")
        self.assertIn("https://", r["status"],
                      "без поддержки микрофона нет честного объяснения: " + r["status"])

    def test_answer_spoken_automatically(self):
        self.assertGreater(self.out["spoken"], 0,
                           "автоозвучка не вызвала speechSynthesis.speak")
        self.assertTrue(self.out["badge"], "у ответа нет бейджа источника")


class TutorVoiceMic(unittest.TestCase):
    """jsdom с фейковым микрофоном: весь жизненный цикл комнаты честный."""

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

    def test_denied_site_gets_avatar_and_instruction(self):
        st = self.out["deny"]
        self.assertTrue(st["avatar"], "при запрете комната должна открываться с аватаром")
        self.assertIn("Диалога разрешения нет", st["note"],
                      "почему нет диалога — не объяснено: " + st["note"])
        self.assertIn("Настройки сайтов", st["note"], "нет второго пути через настройки браузера")
        self.assertIn("текстом", st["note"], "нет запасного пути — писать текстом")

    def test_no_mic_device_explained(self):
        self.assertIn("не найден", self.out["nodev"]["note"].lower(),
                      "отсутствие микрофона не объяснено: " + self.out["nodev"]["note"])

    def test_silence_gets_hint(self):
        st = self.out["silence"]
        self.assertIn("не услышала", st["note"].lower(),
                      "при тишине нет подсказки: " + st["note"])
        self.assertEqual(st["userMsgs"], 0, "тишина не должна отправлять вопрос")

    def test_spoken_words_become_question_and_reply(self):
        st = self.out["spoken"]
        self.assertIn("привет", st["q"].lower(), "сказанное не попало в комнату: " + st["q"])
        self.assertTrue(st["a"], "ответ не появился в комнате")
        self.assertGreater(st["chatUserMsgs"], 0, "сказанное не ушло в чат")
        self.assertTrue(st["chatReply"], "на сказанное нет ответа Мэймэй")

    def test_manual_stop_does_not_send(self):
        self.assertTrue(self.out["stop"]["unchanged"],
                        "ручной стоп отправил недосказанное")

    def test_close_removes_room(self):
        self.assertTrue(self.out["closed"], "крестик не закрыл комнату")


if __name__ == "__main__":
    unittest.main()
