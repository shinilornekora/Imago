"""Проверка проверяльщика: `analysis.verify` обязан ЛОВИТЬ порчу, а не просто печатать «OK».

Тест строит минимальную, но полностью согласованную серию (CSV + записи прогонов + паспорт),
убеждается, что расхождений нет, и затем портит по одному месту за раз — каждая порча должна
быть названа. Проверка, которая не падает ни на чём, бесполезна.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from analysis import verify as V


ROUTE = [2, 3, 4, 2, 5]
PAGES = 10
STATIC_IN, STATIC_OUT = 260_394, 4_085
API_IN, API_OUT = 1_000_000, 10_000


def _record(run_id: str, mode: str, cache: int, held_pages: int, misses: int) -> dict:
    return {
        "run_id": run_id,
        "harness_id": "abcdef0123456789",
        "reference_ok": True,
        "shaper": {
            "config": {"delayMs": 25, "bandwidthMbit": 20, "handshakeRttMs": 50},
            "stats": {
                "bytesIn": API_OUT + STATIC_OUT,
                "bytesOut": API_IN + STATIC_IN,
                "byRoute": {
                    "/api": {"bytesOut": API_IN, "bytesIn": API_OUT},
                    "/zero": {"bytesOut": 0, "bytesIn": 0},
                    "/": {"bytesOut": STATIC_IN, "bytesIn": STATIC_OUT},
                    "(none)": {"bytesOut": 0, "bytesIn": 0},
                },
            },
        },
        "scenario": {
            "t_first_ready": 700.0,
            "t_cmd_ack": 70.0,
            "t_cmd_drawn": 180.0,
            "t_scenario": 12000.0,
            "nav_cache_hits": len(ROUTE) - misses,
            "nav_cache_misses": misses,
            "retained_end_exact": {"pages": held_pages, "shapes": held_pages * 500},
            "steps": [{"action": "open", "page_index": 1}] + [{"action": "nav", "page_index": p} for p in ROUTE],
        },
    }


def _row(run_id: str, mode: str, cache: int, held_pages: int, misses: int) -> dict:
    return {
        "run_id": run_id,
        "series": "t",
        "adapter": "H",
        "mode": mode,
        "cache": cache,
        "doc": "d",
        "repetition": 0,
        "order_index": 0,
        "outcome": "ok",
        "doc_pages": PAGES,
        "t_first_ready_ms": 700.0,
        "t_cmd_ack_ms": 70.0,
        "t_cmd_drawn_ms": 180.0,
        "t_scenario_ms": 12000.0,
        "nav_cache_hits": len(ROUTE) - misses,
        "nav_cache_misses": misses,
        "retained_pages_end_exact": held_pages,
        "retained_shapes_end_exact": held_pages * 500,
        "reference_ok": True,
        "bytes_in": API_IN + STATIC_IN,
        "bytes_out": API_OUT + STATIC_OUT,
        "bytes_in_api": API_IN,
        "bytes_in_zero": 0,
        "bytes_in_static": STATIC_IN,
        "bytes_in_other": 0,
        "bytes_out_api": API_OUT,
        "bytes_out_zero": 0,
        "bytes_out_static": STATIC_OUT,
        "bytes_out_other": 0,
        "bytes_in_route_residual": 0,
        "bytes_out_route_residual": 0,
        "cdp_bytes_in": API_IN + STATIC_IN,
        "cdp_ws_bytes_in": 0,
        "chromium_private_peak_mib": 190.0,
        "chromium_private_peak_raw_mib": 190.0,
        "chromium_private_peak_excl_probe_mib": 188.0,
        "probe_window_count": 7,
        "harness_id": "abcdef0123456789",
    }


def _write(tmp_path: Path, rows: list[dict], recs: list[dict], passport: dict | None = None) -> Path:
    import pandas as pd

    out = tmp_path / "s"
    (out / "runs").mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(out / "runs.csv", index=False)
    for r in recs:
        (out / "runs" / f"{r['run_id']}.json").write_text(json.dumps(r, ensure_ascii=False), encoding="utf-8")
    (out / "passport.json").write_text(
        json.dumps(
            passport
            or {
                "shaper": {"effective": {"delayMs": 25, "bandwidthMbit": 20, "handshakeRttMs": 50}},
                "harness": {
                    "harnessIdShort": "abcdef0123456789",
                    "benchId": "B",
                    "columnsSha256": "C",
                    "comparableBy": ["benchId", "columnsSha256"],
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return out


def _clean(tmp_path: Path):
    # окно ёмкости 2 (cache=1) на маршруте [2,3,4,2,5]: промахов 5, в окне остаются 2 страницы
    win, misses = V.lru_window(ROUTE, 2)
    assert (len(win), misses) == (2, 5)
    rows = [_row("r-p", "P", 1, len(win), misses), _row("r-f", "F", 1, PAGES, 0)]
    recs = [_record("r-p", "P", 1, len(win), misses), _record("r-f", "F", 1, PAGES, 0)]
    return rows, recs


def test_lru_window_is_a_real_lru():
    # без вытеснения: ёмкость больше числа разных страниц
    assert V.lru_window([2, 3, 2], 10) == ([1, 3, 2], 2)
    # ёмкость 2: каждая новая страница вытесняет самую давнюю
    assert V.lru_window([2, 3, 2], 2) == ([3, 2], 2)
    # повторное обращение ОБНОВЛЯЕТ давность (иначе это FIFO, а не LRU)
    assert V.lru_window([2, 1, 3], 2) == ([1, 3], 2)
    assert V.lru_window([], 2) == ([1], 0)


def test_clean_series_has_no_problems(tmp_path):
    rows, recs = _clean(tmp_path)
    res = V.verify_series(_write(tmp_path, rows, recs))
    assert res["problems"] == [], res["problems"]
    assert res["counts"]["runs"] == 2 and res["counts"]["lru_p"] == 1 and res["counts"]["lru_f"] == 1
    assert res["probe_windows"] == [7]


@pytest.mark.parametrize(
    "mutate, needle",
    [
        (lambda rows, recs, pp: rows[0].__setitem__("bytes_in_api", API_IN + 1), "bytes_in_api"),
        (lambda rows, recs, pp: rows[0].__setitem__("bytes_in", API_IN + STATIC_IN + 7), "сумма по маршрутам"),
        (lambda rows, recs, pp: rows[0].__setitem__("bytes_in_route_residual", -50), "route_residual"),
        (lambda rows, recs, pp: rows[0].__setitem__("cdp_bytes_in", 10), "расхождение"),
        (lambda rows, recs, pp: rows[0].__setitem__("t_first_ready_ms", 900.0), "t_first_ready_ms"),
        (lambda rows, recs, pp: rows[0].__setitem__("retained_pages_end_exact", 5), "модель LRU"),
        (lambda rows, recs, pp: rows[0].__setitem__("nav_cache_misses", 2), "промахов по модели"),
        (lambda rows, recs, pp: rows[1].__setitem__("retained_pages_end_exact", 4), "режим F удерживает"),
        (lambda rows, recs, pp: rows[0].__setitem__("chromium_private_peak_raw_mib", 200.0), "chromium_private_peak_mib"),
        (lambda rows, recs, pp: rows[0].__setitem__("chromium_private_peak_excl_probe_mib", 999.0), "больше сырого"),
        (lambda rows, recs, pp: rows[1].__setitem__("probe_window_count", 9), "паритет проб"),
        (lambda rows, recs, pp: rows[0].__setitem__("harness_id", "deadbeefdeadbeef"), "harness_id"),
        (lambda rows, recs, pp: rows[0].__setitem__("reference_ok", False), "reference_ok"),
        (lambda rows, recs, pp: recs[0]["shaper"]["config"].__setitem__("delayMs", 75), "shaper.delayMs"),
    ],
)
def test_each_corruption_is_named(tmp_path, mutate, needle):
    rows, recs = _clean(tmp_path)
    mutate(rows, recs, None)
    res = V.verify_series(_write(tmp_path, rows, recs))
    assert res["problems"], f"порча не обнаружена (ожидалось упоминание {needle!r})"
    assert any(needle in m for m in res["problems"]), res["problems"]


def test_missing_run_record_is_reported(tmp_path):
    rows, recs = _clean(tmp_path)
    out = _write(tmp_path, rows, recs[:1])
    res = V.verify_series(out)
    assert any("нет записи прогона" in m for m in res["problems"]), res["problems"]


def test_cross_series_comparability(tmp_path):
    rows, recs = _clean(tmp_path)
    a = _write(tmp_path, rows, recs)
    b_dir = tmp_path / "other"
    b_dir.mkdir()
    import shutil

    shutil.copytree(a, b_dir / "s")
    # вторая серия снята другой оболочкой → сравнивать абсолютные величины нельзя
    pp = json.loads((b_dir / "s" / "passport.json").read_text(encoding="utf-8"))
    pp["harness"]["benchId"] = "OTHER"
    (b_dir / "s" / "passport.json").write_text(json.dumps(pp, ensure_ascii=False), encoding="utf-8")
    out = V.verify_all([a, b_dir / "s"])
    assert any("comparableBy" in m for m in out["cross_problems"]), out["cross_problems"]
