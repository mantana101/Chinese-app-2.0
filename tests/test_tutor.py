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
  const code = fs.readFileSync(process.cwd() + '/lexicon.js', 'utf8');
  const sc = w.document.createElement('script');
  sc.textContent = code;
  w.document.head.appendChild(sc);
  w.eval('if (typeof TUTOR_LEX !== "undefined") TUTOR_LEX.reload();');
  const questions = JSON.parse(process.argv[1]);
  const out = {};
  for (const step of questions) {
    // строка — одиночный вопрос; массив — разговор из реплик подряд
    try {
      if (Array.isArray(step)) {
        let last = null;
        for (const q of step) last = w.tutorReplyLocal(q);
        out[step.join(' → ')] = { html: String(last && last.html || ''), quiz: !!(last && last.quiz), speak: String(last && last.speak || '') };
      } else {
        const r = w.tutorReplyLocal(step);
        out[step] = { html: String(r && r.html || ''), quiz: !!(r && r.quiz), speak: String(r && r.speak || '') };
      }
    } catch (e) {
      out[Array.isArray(step) ? step.join(' → ') : step] = { error: String(e && e.message || e) };
    }
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}, 600);
"""

LEXICON_STUB = r"""
const fs = require('fs');
const path = require('path');
// Словарь помощника теперь отдельный файл (lexicon.js). В браузере его
// подгружает loadLexicon, а в jsdom внешние скрипты не выполняются —
// подкладываем тем же способом, что и сеть.
function injectLexicon(w) {
  const code = fs.readFileSync(path.join(process.cwd(), 'lexicon.js'), 'utf8');
  const s = w.document.createElement('script');
  s.textContent = code;
  w.document.head.appendChild(s);
}
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


