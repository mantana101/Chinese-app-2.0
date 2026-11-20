#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Тесты домашних заданий: ученик сдаёт работу, учитель её проверяет."""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.test_api import ApiTestCase  # noqa: E402


class TestHomeworkSubmit(ApiTestCase):
    """Ученик выполняет домашку на сайте и отправляет её учителю."""

    def test_student_submits_and_sees_it(self):
        owner, _ = self.register_owner()
        token, student = self.register_student(owner, "Али")

        status, data, _ = self.json(
            "POST", "/api/homework/submit",
            {"lesson_id": "l1", "answers": {"hw0": "0", "hw3": "我叫阿里", "hw5": "我是学生"}},
            token,
        )
        self.assertEqual(status, 200, data)
        self.assertEqual(data["answers"], 3)

        status, data, _ = self.json("GET", "/api/homework", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(len(data["items"]), 1)
        item = data["items"][0]
        self.assertEqual(item["lesson_id"], "l1")
        self.assertEqual(item["answers"]["hw3"], "我叫阿里")
        self.assertIsNone(item["score"], "новая работа ждёт проверки")

    def test_teacher_sees_submission_in_class(self):
        owner, _ = self.register_owner()
        token, _ = self.register_student(owner, "Али")
        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l2", "answers": {"hw0": "0"}}, token)

        status, data, _ = self.json("GET", "/api/class/homework", token=owner)
        self.assertEqual(status, 200)
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["graded"], 0)
        self.assertEqual(data["items"][0]["student"], "Али")
        self.assertIsNone(data["avg"])

        # счётчик «ждут проверки» есть и в обзоре класса
        status, ov, _ = self.json("GET", "/api/class/overview", token=owner)
        self.assertEqual(status, 200)
        self.assertEqual(ov["hw_waiting"], 1)
        self.assertEqual(ov["hw_total"], 1)
        self.assertEqual(ov["students"][0]["hw_waiting"], 1)

    def test_teacher_grades_and_student_sees_result(self):
        owner, _ = self.register_owner()
        token, student = self.register_student(owner, "Али")
        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l3", "answers": {"hw0": "0"}}, token)

        status, data, _ = self.json(
            "POST", "/api/class/homework/grade",
            {"student_id": student["id"], "lesson_id": "l3", "score": 85,
             "feedback": "Хорошо, обрати внимание на 的"},
            owner,
        )
        self.assertEqual(status, 200, data)

        status, data, _ = self.json("GET", "/api/homework", token=token)
        item = data["items"][0]
        self.assertEqual(item["score"], 85)
        self.assertIn("的", item["feedback"])

        # оценка видна учителю как проверенная
        status, data, _ = self.json("GET", "/api/class/homework", token=owner)
        self.assertEqual(data["graded"], 1)
        self.assertEqual(data["avg"], 85)

    def test_resubmit_returns_work_to_review(self):
        """Исправленная работа снова ждёт проверки, а не висит со старой оценкой."""
        owner, _ = self.register_owner()
        token, student = self.register_student(owner, "Али")
        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l4", "answers": {"hw0": "0"}}, token)
        self.json("POST", "/api/class/homework/grade",
                  {"student_id": student["id"], "lesson_id": "l4", "score": 50}, owner)

        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l4", "answers": {"hw0": "0", "hw1": "0"}}, token)

        status, data, _ = self.json("GET", "/api/homework", token=token)
        item = data["items"][0]
        self.assertIsNone(item["score"], "после правки оценка снимается")
        self.assertEqual(item["feedback"], "")
        self.assertEqual(len(item["answers"]), 2)

    def test_second_submission_does_not_duplicate(self):
        owner, _ = self.register_owner()
        token, _ = self.register_student(owner, "Али")
        for _ in range(3):
            self.json("POST", "/api/homework/submit",
                      {"lesson_id": "l5", "answers": {"hw0": "0"}}, token)
        status, data, _ = self.json("GET", "/api/homework", token=token)
        self.assertEqual(len(data["items"]), 1, "одна работа на урок")
        status, data, _ = self.json("GET", "/api/class/homework", token=owner)
        self.assertEqual(data["total"], 1)

    def test_two_lessons_are_separate(self):
        owner, _ = self.register_owner()
        token, _ = self.register_student(owner, "Али")
        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l1", "answers": {"hw0": "0"}}, token)
        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l2", "answers": {"hw1": "0"}}, token)
        status, data, _ = self.json("GET", "/api/homework", token=token)
        ids = sorted(i["lesson_id"] for i in data["items"])
        self.assertEqual(ids, ["l1", "l2"])

    def test_homework_shows_up_in_student_card(self):
        owner, _ = self.register_owner()
        token, student = self.register_student(owner, "Али")
        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l6", "answers": {"hw2": "0"}}, token)
        status, data, _ = self.json("GET", f"/api/class/students/{student['id']}", token=owner)
        self.assertEqual(status, 200)
        self.assertEqual(len(data["homework"]), 1)
        self.assertEqual(data["homework"][0]["lesson_id"], "l6")

    def test_homework_survives_progress_reset(self):
        """Сброс прогресса не должен стирать сданную работу."""
        owner, _ = self.register_owner()
        token, student = self.register_student(owner, "Али")
        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l7", "answers": {"hw0": "0"}}, token)
        self.json("POST", "/api/class/reset", {"student_id": student["id"]}, owner)
        status, data, _ = self.json("GET", "/api/homework", token=token)
        self.assertEqual(len(data["items"]), 1)

    def test_deleting_student_removes_homework(self):
        owner, _ = self.register_owner()
        token, student = self.register_student(owner, "Али")
        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l1", "answers": {"hw0": "0"}}, token)
        self.json("POST", "/api/class/delete", {"student_id": student["id"]}, owner)
        status, data, _ = self.json("GET", "/api/class/homework", token=owner)
        self.assertEqual(status, 200)
        self.assertEqual(data["total"], 0)


