#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Встроенный агент Мэймэй: умный без внешнего ключа.

База знаний расширена до 24 тем, агент собирает целую фразу из слов
курса («переведи я хочу пить чай»), рассказывает конспект любого урока
(«что в уроке 5») и тренирует пиньинь квизом («потренируй пиньинь»).
Движок — tutorReplyLocal в src/app.js; проверяем его ответы в jsdom
на собранной странице, как это увидит ученик.
"""

import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DOM_SCRIPT = r"""
const fs = require('fs');
const {JSDOM} = require(process.argv[2] + '/jsdom/lib/api.js');
const dom = new JSDOM(fs.readFileSync(process.argv[1], 'utf8'), {
  runScripts: 'dangerously', url: 'http://127.0.0.1/', pretendToBeVisual: true,
  beforeParse(w) {
    w.matchMedia = () => ({matches: false, addEventListener(){}, removeEventListener(){}});
    w.HTMLMediaElement.prototype.play = () => Promise.resolve();
    w.speechSynthesis = {speak(){}, cancel(){}, getVoices: () => []};
    w.scrollTo = () => {};
    w.fetch = () => Promise.reject(new Error('offline'));
  }
});
const w = dom.window;
setTimeout(() => {
  const ask = (q) => w.eval(`tutorReplyLocal(${JSON.stringify(q)})`);
  const plain = (r) => String((r && r.html) || '').replace(/<[^>]+>/g, ' ');
  const out = {};

  /* 1. Переводчик: собирает фразу из слов курса */
  const tr = ask('переведи я хочу пить чай');
  out.translator = {
    hasHanzi: /[\u3400-\u9fff]{2,}/.test(tr.html),
    hasPinyin: !!tr.html.match(/tw-py|class="tw-py"|<span class="tw-py">/),
    hasHe: tr.html.includes('喝'),
    plain: plain(tr).slice(0, 200)
  };

  /* 2. Конспект урока */
  const br = ask('что в уроке 3');
  out.brief = { hasTitle: br.html.includes('Семья'), hasLink: br.html.includes('#/lesson/l3'),
    hasVocab: br.html.toLowerCase().includes('главные слова') };

  /* 3. Новые темы правил */
  out.ruleOrder = plain(ask('объясни порядок слов')).toLowerCase().includes('порядок');
  out.ruleHsk = plain(ask('что такое hsk')).includes('HSK');
  out.ruleRadicals = plain(ask('как устроен иероглиф')).toLowerCase().includes('радикал');

  /* 4. Квиз пиньиня: 4 варианта, ответ — ключ азбуки */
  const pq = ask('потренируй пиньинь');
  out.pinyinQuiz = { isQuiz: !!pq.quiz, opts: pq.quiz ? pq.quiz.opts.length : 0,
    targetIsKey: pq.quiz ? /^[a-zü]+$/.test(pq.quiz.target.h) : false };

  /* 5. Обычный квиз по словам не сломан */
  const vq = ask('проверь меня');
  out.vocabQuiz = { isQuiz: !!vq.quiz, opts: vq.quiz ? vq.quiz.opts.length : 0 };

  /* 6. Честный фолбэк на неизвестное сохранён */
  const un = ask('расскажи анекдот про дракона');
  out.unknown = { honest: /не уверен|не поняла|словаре курса/i.test(plain(un)) };

  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}, 900);
"""


def read(*parts) -> str:
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


class TutorAgentWiring(unittest.TestCase):
    """База знаний, новые функции и чипсы подключены в исходниках."""

    def test_rules_grown_to_24(self):
        app = read("src", "app.js")
        n = app.index("const TUTOR_RULES = [")
        seg = app[n:app.index("\n];", n)]
        ids = [m for m in __import__("re").findall(r"id: '([a-z_]+)'", seg)]
        self.assertGreaterEqual(len(ids), 24, f"тем должно быть ≥24, сейчас {len(ids)}: {ids}")
        for new in ("order", "time_date", "he_ye_dou", "ne_part", "shi_de",
                    "polite", "radicals", "learn_how", "hsk", "shenme"):
            self.assertIn(new, ids, f"нет новой темы «{new}»")

    def test_agent_functions_exist(self):
        app = read("src", "app.js")
        for fn in ("function tutorComposePhrase", "function tutorLessonBrief",
                   "function tutorPinyinQuiz"):
            self.assertIn(fn, app, f"нет {fn}")
        self.assertIn("tutorComposePhrase(hits);", app, "сборка фразы не подключена в «переведи …»")
        self.assertIn("const brief = tutorLessonBrief(q, low);", app, "конспект не подключён")

    def test_chips_offer_new_abilities(self):
        app = read("src", "app.js")
        for s in ("переведи я хочу пить чай", "что в уроке 5", "потренируй пиньинь"):
            self.assertIn(s, app, f"в чатах-подсказках нет «{s}»")

    def test_readme_mentions_agent_abilities(self):
        readme = read("README.md")
        self.assertIn("встроенный агент", readme)
        self.assertIn("конспект любого урока", readme)


class TutorAgentDom(unittest.TestCase):
    """jsdom: агент отвечает как конспект, переводчик, правила и квизы."""

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

    def test_translator_composes_phrase(self):
        tr = self.out["translator"]
        self.assertTrue(tr["hasHanzi"], f"переводчик не собрал фразу: {tr['plain']}")
        self.assertTrue(tr["hasHe"], "в переводе «чай пить» нет 喝")

    def test_lesson_brief_works(self):
        br = self.out["brief"]
        self.assertTrue(br["hasTitle"], "конспект не показал название урока")
        self.assertTrue(br["hasLink"], "конспект не ведёт к уроку ссылкой")
        self.assertTrue(br["hasVocab"], "в конспекте нет слов")

    def test_new_rules_answer(self):
        self.assertTrue(self.out["ruleOrder"], "тема «порядок слов» не отвечает")
        self.assertTrue(self.out["ruleHsk"], "тема «HSK» не отвечает")
        self.assertTrue(self.out["ruleRadicals"], "тема «иероглиф/радикалы» не отвечает")

    def test_pinyin_quiz_offered(self):
        pq = self.out["pinyinQuiz"]
        self.assertTrue(pq["isQuiz"], "пиньинь-квиз не запустился")
        self.assertEqual(pq["opts"], 4, "в пиньинь-квизе должно быть 4 варианта")
        self.assertTrue(pq["targetIsKey"], "ответ пиньинь-квиза должен быть ключом азбуки")

    def test_vocab_quiz_intact(self):
        vq = self.out["vocabQuiz"]
        self.assertTrue(vq["isQuiz"], "словарный квиз сломался")
        self.assertEqual(vq["opts"], 4, "в словарном квизе должно быть 4 варианта")

    def test_unknown_question_stays_honest(self):
        self.assertTrue(self.out["unknown"]["honest"],
                        "на незнакомый вопрос агент должен честно признаваться")


if __name__ == "__main__":
    unittest.main()
