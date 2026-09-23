"""Тесты перекрёстного отчёта и SUMMARY на синтетических сериях.

Проверяется не «числа сошлись» (для этого есть test_stats), а то, что оси
строятся из паспортов, оговорка о разных маршрутах появляется именно тогда,
когда маршруты разные, и что CLI обоих модулей доходит до файла.
"""

from pathlib import Path

import pytest

from analysis import cross as C
from analysis import summary as SUM
from analysis.synth import make_series, write_series


@pytest.fixture(scope="module")
def base(tmp_path_factory):
    d = tmp_path_factory.mktemp("results")
    df, steps = make_series(name="main", runs=12, seed=3)
    write_series(
        d / "main",
        df,
        steps,
        passport={
            "seriesConfig": {"doc": "doc-acc-50x500", "docPages": 50, "docShapesPerPage": 500,
                             "scenario": {"route": [2, 3, 1, 4, 2, 5, 1, 6, 3, 50]}},
            "shaper": {"effective": {"delayMs": 25, "handshakeRttMs": 50, "bandwidthMbit": 20}},
            "repetitions": 12,
        },
    )
    df3, steps3 = make_series(name="cache3", runs=6, cache=3, seed=4, modes=("P",), with_steps=0)
    write_series(
        d / "cache3",
        df3,
        steps3,
        passport={
            "seriesConfig": {"doc": "doc-acc-50x500", "docPages": 50, "docShapesPerPage": 500,
                             "scenario": {"route": [2, 3, 1, 4, 2, 5, 1, 6, 3, 50]}},
            "shaper": {"effective": {"delayMs": 25, "handshakeRttMs": 50, "bandwidthMbit": 20}},
            "repetitions": 6,
        },
    )
    df5, steps5 = make_series(name="doc5x100", runs=6, seed=5, with_steps=0)
    write_series(
        d / "doc5x100",
        df5,
        steps5,
        passport={
            "seriesConfig": {"doc": "doc-small-5x100", "docPages": 5, "docShapesPerPage": 100,
                             "scenario": {"route": [2, 3, 1, 4, 2, 5, 1, 3, 2, 5]}},
            "shaper": {"effective": {"delayMs": 25, "handshakeRttMs": 50, "bandwidthMbit": 20}},
            "repetitions": 6,
        },
    )
    return d


def test_series_reads_passport_axes(base):
    s = C.Series("main", base / "main")
    assert s.doc_pages == 50 and s.doc_shapes == 500 and s.total_shapes == 25_000
    assert s.rtt_ms == 50
    # маршрут §7.2: 6 новых страниц, 4 возврата, 7 различных страниц с учётом стартовой
    assert (s.n_new, s.n_return, s.n_visited) == (6, 4, 7)


def test_short_route_counted_by_novelty_not_by_index(base):
    """В документе из 5 страниц маршрут даёт 4 новых и 6 возвратов — оговорка обязана появиться."""
    s = C.Series("doc5x100", base / "doc5x100")
    assert (s.n_new, s.n_return, s.n_visited) == (4, 6, 5)
    text = C.section_inventory(C.load_series([f"main={base / 'main'}", f"doc5x100={base / 'doc5x100'}"]))
    assert "Маршруты серий не одинаковы по составу переходов" in text


def test_same_routes_produce_no_route_warning(base):
    text = C.section_inventory(C.load_series([f"main={base / 'main'}", f"cache3={base / 'cache3'}"]))
    assert "Маршруты серий не одинаковы" not in text


def test_cache_axis_marks_window_that_never_binds(base):
    """Если объявленное окно ≥ числа посещённых страниц, вытеснения нет — это должно быть названо."""
    series = C.load_series([f"main={base / 'main'}", f"cache3={base / 'cache3'}"])
    text = C.section_cache_retained(series, [("cache=1", "main", 1), ("cache=10", "cache3", 10)])
    assert "маршрут" in text and "окно" in text


