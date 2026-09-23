"""Синтетическая серия с известными распределениями — для тестов и «сухого»
прогона отчёта до появления реальных данных.

    python -m analysis.synth --out results/synthetic [--runs 30] [--cache 1] [--seed 1]

Значения каждой метрики в конфигурации — центр ± разброс по симметричной
решётке (linspace), перемешанной seed'ом: выборочная медиана равна центру
точно, p95 (линейная интерполяция) = центр + 0.9·разброс.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import schema as S

NAV_ORDER = [2, 3, 1, 4, 2, 5, 1, 6, 3, 50]
NAV_IS_NEW = [True, True, False, True, False, True, False, True, False, True]


def centers(adapter: str, mode: str, cache: int = 1) -> dict[str, tuple[float, float]]:
    """metric → (центр, полуразброс) для конфигурации."""
    z = adapter == "Z"
    q = adapter == "Q"
    add = 300 if z else (100 if q else 0)
    P = mode == "P"
    win = cache + 1
    c: dict[str, tuple[float, float]] = {
        "t_first_ready_ms": ((700 + add / 2) if P else (2600 + add), 200),
        "t_nav_new_ms": ((400 + add / 3) if P else 150, 60),
        "t_nav_return_ms": ((120 + (200 if P and cache == 1 else 0)) if P else 100, 30),
        # Моменты команды. У H/Q холст обновляется после ответа сервера и
        # перечитывания страницы (drawn > ack). У Z данные приходят
        # синхронизацией и опережают подтверждение, которому нужен ещё один
        # HTTP-круг за результатом операции (drawn < ack) — эта семантика и
        # проверяется разделом «Моменты команды».
        "t_cmd_ack_ms": (215 if z else 120 + add / 3, 30),
        "t_cmd_drawn_ms": (205 if z else (350 if P else 300), 60),
        "t_cmd_server_ms": (140 if z else 0, 25 if z else 0),
        "t_cmd_synced_ms": (195 if z else 0, 30 if z else 0),
        "t_cmd_opget_ms": (70 if z else 0, 15 if z else 0),
        "t_scenario_ms": ((15000 if P else 16000) + add * 2, 1000),
        "probe_overrun_ms": ((900 if z and not P else 150), 60),
        "bytes_in": ((500_000 * min(win, 10) / 2) if P else 3_000_000, 50_000),
        "bytes_out": (60_000 if P else 90_000, 5_000),
        # Статика сборки — поадаптерная КОНСТАНТА (значения порядка выполненной программы):
        # она входит в `bytes_in` одинаково в F и в P, поэтому проверка «данные против полного
        # трафика» на синтетике должна воспроизводить именно этот эффект.
        "bytes_in_static": (572_562 if z else (291_444 if q else 260_432), 0),
        "bytes_out_static": (4_143 if z else 4_085, 0),
        # CDP: у Z почти весь обмен идёт кадрами WebSocket, у H/Q — только HTTP.
        # Сумма HTTP + WS совпадает с шейпером (это и проверяет перекрёстная
        # проверка); исходящая оценка CDP систематически занижена.
        "cdp_http_share_in": (0.08 if z else 1.0, 0.0),
        "cdp_out_factor": (0.78, 0.0),
        "js_heap_peak_mb": ((60 + 5 * win) if P else 180, 10),
        "js_heap_end_mb": ((40 + 5 * win) if P else 150, 10),
        "chromium_private_peak_mib": (((350 + 10 * win) if P else 600) + (80 if z else 0), 30),
        "chromium_private_end_mib": (((300 + 10 * win) if P else 550) + (80 if z else 0), 30),
        "client_storage_bytes": ((2_000_000 if P else 12_000_000) if z else 0, 0),
        "server_api_cpu_ms": ((500 if P else 800), 80),
        "server_api_mem_peak_mib": (120, 10),
        "server_pg_cpu_ms": ((250 if P else 400), 40),
        "server_pg_mem_peak_mib": (60, 5),
        "server_zero_cpu_ms": ((1200 if P else 1500) if z else 0, 100 if z else 0),
        "server_zero_mem_peak_mib": (300 if z else 0, 20 if z else 0),
        "zero_replica_bytes": (50_000_000 if z else 0, 0),
    }
    return c


def _grid(center: float, spread: float, n: int, rng: np.random.Generator) -> np.ndarray:
    if spread == 0 or n == 1:
        return np.full(n, float(center))
    vals = center + spread * np.linspace(-1.0, 1.0, n)
    rng.shuffle(vals)
    return vals


def make_series(
    *,
    name: str = "synthetic",
    runs: int = 30,
    cache: int = 1,
    doc: str = "doc-50x500",
    doc_pages: int = 50,
    doc_shapes_per_page: int = 500,
    seed: int = 1,
    errors: dict[tuple[str, str], int] | None = None,
    timeouts: dict[tuple[str, str], int] | None = None,
    adapters: tuple[str, ...] = ("H", "Q", "Z"),
    modes: tuple[str, ...] = ("F", "P"),
    with_steps: int = 3,
) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    """Возвращает (runs DataFrame, per-run JSON объекты для первых `with_steps` прогонов каждой конфигурации)."""
    rng = np.random.default_rng(seed)
    errors = errors or {}
    timeouts = timeouts or {}
    rows: list[dict[str, Any]] = []
    steps_docs: list[dict[str, Any]] = []
    configs = [(a, m) for a in adapters for m in modes]
    for a, m in configs:
        c = centers(a, m, cache)
        cols = {k: _grid(v[0], v[1], runs, rng) for k, v in c.items()}
        n_err, n_to = errors.get((a, m), 0), timeouts.get((a, m), 0)
        for i in range(runs):
            row: dict[str, Any] = {
                "run_id": f"{name}-{a}{m}-{i:03d}",
                "series": name,
                "adapter": a,
                "mode": m,
                "cache": cache,
                "doc": doc,
                "repetition": i,
                "order_index": 0,
                "started_at": f"2026-09-11T10:{i % 60:02d}:00Z",
                "outcome": "ok",
                "error_stage": "",
                "doc_pages": doc_pages,
                "doc_shapes_per_page": doc_shapes_per_page,
            }
            if i < n_err:
                row.update({"outcome": "error", "error_stage": "nav_3"})
                for col in S.REQUIRED_COLUMNS:
                    if col not in row:
                        row[col] = ""
                row["reference_ok"] = ""
                rows.append(row)
                continue
            nav_new = cols["t_nav_new_ms"][i]
            nav_ret = cols["t_nav_return_ms"][i]
            navs = [nav_new if is_new else nav_ret for is_new in NAV_IS_NEW]
            for k, v in enumerate(navs, start=1):
                row[f"t_nav_{k}_ms"] = v
            row["t_nav_new_median_ms"] = float(np.median([v for v, n in zip(navs, NAV_IS_NEW) if n]))
            row["t_nav_return_median_ms"] = float(np.median([v for v, n in zip(navs, NAV_IS_NEW) if not n]))
            for k in ("t_first_ready_ms", "t_cmd_ack_ms", "t_cmd_drawn_ms", "t_scenario_ms", "bytes_in", "bytes_out", "js_heap_peak_mb", "js_heap_end_mb", "chromium_private_peak_mib", "chromium_private_end_mib", "client_storage_bytes", "server_api_cpu_ms", "server_api_mem_peak_mib", "server_pg_cpu_ms", "server_pg_mem_peak_mib", "server_zero_cpu_ms", "server_zero_mem_peak_mib", "zero_replica_bytes"):
                row[k] = cols[k][i]
            # Необязательные колонки: разложение времени команды у Z и учёт
            # накладных расходов измерительной пробы.
            # разложение обмена по назначению: статика + данные (у Z почти все данные — по WebSocket)
            row["bytes_in_static"] = cols["bytes_in_static"][i]
            data_in = max(row["bytes_in"] - row["bytes_in_static"], 0.0)
            row["bytes_in_zero"] = round(data_in * (0.95 if a == "Z" else 0.0))
            row["bytes_in_api"] = round(data_in - row["bytes_in_zero"])
            row["bytes_out_static"] = cols["bytes_out_static"][i]
            data_out = max(row["bytes_out"] - row["bytes_out_static"], 0.0)
            row["bytes_out_zero"] = round(data_out * (0.95 if a == "Z" else 0.0))
            row["bytes_out_api"] = round(data_out - row["bytes_out_zero"])
            share = cols["cdp_http_share_in"][i]
            row["cdp_bytes_in"] = round(row["bytes_in"] * share)
            row["cdp_ws_bytes_in"] = round(row["bytes_in"] - row["cdp_bytes_in"])
            row["cdp_bytes_out"] = round(row["bytes_out"] * cols["cdp_out_factor"][i] * share)
            row["cdp_ws_bytes_out"] = round(row["bytes_out"] * cols["cdp_out_factor"][i] * (1 - share))
            if a == "Z":
                for k in ("t_cmd_server_ms", "t_cmd_synced_ms", "t_cmd_opget_ms"):
                    row[k] = cols[k][i]
            row["probe_overrun_ms"] = cols["probe_overrun_ms"][i]
            row["t_scenario_wall_ms"] = row["t_scenario_ms"] + row["probe_overrun_ms"]
            if i >= n_err and i < n_err + n_to:
                row["outcome"] = "timeout"
                row["error_stage"] = "scenario"
                row["t_scenario_ms"] = 31000 + i
            for part in ("api", "pg", "zero"):
                row[f"server_{part}_mem_integral_mib_s"] = row[f"server_{part}_mem_peak_mib"] * row["t_scenario_ms"] / 1000 * 0.9
            if m == "F":
                row.update({"retained_pages_end": doc_pages, "retained_shapes_end": doc_pages * doc_shapes_per_page, "retained_pages_max": doc_pages, "retained_shapes_max": doc_pages * doc_shapes_per_page, "loaded_pages_end": doc_pages})
            else:
                win = min(cache + 1, doc_pages)
                row.update({"retained_pages_end": win, "retained_shapes_end": win * doc_shapes_per_page, "retained_pages_max": win, "retained_shapes_max": win * doc_shapes_per_page, "loaded_pages_end": win})
            row["within_budget_first"] = row["t_first_ready_ms"] <= S.BUDGET_FIRST_READY_MS
            row["within_budget_nav"] = all(v <= S.BUDGET_NAV_MS for v in navs)
            row["within_budget_cmd"] = row["t_cmd_drawn_ms"] <= S.BUDGET_CMD_DRAWN_MS
            row["within_budget_scenario"] = row["t_scenario_ms"] <= S.BUDGET_SCENARIO_MS
            row["reference_ok"] = True
            rows.append(row)
            if i < with_steps and row["outcome"] == "ok":
                steps = []
                retained_pages = 0
                for s, page in enumerate([1, *NAV_ORDER]):
                    if m == "F":
                        retained_pages = doc_pages
                    else:
                        retained_pages = min(retained_pages + 1, cache + 1)
                    steps.append({"step": s, "action": "open" if s == 0 else "nav", "page_id": f"p{page}", "t_ms": row["t_first_ready_ms"] if s == 0 else navs[s - 1], "retained_pages": retained_pages, "retained_shapes": retained_pages * doc_shapes_per_page, "loaded_pages": retained_pages})
                steps_docs.append({"run_id": row["run_id"], "adapter": a, "mode": m, "cache": cache, "steps": steps})
    df = pd.DataFrame(rows)
    order = rng.permutation(len(df))
    df["order_index"] = order
    df = df.sort_values("order_index").reset_index(drop=True)
    df = df[[c for c in S.REQUIRED_COLUMNS if c in df.columns] + [c for c in df.columns if c not in S.REQUIRED_COLUMNS]]
    return df, steps_docs


def write_series(out_dir: str | Path, df: pd.DataFrame, steps_docs: list[dict[str, Any]], passport: dict[str, Any] | None = None) -> Path:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    df.to_csv(out / "runs.csv", index=False)
    if steps_docs:
        (out / "runs").mkdir(exist_ok=True)
        for d in steps_docs:
            (out / "runs" / f"{d['run_id']}.json").write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    (out / "passport.json").write_text(json.dumps(passport or {"synthetic": True, "note": "synthetic data, not a measurement"}, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", required=True)
    p.add_argument("--name")
    p.add_argument("--runs", type=int, default=30)
    p.add_argument("--cache", type=int, default=1)
    p.add_argument("--seed", type=int, default=1)
    a = p.parse_args(argv)
    name = a.name or Path(a.out).name
    df, steps = make_series(name=name, runs=a.runs, cache=a.cache, seed=a.seed, errors={("Z", "P"): 1}, timeouts={("Q", "F"): 1})
    write_series(a.out, df, steps)
    print(f"written {len(df)} runs to {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