class ChatSurvivesRerender(unittest.TestCase):
    """Разговор не должен исчезать при перерисовке страницы.

    Раньше вход в аккаунт (Auth.boot завершается уже после первого экрана)
    перерисовывал страницу и стирал чат: ученик видел свой вопрос без
    ответа и решал, что помощник не отвечает.
    """

    RUNNER_CHAT = r"""
const { JSDOM } = require(process.cwd() + '/node_modules/jsdom/lib/api.js');
const fs = require('fs');
const saved = JSON.parse(process.argv[1]);
const dom = new JSDOM(fs.readFileSync(process.cwd() + '/index.html', 'utf8'), {
  runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true,
  beforeParse(w) {
    w.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){} });
    w.HTMLMediaElement.prototype.play = () => Promise.resolve();
    w.speechSynthesis = { speak(){}, cancel(){}, getVoices: () => [] };
    w.scrollTo = () => {}; w.fetch = () => Promise.reject(new Error('offline'));
    w.localStorage.setItem('tutorChat', JSON.stringify(saved));
  }
});
const w = dom.window;
setTimeout(() => {
  w.__guest = true; w.location.hash = '#/tutor'; w.route();
  const msgs = Array.from(w.document.querySelectorAll('.t-msg')).map(m => ({
    role: m.className.indexOf('t-user') >= 0 ? 'user' : 'bot',
    text: (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
  }));
  process.stdout.write(JSON.stringify(msgs));
  process.exit(0);
}, 700);
"""

    def test_previous_chat_is_restored(self):
        node = _node()
        api = os.path.join(ROOT, "node_modules", "jsdom", "lib", "api.js")
        if not os.path.exists(api):
            raise unittest.SkipTest("нет jsdom — npm install --no-save jsdom")
        saved = [
            {"role": "user", "content": "аптека", "html": ""},
            {"role": "assistant", "content": "аптека", "html": "<b>药店</b> — аптека"},
            {"role": "user", "content": "билет", "html": ""},
        ]
        res = subprocess.run(
            [node, "-e", self.RUNNER_CHAT, json.dumps(saved, ensure_ascii=False)],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(res.returncode, 0, res.stderr[-400:])
        msgs = json.loads(res.stdout)
        self.assertEqual(len(msgs), 3, f"разговор потерялся: {msgs}")
        self.assertEqual(msgs[0]["role"], "user")
        self.assertIn("билет", msgs[2]["text"])


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


class TutorThinking(unittest.TestCase):
    """Рассуждение: память разговора, уточнения и проверка ответа."""

    @classmethod
    def setUpClass(cls):
        cls.answers = ask(
            ["объясни частицу 了", "попроще"],
            ["объясни частицу 了", "а пример?"],
            ["объясни частицу 了", "а подробнее"],
            ["объясни разницу 不 и 没", "почему так"],
            ["проверь меня", "не знаю"],
            ["проверь меня", "я ошибся"],
            ["как сказать спасибо", "повтори"],
            ["как сказать спасибо", "как это звучит"],
            "проверь мой ответ 我喝茶了",
            "проверь мой ответ 我喝X茶",
            "проверь мой ответ где вокзал",
            "проверь мой ответ",
            ["давай поговорим", "меня зовут Али", "чай", "я из Душанбе"],
            ["давай поговорим", "хватит"],
        )

    def test_no_errors(self):
        for q, a in self.answers.items():
            self.assertNotIn("error", a, f"«{q}» → {a.get('error')}")

    def test_simpler_uses_plain_words(self):
        """«попроще» пересказывает то же правило, а не начинает заново."""
        t = text_of(self.answers["объясни частицу 了 → попроще"])
        self.assertIn("совсем просто", t)
        self.assertIn("уже", t)

    def test_example_follows_the_rule_in_focus(self):
        t = text_of(self.answers["объясни частицу 了 → а пример?"])
        self.assertIn("пример", t)
        self.assertIn("завтрак", t)   # пример правила 了: 我吃了早饭

    def test_more_gives_deeper_detail(self):
        t = text_of(self.answers["объясни частицу 了 → а подробнее"])
        self.assertIn("подробнее", t)
        self.assertNotIn("совсем просто", t)

    def test_why_explains_reason(self):
        t = text_of(self.answers["объясни разницу 不 и 没 → почему так"])
        self.assertIn("почему так", t)

    def test_after_quiz_idont_know_gives_the_answer(self):
        """Раньше на «не знаю» приходил новый тест вместо ответа."""
        a = self.answers["проверь меня → не знаю"]
        self.assertFalse(a["quiz"], "после «не знаю» новый тест не нужен")
        self.assertIn("правильный ответ", text_of(a))

    def test_after_quiz_wrong_explains_difference(self):
        t = text_of(self.answers["проверь меня → я ошибся"])
        self.assertIn("правильно", t)
        self.assertTrue("ваш вариант" in t or "сравните" in t or "ошибк" in t)

    def test_repeat_returns_last_explained_word(self):
        """«повтори» после перевода — то же слово, а не правило из прошлого."""
        a = self.answers["как сказать спасибо → повтори"]
        self.assertIn("谢谢", a["html"])

    def test_audio_intent(self):
        t = text_of(self.answers["как сказать спасибо → как это звучит"])
        self.assertIn("звучит", t)

    def test_check_known_sentence(self):
        t = text_of(self.answers["проверь мой ответ 我喝茶了"])
        self.assertIn("по словам", t)
        self.assertIn("все слова есть", t)

    def test_check_flags_wrong_keyboard(self):
        """Латиница внутри китайской фразы — типичная ошибка раскладки."""
        t = text_of(self.answers["проверь мой ответ 我喝X茶"])
        self.assertIn("латинские буквы", t)

    def test_check_flags_unknown_words(self):
        """Слова не из курса отмечаются отдельно, а не тонут в общем разборе."""
        answer = ask("проверь мой ответ 我喝鑫")
        t = text_of(answer["проверь мой ответ 我喝鑫"])
        self.assertIn("не встречались", t)

    def test_check_russian_phrase(self):
        t = text_of(self.answers["проверь мой ответ где вокзал"])
        self.assertIn("车站", self.answers["проверь мой ответ где вокзал"]["html"])

    def test_check_without_phrase_asks_for_it(self):
        t = text_of(self.answers["проверь мой ответ"])
        self.assertIn("пришлите фразу", t)

    def test_dialogue_reacts_to_user(self):
        """Диалог слушает: имя запоминается, выбор напитка влияет на ответ."""
        a = self.answers["давай поговорим → меня зовут Али → чай → я из Душанбе"]
        t = text_of(a)
        self.assertIn("али", t)
        self.assertIn("чай", t)
        self.assertIn("душанбе", t)
        # иероглифы идут с пиньинем, поэтому проверяем по тексту без разметки
        self.assertIn("huān", t)
        self.assertIn("yíng", t)
        self.assertIn("добро пожаловать", t)

    def test_dialogue_can_be_stopped(self):
        t = text_of(self.answers["давай поговорим → хватит"])
        self.assertNotIn("как тебя зовут", t)
        self.assertIn("практика", t)


class TutorThinksBeforeAnswering(unittest.TestCase):
    """Помощник не вываливает словарь, а думает: что именно спросили.

    Раньше любой длинный вопрос попадал в словарный поиск, и на «сколько
    времени нужно учить китайский» приходило «几 — сколько, 多少 — сколько,
    要不要 — нужно»: слова вместо ответа. Эти тесты держат новый порядок:
    ситуация → правило → живой ответ → слово, и только потом словарь.
    """

    @classmethod
    def setUpClass(cls):
        cls.answers = ask(
            "как спросить дорогу",
            "как заказать такси",
            "что сказать в аптеке",
            "как позвонить в ресторан и заказать столик",
            "сколько времени нужно учить китайский",
            "что делать если забыл слово",
            "я устал учить",
            "с чего начать",
            "как дела",
            "кто ты",
            "совсем не понимаю",
            "объясни по-человечески 了",
            "не понимаю почему тут 的",
            "аптека",
            "что значит 身份证",
        )

    def test_no_js_errors(self):
        for q, a in self.answers.items():
            self.assertNotIn("error", a, f"«{q}» → {a.get('error')}")

    def test_phrase_question_gets_phrases_not_one_word(self):
        """«как спросить дорогу» — это просьба о фразах, а не перевод 路."""
        t = text_of(self.answers["как спросить дорогу"])
        self.assertIn("как пройти", t)
        self.assertNotIn("по-китайски:", t)

    def test_situation_is_recognised_from_live_wording(self):
        t = text_of(self.answers["как заказать такси"])
        self.assertIn("дорога и транспорт", t)
        self.assertIn("dì tiě", self.answers["как заказать такси"]["html"])

    def test_restaurant_request_gets_bill_phrase(self):
        a = self.answers["как позвонить в ресторан и заказать столик"]
        t = text_of(a)
        self.assertIn("забронировать", t)
        self.assertIn("счёт", t)

    def test_health_question_gets_doctor_phrases(self):
        # руби-разметка режет иероглифы на слоги — проверяем по пиньиню и переводу
        a = self.answers["что сказать в аптеке"]
        self.assertIn("yī shēng", a["html"])
        self.assertIn("вызовите врача", text_of(a))

    def test_long_question_is_not_dumped_into_dictionary(self):
        """Главная регрессия: длинный вопрос не должен превращаться в словарь."""
        for q in ("сколько времени нужно учить китайский",
                  "что делать если забыл слово",
                  "я устал учить",
                  "с чего начать"):
            t = text_of(self.answers[q])
            self.assertNotIn("вот что есть по запросу", t, q)

    def test_learning_time_gets_honest_numbers(self):
        t = text_of(self.answers["сколько времени нужно учить китайский"])
        self.assertIn("hsk", t)
        self.assertIn("месяц", t)

    def test_emotional_message_is_answered_with_care(self):
        a = self.answers["я устал учить"]
        self.assertIn("我有点累", a["html"])
        self.assertIn("карточки", text_of(a))

    def test_small_talk_is_answered(self):
        t = text_of(self.answers["как дела"])
        self.assertIn("你好吗", self.answers["как дела"]["html"].replace(" ", ""))
        self.assertNotIn(NO_IDEA, t)

    def test_confusion_gets_a_question_back(self):
        t = text_of(self.answers["совсем не понимаю"])
        self.assertIn("что именно непонятно", t)

    def test_explain_request_with_hanzi_gets_the_rule(self):
        """«объясни по-человечески 了» — правило, а не «что именно объяснить?»."""
        t = text_of(self.answers["объясни по-человечески 了"])
        self.assertIn("уже", t)
        self.assertNotIn("что именно объяснить", t)

    def test_why_question_points_to_rule(self):
        t = text_of(self.answers["не понимаю почему тут 的"])
        self.assertIn("мой" if False else "какой", t)
        self.assertIn("перед существительным", t)

    def test_single_word_still_works(self):
        self.assertIn("yào diàn", self.answers["аптека"]["html"])
        self.assertIn("аптека", text_of(self.answers["аптека"]))
        self.assertIn("удостоверение личности", text_of(self.answers["что значит 身份证"]))


if __name__ == "__main__":
    unittest.main()