class TestHomeworkValidation(ApiTestCase):
    """Недоверенный ввод не должен ломать сервер и раздувать базу."""

    def setUp(self):
        super().setUp()
        self.owner, _ = self.register_owner()
        self.token, self.student = self.register_student(self.owner, "Али")

    def test_requires_login(self):
        status, _, _ = self.json("POST", "/api/homework/submit",
                                 {"lesson_id": "l1", "answers": {"hw0": "0"}})
        self.assertEqual(status, 401)
        status, _, _ = self.json("GET", "/api/homework")
        self.assertEqual(status, 401)

    def test_student_cannot_see_class_homework(self):
        status, _, _ = self.json("GET", "/api/class/homework", token=self.token)
        self.assertEqual(status, 403)

    def test_student_cannot_grade(self):
        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l1", "answers": {"hw0": "0"}}, self.token)
        status, _, _ = self.json("POST", "/api/class/homework/grade",
                                 {"student_id": self.student["id"], "lesson_id": "l1", "score": 90},
                                 self.token)
        self.assertEqual(status, 403)

    def test_bad_lesson_id_rejected(self):
        for bad in ("", "l99", "lesson-1", "../../etc", "l1; DROP TABLE users"):
            status, _, _ = self.json("POST", "/api/homework/submit",
                                     {"lesson_id": bad, "answers": {"hw0": "0"}}, self.token)
            self.assertEqual(status, 400, f"{bad!r} -> {status}")

    def test_empty_or_broken_answers_rejected(self):
        cases = [
            {"lesson_id": "l1", "answers": {}},
            {"lesson_id": "l1", "answers": {"hw0": "   "}},
            {"lesson_id": "l1", "answers": ["0"]},
            {"lesson_id": "l1", "answers": {"hw0": {"x": 1}}},
            {"lesson_id": "l1"},
        ]
        for body in cases:
            status, _, _ = self.json("POST", "/api/homework/submit", body, self.token)
            self.assertEqual(status, 400, f"{body} -> {status}")

    def test_foreign_keys_are_ignored(self):
        """Ключи, которых нет в домашке, не сохраняются."""
        status, data, _ = self.json(
            "POST", "/api/homework/submit",
            {"lesson_id": "l1", "answers": {"hw0": "0", "evil": "x", "hw99": "y"}},
            self.token,
        )
        self.assertEqual(status, 200)
        status, data, _ = self.json("GET", "/api/homework", token=self.token)
        self.assertEqual(sorted(data["items"][0]["answers"]), ["hw0"])

    def test_long_answer_is_truncated(self):
        status, _, _ = self.json(
            "POST", "/api/homework/submit",
            {"lesson_id": "l1", "answers": {"hw0": "а" * 5000}}, self.token,
        )
        self.assertEqual(status, 200)
        status, data, _ = self.json("GET", "/api/homework", token=self.token)
        self.assertLessEqual(len(data["items"][0]["answers"]["hw0"]), 600)

    def test_grade_validation(self):
        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l1", "answers": {"hw0": "0"}}, self.token)
        for score in (-1, 101, "abc", None):
            status, _, _ = self.json("POST", "/api/class/homework/grade",
                                     {"student_id": self.student["id"], "lesson_id": "l1",
                                      "score": score}, self.owner)
            self.assertEqual(status, 400, f"{score!r} -> {status}")

    def test_grade_missing_work_is_404(self):
        status, _, _ = self.json("POST", "/api/class/homework/grade",
                                 {"student_id": self.student["id"], "lesson_id": "l9",
                                  "score": 90}, self.owner)
        self.assertEqual(status, 404)

    def test_teacher_cannot_grade_owner(self):
        status, _, _ = self.json("POST", "/api/class/homework/grade",
                                 {"student_id": 1, "lesson_id": "l1", "score": 90},
                                 self.owner)
        # владельца не трогаем — это защищено load_target
        self.assertEqual(status, 403)


class TestHomeworkInExport(ApiTestCase):
    """В CSV класса видно, сколько домашков сдано и сколько проверено."""

    def test_csv_has_homework_column(self):
        owner, owner_user = self.register_owner()
        token, _ = self.register_student(owner, "Али")
        self.json("POST", "/api/homework/submit",
                  {"lesson_id": "l1", "answers": {"hw0": "0"}}, token)

        status, raw, hdrs = self.request("GET", "/api/class/export.csv", token=owner)
        self.assertEqual(status, 200)
        text = raw.decode("utf-8-sig")
        header = text.splitlines()[0]
        self.assertIn("Домашки", header)
        self.assertIn("0/1", text, "сдана 1 работа, проверено 0")


if __name__ == "__main__":
    unittest.main()