def test_build_cross_writes_report_and_figures(base, tmp_path):
    out = tmp_path / "RESULTS_cross.md"
    res = C.build_cross(
        [f"main={base / 'main'}", f"cache3={base / 'cache3'}", f"doc5x100={base / 'doc5x100'}"],
        out,
        tmp_path / "figs",
        seed=1,
        n_boot=120,
    )
    text = out.read_text(encoding="utf-8")
    for h in ("# Перекрёстное сравнение серий", "## 1. Состав сравниваемых серий",
              "## 2. Окно кеша", "## 3. Размер документа",
              "## 4. Доля документа", "## 5. Форма команды", "## 6. RTT", "## 7. Бюджеты"):
        assert h in text, h
    # осей, для которых нет серий, быть не должно с пустыми таблицами — но заголовок остаётся
    assert "_нет серии вариантов команды_" in text, "серия вариантов не передана — это должно быть сказано прямо"
    assert res["figs"], "ожидались графики хотя бы по одной оси"
    assert all(Path(p).exists() for p in res["figs"])


def test_build_summary_has_all_sections(base, tmp_path):
    out = tmp_path / "SUMMARY.md"
    SUM.build_summary([f"main={base / 'main'}", f"cache3={base / 'cache3'}"], out, seed=1, n_boot=120)
    text = out.read_text(encoding="utf-8")
    for h in (
        "## 1. Серии",
        "## 2. Показатели по сериям и конфигурациям",
        "## 3. Изменение внутри адаптера: P − F и P ÷ F",
        "## 4. Сопоставление изменения между адаптерами (§1.8)",
        "## 5. Бюджеты §1.2",
        "## 6. Удерживаемые записи против объявленного окна",
        "### 7.1 Моменты команды",
        "### 7.2 Перекрёстная проверка обмена",
    ):
        assert h in text, h
    # числовая опора обязана нести n и интервалы, иначе её нельзя цитировать
    assert "95 % ИД медианы" in text and "Пар (блоков)" in text


def test_summary_marks_small_samples(base, tmp_path):
    """n < 8 помечается †: выдавать такой интервал за 95 % нельзя молча."""
    df, steps = make_series(name="tiny", runs=4, seed=7, with_steps=0)
    write_series(base / "tiny", df, steps, passport={"repetitions": 4})
    out = tmp_path / "SUMMARY_tiny.md"
    SUM.build_summary([f"tiny={base / 'tiny'}"], out, seed=1, n_boot=80)
    assert "†" in out.read_text(encoding="utf-8")


def test_command_shape_axis_splits_variants(base, tmp_path):
    """Ось формы команды: варианты не усредняются и видны отдельными столбцами."""
    import pandas as pd

    df, steps = make_series(name="command-shape", runs=6, seed=11, with_steps=0)
    a = df.copy()
    a["cmd_variant"], a["cmd_target_id"] = "baseline", "doc-cmd-50x500-src-1"
    a["cmd_affected_shapes"], a["cmd_affected_pages"] = 81, 10
    b = df.copy()
    b["cmd_variant"], b["cmd_target_id"] = "large-share", "doc-cmd-50x500-src-23"
    b["cmd_affected_shapes"], b["cmd_affected_pages"] = 2001, 50
    b["run_id"] = b["run_id"].astype(str) + "-ls"
    b["t_cmd_drawn_ms"] = b["t_cmd_drawn_ms"] * 5
    write_series(
        tmp_path / "command-shape",
        pd.concat([a, b], ignore_index=True),
        [],
        passport={
            "seriesConfig": {
                "doc": "doc-cmd-50x500",
                "docPages": 50,
                "docShapesPerPage": 500,
                "scenario": {"route": [2, 3, 1, 4, 2, 5, 1, 6, 3, 50]},
                "variants": [
                    {"name": "baseline", "sourceId": "doc-cmd-50x500-src-1", "note": "81 фигура на 10 страницах"},
                    {"name": "large-share", "sourceId": "doc-cmd-50x500-src-23", "note": "2001 фигура на 50 страницах"},
                ],
            },
            "shaper": {"effective": {"delayMs": 25, "handshakeRttMs": 50, "bandwidthMbit": 20}},
            "repetitions": 6,
        },
    )
    series = C.load_series([f"main={base / 'main'}", f"command-shape={tmp_path / 'command-shape'}"])
    inv = C.section_command_shape_inventory(series, "command-shape")
    assert "2 001" in inv and "50" in inv and "81 фигура на 10 страницах" in inv
    text = C.section_command_shape(series, "command-shape", seed=1, n_boot=80)
    assert "| Конфигурация | baseline | large-share |" in text.replace(" Δ и ×: large-share против baseline |", " |")
    assert "Δ и ×: large-share против baseline" in text
    # различие по вариантам должно быть подтверждено (интервал не накрывает 0)
    assert " *" in text
