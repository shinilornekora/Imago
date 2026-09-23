"""Сквозная проверка публикуемых чисел по СЫРЫМ данным `results/<серия>/**`.

Отчёты (`analysis.report`, `analysis.cross`, `analysis.summary`) считают всё из `runs.csv`.
Этот модуль проверяет сам `runs.csv` — против записей прогонов, против паспорта серии и против
независимых моделей, то есть отвечает на вопрос «а верны ли входные данные», на который отчёт
ответить не может по построению.

Что проверяется (всё — ПОПРОГОННО, а не по медианам; каждая проверка возвращает число прогонов,
которые её прошли, и поимённый список тех, которые не прошли):

1. **Состав** — у каждого прогона CSV есть запись `runs/<run_id>.json` и наоборот.
2. **Параметры канала** — `shaper.config` прогона совпадает с `passport.shaper.effective` серии.
   Серия, снятая с другим шейпером, чем объявлено в паспорте, непригодна целиком.
3. **Разложение обмена** — `bytes_*_{api,zero,static,other}` совпадают со счётчиками шейпера по
   маршрутам (`shaper.stats.byRoute`), их сумма равна итогу побайтно, а собственный контрольный
   остаток оболочки `bytes_*_route_residual` равен нулю. Головная величина `bytes_in_data`
   осмысленна ровно настолько, насколько это выполняется.
4. **Перекрёстная проверка обмена** — шейпер против CDP (HTTP **плюс** WebSocket), допуск 10 %.
5. **Времена, удержание, эталон** — колонки CSV против полей записи прогона.
6. **Пик памяти** — `chromium_private_peak_mib == chromium_private_peak_raw_mib` (совместимость
   схемы) и «пик без окон проб ≤ сырого».
7. **Паритет проб** — `probe_window_count` одинаков у ВСЕХ конфигураций серии, иначе адаптеры
   измерены разным инструментом и пики памяти между ними несравнимы.
8. **Независимая модель LRU** — окно ёмкости `cache + 1` прогоняется по маршруту серии заново, и
   предсказанные состав окна в конце прогона и число промахов сверяются с измеренными.
   **Для прогонов P** проверяется политика вытеснения; **для прогонов F** — другое утверждение
   («удержаны все страницы документа»), потому что в F окно не действует вовсе. Это не поблажка
   режиму F, а разные утверждения для разных режимов, и отчёт печатает их раздельно.
9. **Идентичность оболочки** — `harness_id` строки CSV равен `passport.harness.harnessIdShort`,
   а критерий сопоставимости серий (`harness.comparableBy`) совпадает у всех переданных серий.

CLI::

    python -m analysis.verify --series results/main,results/cache3
    python -m analysis.verify --series results/main --quiet     # только итог

Код возврата: 0 — расхождений нет; 1 — есть (перечислены поимённо).
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Sequence

import pandas as pd

from . import schema as S

#: Допуск перекрёстной проверки обмена по входящему направлению (шейпер против CDP HTTP+WS).
#: Исходящее направление не проверяется: `cdp_bytes_out` оценивается, а не измеряется.
CDP_TOLERANCE = 0.10

#: Соответствие «маршрут шейпера → колонка CSV». Шейпер считает со своей стороны, поэтому
#: `byRoute[...].bytesOut` — это байты К КЛИЕНТУ (`bytes_in` в CSV), а `bytesIn` — от клиента.
ROUTE_TO_COLUMN = {"/api": "api", "/zero": "zero", "/": "static", "(none)": "other"}

#: Колонки CSV и соответствующие им поля `scenario` записи прогона. Допуск 0.11 мс — цена
#: округления при записи CSV, а не измерения.
SCENARIO_FIELDS = [
    ("t_first_ready_ms", "t_first_ready"),
    ("t_cmd_ack_ms", "t_cmd_ack"),
    ("t_cmd_drawn_ms", "t_cmd_drawn"),
    ("t_scenario_ms", "t_scenario"),
    ("t_scenario_wall_ms", "t_scenario_wall"),
    ("retained_pages_max", "retained_pages_max"),
    ("retained_shapes_max", "retained_shapes_max"),
    ("loaded_pages_end", "loaded_pages_end"),
    ("nav_cache_hits", "nav_cache_hits"),
    ("nav_cache_misses", "nav_cache_misses"),
]
SCENARIO_TOLERANCE_MS = 0.11


def lru_window(route: Sequence[int], capacity: int, *, start: int = 1) -> tuple[list[int], int]:
    """Независимая модель окна: (состав окна в конце, число промахов) при ёмкости `capacity`.

    Реализована здесь ЗАНОВО, а не взята из `cross.Series.modeled_reads`, именно чтобы быть
    независимой проверкой: если обе реализации ошибутся одинаково, проверка ничего не стоит.
    """
    window = [start]
    misses = 0
    for page in route:
        if page in window:
            window.remove(page)
            window.append(page)
            continue
        misses += 1
        window.append(page)
        if len(window) > capacity:
            window.pop(0)
    return window, misses


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return math.nan


def verify_series(path: str | Path) -> dict[str, Any]:
    """Проверяет одну серию. Возвращает словарь со счётчиками и списком расхождений."""
    path = Path(path)
    df = pd.read_csv(path / "runs.csv", low_memory=False)
    passport = S.load_passport(path) or {}
    effective = ((passport.get("shaper") or {}).get("effective") or {}) if isinstance(passport, dict) else {}
    harness = passport.get("harness") if isinstance(passport.get("harness"), dict) else {}
    problems: list[str] = []
    counts = {k: 0 for k in ("runs", "shaper", "traffic", "cdp", "scenario", "peak", "harness", "lru_p", "lru_f")}

    files = {p.stem: p for p in sorted((path / "runs").glob("*.json"))} if (path / "runs").is_dir() else {}
    by_id = {str(r["run_id"]): r for _, r in df.iterrows()}
    for rid in by_id:
        if rid not in files:
            problems.append(f"{rid}: нет записи прогона `runs/{rid}.json`")
    for rid in files:
        if rid not in by_id:
            problems.append(f"{rid}: запись прогона есть, строки в runs.csv нет")

    for rid, row in by_id.items():
        counts["runs"] += 1
        if rid not in files:
            continue
        rec = json.loads(files[rid].read_text(encoding="utf-8"))

        # 2. параметры канала
        cfg = (rec.get("shaper") or {}).get("config") or {}
        for k, v in effective.items():
            if k in cfg and cfg[k] != v:
                problems.append(f"{rid}: shaper.{k} = {cfg[k]}, в паспорте {v}")
        counts["shaper"] += 1

        # 3. разложение обмена
        stats = (rec.get("shaper") or {}).get("stats") or {}
        by_route = stats.get("byRoute") or {}
        for direction, csv_total, rec_total, rec_field in (
            ("in", "bytes_in", stats.get("bytesOut"), "bytesOut"),
            ("out", "bytes_out", stats.get("bytesIn"), "bytesIn"),
        ):
            parts = 0
            for route, suffix in ROUTE_TO_COLUMN.items():
                col = f"bytes_{direction}_{suffix}"
                want = int((by_route.get(route) or {}).get(rec_field, 0) or 0)
                parts += want
                if col in row and int(_num(row[col])) != want:
                    problems.append(f"{rid}: {col} = {row[col]}, по byRoute {want}")
            total = int(_num(row[csv_total]))
            if rec_total is not None and total != int(rec_total):
                problems.append(f"{rid}: {csv_total} = {total}, по счётчику шейпера {int(rec_total)}")
            if parts != total:
                problems.append(f"{rid}: сумма по маршрутам ({direction}) {parts} != итог {total}")
            residual = row.get(f"bytes_{direction}_route_residual")
            if residual is not None and not pd.isna(residual) and int(_num(residual)) != 0:
                problems.append(f"{rid}: bytes_{direction}_route_residual = {residual}, ожидается 0")
        counts["traffic"] += 1

        # 4. шейпер против CDP (HTTP + WebSocket)
        cdp_in = 0.0
        for c in ("cdp_bytes_in", "cdp_ws_bytes_in"):
            v = row.get(c)
            if v is not None and not pd.isna(v):
                cdp_in += _num(v)
        shaper_in = _num(row["bytes_in"])
        if shaper_in and not math.isnan(cdp_in):
            rel = abs(shaper_in - cdp_in) / shaper_in
            if rel > CDP_TOLERANCE:
                problems.append(f"{rid}: шейпер {shaper_in:.0f} против CDP {cdp_in:.0f} — расхождение {100 * rel:.1f} %")
        counts["cdp"] += 1

        # 5. времена и удержание
        sc = rec.get("scenario") or {}
        for col, field in SCENARIO_FIELDS:
            if field not in sc or col not in row or pd.isna(row[col]):
                continue
            if abs(_num(row[col]) - _num(sc[field])) > SCENARIO_TOLERANCE_MS:
                problems.append(f"{rid}: {col} = {row[col]}, в записи прогона {sc[field]}")
        exact = sc.get("retained_end_exact") or {}
        for col, key in (("retained_pages_end_exact", "pages"), ("retained_shapes_end_exact", "shapes")):
            if exact.get(key) is not None and col in row and not pd.isna(row[col]) and int(_num(row[col])) != int(exact[key]):
                problems.append(f"{rid}: {col} = {row[col]}, в записи прогона {exact[key]}")
        if "reference_ok" in row and bool(rec.get("reference_ok")) != bool(row["reference_ok"]):
            problems.append(f"{rid}: reference_ok = {row['reference_ok']}, в записи прогона {rec.get('reference_ok')}")
        counts["scenario"] += 1

        # 6. пик памяти
        raw, legacy = row.get(S.CHROMIUM_PEAK_RAW), row.get("chromium_private_peak_mib")
        free = row.get(S.CHROMIUM_PEAK_PROBE_FREE)
        if raw is not None and legacy is not None and not pd.isna(raw) and not pd.isna(legacy) and _num(raw) != _num(legacy):
            problems.append(f"{rid}: chromium_private_peak_mib {legacy} != chromium_private_peak_raw_mib {raw}")
        if free is not None and raw is not None and not pd.isna(free) and not pd.isna(raw) and _num(free) > _num(raw) + 1e-9:
            problems.append(f"{rid}: пик без окон проб {free} больше сырого {raw}")
        counts["peak"] += 1

        # 8. независимая модель LRU
        route = [st.get("page_index") for st in (sc.get("steps") or []) if st.get("action") == "nav"]
        if route and all(isinstance(p, int) for p in route):
            held = row.get("retained_pages_end_exact")
            if str(row.get("mode")) == "P":
                window, misses = lru_window(route, int(_num(row["cache"])) + 1)
                if not pd.isna(held) and int(_num(held)) != len(window):
                    problems.append(f"{rid}: модель LRU даёт {len(window)} стр., измерено {int(_num(held))} (cache={row['cache']})")
                if "nav_cache_misses" in row and not pd.isna(row["nav_cache_misses"]) and int(_num(row["nav_cache_misses"])) != misses:
                    problems.append(f"{rid}: промахов по модели {misses}, измерено {int(_num(row['nav_cache_misses']))}")
                counts["lru_p"] += 1
            else:
                pages = int(_num(row.get("doc_pages")))
                if not pd.isna(held) and pages and int(_num(held)) != pages:
                    problems.append(f"{rid}: режим F удерживает {int(_num(held))} стр. из {pages}")
                counts["lru_f"] += 1

        # 9. идентичность оболочки
        short = harness.get("harnessIdShort")
        if short and row.get("harness_id") is not None and str(row["harness_id"]) != str(short):
            problems.append(f"{rid}: harness_id = {row['harness_id']}, в паспорте {short}")
        if rec.get("harness_id") is not None and str(rec["harness_id"]) != str(row.get("harness_id")):
            problems.append(f"{rid}: harness_id в записи прогона и в CSV расходятся")
        counts["harness"] += 1

    # 7. паритет числа окон проб внутри серии
    windows: list[int] = []
    if "probe_window_count" in df.columns:
        windows = sorted({int(v) for v in pd.to_numeric(df["probe_window_count"], errors="coerce").dropna().unique()})
        if len(windows) > 1:
            problems.append(f"паритет проб нарушен: probe_window_count принимает значения {windows}")

    return {
        "series": path.name,
        "counts": counts,
        "problems": problems,
        "probe_windows": windows,
        "comparable": S.harness_comparable_signature(passport),
    }


def verify_all(paths: Sequence[str | Path]) -> dict[str, Any]:
    """Проверяет несколько серий и дополнительно — их сопоставимость между собой."""
    results = [verify_series(p) for p in paths]
    problems: list[str] = []
    # Ключ — ПУТЬ, а не имя каталога: две серии могут лежать в разных местах под одним именем
    # (например, `results/main` и `results/archive/programme-1/main`), и схлопывать их в один
    # ключ значило бы молча не проверить сопоставимость.
    signatures = {str(path): r["comparable"] for path, r in zip(paths, results)}
    if all(v is not None for v in signatures.values()) and len(signatures) > 1:
        uniq = {tuple(sorted(v[0].items())) for v in signatures.values()}
        if len(uniq) > 1:
            problems.append("серии различаются по `harness.comparableBy` — абсолютные величины между ними несопоставимы")
    elif any(v is None for v in signatures.values()):
        problems.append("не у всех серий в паспорте есть `harness.comparableBy` — сопоставимость НЕ ПРОВЕРЕНА")
    return {"series": results, "cross_problems": problems}


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="analysis.verify", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--series", required=True, help="каталоги серий через запятую")
    p.add_argument("--quiet", action="store_true", help="печатать только итог")
    a = p.parse_args(argv)
    out = verify_all([s.strip() for s in a.series.split(",") if s.strip()])
    total_problems = list(out["cross_problems"])
    for r in out["series"]:
        c = r["counts"]
        total_problems += [f"{r['series']}: {m}" for m in r["problems"]]
        if not a.quiet:
            print(
                f"{r['series']}: прогонов {c['runs']}; канал {c['shaper']}, разложение обмена {c['traffic']}, "
                f"CDP {c['cdp']}, сценарий {c['scenario']}, пик памяти {c['peak']}, оболочка {c['harness']}; "
                f"модель окна: P {c['lru_p']}, F {c['lru_f']}; окон проб {r['probe_windows'] or '—'}; "
                f"расхождений {len(r['problems'])}"
            )
    if total_problems:
        print(f"\nРАСХОЖДЕНИЙ: {len(total_problems)}")
        for m in total_problems[:50]:
            print(f"  {m}")
        if len(total_problems) > 50:
            print(f"  … и ещё {len(total_problems) - 50}")
        return 1
    print(f"\nOK — расхождений нет ({sum(r['counts']['runs'] for r in out['series'])} прогонов)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
