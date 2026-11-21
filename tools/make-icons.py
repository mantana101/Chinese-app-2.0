#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Рисует иконки приложения (192 и 512) без внешних библиотек.

Зачем свои: иконка нужна для установки на телефон (PWA) и для превью
в мессенджерах. Тянуть ради двух PNG тяжёлую библиотеку незачем —
квадрат с золотой рамкой и иероглифом кодируется прямо здесь.

Запуск: python3 tools/make-icons.py
"""
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

BG = (18, 16, 14)        # фон — как в тёмной теме
GOLD = (224, 179, 84)    # акцентный золотой

# Иероглиф 学 крупным планом: сетка 16×16, 1 — закрашенная клетка.
# Простая, но узнаваемая форма: три капли сверху, крыша, ребёнок снизу.
GLYPH = [
    "0001100000110000",
    "0000110001100000",
    "0000011011000000",
    "0000001110000000",
    "1111111111111100",
    "0000110001100000",
    "0001100000110000",
    "0011000000011000",
    "0110111111110110",
    "0000110000110000",
    "0000110000110000",
    "0001100000011000",
    "0001100000011000",
    "0011000000001100",
    "1111000000001111",
    "0000000000000000",
]


def px(w, h, x, y, rgb):
    """Одна точка в буфер RGBA."""
    r, g, b = rgb
    return bytes((r, g, b, 255))


def make(size: int) -> bytes:
    """Возвращает PNG-файл size×size."""
    # Фон + скруглённые углы + рамка
    radius = size * 0.22
    border = max(2, round(size * 0.035))
    rows = []
    glyph_pad = size * 0.19
    glyph_size = size - glyph_pad * 2
    cell = glyph_size / 16.0
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # скругление углов
            dx = max(radius - x, x - (size - 1 - radius), 0)
            dy = max(radius - y, y - (size - 1 - radius), 0)
            inside = (dx * dx + dy * dy) <= radius * radius
            if not inside:
                row += bytes((0, 0, 0, 0))
                continue
            # рамка
            edge = (
                x < border or y < border or
                x >= size - border or y >= size - border
            )
            if edge:
                row += px(size, size, x, y, GOLD)
                continue
            # иероглиф
            gx = int((x - glyph_pad) / cell)
            gy = int((y - glyph_pad) / cell)
            filled = False
            if 0 <= gx < 16 and 0 <= gy < 16:
                filled = GLYPH[gy][gx] == "1"
            row += px(size, size, x, y, GOLD if filled else BG)
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    return png


def main():
    for size in (192, 512):
        out = ROOT / f"icon-{size}.png"
        out.write_bytes(make(size))
        print(f"OK {out} — {out.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
