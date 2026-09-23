"""Перекрёстное сравнение серий (SPEC §7.4–7.5, §1.2, §1.8).

Отдельный модуль, потому что вопросы главы 1 задаются не «внутри серии», а
**между** сериями: как выигрыш частичной загрузки зависит от окна кеша, от
размера документа и от RTT. Обычный `--compare` в `analysis.report` даёт только
таблицу медиан «конфигурация × серия»; здесь строятся ещё три вещи, без которых
на вопросы §1.2 ответить нельзя:

* ось **окна кеша** — окна 1/3/10 против базы F в серии `route-repeat`, где
  маршрут окно связывает, и окно 3 против базы F в `cache3`. Внутри серии оценка
  парная (блок = повторение), поэтому §1.8 выполняется целиком: сперва изменение
  внутри адаптера, потом сопоставление этого изменения между адаптерами. Сравнение
  окон МЕЖДУ сериями делается непарным бутстрепом (блоки повторений у разных серий
  не общие) и рядом печатается фактическое удержание, потому что объявленное окно
  и наблюдаемое совпадают не автоматически;
* ось **размера документа** — величина P/F внутри адаптера (парная, блок =
  повторение) как функция полного размера документа: именно она отвечает на
  вопрос введения «с какого размера усложнение окупается»;
* ось **RTT** — 50 против 150 мс по каждой конфигурации.

Вход — те же каталоги серий. Выход — Markdown и PNG. CLI:

    python -m analysis.cross --series main=../../results/main,cache3=... \\
        --out docs/results/RESULTS_cross.md --figs docs/results/figs/cross
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import pandas as pd

from . import figures as F
from . import report as R
from . import schema as S
from . import stats as ST

# --------------------------------------------------------------------- оси

#: Метрики, по которым строятся все три оси. Порядок = порядок в отчёте.
CROSS_METRICS: list[str] = [
    "t_first_ready_ms",
    "t_nav_new_median_ms",
    "t_nav_return_median_ms",
    "t_cmd_drawn_ms",
    "t_cmd_ack_ms",
    "t_scenario_ms",
    "bytes_in_data",
    "bytes_in",
    "bytes_out",
    S.CHROMIUM_PEAK_PROBE_FREE,
    "chromium_private_peak_mib",
    "js_heap_peak_mb",
    "js_heap_post_gc_mb",
    "retained_pages_end_exact",
    "retained_shapes_end_exact",
    "server_cpu_ms_total",
    "server_mem_integral_mib_s_total",
    "server_zero_cpu_ms",
    # маршрут и повторные чтения (есть только в сериях route-*/command-shape)
    "t_nav_median_ms",
    "nav_cache_misses",
    "page_loads_observed",
    "api_page_reads",
    "api_page_read_bytes",
]

#: Метрики для оси «размер документа»: на них ставится вопрос окупаемости.
SIZE_METRICS: list[str] = [
    "t_first_ready_ms",
    "bytes_in_data",
    "bytes_in",
    S.CHROMIUM_PEAK_PROBE_FREE,
    "chromium_private_peak_mib",
    "js_heap_post_gc_mb",
    "retained_shapes_end_exact",
    "server_cpu_ms_total",
    "t_nav_new_median_ms",
    "t_scenario_ms",
]

FIG_METRICS: list[str] = [
    "t_first_ready_ms",
    "bytes_in_data",
    "chromium_private_peak_mib",
    "js_heap_post_gc_mb",
    "server_cpu_ms_total",
    "t_nav_new_median_ms",
]


# ------------------------------------------------------------------ загрузка
class Series:
    """Серия: данные, паспорт и описание документа/канала из паспорта."""

    def __init__(self, name: str, path: Path) -> None:
        self.name = name
        self.path = path
        self.df, self.validation = S.load_runs(path, require_valid=False)
        self.passport = S.load_passport(path) or {}
        cfg = (self.passport.get("seriesConfig") or {}) if isinstance(self.passport, dict) else {}
        self.doc = cfg.get("doc")
        self.doc_pages = _int_or_none(cfg.get("docPages")) or _col_mode(self.df, "doc_pages")
        self.doc_shapes = _int_or_none(cfg.get("docShapesPerPage")) or _col_mode(self.df, "doc_shapes_per_page")
        self.route = list((cfg.get("scenario") or {}).get("route") or [])
        eff = ((self.passport.get("shaper") or {}).get("effective") or {}) if isinstance(self.passport, dict) else {}
        self.rtt_ms = _int_or_none(eff.get("handshakeRttMs")) or (2 * _int_or_none(eff.get("delayMs")) if eff.get("delayMs") is not None else None)
        self.bandwidth = eff.get("bandwidthMbit")
        self.repetitions = _int_or_none(self.passport.get("repetitions"))
        self.caches = sorted({int(c) for c in self.df.loc[self.df["mode"] == "P", "cache"].dropna().unique()}) if "cache" in self.df else []
        self.modes = sorted(set(self.df["mode"].dropna().unique())) if "mode" in self.df else []

    @property
    def total_shapes(self) -> int | None:
        if self.doc_pages is None or self.doc_shapes is None:
            return None
        return int(self.doc_pages) * int(self.doc_shapes)

    @property
    def n_new(self) -> int | None:
        """Сколько переходов маршрута ведут на ещё не посещённую страницу."""
        if not self.route:
            return None
        seen = {1}
        n = 0
        for p in self.route:
            if p not in seen:
                n += 1
                seen.add(p)
        return n

    @property
    def n_return(self) -> int | None:
        return None if not self.route else len(self.route) - (self.n_new or 0)

    @property
    def n_visited(self) -> int | None:
        """Число РАЗНЫХ страниц, посещённых за сценарий (включая стартовую)."""
        return None if not self.route else len({1, *self.route})

    @property
    def return_gaps(self) -> list[int]:
        """Расстояния возвратов в шагах маршрута: сколько переходов прошло с прошлого визита.

        Ими задаётся, какое окно кеша маршрут вообще проверяет: возврат на расстоянии k попадает в
        окно ёмкости `cache + 1` тогда, когда за эти k шагов страницу не вытеснили. Считается ИЗ
        маршрута паспорта, а не берётся из описания серии, чтобы текст раздела не мог разойтись с
        тем, что исполнялось.
        """
        if not self.route:
            return []
        last: dict[int, int] = {1: 0}
        gaps: list[int] = []
        for i, page in enumerate(self.route, start=1):
            if page in last:
                gaps.append(i - last[page])
            last[page] = i
        return gaps

    @property
    def visited_share(self) -> float | None:
        """Доля документа, которую сценарий успевает посмотреть (страниц посещено / страниц в документе)."""
        v, p = self.n_visited, self.doc_pages
        return None if (v is None or not p) else float(v) / float(p)

    @property
    def affected_pages(self) -> int | None:
        """Сколько страниц затрагивает команда серии (`cmd_affected_pages`)."""
        return _col_mode(self.df, "cmd_affected_pages")

    @property
    def harness(self) -> dict[str, Any]:
        """Идентификация измерительной оболочки серии (см. `schema.harness_identity`)."""
        return S.harness_identity(self.passport)

    def modeled_reads(self, cache: int = 1) -> tuple[float, float]:
        """Модель числа чтений страниц за прогон: (в F, в P) — по маршруту и окну.

        `F` = все страницы документа + страницы, затронутые командой (их перечитывают);
        `P` = открытие + промахи окна LRU ёмкости `cache + 1` вдоль маршрута.
        Это та же модель, которой проверяется механизм (FINDINGS §1): её отношение объясняет
        отношение обмена с точностью до постоянных слагаемых (вход, метаданные, ответ команды).
        """
        if not self.route or not self.doc_pages:
            return (math.nan, math.nan)
        affected = self.affected_pages or 0
        reads_f = float(self.doc_pages) + float(affected)
        window: list[int] = [1]
        capacity = int(cache) + 1
        misses = 0
        for page in self.route:
            if page in window:
                window.remove(page)
                window.append(page)
                continue
            misses += 1
            window.append(page)
            if len(window) > capacity:
                window.pop(0)
        return (reads_f, 1.0 + float(misses))


def _int_or_none(v: Any) -> int | None:
    try:
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return None
        return int(v)
    except (TypeError, ValueError):
        return None


def _col_mode(df: pd.DataFrame, col: str) -> int | None:
    if col not in df.columns or df[col].dropna().empty:
        return None
    return _int_or_none(df[col].dropna().mode().iloc[0])


def load_series(specs: Sequence[str]) -> dict[str, Series]:
    """`name=path` или просто `path` (имя берётся из каталога)."""
    out: dict[str, Series] = {}
    for spec in specs:
        if "=" in spec:
            name, path = spec.split("=", 1)
        else:
            path = spec
            name = Path(path).name
        out[name] = Series(name, Path(path))
    return out


# ------------------------------------------------------------------ выборки
def _values(s: Series, metric: str, adapter: str, mode: str, cache: int | None = None, variant: str | None = None) -> np.ndarray:
    df = ST.ok_runs(s.df)
    if metric not in df.columns:
        return np.array([])
    if variant is not None:
        df = ST.variant_subset(df, variant)
    m = (df["adapter"] == adapter) & (df["mode"] == mode)
    if mode == "P" and cache is not None and "cache" in df.columns:
        m &= df["cache"] == cache
    return df.loc[m, metric].dropna().to_numpy(dtype="float64")


def _summ(x: np.ndarray, *, seed: int, n_boot: int, key: str) -> dict[str, float]:
    return ST.summarize(x, seed=seed, n_boot=n_boot, key=key)


def _cell(x: np.ndarray, digits: int, *, seed: int, n_boot: int, key: str) -> str:
    """`медиана [ИД] (n=…)` — одна ячейка сравнительной таблицы."""
    if x.size == 0:
        return "—"
    s = _summ(x, seed=seed, n_boot=n_boot, key=key)
    ci = "—" if math.isnan(s["ci_lo"]) else R.fmt_ci(s["ci_lo"], s["ci_hi"], digits)
    mark = R.n_mark(s["n"])
    return f"{R.fmt(s['median'], digits)} {ci}{(' ' + mark) if mark else ''} (n={int(s['n'])})"


def _delta_cell(x: np.ndarray, base: np.ndarray, digits: int, *, seed: int, n_boot: int, key: str) -> str:
    """Непарная разность медиан и отношение медиан с интервалами."""
    if x.size == 0 or base.size == 0:
        return "—"
    d, dlo, dhi = ST.bootstrap_two_sample(x, base, lambda a, b: a - b, seed=seed, n_boot=n_boot, key=key + "|d")
    # деление на ноль возможно у метрик, которые в базовой серии равны нулю
    # (например, client_storage_bytes у H/Q): отношение тогда не определено,
    # и печатать вместо него inf было бы хуже, чем не печатать ничего.
    with np.errstate(divide="ignore", invalid="ignore"):
        r, rlo, rhi = ST.bootstrap_two_sample(
            x, base, lambda a, b: np.where(b != 0, a / np.where(b == 0, np.nan, b), np.nan), seed=seed, n_boot=n_boot, key=key + "|r"
        )
    if math.isnan(r):
        return f"{R.fmt(d, digits)} {R.fmt_ci(dlo, dhi, digits)}{'' if (dlo <= 0 <= dhi) else ' *'} / × —"
    sig = "" if (dlo <= 0 <= dhi) else " *"
    return f"{R.fmt(d, digits)} {R.fmt_ci(dlo, dhi, digits)}{sig} / ×{R.fmt(r, 2)} {R.fmt_ci(rlo, rhi, 2)}"


# ---------------------------------------------------------------- раздел: состав
def _harness_warning(series: dict[str, Series]) -> str:
    """Сопоставимы ли серии между собой по версии оболочки и сборки.

    Абсолютные величины сравнимы между сериями только при одной и той же измерительной оболочке:
    сценарий, раннер и сэмплеры между половинами выполненной программы менялись
    (`reviews/pass2/critic-3-code.md`, дефект 2), и в CSV разных половин разное число колонок.
    Пока паспорт не несёт хеша оболочки, это прямо сказано — «не проверено» вместо молчания.
    """
    # Оболочка программы 2 объявляет собственный критерий сопоставимости (`harness.comparableBy`).
    # Если он есть у всех серий — проверяется именно он, а не `harnessId`: последний включает
    # конфигурацию серии и у разных серий различается ЗАКОНОМЕРНО.
    sigs = {name: S.harness_comparable_signature(s.passport) for name, s in series.items()}
    if all(v is not None for v in sigs.values()) and sigs:
        fields = sorted({f for v in sigs.values() for f in v[1]})
        values = {name: tuple(sorted(v[0].items())) for name, v in sigs.items()}
        uniq: dict[tuple, list[str]] = {}
        for name, val in values.items():
            uniq.setdefault(val, []).append(name)
        if len(uniq) == 1:
            bench = dict(next(iter(uniq)))
            short = str(bench.get("benchId", ""))[:16]
            return (
                "\n> **Сопоставимость серий проверена по объявленному оболочкой критерию** "
                f"(`passport.harness.comparableBy` = {', '.join('`' + f + '`' for f in fields)}): у всех "
                f"{len(series)} серий эти поля совпадают"
                + (f" (`benchId` = `{short}`)" if short else "")
                + ". Поэтому абсолютные величины между сериями сопоставимы. В разделе 1 рядом напечатан "
                "`harnessId`: он включает ещё и конфигурацию серии, поэтому у разных серий различается "
                "ЗАКОНОМЕРНО и признаком несопоставимости не является.\n"
            )
        listing = "; ".join(
            "`" + dict(val).get("benchId", "?")[:12] + "`: " + ", ".join(names) for val, names in uniq.items()
        )
        return (
            "\n> **Серии различаются по объявленному критерию сопоставимости** (`harness.comparableBy`) — "
            + listing
            + ". Абсолютные величины между этими группами несопоставимы.\n"
        )
    ids = {name: s.harness.get("harness_id") for name, s in series.items()}
    codes = {name: s.harness.get("code_id") for name, s in series.items()}
    if any(v is None for v in ids.values()):
        return (
            "\n> **Версия измерительной оболочки в паспортах не записана** (`harness`/`code.benchId` отсутствует), "
            "поэтому сравнимость серий по оболочке **не проверена**. Известно, что `packages/bench` между половинами "
            "выполненной программы менялся, а значит, абсолютные величины разных серий сопоставимы только с "
            "оговоркой; сравнимы отношения P/F внутри серии. Как только оболочка начнёт писать свой хеш, эта "
            "проверка станет автоматической.\n"
        )
    groups: dict[str, list[str]] = {}
    for name, hid in ids.items():
        groups.setdefault(str(hid), []).append(name)
    if len(groups) > 1:
        listing = "; ".join(f"`{hid[:12]}`: {', '.join(v)}" for hid, v in groups.items())
        return (
            "\n> **Серии сняты РАЗНЫМИ версиями измерительной оболочки** — " + listing + ". Абсолютные величины "
            "между этими группами несопоставимы (менялись сценарий, раннер или сэмплеры); сравнивать между ними "
            "следует только отношения внутри адаптера.\n"
        )
    if len(set(codes.values())) > 1:
        return (
            "\n> **Серии сняты разными сборками клиента/сервера** (`code.codeId` различается), поэтому абсолютные "
            "величины между ними несопоставимы.\n"
        )
    return ""


def section_inventory(series: dict[str, Series]) -> str:
    rows = []
    for name, s in series.items():
        n_ok = int((s.df["outcome"] == "ok").sum()) if "outcome" in s.df else len(s.df)
        cfgs = ", ".join(sorted({f"{a}/{m}" for a, m in zip(s.df["adapter"], s.df["mode"])}))
        rows.append(
            (
                f"`{name}`",
                s.doc or "—",
                R.fmt(s.doc_pages),
                R.fmt(s.doc_shapes),
                R.fmt(s.total_shapes),
                R.fmt(s.n_visited),
                f"{R.fmt(s.n_new)} / {R.fmt(s.n_return)}",
                ", ".join(str(c) for c in s.caches) or "—",
                R.fmt(s.rtt_ms),
                f"{len(s.df)} ({n_ok} ok)",
                f"{R.fmt(s.repetitions)}{R.n_mark(s.repetitions)}",
                cfgs,
                (s.harness.get("harness_id") or "—")[:12],
                (s.harness.get("harnessIdShort") or (s.harness.get("harnessId") or "—"))[:12],
                (s.harness.get("code_id") or "—")[:12],
            )
        )
    t = R.md_table(
        [
            "Серия",
            "Документ",
            "Страниц",
            "Фигур/стр.",
            "Фигур всего",
            "Посещено разных стр.",
            "Переходов новые / возвраты",
            "cache (P)",
            "RTT, мс",
            "Прогонов",
            "Повторений",
            "Конфигурации",
            "Оболочка: benchId",
            "harnessId (+ конфигурация серии)",
            "Сборка (codeId)",
        ],
        rows,
    )
    warn = _harness_warning(series)
    routes = {name: tuple(s.route) for name, s in series.items() if s.route}
    shapes = {name: (s.n_new, s.n_return) for name, s in series.items() if s.route}
    if len(set(shapes.values())) > 1:
        odd = [f"`{n}` — {v[0]} новых / {v[1]} возвратов" for n, v in shapes.items()]
        # Обе оговорки нужны читателю одновременно: про оболочку — можно ли вообще сравнивать
        # абсолютные величины, про маршруты — какие именно величины сравнивать нельзя.
        warn += (
            "\n> **Маршруты серий не одинаковы по составу переходов.** "
            + "; ".join(odd)
            + ". Это не ошибка (в документе из 5 страниц маршрут §7.2 повторить нельзя), но `t_nav_new_median_ms` "
            "и `t_nav_return_median_ms` в таких сериях считаются по разному числу значений, и сравнивать их "
            "между сериями нужно с этой оговоркой, а не как одинаковые величины.\n"
        )
    return t + warn


# ------------------------------------------------------- раздел: окно кеша
def section_cache_window(
    series: dict[str, Series],
    axis: Sequence[tuple[str, str, int]],
    *,
    seed: int,
    n_boot: int,
    metrics: Sequence[str] = CROSS_METRICS,
) -> str:
    """axis: (подпись, имя серии, cache). Первый элемент — база сравнения."""
    axis = [a for a in axis if a[1] in series]
    if len(axis) < 2:
        return "_нет серий окна кеша_\n"
    base_label, base_name, base_cache = axis[0]
    adapters = [a for a in S.ADAPTERS if a in set(series[base_name].df["adapter"].dropna())]
    parts: list[str] = []
    for m in metrics:
        d = R.metric_digits(m)
        label, unit = R.metric_label(m)
        rows = []
        any_row = False
        for a in adapters:
            row: list[str] = [a]
            base = _values(series[base_name], m, a, "P", base_cache)
            for lab, name, cache in axis:
                x = _values(series[name], m, a, "P", cache)
                if x.size:
                    any_row = True
                row.append(_cell(x, d, seed=seed, n_boot=n_boot, key=f"cache|{lab}|{a}|{m}"))
            for lab, name, cache in axis[1:]:
                x = _values(series[name], m, a, "P", cache)
                row.append(_delta_cell(x, base, d, seed=seed, n_boot=n_boot, key=f"cachedelta|{lab}|{a}|{m}"))
            rows.append(row)
        if not any_row:
            continue
        headers = ["Адаптер"] + [lab for lab, _, _ in axis] + [f"Δ и ×: {lab} против {base_label}" for lab, _, _ in axis[1:]]
        parts.append(f"**{label}{', ' + unit if unit else ''}** — медиана [95 % интервал]\n\n" + R.md_table(headers, rows))
    return "\n".join(parts)


#: Метрики оси окна кеша, которые читаются против базы F (§1.8: сначала изменение ВНУТРИ адаптера).
CACHE_VS_F_METRICS: list[str] = [
    "bytes_in_data",
    S.CHROMIUM_PEAK_PROBE_FREE,
    "js_heap_post_gc_mb",
    "retained_shapes_end_exact",
    "t_nav_return_median_ms",
    "t_nav_median_ms",
    "nav_cache_misses",
    "t_first_ready_ms",
    "server_cpu_ms_total",
]


def _repeat_axis_intro(series: dict[str, Series], name: str) -> str:
    """Врезка к оси окна: что именно этот маршрут проверяет — по данным паспорта, а не по памяти."""
    s = series.get(name)
    if s is None or not s.route:
        return (
            f"_серия `{name}` не передана: главная ось окна не строится, и раздел показывает только окна между "
            "собой._\n"
        )
    gaps = s.return_gaps
    gaps_txt = ", ".join(str(g) for g in gaps) if gaps else "—"
    caches = ", ".join(str(c) for c in s.caches) or "—"
    return (
        f"Главная ось окна — серия `{name}`: она снята с **базой F** и окнами P ({caches}) на одном маршруте, "
        f"который окно действительно связывает: {len(s.route)} переходов, {R.fmt(s.n_visited)} разных страниц из "
        f"{R.fmt(s.doc_pages)}, {len(gaps)} возвратов на расстоянии {gaps_txt} шагов. Часть возвратов попадает "
        "уже в узкое окно, часть — только в широкое, часть не попадает ни в одно; именно поэтому окна на этом "
        "маршруте различимы. Порядок §1.8 выполняется целиком: сначала изменение метрики **внутри адаптера** "
        "(P/F при каждом окне), затем сопоставление величины этого изменения **между адаптерами**. В программе 1 "
        "серии окна снимались без F, и ответ сводился к сравнению окон между собой; серия `cache10` на маршруте "
        "§7.2 была снята зря (см. 2.3) и в программу 2 не вошла.\n"
    )


def section_cache_vs_f(
    series: dict[str, Series],
    name: str,
    *,
    seed: int,
    n_boot: int,
    metrics: Sequence[str] = CACHE_VS_F_METRICS,
) -> str:
    """Окно кеша против базы F в ОДНОЙ серии: порядок §1.8 целиком.

    Серия с арм‑конфигурацией F и несколькими окнами P (`route-repeat`: F и P при 1/3/10,
    `cache3`: F и P/3) позволяет выполнить §1.8 по всей форме: сперва изменение метрики
    **внутри адаптера** (P/F при каждом окне, парно по блокам повторений), затем сопоставление
    величины этого изменения **между адаптерами** (отношение отношений на общих блоках).
    В программе 1 этого не было: серии окна снимались без F, и ответ сводился к сравнению окон
    между собой.
    """
    if name not in series:
        return f"_серия `{name}` не передана_\n"
    s = series[name]
    if "F" not in set(s.df["mode"].dropna()):
        return f"_в серии `{name}` нет конфигураций F: изменение внутри адаптера не вычисляется_\n"
    parts: list[str] = []
    for m in metrics:
        if m not in s.df.columns or not ST._clean(s.df[m]).size:
            continue
        d = R.metric_digits(m)
        label, unit = R.metric_label(m)
        t = ST.within_adapter_deltas_paired(s.df, m, seed=seed, n_boot=n_boot)
        if t.empty:
            continue
        rows = []
        for _, r in t.sort_values(["adapter", "cache"]).iterrows():
            rows.append(
                [
                    r["adapter"],
                    R.fmt(r["cache"]),
                    f"{R.fmt(r['n_pairs'])}{R.n_mark(r['n_pairs'])}",
                    R.fmt(r["median_F"], d),
                    R.fmt(r["median_P"], d),
                    f"{R.fmt(r['delta'], d)} {R.fmt_ci(r['delta_lo'], r['delta_hi'], d)}",
                    f"**{R.fmt(r['ratio'], 3)}** {R.fmt_ci(r['ratio_lo'], r['ratio_hi'], 3)}",
                    R.sign_cell(r),
                ]
            )
        parts.append(
            f"**{label}{', ' + unit if unit else ''}** — P против F внутри адаптера, парно по блокам\n\n"
            + R.md_table(["Адаптер", "Окно", "Пар", "Медиана F", "Медиана P", "Δ = P − F", "P / F", "Знаковый критерий"], rows)
        )
        b = ST.between_adapter_comparison_paired(s.df, m, seed=seed, n_boot=n_boot)
        if not b.empty:
            rows_b = [
                [
                    f"{r['adapter_a']} против {r['adapter_b']}",
                    R.fmt(r["cache"]),
                    f"{R.fmt(r['n_blocks'])}{R.n_mark(r['n_blocks'])}",
                    R.fmt(r["delta_a"], d),
                    R.fmt(r["delta_b"], d),
                    f"{R.fmt(r['delta_diff'], d)} {R.fmt_ci(r['delta_diff_lo'], r['delta_diff_hi'], d)}",
                    f"{R.fmt(r['ratio_of_ratios'], 3)} {R.fmt_ci(r['ratio_of_ratios_lo'], r['ratio_of_ratios_hi'], 3)}",
                ]
                for _, r in b.sort_values(["cache", "adapter_a", "adapter_b"]).iterrows()
            ]
            parts.append(
                "\nСопоставление величины изменения между адаптерами (общие блоки)\n\n"
                + R.md_table(["Пара", "Окно", "Блоков", "Δ A", "Δ B", "Δ A − Δ B", "(P/F)_A ÷ (P/F)_B"], rows_b)
            )
    if not parts:
        return "_нет метрик для этой таблицы_\n"
    return "\n".join(parts)


def section_cache_retained(series: dict[str, Series], axis: Sequence[tuple[str, str, int]]) -> str:
    """Объявленное окно против фактически удержанного и против числа посещённых страниц."""
    rows = []
    for lab, name, cache in axis:
        if name not in series:
            continue
        s = series[name]
        visited = s.n_visited
        for a in [x for x in S.ADAPTERS if x in set(s.df["adapter"].dropna())]:
            x = _values(s, "retained_pages_end_exact", a, "P", cache)
            xs = _values(s, "retained_shapes_end_exact", a, "P", cache)
            if x.size == 0:
                continue
            declared = cache + 1
            binding = declared <= (visited or declared)
            rows.append(
                (
                    lab,
                    a,
                    R.fmt(declared),
                    R.fmt(visited),
                    R.fmt(float(np.median(x))),
                    R.fmt(float(np.median(xs))),
                    R.fmt_ok(bool(np.max(x) <= declared)),
                    "окно" if binding and (visited or 0) > declared else "маршрут",
                )
            )
    t = R.md_table(
        [
            "Серия",
            "Адаптер",
            "Объявлено (cache+1)",
            "Посещено разных страниц",
            "Удержано страниц (медиана, точный скан)",
            "Удержано фигур (медиана)",
            "≤ объявленного",
            "Что ограничивает",
        ],
        rows,
    )
    return t + (
        "\nСтолбец «что ограничивает» отвечает на вопрос, проверяет ли серия окно вообще: если объявленное окно "
        "не меньше числа РАЗНЫХ страниц маршрута, вытеснения за прогон не происходит ни разу, и такая серия измеряет "
        "не политику кеша, а «удержать всё посещённое». Это ограничение маршрута §7.2, а не свойство адаптера.\n"
    )


# --------------------------------------------------- раздел: размер документа
def section_doc_size(
    series: dict[str, Series],
    axis: Sequence[tuple[str, str]],
    *,
    seed: int,
    n_boot: int,
    metrics: Sequence[str] = SIZE_METRICS,
) -> str:
    """Абсолютные медианы F и P по размеру документа."""
    axis = [a for a in axis if a[1] in series]
    if not axis:
        return "_нет серий на этой оси_\n"
    adapters = [a for a in S.ADAPTERS if a in set(series[axis[0][1]].df["adapter"].dropna())]
    parts: list[str] = []
    for m in metrics:
        d = R.metric_digits(m)
        label, unit = R.metric_label(m)
        rows = []
        for a in adapters:
            for mode in ("F", "P"):
                row = [f"{a}/{mode}"]
                for lab, name in axis:
                    x = _values(series[name], m, a, mode, 1 if mode == "P" else None)
                    row.append(_cell(x, d, seed=seed, n_boot=n_boot, key=f"size|{lab}|{a}|{mode}|{m}"))
                rows.append(row)
        parts.append(
            f"**{label}{', ' + unit if unit else ''}** — медиана [95 % интервал]\n\n"
            + R.md_table(["Конфигурация"] + [lab for lab, _ in axis], rows)
        )
    return "\n".join(parts)


def section_doc_size_ratio(
    series: dict[str, Series],
    axis: Sequence[tuple[str, str]],
    *,
    seed: int,
    n_boot: int,
    metrics: Sequence[str] = SIZE_METRICS,
) -> str:
    """P/F внутри адаптера (парно, блок = повторение) как функция размера документа.

    Это и есть ответ на вопрос введения «с какого размера документа усложнение
    окупается»: пока интервал P/F накрывает 1, выигрыша по этой метрике нет.
    """
    axis = [a for a in axis if a[1] in series]
    if not axis:
        return "_нет серий на этой оси_\n"
    adapters = [a for a in S.ADAPTERS if a in set(series[axis[0][1]].df["adapter"].dropna())]
    parts: list[str] = []
    for m in metrics:
        rows = []
        for a in adapters:
            row = [a]
            for lab, name in axis:
                s = series[name]
                t = ST.within_adapter_deltas_paired(s.df, m, seed=seed, n_boot=n_boot)
                r = t[(t["adapter"] == a) & (t["cache"].astype("Float64") == 1)] if not t.empty else t
                if r.empty:
                    row.append("—")
                    continue
                r = r.iloc[0]
                sig = "" if (r["ratio_lo"] <= 1 <= r["ratio_hi"]) else " *"
                n_pairs, n_ratio = int(r["n_pairs"]), int(r.get("n_ratio", r["n_pairs"]))
                pairs = f"пар {n_pairs}" if n_ratio == n_pairs else f"пар {n_pairs}, отношение определено в {n_ratio}"
                row.append(f"{R.fmt(r['ratio'], 2)} {R.fmt_ci(r['ratio_lo'], r['ratio_hi'], 2)}{sig} ({pairs})")
            rows.append(row)
        label, _ = R.metric_label(m)
        parts.append(f"**{label}** — P/F, парная оценка\n\n" + R.md_table(["Адаптер"] + [lab for lab, _ in axis], rows))
    return "\n".join(parts)


def section_size_vs_fraction(
    series: dict[str, Series],
    axis: Sequence[tuple[str, str]],
    *,
    seed: int,
    n_boot: int,
) -> str:
    """Размер документа против ДОЛИ посещённого: что на этой оси данными разделяется, а что нет.

    Вдоль оси «размер документа» маршрут §7.2 адаптируется под документ, поэтому доля посещённых
    страниц меняется вместе с размером (100 / 70 / 14 / 7 / 14 %). Значит, разделить «эффект
    размера» и «эффект доли» этими сериями нельзя, и таблица построена так, чтобы это было видно
    прямо: две серии с ОДИНАКОВОЙ долей и разным размером дают одно и то же отношение обмена, а
    серия с тем же размером и другой долей — другое.
    """
    axis = [a for a in axis if a[1] in series]
    if not axis:
        return "_нет серий на этой оси_\n"
    metric = "bytes_in_data" if any("bytes_in_data" in series[n].df.columns for _, n in axis) else "bytes_in"
    rows = []
    for lab, name in axis:
        s = series[name]
        reads_f, reads_p = s.modeled_reads(1)
        share = s.visited_share
        cells = [
            f"`{name}`",
            R.fmt(s.total_shapes),
            R.fmt(s.doc_pages),
            f"{R.fmt(s.n_visited)} из {R.fmt(s.doc_pages)}" + (f" ({100 * share:.0f} %)" if share is not None else ""),
            f"{R.fmt(reads_f)} / {R.fmt(reads_p)}",
            R.fmt(reads_p / reads_f, 3) if (reads_f and not math.isnan(reads_f)) else "—",
        ]
        for a in [x for x in S.ADAPTERS if x in set(s.df["adapter"].dropna())]:
            t = ST.within_adapter_deltas_paired(s.df, metric, seed=seed, n_boot=n_boot)
            r = t[(t["adapter"] == a) & (t["cache"].astype("Float64") == 1)] if not t.empty else t
            if r.empty:
                cells.append("—")
                continue
            r = r.iloc[0]
            cells.append(f"{R.fmt(r['ratio'], 3)} {R.fmt_ci(r['ratio_lo'], r['ratio_hi'], 3)} (пар {int(r['n_pairs'])}{R.n_mark(r['n_pairs'])})")
        rows.append(cells)
    label = "обмена ДАННЫМИ" if metric == "bytes_in_data" else "полного обмена"
    t = R.md_table(
        [
            "Серия",
            "Фигур в документе",
            "Страниц",
            "Посещено",
            "Чтений по модели F / P",
            "Модель: P/F чтений",
            *[f"P/F {label}, {a}" for a in S.ADAPTERS],
        ],
        rows,
    )
    return t + (
        "\n**Как это читать.** Маршрут §7.2 адаптируется под документ, поэтому вдоль оси «размер» вместе с числом "
        "фигур меняется и доля посещённого документа. Обе величины в таблице стоят рядом, и видно, какая из них "
        "объясняет отношение: серии с **одинаковой долей** посещения и разным размером дают одно и то же отношение "
        "обмена, а серия с тем же размером и другой долей — другое. Отношение следует за модельным числом чтений "
        "(столбец «Модель: P/F чтений»), а не за числом фигур; расхождение между модельным и измеренным отношением "
        "— это постоянные слагаемые прогона (вход, метаданные документа, ответ команды), которые от режима не зависят."
        "\n\n> **Что эта ось НЕ идентифицирует.** Раздельный эффект размера документа при фиксированной доле "
        "посещения. Пока нет серии с одинаковой долей на документах разного размера, любое утверждение вида «порог "
        "окупаемости — столько‑то тысяч фигур» этими данными не подтверждается: за ним стоит доля посещённого "
        "документа. Контролируемое сравнение — раздел ниже.\n"
    )


#: Префикс имени серий контролируемой оси «размер при фиксированной доле посещения».
SIZE_FRACTION_PREFIX = "size-fraction"


def size_fraction_axis(series: dict[str, Series]) -> list[tuple[str, str]]:
    """Серии контролируемой оси: `size-fraction*`, упорядоченные по размеру документа."""
    names = [n for n in series if n.startswith(SIZE_FRACTION_PREFIX)]
    names.sort(key=lambda n: (series[n].total_shapes or 0))
    return [(f"{n} ({R.fmt(series[n].total_shapes)} фигур)", n) for n in names]


def section_size_fraction_controlled(
    series: dict[str, Series],
    *,
    seed: int,
    n_boot: int,
    metrics: Sequence[str] = SIZE_METRICS,
) -> str:
    """Контролируемая ось: размер документа при ФИКСИРОВАННОЙ доле посещения.

    Строится, как только в `--series` появятся серии с именами `size-fraction…`. До тех пор
    раздел печатает явный пропуск: числа порога по размеру взять неоткуда, и подменять их
    неконтролируемой осью нельзя.
    """
    axis = size_fraction_axis(series)
    if not axis:
        return (
            "> **Серия ещё не снята — ЗАПОЛНИТЬ ПОСЛЕ ПЕРЕИЗМЕРЕНИЯ.** Раздел строится автоматически, как только в "
            "`--series` появятся серии с именами `size-fraction…` (один и тот же маршрут по доле посещения на "
            "документах разного размера). До тех пор порог окупаемости по размеру документа **не измерен**: ось "
            "выше меняет размер и долю посещения одновременно, а раздельного эффекта размера в данных нет.\n"
        )
    shares = {name: series[name].visited_share for _, name in axis}
    uniq = {round(v, 3) for v in shares.values() if v is not None}
    head = R.md_table(
        ["Серия", "Документ", "Фигур всего", "Посещено", "Доля посещения", "Чтений по модели F / P"],
        [
            (
                f"`{name}`",
                series[name].doc or "—",
                R.fmt(series[name].total_shapes),
                f"{R.fmt(series[name].n_visited)} из {R.fmt(series[name].doc_pages)}",
                (f"{100 * shares[name]:.0f} %" if shares[name] is not None else "—"),
                " / ".join(R.fmt(v) for v in series[name].modeled_reads(1)),
            )
            for _, name in axis
        ],
    )
    warn = ""
    if len(uniq) > 1:
        warn = (
            "\n> **Доля посещения по сериям этой оси НЕ совпадает** — значит, ось снова смешивает размер и долю, и "
            "читать её как «эффект размера» нельзя. Маршруты серий надо привести к одной доле.\n"
        )
    return (
        "Ось меняет **только** размер документа: доля посещённого документа одинакова во всех сериях, поэтому "
        "разность между ними — это эффект размера, а не маршрута.\n\n"
        + head
        + warn
        + "\n"
        + section_doc_size_ratio(series, axis, seed=seed, n_boot=n_boot, metrics=metrics)
    )


def section_payoff(
    series: dict[str, Series],
    axis: Sequence[tuple[str, str]],
    *,
    seed: int,
    n_boot: int,
) -> str:
    """Сводка окупаемости: абсолютная экономия P против F по размеру документа."""
    axis = [a for a in axis if a[1] in series]
    rows = []
    for lab, name in axis:
        s = series[name]
        for a in [x for x in S.ADAPTERS if x in set(s.df["adapter"].dropna())]:
            cells: list[str] = [lab, R.fmt(s.total_shapes), a]
            for m, d in (("bytes_in", 0), ("chromium_private_peak_mib", 1), ("js_heap_post_gc_mb", 1), ("t_first_ready_ms", 0)):
                t = ST.within_adapter_deltas_paired(s.df, m, seed=seed, n_boot=n_boot)
                r = t[(t["adapter"] == a) & (t["cache"].astype("Float64") == 1)] if not t.empty else t
                if r.empty:
                    cells.append("—")
                    continue
                r = r.iloc[0]
                sig = "" if (r["delta_lo"] <= 0 <= r["delta_hi"]) else " *"
                cells.append(f"{R.fmt(r['delta'], d)} {R.fmt_ci(r['delta_lo'], r['delta_hi'], d)}{sig}")
            # цена: переход на новую страницу
            t = ST.within_adapter_deltas_paired(s.df, "t_nav_new_median_ms", seed=seed, n_boot=n_boot)
            r = t[(t["adapter"] == a) & (t["cache"].astype("Float64") == 1)] if not t.empty else t
            if r.empty:
                cells.append("—")
            else:
                r = r.iloc[0]
                sig = "" if (r["delta_lo"] <= 0 <= r["delta_hi"]) else " *"
                cells.append(f"+{R.fmt(r['delta'], 0)} {R.fmt_ci(r['delta_lo'], r['delta_hi'], 0)}{sig}")
            rows.append(cells)
    return R.md_table(
        [
            "Серия",
            "Фигур в документе",
            "Адаптер",
            "Δ трафика P−F, байт",
            "Δ пика Chromium P−F, МиБ",
            "Δ кучи после GC P−F, МБ",
            "Δ первой готовности P−F, мс",
            "Цена: Δ перехода на новую стр. P−F, мс",
        ],
        rows,
    ) + (
        "\nЗвёздочка — интервал не накрывает 0 (изменение подтверждено). Отрицательная величина в первых четырёх "
        "столбцах = P дешевле F; положительная в последнем = P медленнее на переходах, это и есть цена частичной "
        "загрузки при заданном маршруте.\n"
    )


# ----------------------------------------------- доля документа и форма команды
#: Метрики оси «доля документа, которую сценарий успевает просмотреть».
COVERAGE_METRICS: list[str] = [
    "bytes_in_data",
    "bytes_in",
    "api_page_reads",
    "api_page_read_bytes",
    "nav_cache_misses",
    "chromium_private_peak_mib",
    "js_heap_peak_mb",
    "retained_shapes_end_exact",
    "t_first_ready_ms",
    "t_nav_median_ms",
    "t_scenario_ms",
    "server_cpu_ms_total",
]

#: Метрики оси «форма команды» (размещение против объёма изменения).
SHAPE_METRICS: list[str] = [
    "t_cmd_drawn_ms",
    "t_cmd_ack_ms",
    "t_cmd_server_ms",
    "bytes_in_data",
    "bytes_in",
    "api_page_reads",
    "api_page_read_bytes",
    "server_cpu_ms_total",
    "server_zero_cpu_ms",
    "t_scenario_ms",
]


def section_coverage(
    series: dict[str, Series],
    axis: Sequence[tuple[str, str]],
    *,
    seed: int,
    n_boot: int,
    metrics: Sequence[str] = COVERAGE_METRICS,
) -> str:
    """Абсолютные медианы F и P по доле документа, которую просматривает маршрут."""
    return section_doc_size(series, axis, seed=seed, n_boot=n_boot, metrics=metrics)


def section_coverage_ratio(
    series: dict[str, Series],
    axis: Sequence[tuple[str, str]],
    *,
    seed: int,
    n_boot: int,
    metrics: Sequence[str] = COVERAGE_METRICS,
) -> str:
    """P/F внутри адаптера (парно) как функция доли просмотренного документа."""
    return section_doc_size_ratio(series, axis, seed=seed, n_boot=n_boot, metrics=metrics)


def section_coverage_inventory(series: dict[str, Series], axis: Sequence[tuple[str, str]]) -> str:
    """Сколько документа маршрут вообще трогает: страниц, переходов, загрузок."""
    rows = []
    for lab, name in axis:
        if name not in series:
            continue
        s = series[name]
        pages = s.doc_pages
        visited = s.n_visited
        share = f"{visited} из {pages}" + (f" ({100 * visited / pages:.0f} %)" if pages else "")
        loads_p = _values(s, "page_loads_observed", "H", "P", 1)
        loads_f = _values(s, "page_loads_observed", "H", "F")
        rows.append(
            (
                lab,
                "«" + ", ".join(str(x) for x in s.route) + "»" if len(s.route) <= 20 else f"«2, 3, …, {s.route[-1]}» ({len(s.route)} переходов)",
                R.fmt(len(s.route)),
                f"{R.fmt(s.n_new)} / {R.fmt(s.n_return)}",
                share,
                R.fmt(float(np.median(loads_f)) if loads_f.size else math.nan),
                R.fmt(float(np.median(loads_p)) if loads_p.size else math.nan),
            )
        )
    return R.md_table(
        [
            "Серия",
            "Маршрут",
            "Переходов",
            "Новые / возвраты",
            "Просмотрено страниц документа",
            "Загрузок страниц в F (медиана)",
            "Загрузок страниц в P (медиана)",
        ],
        rows,
    ) + (
        "\nЗагрузка страницы в F одна — весь документ приходит при открытии; в P их столько, сколько промахов окна "
        "плюс открытие. Разница между строками и есть «сколько раз частичная загрузка сходила за страницей».\n"
    )


def section_command_shape(
    series: dict[str, Series],
    name: str,
    *,
    seed: int,
    n_boot: int,
    metrics: Sequence[str] = SHAPE_METRICS,
) -> str:
    """Форма команды: одни и те же конфигурации, разные команды (`variants`, bench §4.2)."""
    if name not in series:
        return "_нет серии вариантов команды_\n"
    s = series[name]
    vs = ST.variants(s.df)
    if vs == [None]:
        return "_серия не размечена вариантами команды_\n"
    base = "baseline" if "baseline" in vs else vs[0]
    order = [base] + [v for v in vs if v != base]
    configs = [(a, m, 1 if m == "P" else None) for a in S.ADAPTERS if a in set(s.df["adapter"].dropna()) for m in ("F", "P")]
    parts: list[str] = []
    for m in metrics:
        d = R.metric_digits(m)
        lab, unit = R.metric_label(m)
        rows = []
        any_row = False
        for a, mode, cache in configs:
            row = [f"{a}/{mode}"]
            b = _values(s, m, a, mode, cache, variant=base)
            for v in order:
                x = _values(s, m, a, mode, cache, variant=v)
                if x.size:
                    any_row = True
                row.append(_cell(x, d, seed=seed, n_boot=n_boot, key=f"shape|{v}|{a}{mode}|{m}"))
            for v in order[1:]:
                x = _values(s, m, a, mode, cache, variant=v)
                row.append(_delta_cell(x, b, d, seed=seed, n_boot=n_boot, key=f"shapedelta|{v}|{a}{mode}|{m}"))
            rows.append(row)
        if not any_row:
            continue
        headers = ["Конфигурация"] + order + [f"Δ и ×: {v} против {base}" for v in order[1:]]
        parts.append(f"**{lab}{', ' + unit if unit else ''}** — медиана [95 % интервал]\n\n" + R.md_table(headers, rows))
    return "\n".join(parts)


def _paired_variant(
    df: pd.DataFrame,
    metric: str,
    adapter: str,
    mode: str,
    cache: int | None,
    variant_a: str,
    variant_b: str,
    *,
    seed: int,
    n_boot: int,
    pair_on: str = ST.PAIR_KEY_DEFAULT,
) -> dict[str, Any] | None:
    """Парная разность и отношение метрики между ДВУМЯ вариантами команды.

    Пары берутся по блоку повторения: раннер разворачивает `configs × variants` ДО построения плана,
    поэтому в одном повторении есть по прогону каждой пары «конфигурация × вариант», порядок внутри
    блока перемешан. Это законная парность — и она сильнее непарного сравнения медиан, которое
    печатается в 5.2, потому что снимает дрейф стенда между блоками.
    """
    if metric not in df.columns or pair_on not in df.columns:
        return None

    def side(variant: str) -> pd.Series:
        g = ST.variant_subset(ST.ok_runs(df), variant)
        g = g[(g["adapter"] == adapter) & (g["mode"] == mode)]
        if mode == "P" and cache is not None and "cache" in g.columns:
            g = g[g["cache"] == cache]
        g = g.dropna(subset=[metric, pair_on])
        return g.groupby(pair_on)[metric].median() if not g.empty else pd.Series(dtype="float64")

    a, b = side(variant_a), side(variant_b)
    idx = a.index.intersection(b.index)
    if len(idx) == 0:
        return None
    va, vb = a.loc[idx].to_numpy("float64"), b.loc[idx].to_numpy("float64")
    key = f"cmdpair|{adapter}{mode}|{metric}|{variant_a}|{variant_b}"
    d, dlo, dhi = ST._boot_median(va - vb, seed=seed, n_boot=n_boot, key=key + "|d")
    with np.errstate(divide="ignore", invalid="ignore"):
        ratios = np.where(vb != 0, va / vb, np.nan)
    r, rlo, rhi = ST._boot_median(ratios.astype("float64"), seed=seed, n_boot=n_boot, key=key + "|r")
    return {
        "n": int(len(idx)),
        "median_a": float(np.median(va)),
        "median_b": float(np.median(vb)),
        "delta": d,
        "delta_lo": dlo,
        "delta_hi": dhi,
        "ratio": r,
        "ratio_lo": rlo,
        "ratio_hi": rhi,
    }


#: Два контраста, разделяющих факторы «размещение» и «объём» (bench §4.2):
#: при равном числе изменённых фигур меняется только число затронутых страниц, и наоборот.
SHAPE_CONTRASTS: list[tuple[str, str, str]] = [
    ("Размещение при равном объёме", "baseline", "concentrated"),
    ("Объём при равном размещении", "large-share", "spread"),
]


def section_command_shape_contrasts(
    series: dict[str, Series],
    name: str,
    *,
    seed: int,
    n_boot: int,
    metrics: Sequence[str] = SHAPE_METRICS,
) -> str:
    """Парное разделение факторов: что меняется от РАЗМЕЩЕНИЯ и что — от ОБЪЁМА изменения."""
    if name not in series:
        return "_нет серии вариантов команды_\n"
    s = series[name]
    vs = set(ST.variants(s.df))
    contrasts = [c for c in SHAPE_CONTRASTS if c[1] in vs and c[2] in vs]
    if not contrasts:
        return "_в серии нет пары вариантов, разделяющей размещение и объём_\n"
    configs = [(a, m, 1 if m == "P" else None) for a in S.ADAPTERS if a in set(s.df["adapter"].dropna()) for m in ("F", "P")]
    parts: list[str] = []
    for title, va, vb in contrasts:
        rows = []
        for m in metrics:
            d = R.metric_digits(m)
            lab, unit = R.metric_label(m)
            row = [f"{lab}{', ' + unit if unit else ''}"]
            for a, mode, cache in configs:
                r = _paired_variant(s.df, m, a, mode, cache, va, vb, seed=seed, n_boot=n_boot)
                if r is None or math.isnan(r["delta"]):
                    row.append("—")
                    continue
                sig = "" if (r["delta_lo"] <= 0 <= r["delta_hi"]) else " *"
                ratio = "—" if math.isnan(r["ratio"]) else f"×{R.fmt(r['ratio'], 3)} {R.fmt_ci(r['ratio_lo'], r['ratio_hi'], 3)}"
                row.append(f"{R.fmt(r['delta'], d)} {R.fmt_ci(r['delta_lo'], r['delta_hi'], d)}{sig} / {ratio}")
            rows.append(row)
        parts.append(
            f"**{title}: `{va}` против `{vb}`**\n\n"
            + R.md_table(["Показатель"] + [f"{a}/{m}" for a, m, _ in configs], rows)
        )
    return "\n".join(parts) + (
        "\nПарно по блокам повторений (в одном повторении есть прогон каждой пары «конфигурация × вариант», "
        "порядок внутри блока перемешан), поэтому дрейф стенда между блоками снят. Звёздочка — интервал разности "
        "не накрывает 0. `baseline` и `concentrated` меняют **одинаковое** число фигур (81) на 10 и на 2 страницах; "
        "`large-share` и `spread` затрагивают **одинаковые** 50 страниц, меняя 2 001 и 51 фигуру. Поэтому первая "
        "таблица — чистый эффект размещения, вторая — чистый эффект объёма.\n"
    )


def section_command_shape_inventory(series: dict[str, Series], name: str) -> str:
    """Что именно меняет каждая команда: сколько фигур и на скольких страницах."""
    if name not in series:
        return ""
    s = series[name]
    df = ST.ok_runs(s.df)
    if S.VARIANT_COLUMN not in df.columns:
        return ""
    cfg = (s.passport.get("seriesConfig") or {}) if isinstance(s.passport, dict) else {}
    notes = {v.get("name"): v.get("note", "") for v in (cfg.get("variants") or []) if isinstance(v, dict)}
    targets = {v.get("name"): v.get("sourceId", "") for v in (cfg.get("variants") or []) if isinstance(v, dict)}
    rows = []
    for v in ST.variants(df):
        g = ST.variant_subset(df, v)
        pages = ST.median(g["cmd_affected_pages"]) if "cmd_affected_pages" in g.columns else math.nan
        shapes = ST.median(g["cmd_affected_shapes"]) if "cmd_affected_shapes" in g.columns else math.nan
        total = s.total_shapes
        rows.append(
            (
                v,
                f"`{targets.get(v, '')}`",
                R.fmt(shapes),
                (f"{100 * shapes / total:.2f} %" if total and not math.isnan(shapes) else "—"),
                R.fmt(pages),
                (f"{100 * pages / s.doc_pages:.0f} %" if s.doc_pages and not math.isnan(pages) else "—"),
                notes.get(v, ""),
            )
        )
    return R.md_table(
        [
            "Вариант",
            "Источник",
            "Изменено фигур",
            "Доля фигур документа",
            "Затронуто страниц",
            "Доля страниц",
            "Замечание из конфигурации серии",
        ],
        rows,
    )


# ------------------------------------------------------------------ RTT
def section_rtt(
    series: dict[str, Series],
    axis: Sequence[tuple[str, str]],
    *,
    seed: int,
    n_boot: int,
    metrics: Sequence[str] = CROSS_METRICS,
) -> str:
    axis = [a for a in axis if a[1] in series]
    if len(axis) < 2:
        return "_нет серий RTT_\n"
    base_label, base_name = axis[0]
    base_s = series[base_name]
    configs: list[tuple[str, str, int | None]] = []
    for a in [x for x in S.ADAPTERS if x in set(base_s.df["adapter"].dropna())]:
        for mode in ("F", "P"):
            configs.append((a, mode, 1 if mode == "P" else None))
    parts: list[str] = []
    for m in metrics:
        d = R.metric_digits(m)
        label, unit = R.metric_label(m)
        rows = []
        any_row = False
        for a, mode, cache in configs:
            row = [f"{a}/{mode}"]
            base = _values(base_s, m, a, mode, cache)
            for lab, name in axis:
                x = _values(series[name], m, a, mode, cache)
                if x.size:
                    any_row = True
                row.append(_cell(x, d, seed=seed, n_boot=n_boot, key=f"rtt|{lab}|{a}{mode}|{m}"))
            for lab, name in axis[1:]:
                x = _values(series[name], m, a, mode, cache)
                row.append(_delta_cell(x, base, d, seed=seed, n_boot=n_boot, key=f"rttdelta|{lab}|{a}{mode}|{m}"))
            rows.append(row)
        if not any_row:
            continue
        headers = ["Конфигурация"] + [lab for lab, _ in axis] + [f"Δ и ×: {lab} против {base_label}" for lab, _ in axis[1:]]
        parts.append(f"**{label}{', ' + unit if unit else ''}** — медиана [95 % интервал]\n\n" + R.md_table(headers, rows))
    return "\n".join(parts)


# ------------------------------------------------------------------ бюджеты
def _budget_value(bc: pd.DataFrame, config: str, budget: str, statistic: str) -> pd.Series | None:
    sel = bc[(bc["config"] == config) & (bc["budget"] == budget) & (bc["statistic"] == statistic)]
    return None if sel.empty else sel.iloc[0]


def section_budgets_all(series: dict[str, Series], *, seed: int = 42, n_boot: int = ST.DEFAULT_N_BOOT) -> str:
    """Матрица «серия × конфигурация × бюджет §1.2» — чтобы нарушение было видно сразу во всех сериях."""
    rows = []
    for name, s in series.items():
        bc = ST.budget_checks(s.df, seed=seed, n_boot=n_boot)
        v = ST.budget_verdicts(bc)
        for _, r in v.iterrows():
            cfg = r["config"]

            def val(budget: str, statistic: str, digits: int = 0) -> str:
                b = _budget_value(bc, cfg, budget, statistic)
                if b is None or pd.isna(b["value"]):
                    return "—"
                return R._budget_cell(b)

            share = _budget_value(bc, cfg, "scenario_budget_share", "share")
            share_txt = "—" if share is None or pd.isna(share["value"]) else R._budget_cell(share)
            failed = ", ".join(R.BUDGET_LABELS.get(x, x) for x in (r["failed"] or [])) or "—"
            breached = ", ".join(R.BUDGET_LABELS.get(x, x) for x in (r.get("breached") or [])) or "—"
            nav_max = _budget_value(bc, cfg, "nav_max", "max")
            rows.append(
                (
                    f"`{name}`",
                    cfg,
                    R.fmt_ok(r["all_ok"]),
                    failed,
                    breached,
                    val("first_ready", "median"),
                    val("nav_all", "median"),
                    "—" if nav_max is None else R._budget_cell(nav_max),
                    val("cmd_drawn", "median"),
                    share_txt,
                    val("chromium_private_peak", "median", 1),
                    val("server_vcpu", "median", 2),
                    val("server_mem_peak", "median", 1),
                )
            )
    return R.md_table(
        [
            "Серия",
            "Конфигурация",
            "Все бюджеты (точечно)",
            "Точечно вне бюджета",
            "**Нарушение подтверждено интервалом**",
            "Первая готовность, мс (≤ 2 000)",
            "Переход, мс (≤ 1 000)",
            "Худший переход, мс (справочно)",
            "Команда до холста, мс (≤ 2 000)",
            "Сценарий в бюджете серии [Уилсон 95 %]",
            "Chromium, МиБ (≤ 768)",
            "Сервер, vCPU (≤ 4)",
            "Сервер, МиБ (≤ 8 192)",
        ],
        rows,
    ) + (
        "\n`✓`/`✗` — точечная оценка; знак рядом — вердикт по интервалу: пусто — интервал целиком по нужную сторону "
        "порога, `≈` — интервал накрывает порог (данные вопрос не решают), `!` — интервал порог исключает. "
        "**Нарушением бюджета §1.2 считается только `!`.** Столбец «худший переход» справочный: §1.2 задаёт бюджет "
        "перехода медианой, но прогоны, где хотя бы один переход вышел за секунду, названы тут же.\n"
    )


# ------------------------------------------------------------------ графики
def plot_axis(
    series: dict[str, Series],
    axis: Sequence[tuple[str, str, int | None]],
    metric: str,
    out: Path,
    *,
    xlabel: str,
    modes: Sequence[str] = ("F", "P"),
) -> Path | None:
    """Линии «метрика против оси» по адаптерам (сплошная — F, пунктир — P)."""
    import matplotlib.pyplot as plt

    axis = [a for a in axis if a[1] in series]
    if len(axis) < 2:
        return None
    spec = S.METRIC_BY_COLUMN.get(metric)
    label = spec.label_ru if spec else metric
    adapters = [a for a in S.ADAPTERS if a in set(series[axis[0][1]].df["adapter"].dropna())]
    fig, ax = plt.subplots(figsize=(7.6, 4.2))
    F._style_axes(ax)
    x = np.arange(len(axis))
    drew = False
    for i, a in enumerate(adapters):
        for mode in modes:
            ys, los, his, xs = [], [], [], []
            for j, (lab, name, cache) in enumerate(axis):
                v = _values(series[name], metric, a, mode, cache if mode == "P" else None)
                if v.size == 0:
                    continue
                s = ST.summarize(v, seed=42, n_boot=400, key=f"fig|{metric}|{a}|{mode}|{lab}")
                xs.append(x[j])
                ys.append(s["median"])
                los.append(max(0.0, s["median"] - s["ci_lo"]) if not math.isnan(s["ci_lo"]) else 0.0)
                his.append(max(0.0, s["ci_hi"] - s["median"]) if not math.isnan(s["ci_hi"]) else 0.0)
            if not ys:
                continue
            drew = True
            ax.errorbar(
                xs,
                ys,
                yerr=[los, his],
                marker="o" if mode == "F" else "s",
                markersize=4,
                linestyle="-" if mode == "F" else "--",
                color=F.SERIES[i % len(F.SERIES)],
                elinewidth=0.9,
                capsize=2,
                linewidth=1.6,
                label=f"{a}/{mode}",
            )
    if not drew:
        plt.close(fig)
        return None
    ax.set_xticks(x)
    ax.set_xticklabels([lab for lab, _, _ in axis], rotation=12, ha="right")
    ax.set_xlabel(xlabel)
    ax.set_ylabel(spec.unit if spec else "")
    ax.set_title(f"{label} (медиана, 95 % интервал)", loc="left", fontsize=11, color=F.INK)
    ax.legend(loc="upper left", bbox_to_anchor=(0, -0.22), ncol=min(6, len(adapters) * len(modes)), fontsize=9)
    ax.set_ylim(bottom=0)
    fig.tight_layout()
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out)
    plt.close(fig)
    return out


def plot_shape_axis(s: Series, metric: str, out: Path) -> Path | None:
    """Метрика против варианта команды: линии по конфигурациям (сплошная — F, пунктир — P)."""
    import matplotlib.pyplot as plt

    vs = ST.variants(s.df)
    if vs == [None] or len(vs) < 2:
        return None
    base = "baseline" if "baseline" in vs else vs[0]
    order = [base] + [v for v in vs if v != base]
    spec = S.METRIC_BY_COLUMN.get(metric)
    label = spec.label_ru if spec else metric
    adapters = [a for a in S.ADAPTERS if a in set(s.df["adapter"].dropna())]
    fig, ax = plt.subplots(figsize=(7.6, 4.2))
    F._style_axes(ax)
    x = np.arange(len(order))
    drew = False
    for i, a in enumerate(adapters):
        for mode in ("F", "P"):
            xs, ys, los, his = [], [], [], []
            for j, v in enumerate(order):
                vals = _values(s, metric, a, mode, 1 if mode == "P" else None, variant=v)
                if vals.size == 0:
                    continue
                st = ST.summarize(vals, seed=42, n_boot=400, key=f"shapefig|{metric}|{a}|{mode}|{v}")
                xs.append(x[j])
                ys.append(st["median"])
                los.append(max(0.0, st["median"] - st["ci_lo"]) if not math.isnan(st["ci_lo"]) else 0.0)
                his.append(max(0.0, st["ci_hi"] - st["median"]) if not math.isnan(st["ci_hi"]) else 0.0)
            if not ys:
                continue
            drew = True
            ax.errorbar(
                xs,
                ys,
                yerr=[los, his],
                marker="o" if mode == "F" else "s",
                markersize=4,
                linestyle="-" if mode == "F" else "--",
                color=F.SERIES[i % len(F.SERIES)],
                elinewidth=0.9,
                capsize=2,
                linewidth=1.6,
                label=f"{a}/{mode}",
            )
    if not drew:
        plt.close(fig)
        return None
    if spec is not None and spec.budget:
        ax.axhline(spec.budget, color=F.WARN if hasattr(F, "WARN") else "#b3261e", linestyle=":", linewidth=1.2)
    ax.set_xticks(x)
    ax.set_xticklabels(order, rotation=12, ha="right")
    ax.set_xlabel("вариант команды (размещение и объём изменения)")
    ax.set_ylabel(spec.unit if spec else "")
    ax.set_title(f"{label} (медиана, 95 % интервал)", loc="left", fontsize=11, color=F.INK)
    ax.legend(loc="upper left", bbox_to_anchor=(0, -0.22), ncol=min(6, len(adapters) * 2), fontsize=9)
    ax.set_ylim(bottom=0)
    fig.tight_layout()
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out)
    plt.close(fig)
    return out


# ------------------------------------------------------------------ сборка
def build_cross(
    specs: Sequence[str],
    out: str | Path,
    figs: str | Path | None = None,
    *,
    seed: int = 42,
    n_boot: int = 2000,
) -> dict[str, Any]:
    series = load_series(specs)
    out = Path(out)
    figs = Path(figs) if figs else out.parent / "figs" / "cross"
    figs.mkdir(parents=True, exist_ok=True)

    cache_axis = [("main P/1 (cache=1)", "main", 1), ("cache3 (cache=3)", "cache3", 3)]
    repeat_axis = [("route-repeat cache=1", "route-repeat", 1), ("route-repeat cache=3", "route-repeat", 3), ("route-repeat cache=10", "route-repeat", 10)]
    coverage_axis = [("main: 7 из 50 стр.", "main"), ("route-repeat: 13 из 50 стр.", "route-repeat"), ("route-full: 50 из 50 стр.", "route-full")]
    size_axis = [
        ("doc5x100 (500)", "doc5x100"),
        ("main 50×500 (25 000)", "main"),
        ("doc50x1000 (50 000)", "doc50x1000"),
    ]
    rtt_axis = [("RTT 50 мс (main)", "main"), ("RTT 150 мс (rtt150)", "rtt150")]

    fig_paths: list[tuple[str, Path]] = []
    for m in FIG_METRICS:
        p = plot_axis(series, [(l, n, c) for l, n, c in cache_axis], m, figs / f"cache_{m}.png", xlabel="окно кеша", modes=("P",))
        if p:
            fig_paths.append((f"Окно кеша — {R.metric_label(m)[0]}", p))
    for m in FIG_METRICS:
        p = plot_axis(series, [(l, n, 1) for l, n in size_axis], m, figs / f"size_{m}.png", xlabel="документ (фигур всего)")
        if p:
            fig_paths.append((f"Размер документа — {R.metric_label(m)[0]}", p))
    for m in FIG_METRICS:
        p = plot_axis(series, [(l, n, 1) for l, n in size_fraction_axis(series)], m, figs / f"sizefrac_{m}.png", xlabel="документ при фиксированной доле посещения")
        if p:
            fig_paths.append((f"Размер при фиксированной доле — {R.metric_label(m)[0]}", p))
    for m in FIG_METRICS:
        p = plot_axis(series, [(l, n, 1) for l, n in rtt_axis], m, figs / f"rtt_{m}.png", xlabel="RTT")
        if p:
            fig_paths.append((f"RTT — {R.metric_label(m)[0]}", p))
    for m in FIG_METRICS + ["retained_shapes_end_exact", "t_scenario_ms"]:
        p = plot_axis(series, [(l, n, 1) for l, n in coverage_axis], m, figs / f"coverage_{m}.png", xlabel="доля документа, просмотренная маршрутом")
        if p:
            fig_paths.append((f"Доля документа — {R.metric_label(m)[0]}", p))
    for m in FIG_METRICS + ["nav_cache_misses", "api_page_reads"]:
        p = plot_axis(series, repeat_axis, m, figs / f"repeat_{m}.png", xlabel="окно кеша на маршруте с возвратами", modes=("P",))
        if p:
            fig_paths.append((f"Окно на связывающем маршруте — {R.metric_label(m)[0]}", p))
    if "command-shape" in series:
        cs = series["command-shape"]
        shape_axis = [(v, "command-shape") for v in ST.variants(cs.df)]
        for m in ("t_cmd_drawn_ms", "bytes_in", "api_page_reads", "server_cpu_ms_total"):
            p = plot_shape_axis(cs, m, figs / f"shape_{m}.png")
            if p:
                fig_paths.append((f"Форма команды — {R.metric_label(m)[0]}", p))

    def rel(p: Path) -> str:
        try:
            return str(p.relative_to(out.parent))
        except ValueError:
            return str(p)

    head = (
        "# Перекрёстное сравнение серий\n\n"
        "Сопоставление серий по осям главы 1: окно кеша (в том числе на маршруте, где оно связывает), размер "
        "документа, доля просмотренного документа, форма команды, RTT. Все величины — медианы по "
        "прогонам `outcome=ok` с 95 % перцентильным бутстреп‑интервалом (2 000 ресемплов, seed фиксирован); "
        "`†` — интервал по n < 8 наблюдениям.\n\n"
        "Порядок сравнения — по §1.8: **сначала изменение метрики внутри адаптера** (P−F и P/F, парно по блокам "
        "повторений; см. отчёты отдельных серий и раздел 3.2 здесь), **затем сопоставление величины этого изменения "
        "между адаптерами и между сериями**. Между сериями парность невозможна: блоки повторений разных серий — "
        "разные прогоны в разное время, поэтому межсерийные Δ и × считаются **непарным** бутстрепом двух выборок, и "
        "звёздочка `*` означает лишь, что интервал не накрывает 0 (для отношения — 1).\n\n"
        "> Ограничение среды (`docs/DEVIATIONS.md` 1.3): клиент и сервер работают на одной ВМ с 2 vCPU, поэтому "
        "абсолютные времена нельзя переносить на конфигурацию §1.2; сравнимы изменения внутри и между адаптерами.\n"
    )

    parts = [
        head,
        "## 1. Состав сравниваемых серий\n",
        section_inventory(series),
        "\n## 2. Окно кеша: 1 против 3 и 10\n",
        _repeat_axis_intro(series, "route-repeat"),
        "\n### 2.1 Окно против базы F на связывающем маршруте (§1.8, порядок соблюдён)\n",
        section_cache_vs_f(series, "route-repeat", seed=seed, n_boot=n_boot),
        "\n### 2.2 Окна между собой, база — окно 1\n",
        section_cache_window(series, repeat_axis, seed=seed, n_boot=n_boot),
        "\n### 2.3 Удержание и повторные чтения на связывающем маршруте\n",
        section_cache_retained(series, repeat_axis),
        "\n### 2.4 Окно на маршруте §7.2, где оно НЕ связывает (`main` против `cache3`)\n",
        "Маршрут §7.2 посещает **7 разных страниц из 50**, поэтому окно 3 (4 страницы с активной) вытесняет там "
        "мало, а окно 10 не вытесняло бы ни разу: «удержать всё посещённое» и «политика сохранения страниц» на "
        "таком маршруте — одно и то же. Серия `cache10` из‑за этого была неинформативна и в программе 2 не "
        "переснималась; `cache3` пересняли **с армом F**, поэтому и здесь §1.8 выполняется полностью.\n",
        "\n#### 2.4.1 Внутри адаптера, серия `cache3` (F и P/3 в одной серии)\n",
        section_cache_vs_f(series, "cache3", seed=seed, n_boot=n_boot),
        "\n#### 2.4.2 Окна между сериями (`main` P/1 против `cache3` P/3, непарно)\n",
        section_cache_window(series, cache_axis, seed=seed, n_boot=n_boot),
        "\n#### 2.4.3 Объявленное окно против фактически удержанного\n",
        section_cache_retained(series, cache_axis),
        "\n## 3. Размер документа\n",
        "Серии отличаются документом; маршрут §7.2 сохранён везде, кроме `doc5x100` (в документе из 5 страниц "
        "маршрут «2, 3, 1, 4, 2, 5, 1, 6, 3, 50» неисполним — см. оговорку в разделе 1). Эта ось **меняет размер "
        "и долю посещения вместе** и потому эффекта размера не идентифицирует; контролируемый ответ — раздел 3.5, "
        "серии `size-fraction-*`. Серии программы 1 `doc10x200` и `doc100x500` не переснимались: первая дублировала "
        "`doc5x100` по доле, вторая — `doc50x1000` по числу фигур, и обе на неконтролируемой оси.\n",
        "\n### 3.1 Абсолютные значения\n",
        section_doc_size(series, size_axis, seed=seed, n_boot=n_boot),
        "\n### 3.2 Изменение внутри адаптера (P/F) как функция размера документа\n",
        "Парная оценка (блок = повторение) внутри каждой серии. Звёздочка — интервал P/F не накрывает 1. "
        "Именно эта таблица отвечает на вопрос введения «с какого размера документа усложнение окупается»: "
        "там, где интервал накрывает 1, выигрыша по этой метрике в данных нет.\n",
        section_doc_size_ratio(series, size_axis, seed=seed, n_boot=n_boot),
        "\n### 3.3 Абсолютная экономия и её цена\n",
        section_payoff(series, size_axis, seed=seed, n_boot=n_boot),
        "\n### 3.4 Размер документа против доли посещённого: что эта ось разделяет\n",
        "Маршрут §7.2 адаптируется под документ (в документе из 5 страниц перехода на 50‑ю быть не может), "
        "поэтому вдоль оси «размер» доля посещённого документа меняется ВМЕСТЕ с размером. Раздельно эффект "
        "размера и эффект доли эти серии не идентифицируют; таблица показывает обе величины рядом.\n",
        section_size_vs_fraction(series, size_axis, seed=seed, n_boot=n_boot),
        "\n### 3.5 Контролируемая ось: размер при фиксированной доле посещения\n",
        section_size_fraction_controlled(series, seed=seed, n_boot=n_boot),
        "\n## 4. Доля документа, которую успевает просмотреть сценарий\n",
        "Ось отвечает на первый «не установлено» введения: что происходит с выигрышем частичной загрузки, когда "
        "документ всё равно будет прочитан целиком. Документ и канал одни и те же (50×500, RTT 50 мс), отличается "
        "только маршрут — 7 разных страниц из 50 (`main`), 13 из 50 (`route-repeat`) и все 50 (`route-full`).\n",
        "\n### 4.1 Что трогает маршрут\n",
        section_coverage_inventory(series, coverage_axis),
        "\n### 4.2 Абсолютные значения\n",
        "Между сериями сравниваются РАЗНЫЕ сценарии: у `route-full` 49 объявленных пауз против 10 у `main`, поэтому "
        "`t_scenario_ms` между строками этой таблицы несопоставим (у `route-full` собственный бюджет 70 с). "
        "Сопоставимы величины, не зависящие от числа пауз: обмен, память, удержание, время одного перехода.\n",
        section_coverage(series, coverage_axis, seed=seed, n_boot=n_boot),
        "\n### 4.3 Изменение внутри адаптера (P/F) как функция доли просмотренного документа\n",
        "Парная оценка внутри каждой серии (блок = повторение): именно она показывает, сохраняется ли выигрыш P, "
        "когда маршрут обходит весь документ. Значение > 1 означает, что частичная загрузка по этой метрике "
        "**дороже** полной.\n",
        section_coverage_ratio(series, coverage_axis, seed=seed, n_boot=n_boot),
        "\n## 5. Форма команды: размещение против объёма изменения\n",
        "Серия `command-shape`: один документ (`doc-cmd-50x500`, геометрия и seed приёмочного), один маршрут §7.2, "
        "одни и те же шесть конфигураций, и **четыре разные команды**. Варианты перемешаны внутри повторений, "
        "поэтому различия между ними — свойство команды, а не дрейфа стенда.\n",
        "\n### 5.1 Что меняет каждая команда\n",
        section_command_shape_inventory(series, "command-shape"),
        "\n### 5.2 Показатели по вариантам\n",
        section_command_shape(series, "command-shape", seed=seed, n_boot=n_boot),
        "\n### 5.3 Разделение факторов: размещение против объёма (парно)\n",
        section_command_shape_contrasts(series, "command-shape", seed=seed, n_boot=n_boot),
        "\n## 6. RTT 50 против 150 мс\n",
        "Документ и маршрут те же, что в основной серии; отличается только задержка канала "
        "(`shaper.effective.delayMs` 25 → 75 мс, `handshakeRttMs` 50 → 150).\n",
        section_rtt(series, rtt_axis, seed=seed, n_boot=n_boot),
        "\n## 7. Бюджеты §1.2 по всем сериям\n",
        "Бюджет сценария у каждой серии свой (объявлен в паспорте): 30 с для маршрута §7.2, **40 с** у "
        "`route-repeat` и **70 с** у `route-full` — одни только объявленные паузы §1.2 дают там 18 и 49 с. "
        "Столбец «Сценарий в бюджете серии» проверяет каждую серию против её собственного порога.\n",
        section_budgets_all(series, seed=seed, n_boot=n_boot),
        "\n## 8. Графики\n",
        "\n".join(f"![{lab}]({rel(p)})\n" for lab, p in fig_paths),
    ]
    text = "\n".join(parts)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    return {"out": out, "figs": [p for _, p in fig_paths], "series": list(series)}


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="analysis.cross", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--series", required=True, help="список `имя=каталог` через запятую (или просто каталоги)")
    p.add_argument("--out", required=True)
    p.add_argument("--figs")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--n-boot", type=int, default=2000)
    a = p.parse_args(argv)
    res = build_cross([s.strip() for s in a.series.split(",") if s.strip()], a.out, a.figs, seed=a.seed, n_boot=a.n_boot)
    print(f"cross report: {res['out']}; figures: {len(res['figs'])}; series: {', '.join(res['series'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
