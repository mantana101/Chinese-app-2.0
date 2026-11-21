#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Тесты ИИ-помощника: он должен понимать живую русскую речь.

Раньше помощник отвечал по жёстким регулярным выражениям, и любая
формулировка не по шаблону давала «я не понял». Здесь проверяется,
что вопросы с опечатками, падежами, темами и смешанным вводом
(иероглифы + русский) получают осмысленный ответ, а не отписку.
"""

import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "index.html")

# Загружаем собранную страницу в jsdom и спрашиваем помощника напрямую.
RUNNER = r"""
const { JSDOM } = require(process.cwd() + '/node_modules/jsdom/lib/api.js');
const fs = require('fs');
const dom = new JSDOM(fs.readFileSync(process.cwd() + '/index.html', 'utf8'), {
  runScripts: 'dangerously', url: 'http://localhost/#/', pretendToBeVisual: true,
  beforeParse(w) {
    w.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){} });
    w.HTMLMediaElement.prototype.play = () => Promise.resolve();
    w.speechSynthesis = { speak(){}, cancel(){}, getVoices: () => [] };
    w.scrollTo = () => {}; w.fetch = () => Promise.reject(new Error('offline'));
  }
});
const w = dom.window;
setTimeout(() => {
  const questions = JSON.parse(process.argv[1]);
  const out = {};
  for (const q of questions) {
    try {
      const r = w.tutorReplyLocal(q);
      out[q] = { html: String(r && r.html || ''), quiz: !!(r && r.quiz), speak: String(r && r.speak || '') };
    } catch (e) {
      out[q] = { error: String(e && e.message || e) };
    }
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}, 600);
"""

NO_IDEA = "не уверен, что понял"


def _node():
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("нет node — нечем проверить помощника")
    return node


def ask(*questions):
    """Спросить помощника из собранной страницы."""
    if not os.path.exists(INDEX):
        raise unittest.SkipTest("index.html не собран — запустите build.py")
    api = os.path.join(ROOT, "node_modules", "jsdom", "lib", "api.js")
    if not os.path.exists(api):
        raise unittest.SkipTest("нет jsdom — npm install --no-save jsdom")
    res = subprocess.run(
        [_node(), "-e", RUNNER, json.dumps(list(questions), ensure_ascii=False)],
        cwd=ROOT, capture_output=True, text=True, timeout=180,
    )
    if res.returncode != 0:
        raise AssertionError("jsdom упал: " + res.stderr[-800:])
    return json.loads(res.stdout)


def text_of(payload):
    html = payload.get("html", "")
    out, depth = [], 0
    for ch in html:
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(ch)
    return " ".join("".join(out).split()).lower()


class TutorUnderstanding(unittest.TestCase):
    """Понимание живых формулировок."""

    @classmethod
    def setUpClass(cls):
        cls.answers = ask(
            "как сказать спасибо",
            "как сказать спасиба",              # опечатка
            "как сказать извините",
            "объясни частицу 了",
            "в чём разница между 不 и 没",
            "зачем нужна 吗",
            "разбери 我想喝茶",
            "что значит 车站",
            "как спросить дорогу",
            "что ты умеешь",
            "абракадабра вжух",
            "chá",
            "сколько времени нужно учить китайский",
        )

    def test_no_js_errors(self):
        for q, a in self.answers.items():
            self.assertNotIn("error", a, f"«{q}» → {a.get('error')}")

    def test_typo_is_forgiven(self):
        """"спасиба" должна находить 谢谢."""
        t = text_of(self.answers["как сказать спасиба"])
        self.assertIn("谢谢", self.answers["как сказать спасиба"]["html"])
        self.assertIn("спасибо", t)

    def test_translation_answer_has_pinyin(self):
        """Ученик читает с пиньинем: у ответа-перевода он обязателен."""
        a = self.answers["как сказать извините"]
        self.assertIn("对不起", a["html"])
        self.assertIn("duì", a["html"].lower())

    def test_grammar_rules_are_explained(self):
        le = text_of(self.answers["объясни частицу 了"])
        self.assertIn("уже", le)
        ma = text_of(self.answers["зачем нужна 吗"])
        self.assertIn("вопрос", ma)

    def test_difference_question_gets_rule_not_parse(self):
        """«в чём разница 不 и 没» — это вопрос о правиле, а не перевод."""
        t = text_of(self.answers["в чём разница между 不 и 没"])
        self.assertIn("разных", t)
        self.assertNotIn("по словам", t)

    def test_sentence_is_parsed_word_by_word(self):
        t = text_of(self.answers["разбери 我想喝茶"])
        self.assertIn("по словам", t)
        for ru in ("я", "хочу", "пить", "чай"):
            self.assertIn(ru, t)

    def test_hanzi_lookup(self):
        a = self.answers["что значит 车站"]
        self.assertIn("车站", a["html"])
        self.assertIn("вокзал", text_of(a))

    def test_topic_question_returns_relevant_phrases(self):
        t = text_of(self.answers["как спросить дорогу"])
        self.assertTrue("дорог" in t or "пройти" in t, t[:120])
        # раньше здесь оказывались 把 и 太贵了 из соседних уроков
        self.assertNotIn("слишком дорого", t)

    def test_capabilities(self):
        t = text_of(self.answers["что ты умеешь"])
        self.assertIn("как сказать", t)

    def test_intent_is_admitted_not_faked(self):
        """На бессмыслицу — уточняющий вопрос, а не случайное слово."""
        t = text_of(self.answers["абракадабра вжух"])
        self.assertIn(NO_IDEA, t)

    def test_pinyin_with_tones_is_found(self):
        a = self.answers["chá"]
        self.assertIn("茶", a["html"])

    def test_long_question_is_not_misread_as_topic(self):
        """«сколько времени нужно учить» — не тема про время в пути."""
        t = text_of(self.answers["сколько времени нужно учить китайский"])
        self.assertNotIn("транспорт", t)


class TutorInteraction(unittest.TestCase):
    """Диалог, тест и подстройка под прогресс."""

    @classmethod
    def setUpClass(cls):
        cls.answers = ask(
            "давай поговорим",
            "проверь меня тестом",
            "что мне повторить",
        )

    def test_dialogue_starts(self):
        t = text_of(self.answers["давай поговорим"])
        self.assertIn("диалог", t)
        self.assertIn("你叫什么名字", self.answers["давай поговорим"]["html"])

    def test_quiz_has_options_and_question(self):
        a = self.answers["проверь меня тестом"]
        self.assertTrue(a["quiz"], "тест должен приходить с вариантами")
        self.assertIn("как переводится", text_of(a))

    def test_advice_mentions_real_progress(self):
        t = text_of(self.answers["что мне повторить"])
        self.assertIn("уроков", t)
        self.assertIn("точность", t)


if __name__ == "__main__":
    unittest.main()
