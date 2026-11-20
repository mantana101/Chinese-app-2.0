#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Тесты практики в src/data.js.

Ученики занимаются с пиньинем, поэтому практика не должна требовать
набирать иероглифы: любой возврат задания типа `gap` ломает занятие.
Эти тесты читают data.js тем же способом, что и страница, — через node.
"""

import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "src", "data.js")

READ_SCRIPT = r"""
const fs = require('fs');
const code = fs.readFileSync(process.argv[1], 'utf8');
const { LESSONS, DIAGNOSTIC, HOMEWORK, homeworkFor } =
  new Function(code + '\nreturn { LESSONS, DIAGNOSTIC, HOMEWORK, homeworkFor };')();
// Функции через JSON не передать — считаем нужное прямо в node.
process.stdout.write(JSON.stringify({
  LESSONS, DIAGNOSTIC, HOMEWORK,
  fallback: { known: homeworkFor('l15').length, unknown: homeworkFor('zzz').length }
}));
"""

# Типы, где ответ нужно впечатать руками. В курсе таких быть не должно.
TYPING_KINDS = {"gap"}


def load_quiz():
    node = shutil.which("node")
    if not node:
        raise unittest.SkipTest("нет node — нечем разобрать data.js")
    res = subprocess.run(
        [node, "-e", READ_SCRIPT, DATA], capture_output=True, text=True, timeout=120
    )
    if res.returncode != 0:
        raise AssertionError("data.js не разбирается: " + res.stderr[-500:])
    return json.loads(res.stdout)


class TestPracticeHasNoTyping(unittest.TestCase):
    """Практика проходится выбором варианта и перестановкой слов."""

    @classmethod
    def setUpClass(cls):
        cls.data = load_quiz()
        cls.lessons = cls.data["LESSONS"]

    def test_all_lessons_present(self):
        self.assertEqual(len(self.lessons), 15, "ожидаем 15 уроков")

    def test_no_typing_tasks(self):
        """Ни одного задания, где надо печатать иероглифы."""
        offenders = []
        for lid, lesson in self.lessons.items():
            for i, q in enumerate(lesson["quiz"]):
                if q["k"] in TYPING_KINDS:
                    offenders.append(f"{lid}[{i}] {q['q']}")
        self.assertEqual(
            offenders, [], "вернулись задания с ручным вводом: " + "; ".join(offenders)
        )

    def test_diagnostic_has_no_typing(self):
        offenders = [
            i for i, q in enumerate(self.data["DIAGNOSTIC"]["quiz"]) if q["k"] in TYPING_KINDS
        ]
        self.assertEqual(offenders, [], f"в диагностике ввод в вопросах {offenders}")

    def test_options_and_answer_indexes_valid(self):
        """Каждый вариант существует, правильный индекс указывает на вариант."""
        for lid, lesson in self.lessons.items():
            for i, q in enumerate(lesson["quiz"]):
                where = f"{lid}[{i}]"
                self.assertIn(q["k"], {"mcq", "order", "listen"}, f"{where}: тип {q['k']}")
                self.assertTrue(q.get("q", "").strip(), f"{where}: пустой вопрос")
                self.assertGreaterEqual(len(q["o"]), 3, f"{where}: мало вариантов")
                self.assertEqual(
                    len(set(q["o"])), len(q["o"]), f"{where}: повторяющиеся варианты"
                )
                if q["k"] == "order":
                    self.assertEqual(
                        sorted(q["a"]), list(range(len(q["o"]))), f"{where}: не перестановка"
                    )
                    self.assertFalse(
                        any(len(w.strip()) == 1 and w in "，。？！、 " for w in q["o"]),
                        f"{where}: в плитках лишняя пунктуация",
                    )
                else:
                    self.assertIsInstance(q["a"], int, f"{where}: индекс ответа")
                    self.assertTrue(0 <= q["a"] < len(q["o"]), f"{where}: индекс вне списка")

    def test_listen_tasks_speak_a_lesson_word(self):
        """Аудирование озвучивает слово урока, а не вариант-ловушку."""
        for lid, lesson in self.lessons.items():
            vocab = {w["h"] for w in lesson["vocab"]}
            for i, q in enumerate(lesson["quiz"]):
                if q["k"] != "listen":
                    continue
                self.assertTrue(q.get("speak"), f"{lid}[{i}]: нечего озвучивать")
                self.assertIn(q["speak"], vocab, f"{lid}[{i}]: слово не из урока")
                self.assertEqual(q["o"][q["a"]], q["speak"], f"{lid}[{i}]: ответ ≠ озвучка")

    def test_mcq_covers_lesson_material(self):
        """Вопросы урока говорят о его словах, а не о случайных темах."""
        for lid, lesson in self.lessons.items():
            vocab = {w["h"] for w in lesson["vocab"]}
            texts = []
            for q in lesson["quiz"]:
                texts.append(q["q"])
                texts.extend(q["o"] if isinstance(q.get("o"), list) else [])
            joined = " ".join(texts)
            hits = sum(1 for word in vocab if word in joined)
            self.assertGreaterEqual(
                hits, 4, f"{lid}: в заданиях почти нет слов урока ({hits})"
            )


class TestHomeworkContent(unittest.TestCase):
    """Домашка каждого урока выполнима на сайте и без набора иероглифов."""

    @classmethod
    def setUpClass(cls):
        cls.data = load_quiz()
        cls.lessons = cls.data["LESSONS"]

    def test_every_lesson_has_six_tasks(self):
        for lid in self.lessons:
            self.assertEqual(len(self.data["HOMEWORK"][lid]), 6, lid)

    def test_no_typing_of_hanzi_required(self):
        """Свободные ответы разрешают пиньинь и русский, выбора «впишите знак» нет."""
        for lid, tasks in self.data["HOMEWORK"].items():
            for i, task in enumerate(tasks):
                self.assertIn(task["k"], {"mcq", "read", "order", "text"}, f"{lid}[{i}]")
                self.assertTrue(task["q"].strip(), f"{lid}[{i}]: пустой вопрос")
                if task["k"] in ("mcq", "read"):
                    self.assertTrue(0 <= task["a"] < len(task["o"]), f"{lid}[{i}]: индекс")
                    self.assertEqual(len(set(task["o"])), len(task["o"]), f"{lid}[{i}]: дубли")
                if task["k"] == "order":
                    self.assertEqual(sorted(task["a"]), list(range(len(task["o"]))), f"{lid}[{i}]")
                if task["k"] == "text":
                    self.assertGreater(task.get("n", 0), 0, f"{lid}[{i}]: нет объёма")

    def test_tasks_touch_lesson_vocabulary(self):
        for lid, lesson in self.lessons.items():
            vocab = {w["h"] for w in lesson["vocab"]}
            texts = []
            for task in self.data["HOMEWORK"][lid]:
                texts.append(task["q"])
                texts.append(task.get("h", ""))
                texts.extend(task.get("o", []))
            joined = " ".join(texts)
            hits = sum(1 for w in vocab if w in joined)
            self.assertGreaterEqual(hits, 3, f"{lid}: в домашке нет слов урока ({hits})")

    def test_fallback_for_unknown_lesson(self):
        """Если урок добавят без ручной домашки, она собирается из l.hw."""
        self.assertEqual(self.data["fallback"]["known"], 6)
        self.assertEqual(self.data["fallback"]["unknown"], 0)


if __name__ == "__main__":
    unittest.main()
