"""Статистика серии (SPEC §7.5): медианы, p95, бутстреп‑интервалы, интервал
Уилсона, сводки по конфигурациям, изменения внутри адаптера (P−F, P/F) и их
сопоставление между адаптерами, проверка бюджетов (§7.4) и окна кеша.

Определения, принятые здесь (и повторённые в отчёте, чтобы число нельзя было
прочитать двояко):

* **p95** — перцентиль по линейной интерполяции порядковых статистик
  (`numpy.percentile(..., method='linear')`, он же «тип 7» в R). При n = 30 это
  интерполяция между 29‑м и 30‑м значением вариационного ряда, то есть p95 по
  построению **не** превышает максимум выборки и при малых n смещён вниз
  относительно истинного 95‑го перцентиля. Другие определения (ближайший ранг,
  «не менее 95 % значений ≤ p95») дали бы при n = 30 ровно максимум.
* **Интервал медианы и p95** — перцентильный бутстреп (2000 ресемплов по
  умолчанию) по одной и той же матрице ресемплов, поэтому оба интервала
  согласованы между собой. При n = 1 интервал не определён (NaN), при n < 8
  он ненадёжен и помечается в отчёте.
* **Доля** (успех, «сценарий в пределах бюджета серии») — интервал Уилсона 95 % по **всем**
  начатым прогонам конфигурации; ошибки и таймауты считаются неуспехом.
* **Сводки времени/памяти** — только по прогонам `outcome == 'ok'`; прогоны
  `error`/`timeout` не отбрасываются молча, а учитываются в долях и в разделе
  ошибок.

Все бутстрепы детерминированы: seed задаётся явно, а seed каждой группы
выводится из базового seed и ключа группы, поэтому результат не зависит от
порядка обработки групп.
"""

from __future__ import annotations

import itertools
import math
import zlib
from typing import Any, Callable, Iterable, Sequence

import numpy as np
import pandas as pd

from . import schema as S

DEFAULT_N_BOOT = 2000
DEFAULT_ALPHA = 0.05
Z_95 = 1.959963984540054

#: Ниже этого числа наблюдений перцентильный бутстреп‑интервал не считается
#: надёжным (в отчёте помечается), при n = 1 он вообще не определён.
MIN_N_FOR_CI = 8

#: Перекрёстная проверка обмена: шейпер считает байты TCP‑полезной нагрузки,
#: CDP — отдельно HTTP (`encodedDataLength`) и кадры WebSocket. У адаптера Z
#: почти весь обмен идёт по WebSocket, поэтому сравнивать надо СУММУ.
CDP_IN_PARTS = ("cdp_bytes_in", "cdp_ws_bytes_in")
CDP_OUT_PARTS = ("cdp_bytes_out", "cdp_ws_bytes_out")

#: Необязательные метрики, которые измерительная оболочка может начать писать
#: (новая семантика моментов команды, учёт накладных расходов пробы). Анализ не
#: требует их наличия: отсутствующие пропускаются, присутствующие попадают в
#: отчёт. Формат: колонка → (подпись, единица).
OPTIONAL_METRICS: dict[str, tuple[str, str]] = {
    "t_cmd_server_ms": ("Команда: разрешение мутатора на сервере (Z, `.server`)", "мс"),
    "t_cmd_synced_ms": ("Команда: синхронизированная ревизия у клиента (Z)", "мс"),
    "t_cmd_opget_ms": ("Команда: чтение результата операции `GET /api/operations` (Z)", "мс"),
    "t_scenario_wall_ms": ("Сценарий: настенное время оболочки (с пробами)", "мс"),
    "t_scenario_model_ms": ("Сценарий: независимая модель по журналу событий страницы", "мс"),
    "probe_overrun_ms": ("Превышение объявленной паузы измерительной пробой", "мс"),
    "probe_total_ms": ("Суммарное время измерительных проб за прогон", "мс"),
    "js_heap_samples": ("Число проб JS‑кучи за прогон", "шт."),
    "js_heap_sample_interval_ms": ("Интервал опроса JS‑кучи", "мс"),
    # добавлены оболочкой 2026-09-13 (паритет сборщика, сравнимое удержание, честность модели)
    "t_scenario_model_residual_ms": ("Сценарий: остаток модели (`t_scenario` − модель по журналу)", "мс"),
    "retained_pages_end_exact": ("Удерживаемые страницы, конец — точный скан", "шт."),
    "retained_shapes_end_exact": ("Удерживаемые фигуры, конец — точный скан", "шт."),
    "js_heap_gc_count": ("Принудительных сборок мусора за прогон", "шт."),
    "js_heap_post_gc_mb": ("JS‑куча после принудительной сборки (остановка часов)", "МБ"),
    "js_heap_suspended_ms": ("Опрос JS‑кучи приостановлен (сканы + выгрузка снимков)", "мс"),
    # добавлены оболочкой 2026-09-14 (программа 2): честность пика памяти и паритет проб
    "chromium_private_peak_raw_mib": ("Chromium, пик частной памяти, сырой (все выборки)", "МиБ"),
    "chromium_samples": ("Выборок `procfs` Chromium за прогон", "шт."),
    "chromium_probe_ticks": ("Из них попавших в окна измерительных проб", "шт."),
    "probe_window_count": ("Окон измерительных проб за прогон (паритет политики проб)", "шт."),
    "probe_window_ms": ("Время в окнах измерительных проб", "мс"),
    "js_heap_sampler_coverage": ("Покрытие сэмплера JS‑кучи (доля времени прогона)", "доля"),
    "server_api_mem_peak_excl_probe_mib": ("Сервер api: пик памяти без окон проб", "МиБ"),
    "server_pg_mem_peak_excl_probe_mib": ("Сервер postgres: пик памяти без окон проб", "МиБ"),
    "server_zero_mem_peak_excl_probe_mib": ("Сервер zero‑cache: пик памяти без окон проб", "МиБ"),
}

#: Колонки моментов команды, которые выводятся в отдельном разделе отчёта.
COMMAND_TIME_COLUMNS = ["t_cmd_ack_ms", "t_cmd_drawn_ms", "t_cmd_server_ms", "t_cmd_synced_ms", "t_cmd_opget_ms"]


# ------------------------------------------------------------------ primitives
def _clean(x: Iterable[Any]) -> np.ndarray:
    a = np.asarray(list(x) if not isinstance(x, (np.ndarray, pd.Series)) else x, dtype="float64")
    return a[~np.isnan(a)]


def median(x: Iterable[Any]) -> float:
    a = _clean(x)
    return float(np.median(a)) if a.size else math.nan


def p95(x: Iterable[Any]) -> float:
    """95‑й перцентиль по линейной интерполяции порядковых статистик (тип 7).

    При n = 30 это интерполяция между 29‑м и 30‑м значением ряда; определение
    зафиксировано здесь и повторено в отчёте.
    """
    a = _clean(x)
    return float(np.percentile(a, 95, method="linear")) if a.size else math.nan


def _group_seed(seed: int, key: str) -> int:
    return (int(seed) * 1_000_003 + zlib.crc32(key.encode("utf-8"))) % (2**32)


def bootstrap_ci(
    x: Iterable[Any],
    stat: Callable[[np.ndarray], np.ndarray] | None = None,
    *,
    n_boot: int = DEFAULT_N_BOOT,
    seed: int = 0,
    alpha: float = DEFAULT_ALPHA,
    key: str = "",
) -> tuple[float, float]:
    """Перцентильный бутстреп‑интервал статистики (по умолчанию — медианы).

    `stat` принимает матрицу (n_boot × n) и возвращает вектор n_boot.
    """
    a = _clean(x)
    if a.size < 2:
        # По одному наблюдению интервал не определён: выдавать (x, x) как
        # «95 % интервал» — вводить читателя в заблуждение.
        return (math.nan, math.nan)
    rng = np.random.default_rng(_group_seed(seed, key))
    idx = rng.integers(0, a.size, size=(n_boot, a.size))
    samples = a[idx]
    f = stat or (lambda m: np.median(m, axis=1))
    vals = f(samples)
    lo, hi = np.percentile(vals, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return (float(lo), float(hi))


def bootstrap_two_sample(
    x: Iterable[Any],
    y: Iterable[Any],
    func: Callable[[np.ndarray, np.ndarray], np.ndarray],
    *,
    n_boot: int = DEFAULT_N_BOOT,
    seed: int = 0,
    alpha: float = DEFAULT_ALPHA,
    key: str = "",
) -> tuple[float, float, float]:
    """Точечная оценка и интервал для func(medians...) при независимом
    ресемплинге двух выборок. `func(mx, my)` получает векторы медиан ресемплов."""
    a, b = _clean(x), _clean(y)
    if a.size == 0 or b.size == 0:
        return (math.nan, math.nan, math.nan)
    # Деление на нулевую медиану знаменателя даёт `nan`, а не предупреждение numpy: в отчёте
    # такая ячейка и должна быть прочерком (например, P/F для `nav_cache_misses`, где медиана F
    # равна нулю по устройству режима).
    with np.errstate(divide="ignore", invalid="ignore"):
        est = float(func(np.array([np.median(a)]), np.array([np.median(b)]))[0])
        rng = np.random.default_rng(_group_seed(seed, key))
        ma = np.median(a[rng.integers(0, a.size, size=(n_boot, a.size))], axis=1)
        mb = np.median(b[rng.integers(0, b.size, size=(n_boot, b.size))], axis=1)
        vals = func(ma, mb)
    vals = vals[np.isfinite(vals)]
    if vals.size == 0:
        return (est, math.nan, math.nan)
    lo, hi = np.percentile(vals, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return (est, float(lo), float(hi))


def sign_test(diffs: Iterable[Any], *, null_value: float = 0.0) -> dict[str, float]:
    """Точный знаковый критерий по поблочным разностям (двусторонний).

    Зачем он нужен рядом с бутстрепом: при n = 6 (серия `command-shape`) перцентильный интервал
    строится по шести точкам и сам по себе ненадёжен, а знаки пар — статистика, не зависящая ни от
    формы распределения, ни от величины выбросов. Если все шесть разностей одного знака, точный
    двусторонний критерий даёт p = 2·(1/2)⁶ = 0.031 — это и есть устойчивая проверка вывода.

    Нулевые разности (`d == null_value`) исключаются, как требует классический знаковый критерий;
    их число публикуется отдельно. Возвращает `{n, n_pos, n_neg, n_zero, p_value}`; при n = 0
    `p_value = nan`.
    """
    d = _clean(diffs) - float(null_value)
    n_zero = int((d == 0).sum())
    d = d[d != 0]
    n = int(d.size)
    n_pos = int((d > 0).sum())
    n_neg = n - n_pos
    if n == 0:
        return {"n": 0, "n_pos": 0, "n_neg": 0, "n_zero": n_zero, "p_value": math.nan}
    k = min(n_pos, n_neg)
    tail = sum(math.comb(n, i) for i in range(0, k + 1)) / (2**n)
    return {"n": n, "n_pos": n_pos, "n_neg": n_neg, "n_zero": n_zero, "p_value": float(min(1.0, 2 * tail))}


def wilson_interval(k: int, n: int, *, z: float = Z_95) -> tuple[float, float, float]:
    """Доля успеха k/n и интервал Уилсона (p, lo, hi)."""
    if n <= 0:
        return (math.nan, math.nan, math.nan)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (p, max(0.0, centre - half), min(1.0, centre + half))


def summarize(x: Iterable[Any], *, seed: int = 0, n_boot: int = DEFAULT_N_BOOT, key: str = "") -> dict[str, float]:
    """n, медиана, p95 и перцентильные бутстреп‑интервалы обеих статистик.

    Медиана и p95 ресемплируются по одной и той же матрице индексов, поэтому их
    интервалы согласованы. `ci_reliable` = n ≥ MIN_N_FOR_CI.
    """
    empty = {
        "n": 0,
        "median": math.nan,
        "ci_lo": math.nan,
        "ci_hi": math.nan,
        "p95": math.nan,
        "p95_lo": math.nan,
        "p95_hi": math.nan,
        "mean": math.nan,
        "min": math.nan,
        "max": math.nan,
        "ci_reliable": False,
    }
    a = _clean(x)
    if a.size == 0:
        return empty
    lo = hi = plo = phi = math.nan
    if a.size >= 2:
        rng = np.random.default_rng(_group_seed(seed, key))
        samples = a[rng.integers(0, a.size, size=(n_boot, a.size))]
        meds = np.median(samples, axis=1)
        p95s = np.percentile(samples, 95, axis=1, method="linear")
        lo, hi = (float(v) for v in np.percentile(meds, [100 * DEFAULT_ALPHA / 2, 100 * (1 - DEFAULT_ALPHA / 2)]))
        plo, phi = (float(v) for v in np.percentile(p95s, [100 * DEFAULT_ALPHA / 2, 100 * (1 - DEFAULT_ALPHA / 2)]))
    return {
        "n": int(a.size),
        "median": float(np.median(a)),
        "ci_lo": lo,
        "ci_hi": hi,
        "p95": float(np.percentile(a, 95, method="linear")),
        "p95_lo": plo,
        "p95_hi": phi,
        "mean": float(np.mean(a)),
        "min": float(np.min(a)),
        "max": float(np.max(a)),
        "ci_reliable": bool(a.size >= MIN_N_FOR_CI),
    }


# --------------------------------------------------------------- config keys
def config_key_columns(df: pd.DataFrame) -> list[str]:
    """Колонки ключа конфигурации, имеющиеся в кадре.

    `cmd_variant` входит в ключ, но только если серия действительно измеряла варианты команды:
    пустую колонку (серии без `variants`) в ключ брать незачем — она добавила бы в подпись
    конфигурации ничего не значащий хвост.
    """
    keys = [c for c in S.CONFIG_KEY if c in df.columns]
    if S.VARIANT_COLUMN in keys and not _has_variants(df):
        keys.remove(S.VARIANT_COLUMN)
    return keys


def _has_variants(df: pd.DataFrame) -> bool:
    if S.VARIANT_COLUMN not in df.columns:
        return False
    vals = {str(v).strip() for v in df[S.VARIANT_COLUMN].dropna().unique()}
    return bool(vals - {""})


def variants(df: pd.DataFrame) -> list[str | None]:
    """Варианты команды серии (`packages/bench/README.md` §4.2) или `[None]`, если их нет."""
    if not _has_variants(df):
        return [None]
    return sorted({str(v).strip() for v in df[S.VARIANT_COLUMN].dropna().unique() if str(v).strip()})


def variant_subset(df: pd.DataFrame, variant: str | None) -> pd.DataFrame:
    if variant is None or S.VARIANT_COLUMN not in df.columns:
        return df
    return df[df[S.VARIANT_COLUMN].astype("object").map(lambda v: None if v is None else str(v).strip()) == variant]


def config_label(row: pd.Series | dict[str, Any]) -> str:
    a, m = row.get("adapter"), row.get("mode")
    c = row.get("cache")
    lab = f"{a}/{m}"
    if m == "P" and c is not None and not (isinstance(c, float) and math.isnan(c)):
        lab += f" (cache={int(c)})"
    v = row.get(S.VARIANT_COLUMN)
    if v is not None and not (isinstance(v, float) and math.isnan(v)) and str(v).strip():
        lab += f" [{str(v).strip()}]"
    return lab


def ok_runs(df: pd.DataFrame) -> pd.DataFrame:
    """Прогоны, по которым считаются метрики времени/памяти: `outcome == 'ok'`.

    Прогоны `error`/`timeout` исключаются только отсюда: в долю успеха, в долю
    «сценарий в пределах бюджета» и в раздел ошибок они входят полностью. Прогон с
    `outcome='ok'`, но `reference_ok=false` из метрик НЕ исключается (он
    состоялся и измерен), однако выносится отдельным счётчиком
    `n_ok_reference_failed` в таблице состава серии — §1.8 требует допуска по
    эталону до сравнения, поэтому ненулевое значение должно быть замечено.
    """
    if "outcome" not in df.columns:
        return df
    return df[df["outcome"] == "ok"]


# ------------------------------------------------------------------ summaries
def summarize_configs(
    df: pd.DataFrame,
    metrics: Sequence[str] | None = None,
    *,
    seed: int = 0,
    n_boot: int = DEFAULT_N_BOOT,
    only_ok: bool = True,
) -> pd.DataFrame:
    """Длинная таблица: конфигурация × метрика → n, median, ci_lo, ci_hi, p95, mean, min, max."""
    metrics = list(metrics or [m.column for m in S.METRICS])
    keys = config_key_columns(df)
    src = ok_runs(df) if only_ok else df
    rows: list[dict[str, Any]] = []
    for kv, g in src.groupby(keys, dropna=False, sort=True):
        kv = kv if isinstance(kv, tuple) else (kv,)
        base = dict(zip(keys, kv))
        base["config"] = config_label(base)
        for m in metrics:
            if m not in g.columns:
                continue
            key = f"{base['config']}|{m}"
            s = summarize(g[m], seed=seed, n_boot=n_boot, key=key)
            rows.append({**base, "metric": m, **s})
    return pd.DataFrame(rows)


def success_table(df: pd.DataFrame, *, scenario_budget_ms: float | None = None) -> pd.DataFrame:
    """Исходы и доля успеха по конфигурациям с интервалом Уилсона.

    Порог сценария — бюджет СЕРИИ: колонка `scenario_budget_ms` кадра (её ставит `schema.coerce`
    по паспорту), иначе явный аргумент, иначе §7.4 по умолчанию. Он же публикуется в таблице,
    чтобы доля «уложились» читалась вместе с порогом, против которого посчитана.
    """
    budget = float(scenario_budget_ms) if scenario_budget_ms is not None else S.series_scenario_budget_ms(df)
    keys = config_key_columns(df)
    rows: list[dict[str, Any]] = []
    for kv, g in df.groupby(keys, dropna=False, sort=True):
        kv = kv if isinstance(kv, tuple) else (kv,)
        base = dict(zip(keys, kv))
        n = len(g)
        n_ok = int((g["outcome"] == "ok").sum()) if "outcome" in g else n
        n_err = int((g["outcome"] == "error").sum()) if "outcome" in g else 0
        n_to = int((g["outcome"] == "timeout").sum()) if "outcome" in g else 0
        n_succ = int(g["success"].fillna(False).astype(bool).sum()) if "success" in g else n_ok
        n_ref_ok = int(g["reference_ok"].map(S.is_true).sum()) if "reference_ok" in g else n_ok
        if "reference_ok" in g and "outcome" in g:
            n_ok_ref_failed = int(g.loc[g["outcome"] == "ok", "reference_ok"].map(S.is_false).sum())
        else:
            n_ok_ref_failed = 0
        n_in_budget = int((g["t_scenario_ms"] <= budget).sum()) if "t_scenario_ms" in g else n_ok
        p, lo, hi = wilson_interval(n_succ, n)
        p30, lo30, hi30 = wilson_interval(n_in_budget, n)
        rows.append(
            {
                **base,
                "config": config_label(base),
                "n": n,
                "n_ok": n_ok,
                "n_error": n_err,
                "n_timeout": n_to,
                "n_reference_ok": n_ref_ok,
                "n_ok_reference_failed": n_ok_ref_failed,
                "n_success": n_succ,
                "success_share": p,
                "success_lo": lo,
                "success_hi": hi,
                "n_within_budget": n_in_budget,
                "share_within_budget": p30,
                "share_within_budget_lo": lo30,
                "share_within_budget_hi": hi30,
                "scenario_budget_ms": budget,
            }
        )
    return pd.DataFrame(rows)


def _pick(df: pd.DataFrame, adapter: str, mode: str, metric: str, cache: int | None = None) -> np.ndarray:
    g = df[(df["adapter"] == adapter) & (df["mode"] == mode)]
    if mode == "P" and cache is not None and "cache" in g.columns:
        g = g[g["cache"] == cache]
    return _clean(g[metric]) if metric in g.columns else np.array([])


def _caches_for_p(df: pd.DataFrame) -> list[int | None]:
    if "cache" not in df.columns:
        return [None]
    vals = sorted({int(v) for v in df.loc[df["mode"] == "P", "cache"].dropna().unique()})
    return vals or [None]


def within_adapter_deltas(
    df: pd.DataFrame,
    metric: str,
    *,
    seed: int = 0,
    n_boot: int = DEFAULT_N_BOOT,
    only_ok: bool = True,
) -> pd.DataFrame:
    """Для каждого адаптера: медианы F и P, Δ = med(P) − med(F) и P/F с бутстреп‑интервалами.

    Если в серии несколько значений cache для P — строка на каждое.
    """
    src0 = ok_runs(df) if only_ok else df
    rows: list[dict[str, Any]] = []
    for variant in variants(src0):
        src = variant_subset(src0, variant)
        adapters = [a for a in S.ADAPTERS if a in set(src["adapter"].dropna())]
        for a in adapters:
            xf = _pick(src, a, "F", metric)
            for c in _caches_for_p(src):
                xp = _pick(src, a, "P", metric, c)
                if xf.size == 0 or xp.size == 0:
                    continue
                key = f"{a}|{c}|{variant}|{metric}"
                d, dlo, dhi = bootstrap_two_sample(xp, xf, lambda mp, mf: mp - mf, seed=seed, n_boot=n_boot, key=key + "|delta")
                r, rlo, rhi = bootstrap_two_sample(xp, xf, lambda mp, mf: mp / mf, seed=seed, n_boot=n_boot, key=key + "|ratio")
                rows.append(
                    {
                        "adapter": a,
                        "cache": c,
                        "variant": variant,
                        "metric": metric,
                        "n_F": int(xf.size),
                        "n_P": int(xp.size),
                        "median_F": float(np.median(xf)),
                        "median_P": float(np.median(xp)),
                        "delta": d,
                        "delta_lo": dlo,
                        "delta_hi": dhi,
                        "ratio": r,
                        "ratio_lo": rlo,
                        "ratio_hi": rhi,
                    }
                )
    return pd.DataFrame(rows)


def between_adapter_comparison(
    df: pd.DataFrame,
    metric: str,
    *,
    seed: int = 0,
    n_boot: int = DEFAULT_N_BOOT,
    only_ok: bool = True,
) -> pd.DataFrame:
    """Сопоставление изменения P−F между адаптерами (§1.8): для пар (A,B)
    разность дельт Δ_A − Δ_B и отношение отношений (P/F)_A / (P/F)_B с бутстреп‑интервалами
    при независимом ресемплинге четырёх групп."""
    src0 = ok_runs(df) if only_ok else df
    rows: list[dict[str, Any]] = []
    for variant in variants(src0):
      src = variant_subset(src0, variant)
      adapters = [a for a in S.ADAPTERS if a in set(src["adapter"].dropna())]
      for c in _caches_for_p(src):
        groups: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        for a in adapters:
            xf, xp = _pick(src, a, "F", metric), _pick(src, a, "P", metric, c)
            if xf.size and xp.size:
                groups[a] = (xf, xp)
        for a, b in itertools.combinations(groups, 2):
            af, ap = groups[a]
            bf, bp = groups[b]
            rng = np.random.default_rng(_group_seed(seed, f"{a}|{b}|{c}|{variant}|{metric}"))

            def meds(x: np.ndarray) -> np.ndarray:
                return np.median(x[rng.integers(0, x.size, size=(n_boot, x.size))], axis=1)

            m_af, m_ap, m_bf, m_bp = meds(af), meds(ap), meds(bf), meds(bp)
            dd = (m_ap - m_af) - (m_bp - m_bf)
            with np.errstate(divide="ignore", invalid="ignore"):
                rr = (m_ap / m_af) / (m_bp / m_bf)
            rr = rr[np.isfinite(rr)]
            delta_a = float(np.median(ap) - np.median(af))
            delta_b = float(np.median(bp) - np.median(bf))
            ratio_a = float(np.median(ap) / np.median(af)) if np.median(af) else math.nan
            ratio_b = float(np.median(bp) / np.median(bf)) if np.median(bf) else math.nan
            rows.append(
                {
                    "adapter_a": a,
                    "adapter_b": b,
                    "cache": c,
                    "variant": variant,
                    "metric": metric,
                    "delta_a": delta_a,
                    "delta_b": delta_b,
                    "delta_diff": delta_a - delta_b,
                    "delta_diff_lo": float(np.percentile(dd, 2.5)),
                    "delta_diff_hi": float(np.percentile(dd, 97.5)),
                    "ratio_a": ratio_a,
                    "ratio_b": ratio_b,
                    "ratio_of_ratios": (ratio_a / ratio_b) if ratio_b else math.nan,
                    "ratio_of_ratios_lo": float(np.percentile(rr, 2.5)) if rr.size else math.nan,
                    "ratio_of_ratios_hi": float(np.percentile(rr, 97.5)) if rr.size else math.nan,
                }
            )
    return pd.DataFrame(rows)


# -------------------------------------------------- парный (блочный) анализ
# Обоснование парности. Раннер выполняет каждое повторение как БЛОК: в одном
# повторении ровно по одному прогону каждой из конфигураций серии, порядок
# внутри блока перемешан seeded‑PRNG, перед каждым прогоном — сброс документа и
# новый процесс Chromium (`packages/bench/src/series/plan.mjs`,
# `docs/PASSPORT.md` §6). Поэтому `repetition` — законный блокирующий фактор:
# прогоны одного блока выполнены в одном «окне» состояния машины, и разность
# P − F внутри блока снимает медленный дрейф (прогрев, фоновая нагрузка,
# рост реплики) между блоками.
#
# Чего парность НЕ даёт: прогоны блока разнесены во времени на минуты и идут в
# разном порядке, поэтому пара — не одновременное измерение, а блок; эффект
# позиции внутри блока парность не убирает. Пары, в которых хотя бы один прогон
# не `ok`, отбрасываются целиком (число отброшенных публикуется), поэтому при
# несимметричных отказах парная оценка считается по другому подмножеству, чем
# непарная. Обе оценки выводятся рядом; расхождение между ними — сигнал, что
# результат чувствителен к дрейфу или к выпавшим прогонам.
PAIR_KEY_DEFAULT = "repetition"


def _paired_values(
    df: pd.DataFrame,
    adapter: str,
    metric: str,
    cache: int | None,
    *,
    pair_on: str = PAIR_KEY_DEFAULT,
) -> tuple[np.ndarray, np.ndarray, dict[str, int]]:
    """Значения метрики F и P одного адаптера, выровненные по ключу блока.

    Возвращает (значения F, значения P, диагностика). Если в блоке несколько
    прогонов одной конфигурации, берётся их медиана (и это отмечается).
    """
    info = {"n_F_all": 0, "n_P_all": 0, "n_pairs": 0, "n_dropped": 0, "n_collapsed": 0}
    if pair_on not in df.columns or metric not in df.columns:
        return np.array([]), np.array([]), info
    g = df[df["adapter"] == adapter]
    join = [pair_on] + (["doc"] if "doc" in g.columns else [])

    def side(mode: str) -> pd.DataFrame:
        s = g[g["mode"] == mode]
        if mode == "P" and cache is not None and "cache" in s.columns:
            s = s[s["cache"] == cache]
        s = s.dropna(subset=[metric, pair_on])
        if s.empty:
            return s.assign(**{metric: pd.Series(dtype="float64")})
        grouped = s.groupby(join, dropna=False, sort=True)
        info["n_collapsed"] += int((grouped.size() > 1).sum())
        return grouped[metric].median().reset_index()

    f, p = side("F"), side("P")
    info["n_F_all"], info["n_P_all"] = len(f), len(p)
    if f.empty or p.empty:
        info["n_dropped"] = info["n_F_all"] + info["n_P_all"]
        return np.array([]), np.array([]), info
    m = f.merge(p, on=join, suffixes=("_F", "_P"), how="inner")
    info["n_pairs"] = len(m)
    info["n_dropped"] = (info["n_F_all"] - len(m)) + (info["n_P_all"] - len(m))
    return m[f"{metric}_F"].to_numpy(dtype="float64"), m[f"{metric}_P"].to_numpy(dtype="float64"), info


def _boot_median(v: np.ndarray, *, seed: int, n_boot: int, key: str) -> tuple[float, float, float]:
    """Медиана вектора и её перцентильный бутстреп‑интервал (ресемплинг пар)."""
    v = v[np.isfinite(v)]
    if v.size == 0:
        return (math.nan, math.nan, math.nan)
    est = float(np.median(v))
    if v.size < 2:
        return (est, math.nan, math.nan)
    rng = np.random.default_rng(_group_seed(seed, key))
    meds = np.median(v[rng.integers(0, v.size, size=(n_boot, v.size))], axis=1)
    lo, hi = np.percentile(meds, [100 * DEFAULT_ALPHA / 2, 100 * (1 - DEFAULT_ALPHA / 2)])
    return (est, float(lo), float(hi))


def within_adapter_deltas_paired(
    df: pd.DataFrame,
    metric: str,
    *,
    seed: int = 0,
    n_boot: int = DEFAULT_N_BOOT,
    only_ok: bool = True,
    pair_on: str = PAIR_KEY_DEFAULT,
) -> pd.DataFrame:
    """P − F и P / F внутри адаптера по парам «один блок повторения» (§1.8).

    Точечные оценки — медиана поблочных разностей и медиана поблочных отношений
    (это НЕ разность/отношение медиан: при парности усредняется сам эффект).
    Интервалы — перцентильный бутстреп по парам.
    """
    src0 = ok_runs(df) if only_ok else df
    rows: list[dict[str, Any]] = []
    for variant in variants(src0):
      src = variant_subset(src0, variant)
      adapters = [a for a in S.ADAPTERS if a in set(src["adapter"].dropna())]
      for a in adapters:
        for c in _caches_for_p(src):
            xf, xp, info = _paired_values(src, a, metric, c, pair_on=pair_on)
            if xf.size == 0:
                continue
            key = f"{a}|{c}|{variant}|{metric}|paired"
            d, dlo, dhi = _boot_median(xp - xf, seed=seed, n_boot=n_boot, key=key + "|delta")
            with np.errstate(divide="ignore", invalid="ignore"):
                ratios = np.where(xf != 0, xp / xf, np.nan)
            r, rlo, rhi = _boot_median(ratios, seed=seed, n_boot=n_boot, key=key + "|ratio")
            # Блоки, где знаменатель равен нулю, отношения не дают вовсе: их нельзя молча
            # выбросить, иначе «медиана по 10 парам» окажется медианой по двум (например,
            # `nav_cache_misses` в F равен 0 во всех прогонах, кроме тех, где полная загрузка
            # ещё шла в фоне). Число пар, давших отношение, публикуется отдельно.
            n_ratio = int(np.isfinite(ratios).sum())
            # Знаковый критерий рядом с бутстрепом (§1.8, n = 6/10): проверка, не зависящая от
            # формы распределения, — именно она держит выводы на тонких ячейках.
            st = sign_test(xp - xf)
            rows.append(
                {
                    "adapter": a,
                    "cache": c,
                    "variant": variant,
                    "metric": metric,
                    "pair_on": pair_on,
                    "sign_n": st["n"],
                    "sign_pos": st["n_pos"],
                    "sign_neg": st["n_neg"],
                    "sign_p": st["p_value"],
                    "n_pairs": info["n_pairs"],
                    "n_ratio": n_ratio,
                    "n_dropped": info["n_dropped"],
                    "n_collapsed": info["n_collapsed"],
                    "median_F": float(np.median(xf)),
                    "median_P": float(np.median(xp)),
                    "delta": d,
                    "delta_lo": dlo,
                    "delta_hi": dhi,
                    "ratio": r,
                    "ratio_lo": rlo,
                    "ratio_hi": rhi,
                }
            )
    return pd.DataFrame(rows)


def between_adapter_comparison_paired(
    df: pd.DataFrame,
    metric: str,
    *,
    seed: int = 0,
    n_boot: int = DEFAULT_N_BOOT,
    only_ok: bool = True,
    pair_on: str = PAIR_KEY_DEFAULT,
) -> pd.DataFrame:
    """Сопоставление изменения P−F между адаптерами на общих блоках (§1.8).

    Для каждого блока считается d_A(r) = P_A(r) − F_A(r) и d_B(r); сравниваются
    d_A − d_B и отношение отношений на ОДНИХ и тех же блоках, поэтому общий для
    обоих адаптеров дрейф машины сокращается.
    """
    src0 = ok_runs(df) if only_ok else df
    rows: list[dict[str, Any]] = []
    join = [pair_on] + (["doc"] if "doc" in src0.columns else [])
    for variant in variants(src0):
      src = variant_subset(src0, variant)
      adapters = [a for a in S.ADAPTERS if a in set(src["adapter"].dropna())]
      for c in _caches_for_p(src):
        per_adapter: dict[str, pd.DataFrame] = {}
        for a in adapters:
            if pair_on not in src.columns or metric not in src.columns:
                continue
            g = src[src["adapter"] == a]
            f = g[g["mode"] == "F"].dropna(subset=[metric, pair_on])
            p = g[g["mode"] == "P"]
            if c is not None and "cache" in p.columns:
                p = p[p["cache"] == c]
            p = p.dropna(subset=[metric, pair_on])
            if f.empty or p.empty:
                continue
            fm = f.groupby(join, dropna=False, sort=True)[metric].median().reset_index()
            pm = p.groupby(join, dropna=False, sort=True)[metric].median().reset_index()
            m = fm.merge(pm, on=join, suffixes=("_F", "_P"), how="inner")
            if m.empty:
                continue
            m["delta"] = m[f"{metric}_P"] - m[f"{metric}_F"]
            with np.errstate(divide="ignore", invalid="ignore"):
                m["ratio"] = np.where(m[f"{metric}_F"] != 0, m[f"{metric}_P"] / m[f"{metric}_F"], np.nan)
            per_adapter[a] = m[[*join, "delta", "ratio"]]
        for a, b in itertools.combinations(per_adapter, 2):
            m = per_adapter[a].merge(per_adapter[b], on=join, suffixes=("_a", "_b"), how="inner")
            if m.empty:
                continue
            key = f"{a}|{b}|{c}|{variant}|{metric}|paired"
            dd, dlo, dhi = _boot_median(
                (m["delta_a"] - m["delta_b"]).to_numpy(dtype="float64"), seed=seed, n_boot=n_boot, key=key + "|delta"
            )
            with np.errstate(divide="ignore", invalid="ignore"):
                rr = np.where(m["ratio_b"].to_numpy() != 0, m["ratio_a"].to_numpy() / m["ratio_b"].to_numpy(), np.nan)
            rrv, rlo, rhi = _boot_median(rr.astype("float64"), seed=seed, n_boot=n_boot, key=key + "|ratio")
            st = sign_test((m["delta_a"] - m["delta_b"]).to_numpy(dtype="float64"))
            rows.append(
                {
                    "adapter_a": a,
                    "adapter_b": b,
                    "cache": c,
                    "variant": variant,
                    "metric": metric,
                    "pair_on": pair_on,
                    "sign_n": st["n"],
                    "sign_pos": st["n_pos"],
                    "sign_neg": st["n_neg"],
                    "sign_p": st["p_value"],
                    "n_blocks": int(len(m)),
                    "delta_a": float(np.median(m["delta_a"])),
                    "delta_b": float(np.median(m["delta_b"])),
                    "delta_diff": dd,
                    "delta_diff_lo": dlo,
                    "delta_diff_hi": dhi,
                    "ratio_of_ratios": rrv,
                    "ratio_of_ratios_lo": rlo,
                    "ratio_of_ratios_hi": rhi,
                }
            )
    return pd.DataFrame(rows)


def pairing_feasible(df: pd.DataFrame, *, pair_on: str = PAIR_KEY_DEFAULT, min_pairs: int = 3) -> tuple[bool, str]:
    """Можно ли вести парный анализ по блокам повторений и почему нет, если нельзя."""
    if pair_on not in df.columns:
        return (False, f"в `runs.csv` нет колонки `{pair_on}` — блок повторения не определён")
    src = ok_runs(df)
    if src.empty:
        return (False, "нет прогонов с `outcome=ok`")
    best = 0
    for variant in variants(src):
        sub = variant_subset(src, variant)
        adapters = [a for a in S.ADAPTERS if a in set(sub["adapter"].dropna())]
        for a in adapters:
            for c in _caches_for_p(sub):
                xf, _, info = _paired_values(sub, a, "t_scenario_ms", c, pair_on=pair_on)
                best = max(best, info["n_pairs"])
    if best < min_pairs:
        return (False, f"общих блоков F и P недостаточно (максимум {best} < {min_pairs})")
    return (True, f"блок = `{pair_on}` (в одном повторении по одному прогону каждой конфигурации), пар до {best}")


# ------------------------------------------------------- моменты команды (§1.2)
def command_timing_table(
    df: pd.DataFrame,
    *,
    seed: int = 0,
    n_boot: int = DEFAULT_N_BOOT,
    only_ok: bool = True,
    eq_tolerance_ms: float = 0.5,
) -> pd.DataFrame:
    """`t_cmd_ack` и `t_cmd_drawn` по отдельности + их разность внутри прогона.

    §1.8: «Время отсчитывается до фактического обновления холста, подтверждение
    сервера регистрируется отдельно». Знак разности `drawn − ack` не
    предполагается: у HTTP‑адаптеров холст обновляется после ответа сервера
    (разность > 0), у Z синхронизация может опередить подтверждение (< 0).
    Разность считается **внутри одного прогона** — это настоящая пара, а не
    блок, поэтому интервал строится ресемплингом прогонов.
    """
    keys = config_key_columns(df)
    src = ok_runs(df) if only_ok else df
    rows: list[dict[str, Any]] = []
    for kv, g in src.groupby(keys, dropna=False, sort=True):
        kv = kv if isinstance(kv, tuple) else (kv,)
        base = dict(zip(keys, kv))
        cfg = config_label(base)
        row: dict[str, Any] = {**base, "config": cfg}
        for col in COMMAND_TIME_COLUMNS:
            if col not in g.columns:
                continue
            s = summarize(g[col], seed=seed, n_boot=n_boot, key=f"{cfg}|{col}")
            if s["n"] == 0:
                continue
            row[f"{col}_n"] = s["n"]
            row[f"{col}_median"] = s["median"]
            row[f"{col}_ci_lo"] = s["ci_lo"]
            row[f"{col}_ci_hi"] = s["ci_hi"]
            row[f"{col}_p95"] = s["p95"]
        if {"t_cmd_ack_ms", "t_cmd_drawn_ms"} <= set(g.columns):
            pair = g[["t_cmd_ack_ms", "t_cmd_drawn_ms"]].dropna()
            d = (pair["t_cmd_drawn_ms"] - pair["t_cmd_ack_ms"]).to_numpy(dtype="float64")
            est, lo, hi = _boot_median(d, seed=seed, n_boot=n_boot, key=f"{cfg}|drawn-ack")
            row.update(
                {
                    "n_pairs": int(d.size),
                    "drawn_minus_ack_median": est,
                    "drawn_minus_ack_lo": lo,
                    "drawn_minus_ack_hi": hi,
                    "share_drawn_before_ack": float(np.mean(d < -eq_tolerance_ms)) if d.size else math.nan,
                    "share_drawn_after_ack": float(np.mean(d > eq_tolerance_ms)) if d.size else math.nan,
                    "share_equal": float(np.mean(np.abs(d) <= eq_tolerance_ms)) if d.size else math.nan,
                }
            )
        rows.append(row)
    return pd.DataFrame(rows)


def optional_columns_status(df: pd.DataFrame) -> pd.DataFrame:
    """Какие необязательные метрики оболочка уже пишет, а какие ещё нет.

    Нужно, чтобы смена семантики моментов команды или новые колонки оболочки
    (`t_cmd_server_ms`, `probe_overrun_ms`, …) были видны в отчёте, а не молча
    игнорировались.
    """
    rows: list[dict[str, Any]] = []
    known = (
        set(S.REQUIRED_COLUMNS)
        | set(S.OPTIONAL_COLUMNS)
        | set(S.DERIVED_COLUMNS)
        | set(OPTIONAL_METRICS)
        | set(CDP_IN_PARTS)
        | set(CDP_OUT_PARTS)
        | {"success", S.SCENARIO_BUDGET_COLUMN}  # производные колонки schema.coerce
    )
    required = set(S.REQUIRED_COLUMNS)
    for col, (label, unit) in OPTIONAL_METRICS.items():
        if col in required:
            continue  # колонка стала обязательной — её отсутствие ловит валидатор схемы
        present = col in df.columns
        n = int(pd.to_numeric(df[col], errors="coerce").notna().sum()) if present else 0
        rows.append({"column": col, "label": label, "unit": unit, "present": present, "n_values": n, "source": "известная необязательная метрика"})
    for col in df.columns:
        if col in known:
            continue
        n = int(df[col].notna().sum())
        rows.append({"column": col, "label": "—", "unit": "", "present": True, "n_values": n, "source": "новая колонка, схемой не описана"})
    return pd.DataFrame(rows)


# ------------------------------------------------------------------- budgets
#: Вердикты бюджета. Точечная оценка сама по себе НЕ основание объявлять нарушение: `rtt150` Z/F
#: даёт медиану 2 007 мс при пороге 2 000 с интервалом [1 962; 2 058] и тремя прогонами из десяти
#: внутри бюджета. Поэтому вердикт трёхзначный и печатается рядом с отметкой точечной оценки.
VERDICT_WITHIN = "within"  # интервал целиком по нужную сторону порога — выполнение подтверждено
VERDICT_BREACH = "breach"  # интервал целиком по другую сторону — нарушение подтверждено
VERDICT_UNDETERMINED = "undetermined"  # интервал накрывает порог — данные не решают
VERDICT_MARKS = {VERDICT_WITHIN: "✓", VERDICT_BREACH: "✗", VERDICT_UNDETERMINED: "≈"}


def budget_verdict(value: float, lo: float, hi: float, limit: float, *, lower_is_better: bool = True) -> str | None:
    """Вердикт по бюджету с учётом интервала: `within` / `breach` / `undetermined`.

    `lower_is_better=True` — бюджет вида «не более `limit`» (времена, память); иначе — «не менее»
    (доля сценариев в бюджете). Нарушение объявляется ТОЛЬКО когда интервал исключает порог.
    Если интервала нет (n = 1), вердикт не определён (None) — печатается точечная отметка.
    """
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if math.isnan(lo) or math.isnan(hi):
        return None
    if lower_is_better:
        if hi <= limit:
            return VERDICT_WITHIN
        if lo > limit:
            return VERDICT_BREACH
    else:
        if lo >= limit:
            return VERDICT_WITHIN
        if hi < limit:
            return VERDICT_BREACH
    return VERDICT_UNDETERMINED


def nav_values(g: pd.DataFrame) -> np.ndarray:
    """Все времена переходов прогонов конфигурации.

    `t_nav_1..10` покрывают только первые десять переходов, а в `route-full` их 49 и в
    `route-repeat` 18; полный список оболочка пишет в `t_nav_ms_list` (значения через `|`).
    Берём список, если он есть, иначе — колонки (критик‑2 прохода 2, дефект 11).
    """
    if "t_nav_ms_list" in g.columns and g["t_nav_ms_list"].notna().any():
        vals: list[float] = []
        for s in g["t_nav_ms_list"].dropna():
            for part in str(s).replace(",", "|").split("|"):
                part = part.strip()
                if not part:
                    continue
                try:
                    vals.append(float(part))
                except ValueError:
                    continue
        if vals:
            return np.asarray(vals, dtype="float64")
    cols = [c for c in S.NAV_COLUMNS if c in g.columns]
    return _clean(g[cols].to_numpy().ravel()) if cols else np.array([])


def budget_checks(df: pd.DataFrame, *, scenario_budget_ms: float | None = None, seed: int = 0, n_boot: int = DEFAULT_N_BOOT) -> pd.DataFrame:
    """Проверка бюджетов SPEC §7.4 по каждой конфигурации.

    Времена — по медианам успешно завершившихся прогонов; доля сценариев в пределах бюджета —
    по всем прогонам (ошибки и таймауты = не уложились), с интервалом Уилсона;
    память Chromium и сервера — медиана и максимум; диск — максимум.

    Бюджет сценария — СВОЙ У КАЖДОЙ СЕРИИ (`scenario_budget_ms`, из паспорта): 30 с для маршрута
    §7.2, 40 с у `route-repeat`, 70 с у `route-full`. Фактический порог возвращается в колонке
    `limit` строки `scenario_budget_share`, поэтому отчёт печатает его, а не константу.

    Каждая строка несёт `n`, интервал (`ci_lo`/`ci_hi`) и `verdict`: `ok` — это отметка ТОЧЕЧНОЙ
    оценки, а нарушение бюджета объявляется только вердиктом `breach`, то есть когда интервал
    порог исключает (иначе `undetermined`).
    """
    budget = float(scenario_budget_ms) if scenario_budget_ms is not None else S.series_scenario_budget_ms(df)
    keys = config_key_columns(df)
    rows: list[dict[str, Any]] = []

    def add(base: dict[str, Any], budget: str, statistic: str, value: float, limit: float, ok: bool | None, **extra: Any) -> None:
        rows.append({**base, "config": config_label(base), "budget": budget, "statistic": statistic, "value": value, "limit": limit, "ok": (bool(ok) if S.is_bool(ok) else None), **extra})

    for kv, g in df.groupby(keys, dropna=False, sort=True):
        kv = kv if isinstance(kv, tuple) else (kv,)
        base = dict(zip(keys, kv))
        ok = ok_runs(g)
        cfg_key = config_label(base)

        def med(col: str) -> float:
            return median(ok[col]) if col in ok.columns else math.nan

        def add_median(budget_name: str, values: np.ndarray, limit: float, **extra: Any) -> None:
            """Медиана + бутстреп‑интервал + трёхзначный вердикт для бюджета «не более limit»."""
            v = float(np.median(values)) if values.size else math.nan
            lo, hi = bootstrap_ci(values, seed=seed, n_boot=n_boot, key=f"{cfg_key}|{budget_name}") if values.size >= 2 else (math.nan, math.nan)
            add(
                base,
                budget_name,
                "median",
                v,
                limit,
                None if math.isnan(v) else v <= limit,
                n=int(values.size),
                ci_lo=lo,
                ci_hi=hi,
                verdict=budget_verdict(v, lo, hi, limit),
                ci_reliable=bool(values.size >= MIN_N_FOR_CI),
                **extra,
            )

        add_median("first_ready", _clean(ok["t_first_ready_ms"]) if "t_first_ready_ms" in ok.columns else np.array([]), S.BUDGET_FIRST_READY_MS)
        nav_all = nav_values(ok)
        add_median("nav_all", nav_all, S.BUDGET_NAV_MS, source=("t_nav_ms_list" if "t_nav_ms_list" in ok.columns and ok["t_nav_ms_list"].notna().any() else "t_nav_1..10"))
        add_median("nav_new", _clean(ok["t_nav_new_median_ms"]) if "t_nav_new_median_ms" in ok.columns else np.array([]), S.BUDGET_NAV_MS)
        add_median("nav_return", _clean(ok["t_nav_return_median_ms"]) if "t_nav_return_median_ms" in ok.columns else np.array([]), S.BUDGET_NAV_MS)
        add_median("cmd_drawn", _clean(ok["t_cmd_drawn_ms"]) if "t_cmd_drawn_ms" in ok.columns else np.array([]), S.BUDGET_CMD_DRAWN_MS)
        # §1.2 задаёт бюджет перехода МЕДИАНОЙ, поэтому отдельные длинные переходы нарушением не
        # считаются — но умолчать о них нельзя: строка `nav_max` выводит худший переход и прогоны,
        # где хотя бы один переход вышел за секунду (`within_budget_nav=false`).
        if nav_all.size:
            worst = float(np.max(nav_all))
            over = g[g["within_budget_nav"].map(S.is_false)] if "within_budget_nav" in g.columns else g.iloc[0:0]
            add(
                base,
                "nav_max",
                "max",
                worst,
                S.BUDGET_NAV_MS,
                None,  # не отметка бюджета: §1.2 судит переход по медиане
                n=int(nav_all.size),
                runs_over=int(len(over)),
                runs_total=int(len(g)),
                run_ids_over=", ".join(str(r) for r in over["run_id"].tolist()[:10]) if "run_id" in over.columns else "",
                verdict=None,
            )
        n = len(g)
        k = int((g["t_scenario_ms"] <= budget).sum()) if "t_scenario_ms" in g.columns else 0
        p, lo, hi = wilson_interval(k, n)
        add(
            base,
            "scenario_budget_share",
            "share",
            p,
            S.BUDGET_SCENARIO_SHARE,
            p >= S.BUDGET_SCENARIO_SHARE if n else None,
            ci_lo=lo,
            ci_hi=hi,
            n=n,
            k=k,
            confident=(lo >= S.BUDGET_SCENARIO_SHARE) if n else None,
            verdict=budget_verdict(p, lo, hi, S.BUDGET_SCENARIO_SHARE, lower_is_better=False) if n else None,
            scenario_budget_ms=budget,
        )
        # Пик Chromium: головная величина — БЕЗ окон измерительной пробы, если оболочка её пишет
        # (у Z/F точный скан после команды сам поднимает частную память). Сырой пик остаётся
        # отдельной строкой, чтобы разницу было видно.
        peak_cols = [c for c in (S.CHROMIUM_PEAK_PROBE_FREE, "chromium_private_peak_mib") if c in ok.columns]
        for col in peak_cols:
            vals = _clean(ok[col])
            name = "chromium_private_peak" if (col == peak_cols[0]) else "chromium_private_peak_raw"
            vmax = float(np.max(vals)) if vals.size else math.nan
            add_median(
                name,
                vals,
                S.BUDGET_CHROMIUM_MIB,
                max=vmax,
                share_within=float((vals <= S.BUDGET_CHROMIUM_MIB).mean()) if vals.size else math.nan,
                source=col,
            )
            add(base, name, "max", vmax, S.BUDGET_CHROMIUM_MIB, None if math.isnan(vmax) else vmax <= S.BUDGET_CHROMIUM_MIB, n=int(vals.size), source=col)
        if {"server_cpu_ms_total", "t_scenario_ms"} <= set(ok.columns):
            util = _clean(ok["server_cpu_ms_total"] / ok["t_scenario_ms"])
            add_median("server_vcpu", util, S.BUDGET_SERVER_VCPU)
        if "server_mem_peak_mib_total" in ok.columns:
            vals = _clean(ok["server_mem_peak_mib_total"])
            vmax = float(np.max(vals)) if vals.size else math.nan
            add_median("server_mem_peak", vals, S.BUDGET_SERVER_MEM_MIB, max=vmax)
        if "zero_replica_bytes" in ok.columns:
            vals = _clean(ok["zero_replica_bytes"])
            vmax = float(np.max(vals)) if vals.size else math.nan
            add(base, "zero_replica_disk", "max", vmax, S.BUDGET_SERVER_DISK_BYTES, None if math.isnan(vmax) else vmax <= S.BUDGET_SERVER_DISK_BYTES)
        # Бюджет §1.2 «40 ГиБ диска» относится ко ВСЕЙ серверной конфигурации
        # (PostgreSQL + реплика zero-cache + журналы), а не к одной реплике.
        # Полная проверка возможна, только если оболочка пишет занятость
        # серверного диска; иначе выше проверяется её наибольшая часть.
        for disk_col in ("server_disk_used_bytes", "server_disk_bytes_total"):
            if disk_col in ok.columns:
                vals = _clean(ok[disk_col])
                vmax = float(np.max(vals)) if vals.size else math.nan
                add(base, "server_disk", "max", vmax, S.BUDGET_SERVER_DISK_BYTES, None if math.isnan(vmax) else vmax <= S.BUDGET_SERVER_DISK_BYTES, source=disk_col)
                break
        if "reference_ok" in g.columns:
            # доля среди прогонов, где проверка эталона состоялась (True/False); прогоны с ошибкой
            # до проверки учитываются бюджетом сценария, а не эталона
            known = g["reference_ok"].map(S.is_bool)
            n_known = int(known.sum())
            n_ref = int(g.loc[known, "reference_ok"].map(S.is_true).sum())
            add(base, "reference_ok_share", "share", n_ref / n_known if n_known else math.nan, 1.0, (n_ref == n_known) if n_known else None, n=n_known, k=n_ref)
    return pd.DataFrame(rows)


def budget_verdicts(bc: pd.DataFrame) -> pd.DataFrame:
    """Итог по конфигурации: все ли ключевые бюджеты выполнены (§7.4).

    Две разные колонки, и их нельзя смешивать: `failed` — бюджеты, где ТОЧЕЧНАЯ оценка вне
    порога; `breached` — где нарушение подтверждено интервалом (вердикт `breach`); `undetermined`
    — где интервал накрывает порог и данные вопрос не решают. Утверждать «бюджет §1.2 нарушен»
    можно только по `breached`.
    """
    key_budgets = {
        "first_ready": "median",
        "nav_all": "median",
        "cmd_drawn": "median",
        "scenario_budget_share": "share",
        "chromium_private_peak": "median",
        "server_vcpu": "median",
        "server_mem_peak": "median",
        "zero_replica_disk": "max",
        "server_disk": "max",
        "reference_ok_share": "share",
    }
    rows: list[dict[str, Any]] = []
    for cfg, g in bc.groupby("config", sort=False):
        oks: dict[str, bool | None] = {}
        verdicts: dict[str, str | None] = {}
        for b, st in key_budgets.items():
            sel = g[(g["budget"] == b) & (g["statistic"] == st)]
            v = None if sel.empty else sel["ok"].iloc[0]
            oks[b] = bool(v) if S.is_bool(v) else None
            vd = None if (sel.empty or "verdict" not in sel.columns) else sel["verdict"].iloc[0]
            verdicts[b] = vd if isinstance(vd, str) else None
        present = [v for v in oks.values() if v is not None]
        rows.append(
            {
                "config": cfg,
                **oks,
                "all_ok": all(present) if present else None,
                "failed": [k for k, v in oks.items() if S.is_false(v)],
                "breached": [k for k, v in verdicts.items() if v == VERDICT_BREACH],
                "undetermined": [k for k, v in verdicts.items() if v == VERDICT_UNDETERMINED],
                "all_within_confident": (
                    all(verdicts[k] == VERDICT_WITHIN for k in verdicts if verdicts[k] is not None)
                    if any(v is not None for v in verdicts.values())
                    else None
                ),
            }
        )
    return pd.DataFrame(rows)


# --------------------------------------------------------- обмен: данные/статика
def traffic_breakdown(df: pd.DataFrame, *, only_ok: bool = True) -> pd.DataFrame:
    """Разложение входящего обмена по конфигурациям: данные, статика сборки, полный объём.

    Отвечает на вопрос «насколько отличается головное число, если считать по данным»: печатает
    медианы всех трёх величин, долю статики в полном объёме и разброс статики внутри конфигурации
    (он обязан быть нулевым — статика это константа сборки; ненулевой разброс сам по себе дефект).
    """
    if "bytes_in_data" not in df.columns:
        return pd.DataFrame()
    keys = config_key_columns(df)
    src = ok_runs(df) if only_ok else df
    rows: list[dict[str, Any]] = []
    for kv, g in src.groupby(keys, dropna=False, sort=True):
        kv = kv if isinstance(kv, tuple) else (kv,)
        base = dict(zip(keys, kv))
        total, data = _clean(g["bytes_in"]), _clean(g["bytes_in_data"])
        static = _clean(g["bytes_in_static"]) if "bytes_in_static" in g.columns else np.array([])
        rows.append(
            {
                **base,
                "config": config_label(base),
                "n": int(len(g)),
                "bytes_in_median": float(np.median(total)) if total.size else math.nan,
                "bytes_in_data_median": float(np.median(data)) if data.size else math.nan,
                "bytes_in_static_median": float(np.median(static)) if static.size else math.nan,
                "static_spread": float(np.max(static) - np.min(static)) if static.size else math.nan,
                "static_share": float(np.median(static) / np.median(total)) if (static.size and total.size and np.median(total)) else math.nan,
            }
        )
    return pd.DataFrame(rows)


def traffic_decomposition_check(df: pd.DataFrame, *, only_ok: bool = True) -> pd.DataFrame:
    """Полнота разложения обмена: `api + zero + static + other` против итога, по каждому прогону.

    Головная величина обмена — `bytes_in_data = bytes_in_api + bytes_in_zero`. Она осмысленна
    ровно настолько, насколько разложение ПОЛНОЕ: если часть байтов не отнесена ни к одному
    маршруту, «данные» окажутся недосчитанными на неизвестную величину. Поэтому проверяются две
    вещи сразу, и обе — поПРОГОННО, а не по медианам:

    * сумма четырёх слагаемых равна `bytes_in` (и `bytes_out`) с точностью до байта;
    * собственный контрольный остаток оболочки `bytes_*_route_residual` равен нулю.

    Возвращает по одной строке на конфигурацию: максимальные абсолютные расхождения (в байтах),
    медиану «прочего» и итоговую отметку. `ok` = True только если ВСЕ прогоны конфигурации сошлись.
    """
    if "bytes_in" not in df.columns:
        return pd.DataFrame()
    parts_in = [c for c in S.TRAFFIC_IN_ALL_PARTS if c in df.columns]
    parts_out = [c for c in S.TRAFFIC_OUT_ALL_PARTS if c in df.columns]
    if not parts_in:
        return pd.DataFrame()
    keys = config_key_columns(df)
    src = ok_runs(df) if only_ok else df
    rows: list[dict[str, Any]] = []

    def num(g: pd.DataFrame, col: str) -> pd.Series:
        return pd.to_numeric(g[col], errors="coerce") if col in g.columns else pd.Series(np.nan, index=g.index)

    for kv, g in src.groupby(keys, dropna=False, sort=True):
        kv = kv if isinstance(kv, tuple) else (kv,)
        base = dict(zip(keys, kv))
        sum_in = sum(num(g, c).fillna(0.0) for c in parts_in)
        gap_in = (sum_in - num(g, "bytes_in")).abs()
        sum_out = sum(num(g, c).fillna(0.0) for c in parts_out) if parts_out else None
        gap_out = (sum_out - num(g, "bytes_out")).abs() if sum_out is not None and "bytes_out" in g.columns else None
        res_in = num(g, S.TRAFFIC_RESIDUAL_IN).abs()
        res_out = num(g, S.TRAFFIC_RESIDUAL_OUT).abs()
        other_in = num(g, "bytes_in_other")
        other_out = num(g, "bytes_out_other")
        max_gap_in = float(gap_in.max()) if gap_in.notna().any() else math.nan
        max_gap_out = float(gap_out.max()) if gap_out is not None and gap_out.notna().any() else math.nan
        max_res_in = float(res_in.max()) if res_in.notna().any() else math.nan
        max_res_out = float(res_out.max()) if res_out.notna().any() else math.nan
        checks = [v for v in (max_gap_in, max_gap_out, max_res_in, max_res_out) if not math.isnan(v)]
        rows.append(
            {
                **base,
                "config": config_label(base),
                "n": int(len(g)),
                "max_gap_in": max_gap_in,
                "max_gap_out": max_gap_out,
                "max_residual_in": max_res_in,
                "max_residual_out": max_res_out,
                "other_in_median": float(np.median(_clean(other_in))) if other_in.notna().any() else math.nan,
                "other_out_median": float(np.median(_clean(other_out))) if other_out.notna().any() else math.nan,
                "ok": (max(checks) == 0.0) if checks else None,
            }
        )
    return pd.DataFrame(rows)


def probe_parity_check(df: pd.DataFrame, *, only_ok: bool = True) -> pd.DataFrame:
    """Паритет политики измерительных проб и цена исключения их окон из пиков памяти.

    Число окон проб (`probe_window_count`) обязано совпадать у ВСЕХ конфигураций серии: иначе
    адаптеры измерены разным инструментом и пики памяти между ними несравнимы. Длительность окон
    (`probe_window_ms`) у адаптеров различается законно — это измеренное свойство адаптера
    (точный скан хранилища у Z/F дороже), а не нарушение паритета. Рядом печатается, на сколько
    сырой пик Chromium выше пика без окон проб, и какая доля выборок исключена.
    """
    if "probe_window_count" not in df.columns and S.CHROMIUM_PEAK_PROBE_FREE not in df.columns:
        return pd.DataFrame()
    keys = config_key_columns(df)
    src = ok_runs(df) if only_ok else df
    rows: list[dict[str, Any]] = []
    for kv, g in src.groupby(keys, dropna=False, sort=True):
        kv = kv if isinstance(kv, tuple) else (kv,)
        base = dict(zip(keys, kv))
        raw = _clean(g[S.CHROMIUM_PEAK_RAW]) if S.CHROMIUM_PEAK_RAW in g.columns else np.array([])
        legacy = _clean(g["chromium_private_peak_mib"]) if "chromium_private_peak_mib" in g.columns else np.array([])
        free = _clean(g[S.CHROMIUM_PEAK_PROBE_FREE]) if S.CHROMIUM_PEAK_PROBE_FREE in g.columns else np.array([])
        wc = _clean(g["probe_window_count"]) if "probe_window_count" in g.columns else np.array([])
        wm = _clean(g["probe_window_ms"]) if "probe_window_ms" in g.columns else np.array([])
        ticks = _clean(g["chromium_probe_ticks"]) if "chromium_probe_ticks" in g.columns else np.array([])
        samples = _clean(g["chromium_samples"]) if "chromium_samples" in g.columns else np.array([])
        cov = _clean(g["js_heap_sampler_coverage"]) if "js_heap_sampler_coverage" in g.columns else np.array([])
        rows.append(
            {
                **base,
                "config": config_label(base),
                "n": int(len(g)),
                "probe_windows": float(np.median(wc)) if wc.size else math.nan,
                "probe_windows_spread": float(wc.max() - wc.min()) if wc.size else math.nan,
                "probe_window_ms_median": float(np.median(wm)) if wm.size else math.nan,
                "peak_raw": float(np.median(raw)) if raw.size else math.nan,
                "peak_free": float(np.median(free)) if free.size else math.nan,
                "peak_drop": (float(np.median(raw)) - float(np.median(free))) if (raw.size and free.size) else math.nan,
                "raw_equals_legacy": bool(raw.size and legacy.size and raw.size == legacy.size and np.allclose(raw, legacy)),
                "ticks_share": (float(np.median(ticks)) / float(np.median(samples))) if (ticks.size and samples.size and np.median(samples)) else math.nan,
                "heap_coverage": float(np.median(cov)) if cov.size else math.nan,
            }
        )
    return pd.DataFrame(rows)


def traffic_ratio_comparison(df: pd.DataFrame, *, seed: int = 0, n_boot: int = DEFAULT_N_BOOT) -> pd.DataFrame:
    """P/F обмена, посчитанное по данным и по полному объёму — рядом, с пометкой «изменилось».

    Именно эта таблица показывает, какие опубликованные головные числа двигает вычитание статики
    (`docs/DEVIATIONS.md` §3.1): у `doc5x100` Z полное P/F = 1.31, а по данным 2.30.
    """
    if "bytes_in_data" not in df.columns:
        return pd.DataFrame()
    out: list[dict[str, Any]] = []
    data = within_adapter_deltas_paired(df, "bytes_in_data", seed=seed, n_boot=n_boot)
    total = within_adapter_deltas_paired(df, "bytes_in", seed=seed, n_boot=n_boot)
    if data.empty or total.empty:
        return pd.DataFrame()
    join = ["adapter", "cache", "variant"]
    m = total.merge(data, on=join, suffixes=("_total", "_data"), how="inner")
    for _, r in m.iterrows():
        rt, rd = float(r["ratio_total"]), float(r["ratio_data"])
        changed = bool(np.isfinite(rt) and np.isfinite(rd) and abs(rd - rt) >= 0.005)
        out.append(
            {
                "adapter": r["adapter"],
                "cache": r["cache"],
                "variant": r["variant"],
                "n_pairs": int(r["n_pairs_data"]),
                "ratio_total": rt,
                "ratio_total_lo": float(r["ratio_lo_total"]),
                "ratio_total_hi": float(r["ratio_hi_total"]),
                "ratio_data": rd,
                "ratio_data_lo": float(r["ratio_lo_data"]),
                "ratio_data_hi": float(r["ratio_hi_data"]),
                "delta_data": float(r["delta_data"]),
                "static_bytes": float(median(df.loc[df["adapter"] == r["adapter"], "bytes_in_static"])) if "bytes_in_static" in df.columns else math.nan,
                "changed": changed,
                "shift": (rd - rt) if (np.isfinite(rt) and np.isfinite(rd)) else math.nan,
            }
        )
    return pd.DataFrame(out)


# ------------------------------------------------------------------- выбросы
#: Во сколько раз значение должно превышать межквартильный размах над медианой конфигурации,
#: чтобы считаться выбросом. 3·IQR — классическая граница «far out» Тьюки: она не ловит обычный
#: разброс и ловит фоновые всплески вроде `main-0020-QF1` (серверный CPU 2 960 мс при медиане 560).
OUTLIER_IQR_FACTOR = 3.0
#: Метрики, по которым выбросы ищутся и публикуются: те, что попадают в головные таблицы и в p95.
OUTLIER_METRICS = ["server_cpu_ms_total", "t_first_ready_ms", "t_cmd_drawn_ms", "t_scenario_ms", "chromium_private_peak_mib"]


def outlier_report(
    df: pd.DataFrame,
    metrics: Sequence[str] = tuple(OUTLIER_METRICS),
    *,
    factor: float = OUTLIER_IQR_FACTOR,
    only_ok: bool = True,
) -> pd.DataFrame:
    """Прогоны‑выбросы и их влияние: медиана и p95 конфигурации С НИМИ и БЕЗ них.

    Выбросы НЕ отбрасываются ни в одной таблице отчёта — это правило §1.7 («ошибочные и
    прерванные прогоны не подменяются») распространённое на аномальные, но успешные прогоны.
    Смысл таблицы обратный: показать, что именно изменилось бы, если бы их отбросили, чтобы
    читатель видел вклад одного прогона (у `main-0020-QF1` фоновая работа PostgreSQL смещает p95
    серверного CPU, но не медиану).
    """
    keys = config_key_columns(df)
    src = ok_runs(df) if only_ok else df
    rows: list[dict[str, Any]] = []
    for m in metrics:
        if m not in src.columns:
            continue
        for kv, g in src.groupby(keys, dropna=False, sort=True):
            kv = kv if isinstance(kv, tuple) else (kv,)
            base = dict(zip(keys, kv))
            v = pd.to_numeric(g[m], errors="coerce")
            vals = _clean(v)
            if vals.size < 4:
                continue
            q1, q3 = np.percentile(vals, [25, 75])
            iqr = q3 - q1
            if iqr <= 0:
                continue
            hi_lim, lo_lim = q3 + factor * iqr, q1 - factor * iqr
            mask = (v > hi_lim) | (v < lo_lim)
            if not bool(mask.any()):
                continue
            kept = _clean(v[~mask])
            for run_id, value in zip(g.loc[mask, "run_id"] if "run_id" in g.columns else g.index[mask], v[mask]):
                rows.append(
                    {
                        **base,
                        "config": config_label(base),
                        "metric": m,
                        "run_id": run_id,
                        "value": float(value),
                        "n": int(vals.size),
                        "median_all": float(np.median(vals)),
                        "median_without": float(np.median(kept)) if kept.size else math.nan,
                        "p95_all": p95(vals),
                        "p95_without": p95(kept) if kept.size else math.nan,
                        "limit_hi": float(hi_lim),
                    }
                )
    return pd.DataFrame(rows)


def retained_window_check(df: pd.DataFrame, *, only_ok: bool = True) -> pd.DataFrame:
    """Сравнение удерживаемых записей с объявленным окном кеша (§7.5).

    P: retained_pages_max ≤ cache + 1 (активная + окно) и retained_pages_end ≤ cache + 1;
    при наличии doc_shapes_per_page — retained_shapes_max ≤ (cache+1)·shapes_per_page.
    F: ожидается удержание всех страниц (retained_pages_end == doc_pages, если известно).

    Конец прогона берётся из `retained_*_end_exact`, если оболочка их пишет: это результат точного
    скана хранилища в одной и той же точке у всех адаптеров, то есть сравнимая величина (§3.2
    `packages/bench/README.md`). `retained_*_max` остаётся максимумом по ДЕШЁВЫМ шаговым пробам —
    собственному значению адаптера, — поэтому вывод об окне кеша делается по точному концу, а
    шаговый максимум приводится рядом как диагностика. Использованный источник — колонка
    `retained_end_source` (`exact` / `end`).
    """
    keys = config_key_columns(df)
    src = ok_runs(df) if only_ok else df
    rows: list[dict[str, Any]] = []
    for kv, g in src.groupby(keys, dropna=False, sort=True):
        kv = kv if isinstance(kv, tuple) else (kv,)
        base = dict(zip(keys, kv))
        mode = base.get("mode")
        cache = base.get("cache")
        cache = None if cache is None or (isinstance(cache, float) and math.isnan(cache)) or pd.isna(cache) else int(cache)

        def _end(kind: str) -> tuple[np.ndarray, str]:
            """Конец прогона: точный скан, если он есть в серии, иначе колонка `_end`."""
            exact = f"retained_{kind}_end_exact"
            if exact in g.columns:
                v = _clean(g[exact])
                if v.size:
                    return v, "exact"
            plain = f"retained_{kind}_end"
            return (_clean(g[plain]) if plain in g.columns else np.array([])), "end"

        pmax = _clean(g["retained_pages_max"]) if "retained_pages_max" in g else np.array([])
        pend, end_source = _end("pages")
        send, _ = _end("shapes")
        smax = _clean(g["retained_shapes_max"]) if "retained_shapes_max" in g else np.array([])
        doc_pages = median(g["doc_pages"]) if "doc_pages" in g.columns else math.nan
        spp = median(g["doc_shapes_per_page"]) if "doc_shapes_per_page" in g.columns else math.nan
        row: dict[str, Any] = {
            **base,
            "config": config_label(base),
            "n": int(len(g)),
            "declared_window_pages": (cache + 1) if (mode == "P" and cache is not None) else (doc_pages if not math.isnan(doc_pages) else math.nan),
            "retained_pages_max_max": float(np.max(pmax)) if pmax.size else math.nan,
            "retained_pages_end_median": float(np.median(pend)) if pend.size else math.nan,
            "retained_shapes_end_median": float(np.median(send)) if send.size else math.nan,
            "retained_end_source": end_source,
            "retained_pages_max_median": float(np.median(pmax)) if pmax.size else math.nan,
            "retained_shapes_max_median": float(np.median(smax)) if smax.size else math.nan,
            "retained_shapes_max_max": float(np.max(smax)) if smax.size else math.nan,
            "declared_window_shapes": ((cache + 1) * spp) if (mode == "P" and cache is not None and not math.isnan(spp)) else math.nan,
        }
        if mode == "P" and cache is not None and pmax.size:
            limit = cache + 1
            within = (pmax <= limit) & (pend <= limit if pend.size == pmax.size else True)
            row["share_within_window"] = float(np.mean(within))
            ok = bool(np.all(within))
            if not math.isnan(row["declared_window_shapes"]):
                if smax.size:
                    ok = ok and bool(np.all(smax <= row["declared_window_shapes"]))
                if send.size:  # точный конец — сравнимая между адаптерами величина
                    ok = ok and bool(np.all(send <= row["declared_window_shapes"]))
            row["ok"] = ok
        elif mode == "F" and pend.size:
            if not math.isnan(doc_pages):
                row["share_within_window"] = float(np.mean(pend == doc_pages))
                row["ok"] = bool(np.all(pend == doc_pages))
            else:
                row["share_within_window"] = math.nan
                row["ok"] = None
        else:
            row["share_within_window"] = math.nan
            row["ok"] = None
        rows.append(row)
    return pd.DataFrame(rows)


def cross_check_bytes(df: pd.DataFrame, *, tolerance: float = 0.10, tolerance_out: float = 0.50) -> pd.DataFrame:
    """Перекрёстная проверка объёма обмена: шейпер против CDP (HTTP **и** WebSocket).

    Шейпер считает байты TCP‑полезной нагрузки всех соединений клиента. CDP даёт
    их двумя счётчиками: `cdp_bytes_in` — `encodedDataLength` HTTP‑ответов,
    `cdp_ws_bytes_in` — кадры WebSocket. У H/Q второй равен нулю, у Z по
    WebSocket идёт почти весь обмен, поэтому сравнение только с `cdp_bytes_in`
    даёт ложный провал (в `results/smoke` это были Z/F 92.5 % и Z/P 76.6 %).
    Сравнивается СУММА обоих счётчиков.

    Направления неравноценны и оцениваются по‑разному:

    * **входящее** — величины сопоставимы по построению (обе считают полученные
      байты), допуск `tolerance`; именно эта отметка и стоит в колонке `ok`,
      потому что «объём обмена» §1.2 — это входящий трафик;
    * **исходящее** — `cdp_bytes_out` не измеряется, а ОЦЕНИВАЕТСЯ по
      `Network.requestWillBeSent` (стартовая строка + заголовки, известные CDP,
      + тело) и систематически занижено на заголовки, которые добавляет сетевой
      стек браузера, и на рукопожатие WebSocket. Поэтому исходящее направление
      сверяется справочно, с отдельным допуском `tolerance_out` и отдельной
      отметкой `ok_out`; в итоговый вердикт конфигурации оно не входит.
    """
    keys = config_key_columns(df)
    rows: list[dict[str, Any]] = []
    if "bytes_in" not in df.columns or "cdp_bytes_in" not in df.columns:
        return pd.DataFrame(rows)
    missing = [c for c in (*CDP_IN_PARTS, *CDP_OUT_PARTS) if c not in df.columns]

    def total(g: pd.DataFrame, parts: Sequence[str]) -> float:
        present = [c for c in parts if c in g.columns]
        if not present:
            return math.nan
        # Сумма по прогону, затем медиана по прогонам: так медиана суммы не
        # подменяется суммой медиан (они расходятся при несимметричных выбросах).
        per_run = sum(pd.to_numeric(g[c], errors="coerce").fillna(0.0) for c in present)
        return median(per_run)

    for kv, g in ok_runs(df).groupby(keys, dropna=False, sort=True):
        kv = kv if isinstance(kv, tuple) else (kv,)
        base = dict(zip(keys, kv))
        shaper_in, shaper_out = median(g["bytes_in"]), median(g["bytes_out"]) if "bytes_out" in g.columns else math.nan
        http_in = median(g["cdp_bytes_in"])
        ws_in = median(g["cdp_ws_bytes_in"]) if "cdp_ws_bytes_in" in g.columns else math.nan
        cdp_in = total(g, CDP_IN_PARTS)
        cdp_out = total(g, CDP_OUT_PARTS)
        rel = abs(shaper_in - cdp_in) / shaper_in if shaper_in and not math.isnan(cdp_in) else math.nan
        rel_out = abs(shaper_out - cdp_out) / shaper_out if shaper_out and not math.isnan(cdp_out) else math.nan
        rows.append(
            {
                **base,
                "config": config_label(base),
                "bytes_in_median": shaper_in,
                "cdp_http_in_median": http_in,
                "cdp_ws_in_median": ws_in,
                "cdp_in_total_median": cdp_in,
                "rel_diff": rel,
                "ok": None if math.isnan(rel) else rel <= tolerance,
                "bytes_out_median": shaper_out,
                "cdp_out_total_median": cdp_out,
                "rel_diff_out": rel_out,
                "ok_out": None if math.isnan(rel_out) else rel_out <= tolerance_out,
                "missing_columns": ", ".join(missing),
            }
        )
    return pd.DataFrame(rows)
