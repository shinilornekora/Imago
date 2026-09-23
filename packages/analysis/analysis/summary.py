"""Числовая опора итогового отчёта: `docs/results/SUMMARY.md`.

Одна таблица на показатель, строки — «серия × конфигурация»; затем изменение
внутри адаптера (P−F, P/F, парно по блокам повторений), сопоставление величины
этого изменения между адаптерами (§1.8), вердикты бюджетов §1.2 с интервалами
Уилсона и проверка «удержано против объявленного окна». Без пояснительного
текста сверх того, что нужно, чтобы число нельзя было прочитать двояко.

CLI:

    python -m analysis.summary --series main=../../results/main,... \\
        --out ../../docs/results/SUMMARY.md
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import pandas as pd

from . import cross as C
from . import report as R
from . import schema as S
from . import stats as ST

#: Подписи для колонок, которых нет в `schema.METRICS` (разложение сервера по группам).
EXTRA_LABELS: dict[str, tuple[str, str]] = {
    "server_api_mem_integral_mib_s": ("Сервер: интеграл памяти API", "МиБ·с"),
    "server_pg_mem_integral_mib_s": ("Сервер: интеграл памяти PostgreSQL", "МиБ·с"),
    "server_zero_mem_integral_mib_s": ("Сервер: интеграл памяти zero‑cache", "МиБ·с"),
    "server_api_mem_peak_mib": ("Сервер: пик RSS API", "МиБ"),
    "server_pg_mem_peak_mib": ("Сервер: пик RSS PostgreSQL", "МиБ"),
    "server_zero_mem_peak_mib": ("Сервер: пик RSS zero‑cache", "МиБ"),
    "server_disk_used_bytes": ("Сервер: занято на диске (PostgreSQL + реплика)", "байт"),
}

#: Порядок показателей в §2. Каждая строка — (колонка, группа).
METRIC_GROUPS: list[tuple[str, list[str]]] = [
    (
        "Время",
        [
            "t_first_ready_ms",
            "t_nav_new_median_ms",
            "t_nav_return_median_ms",
            "t_cmd_server_ms",
            "t_cmd_synced_ms",
            "t_cmd_ack_ms",
            "t_cmd_opget_ms",
            "t_cmd_drawn_ms",
            "t_scenario_ms",
        ],
    ),
    ("Обмен", ["bytes_in_data", "bytes_in", "bytes_in_static", "bytes_out_data", "bytes_out"]),
    (
        "Память клиента",
        [S.CHROMIUM_PEAK_PROBE_FREE, "chromium_private_peak_mib", "js_heap_peak_mb", "js_heap_post_gc_mb", "client_storage_bytes"],
    ),
    (
        "Удерживаемое состояние",
        ["retained_pages_end_exact", "retained_shapes_end_exact", "retained_pages_max", "retained_shapes_max", "loaded_pages_end"],
    ),
    (
        "Маршрут и повторные чтения",
        [
            "t_nav_median_ms",
            "nav_cache_misses",
            "nav_cache_hits",
            "page_loads_observed",
            "api_page_reads",
            "api_page_reads_distinct",
            "api_page_read_bytes",
        ],
    ),
    (
        "Сервер",
        [
            "server_api_cpu_ms",
            "server_pg_cpu_ms",
            "server_zero_cpu_ms",
            "server_cpu_ms_total",
            "server_api_mem_integral_mib_s",
            "server_pg_mem_integral_mib_s",
            "server_zero_mem_integral_mib_s",
            "server_mem_integral_mib_s_total",
            "server_mem_peak_mib_total",
            "zero_replica_bytes",
            "server_disk_used_bytes",
        ],
    ),
]

#: Показатели, для которых печатаются P−F / P÷F и сопоставление между адаптерами.
DELTA_METRICS: list[str] = [
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
    "retained_shapes_end_exact",
    "server_cpu_ms_total",
    "server_mem_integral_mib_s_total",
    "nav_cache_misses",
    "api_page_reads",
    "api_page_read_bytes",
]


def label(m: str) -> tuple[str, str]:
    if m in EXTRA_LABELS:
        return EXTRA_LABELS[m]
    return R.metric_label(m)


def digits(m: str) -> int:
    _, unit = label(m)
    return 1 if unit in ("МиБ", "МБ") else 0


def _variant_tag(r) -> str:
    """Хвост `[вариант]` в подписи строки, если серия измеряла варианты команды."""
    v = r.get("variant") if hasattr(r, "get") else None
    if v is None or (isinstance(v, float) and pd.isna(v)) or not str(v).strip():
        return ""
    return f" [{str(v).strip()}]"


def _sig(lo: float, hi: float, null: float) -> str:
    if pd.isna(lo) or pd.isna(hi):
        return ""
    return "" if lo <= null <= hi else " *"


# ------------------------------------------------------------------ §1 состав
def section_series(series: dict[str, C.Series]) -> str:
    rows = []
    for name, s in series.items():
        n_ok = int((s.df["outcome"] == "ok").sum()) if "outcome" in s.df else len(s.df)
        ref = int(s.df["reference_ok"].map(S.is_true).sum()) if "reference_ok" in s.df else 0
        rows.append(
            (
                f"`{name}`",
                s.doc or "—",
                f"{R.fmt(s.doc_pages)}×{R.fmt(s.doc_shapes)}",
                R.fmt(s.total_shapes),
                "«" + ", ".join(str(x) for x in s.route) + "»" if s.route else "—",
                f"{R.fmt(s.n_new)} / {R.fmt(s.n_return)}",
                R.fmt(s.n_visited),
                ", ".join(str(c) for c in s.caches) or "—",
                f"{R.fmt(s.rtt_ms)} / {R.fmt(s.bandwidth)}",
                f"{len(s.df)}",
                f"{n_ok}",
                f"{ref}",
                f"{R.fmt(s.repetitions)}{R.n_mark(s.repetitions)}",
                (s.harness.get("harness_id") or "—")[:12],
            )
        )
    return R.md_table(
        [
            "Серия",
            "Документ",
            "Страниц×фигур",
            "Фигур всего",
            "Маршрут",
            "Новые / возвраты",
            "Разных страниц",
            "cache (P)",
            "RTT, мс / полоса, Мбит/с",
            "Прогонов",
            "`outcome=ok`",
            "`reference_ok`",
            "Повторений",
            "Оболочка (harness)",
        ],
        rows,
    ) + C._harness_warning(series) + (
        "\n`‡` — повторений меньше 30, которых требует §1.8; `†` — меньше 8, то есть перцентильный интервал "
        "ненадёжен (раздел «статистические границы» в `FINDINGS.md`).\n"
    )


# ------------------------------------------------------------- §2 показатели
def section_metrics(series: dict[str, C.Series], *, seed: int, n_boot: int) -> str:
    parts: list[str] = []
    summaries: dict[str, pd.DataFrame] = {}
    all_metrics = [m for _, g in METRIC_GROUPS for m in g]
    for name, s in series.items():
        cols = [m for m in all_metrics if m in s.df.columns]
        summaries[name] = ST.summarize_configs(s.df, cols, seed=seed, n_boot=n_boot)
    for group, metrics in METRIC_GROUPS:
        parts.append(f"### 2.{[g for g, _ in METRIC_GROUPS].index(group) + 1} {group}\n")
        for m in metrics:
            d = digits(m)
            lab, unit = label(m)
            rows = []
            for name, s in series.items():
                sub = summaries[name]
                sub = sub[sub["metric"] == m]
                for _, r in sub.iterrows():
                    if pd.isna(r["n"]) or int(r["n"]) == 0:
                        continue
                    mark = "" if int(r["n"]) >= 8 else " †"
                    rows.append(
                        (
                            f"`{name}`",
                            r["config"],
                            R.fmt(r["n"]),
                            R.fmt(r["median"], d),
                            (R.fmt_ci(r["ci_lo"], r["ci_hi"], d) + mark) if not pd.isna(r["ci_lo"]) else "—",
                            R.fmt(r["p95"], d),
                            (R.fmt_ci(r["p95_lo"], r["p95_hi"], d) + mark) if not pd.isna(r["p95_lo"]) else "—",
                            R.fmt(r["min"], d),
                            R.fmt(r["max"], d),
                        )
                    )
            if not rows:
                continue
            parts.append(
                f"**{lab}{', ' + unit if unit else ''}** (`{m}`)\n\n"
                + R.md_table(["Серия", "Конфигурация", "n", "Медиана", "95 % ИД медианы", "p95", "95 % ИД p95", "min", "max"], rows)
            )
    return "\n".join(parts)


# ------------------------------------------------- §3 изменение внутри адаптера
def section_within(series: dict[str, C.Series], *, seed: int, n_boot: int) -> str:
    parts: list[str] = []
    for m in DELTA_METRICS:
        d = digits(m)
        lab, unit = label(m)
        rows = []
        for name, s in series.items():
            if m not in s.df.columns or not {"F", "P"} <= set(s.df["mode"].dropna()):
                continue
            paired = ST.within_adapter_deltas_paired(s.df, m, seed=seed, n_boot=n_boot)
            unpaired = ST.within_adapter_deltas(s.df, m, seed=seed, n_boot=n_boot)
            for _, r in paired.iterrows():
                u = unpaired[(unpaired["adapter"] == r["adapter"]) & (unpaired["cache"].astype("Float64") == r["cache"])]
                if "variant" in unpaired.columns and not u.empty:
                    u = u[u["variant"].astype("object") == r.get("variant")]
                u = None if u.empty else u.iloc[0]
                cache = "" if pd.isna(r["cache"]) else f" cache={int(r['cache'])}"
                rows.append(
                    (
                        f"`{name}`",
                        f"{r['adapter']}{cache}{_variant_tag(r)}",
                        f"{R.fmt(r['n_pairs'])}{R.n_mark(r['n_pairs'])}",
                        R.fmt(r["n_dropped"]),
                        R.fmt(r["median_F"], d),
                        R.fmt(r["median_P"], d),
                        R.fmt(r["delta"], d) + " " + R.fmt_ci(r["delta_lo"], r["delta_hi"], d) + _sig(r["delta_lo"], r["delta_hi"], 0.0),
                        R.fmt(r["ratio"], 2) + " " + R.fmt_ci(r["ratio_lo"], r["ratio_hi"], 2) + _sig(r["ratio_lo"], r["ratio_hi"], 1.0),
                        "—" if u is None else R.fmt(u["delta"], d) + " " + R.fmt_ci(u["delta_lo"], u["delta_hi"], d),
                        "—" if u is None else R.fmt(u["ratio"], 2) + " " + R.fmt_ci(u["ratio_lo"], u["ratio_hi"], 2),
                        R.sign_cell(r),
                    )
                )
        if not rows:
            continue
        parts.append(
            f"**{lab}{', ' + unit if unit else ''}** (`{m}`)\n\n"
            + R.md_table(
                [
                    "Серия",
                    "Адаптер",
                    "Пар (блоков)",
                    "Отброшено",
                    "Медиана F",
                    "Медиана P",
                    "med(P − F) [95 %], парно",
                    "med(P / F) [95 %], парно",
                    "P − F [95 %], непарно",
                    "P / F [95 %], непарно",
                    "Знаковый критерий",
                ],
                rows,
            )
        )
    return "\n".join(parts)


# -------------------------------------- §4 сопоставление изменения между адаптерами
def section_between(series: dict[str, C.Series], *, seed: int, n_boot: int) -> str:
    parts: list[str] = []
    for m in DELTA_METRICS:
        d = digits(m)
        lab, unit = label(m)
        rows = []
        for name, s in series.items():
            if m not in s.df.columns or not {"F", "P"} <= set(s.df["mode"].dropna()):
                continue
            t = ST.between_adapter_comparison_paired(s.df, m, seed=seed, n_boot=n_boot)
            for _, r in t.iterrows():
                cache = "" if pd.isna(r["cache"]) else f" cache={int(r['cache'])}"
                rows.append(
                    (
                        f"`{name}`",
                        f"{r['adapter_a']} vs {r['adapter_b']}{cache}{_variant_tag(r)}",
                        f"{R.fmt(r['n_blocks'])}{R.n_mark(r['n_blocks'])}",
                        R.fmt(r["delta_a"], d),
                        R.fmt(r["delta_b"], d),
                        R.fmt(r["delta_diff"], d)
                        + " "
                        + R.fmt_ci(r["delta_diff_lo"], r["delta_diff_hi"], d)
                        + _sig(r["delta_diff_lo"], r["delta_diff_hi"], 0.0),
                        R.fmt(r["ratio_of_ratios"], 2)
                        + " "
                        + R.fmt_ci(r["ratio_of_ratios_lo"], r["ratio_of_ratios_hi"], 2)
                        + _sig(r["ratio_of_ratios_lo"], r["ratio_of_ratios_hi"], 1.0),
                        R.sign_cell(r),
                    )
                )
        if not rows:
            continue
        parts.append(
            f"**{lab}{', ' + unit if unit else ''}** (`{m}`)\n\n"
            + R.md_table(
                ["Серия", "Пара адаптеров", "Блоков", "Δ_A = P−F (A)", "Δ_B = P−F (B)", "med(Δ_A − Δ_B) [95 %]", "med((P/F)_A / (P/F)_B) [95 %]", "Знаковый критерий"],
                rows,
            )
        )
    return "\n".join(parts)


# ------------------------------------------------------------------ §5 бюджеты
def section_budgets(series: dict[str, C.Series], *, seed: int = 42, n_boot: int = ST.DEFAULT_N_BOOT) -> str:
    rows = []
    for name, s in series.items():
        bc = ST.budget_checks(s.df, seed=seed, n_boot=n_boot)
        v = ST.budget_verdicts(bc)
        for _, r in v.iterrows():
            cfg = r["config"]

            def val(budget: str, statistic: str, dg: int = 0) -> str:
                b = C._budget_value(bc, cfg, budget, statistic)
                if b is None or pd.isna(b["value"]):
                    return "—"
                return R._budget_cell(b)

            share = C._budget_value(bc, cfg, "scenario_budget_share", "share")
            if share is None or pd.isna(share["value"]):
                share_txt, conf_txt = "—", "—"
            else:
                share_txt = R._budget_cell(share)
                budget_s = float(share.get("scenario_budget_ms", S.BUDGET_SCENARIO_MS)) / 1000.0
                conf_txt = (
                    f"порог {budget_s:.0f} с; n={int(share.get('n'))}, k={int(share.get('k'))}; "
                    f"нижняя граница ≥ 95 % — {R.fmt_ok(share.get('confident'))}"
                )
            ref = C._budget_value(bc, cfg, "reference_ok_share", "share")
            rows.append(
                (
                    f"`{name}`",
                    cfg,
                    R.fmt_ok(r["all_ok"]),
                    ", ".join(R.BUDGET_LABELS.get(x, x) for x in (r["failed"] or [])) or "—",
                    ", ".join(R.BUDGET_LABELS.get(x, x) for x in (r.get("breached") or [])) or "—",
                    val("first_ready", "median"),
                    val("nav_all", "median"),
                    val("nav_new", "median"),
                    val("nav_return", "median"),
                    val("nav_max", "max"),
                    val("cmd_drawn", "median"),
                    share_txt,
                    conf_txt,
                    val("chromium_private_peak", "median", 1),
                    val("chromium_private_peak", "max", 1),
                    val("server_vcpu", "median", 2),
                    val("server_mem_peak", "median", 1),
                    val("server_disk", "max"),
                    "—" if ref is None or pd.isna(ref["value"]) else f"{R.fmt_pct(ref['value'])} {R.fmt_ok(ref['ok'])}",
                )
            )
    return R.md_table(
        [
            "Серия",
            "Конфигурация",
            "Все бюджеты (точечно)",
            "Точечно вне бюджета",
            "**Нарушение подтверждено интервалом**",
            "Первая готовность ≤ 2 000 мс",
            "Переход (все) ≤ 1 000 мс",
            "Переход новые",
            "Переход возвраты",
            "Худший переход (справочно)",
            "Команда до холста ≤ 2 000 мс",
            "Сценарий в бюджете серии, доля [Уилсон 95 %]",
            "Объём и надёжность доли",
            "Chromium медиана ≤ 768 МиБ",
            "Chromium максимум",
            "Сервер ≤ 4 vCPU",
            "Сервер ≤ 8 192 МиБ",
            "Диск ≤ 40 ГиБ",
            "Эталон 100 %",
        ],
        rows,
    )


# --------------------------------------------------- §6 удержание против окна
def section_retained(series: dict[str, C.Series]) -> str:
    rows = []
    for name, s in series.items():
        rt = ST.retained_window_check(s.df)
        for _, r in rt.iterrows():
            rows.append(
                (
                    f"`{name}`",
                    r["config"],
                    R.fmt(r.get("n")),
                    R.fmt(r.get("declared_window_pages")),
                    R.fmt(r.get("declared_window_shapes")),
                    R.fmt(r.get("retained_pages_end_median")),
                    R.fmt(r.get("retained_shapes_end_median")),
                    R.fmt(r.get("retained_pages_max_max")),
                    R.fmt(r.get("retained_shapes_max_max")),
                    R.fmt_pct(r.get("share_within_window")),
                    R.fmt_ok(r.get("ok")),
                )
            )
    return R.md_table(
        [
            "Серия",
            "Конфигурация",
            "n",
            "Объявлено страниц",
            "Объявлено фигур",
            "Конец, страниц (точный скан, медиана)",
            "Конец, фигур (точный скан, медиана)",
            "`retained_pages_max`, максимум",
            "`retained_shapes_max`, максимум",
            "Доля прогонов в окне",
            "Соответствие",
        ],
        rows,
    )


# -------------------------------------------- §7 моменты команды и сверка обмена
def section_command(series: dict[str, C.Series], *, seed: int, n_boot: int) -> str:
    rows = []
    for name, s in series.items():
        ct = ST.command_timing_table(s.df, seed=seed, n_boot=n_boot)
        for _, r in ct.iterrows():
            rows.append(
                (
                    f"`{name}`",
                    r["config"],
                    R.fmt(r.get("t_cmd_ack_ms_n")),
                    f"{R.fmt(r.get('t_cmd_ack_ms_median'), 1)} {R.fmt_ci(r.get('t_cmd_ack_ms_ci_lo'), r.get('t_cmd_ack_ms_ci_hi'), 1)}",
                    f"{R.fmt(r.get('t_cmd_drawn_ms_median'), 1)} {R.fmt_ci(r.get('t_cmd_drawn_ms_ci_lo'), r.get('t_cmd_drawn_ms_ci_hi'), 1)}",
                    f"{R.fmt(r.get('drawn_minus_ack_median'), 1)} {R.fmt_ci(r.get('drawn_minus_ack_lo'), r.get('drawn_minus_ack_hi'), 1)}",
                    R.fmt_pct(r.get("share_drawn_before_ack")),
                    R.fmt_pct(r.get("share_equal")),
                )
            )
    t1 = R.md_table(
        [
            "Серия",
            "Конфигурация",
            "n",
            "`t_cmd_ack`, медиана [95 %]",
            "`t_cmd_drawn`, медиана [95 %]",
            "drawn − ack, медиана [95 %] (внутри прогона)",
            "Доля drawn < ack",
            "Доля drawn = ack (±0.5 мс)",
        ],
        rows,
    )
    rows2 = []
    for name, s in series.items():
        bx = ST.cross_check_bytes(s.df)
        for _, r in bx.iterrows():
            rows2.append(
                (
                    f"`{name}`",
                    r["config"],
                    R.fmt(r.get("bytes_in_median")),
                    R.fmt(r.get("cdp_http_in_median")),
                    R.fmt(r.get("cdp_ws_in_median")),
                    R.fmt(r.get("cdp_in_total_median")),
                    R.fmt_pct(r.get("rel_diff")),
                    R.fmt_ok(r.get("ok")),
                    R.fmt(r.get("bytes_out_median")),
                    R.fmt(r.get("cdp_out_total_median")),
                    R.fmt_pct(r.get("rel_diff_out")),
                    R.fmt_ok(r.get("ok_out")),
                )
            )
    t2 = R.md_table(
        [
            "Серия",
            "Конфигурация",
            "bytes_in (шейпер)",
            "CDP HTTP",
            "CDP WebSocket",
            "CDP сумма",
            "Расхождение",
            "≤ 10 %",
            "bytes_out (шейпер)",
            "CDP сумма (оценка)",
            "Расхождение",
            "≤ 50 %",
        ],
        rows2,
    )
    return (
        "### 7.1 Моменты команды\n\n"
        + t1
        + "\n### 7.2 Перекрёстная проверка обмена (шейпер против CDP)\n\n"
        + t2
    )


# ------------------------------------------------------------------ сборка
HEAD = """# SUMMARY — числовые результаты измерений

{inventory}

**Как читать числа.**

* Медиана и p95 — по прогонам `outcome=ok`; доли — по **всем** начатым прогонам (ошибка и таймаут = неуспех).
* p95 — перцентиль по линейной интерполяции порядковых статистик (`numpy.percentile`, тип 7); при n = 10 и n = 30
  он не превышает максимум выборки и смещён вниз относительно истинного 95‑го перцентиля.
* Интервалы медианы и p95 — перцентильный бутстреп, 2 000 ресемплов, одна матрица ресемплов на обе статистики;
  `†` — интервал по n < 8 наблюдениям, ненадёжен.
* Доли — интервал Уилсона 95 % без поправки на непрерывность.
* `*` у Δ означает, что 95 % интервал не накрывает 0; `*` у отношения — что интервал не накрывает 1.
* Порядок §1.8: сначала изменение метрики **внутри** адаптера (§3, парно по блокам повторений), затем
  сопоставление величины этого изменения **между** адаптерами (§4, на общих блоках).
* `server_*_total` — бюджет конфигурации: слагаемое zero‑cache входит только в прогонах Z
  (`server_zero_applicable=true`); в прогонах H/Q `server_zero_*` — измеренный фон компонента, к их бюджету
  не прибавляемый.
* Единицы: `_ms` — миллисекунды, `_mib` — 2²⁰ байт, `_mb` — 10⁶ байт, трафик — байты.
* **Бюджет сценария у каждой серии свой** и объявлен в её паспорте (`scenario.budgets.scenarioMs`): 30 000 мс
  для маршрута §7.2 (11 действий), **40 000** у `route-repeat` (19 действий) и **70 000** у `route-full`
  (50 действий). Одни только объявленные паузы §1.2 («между действиями выдерживается одна секунда») дают
  у этих маршрутов 18 и 49 с, поэтому общий порог 30 с был бы для них не бюджетом, а арифметической
  невозможностью. В §5 столбец «Сценарий в бюджете серии» проверяет каждую серию против её порога, а сам
  порог напечатан там же.
* `command-shape` измеряет **четыре разные команды** на одних и тех же конфигурациях; вариант входит в подпись
  конфигурации в квадратных скобках (`Z/F [large-share]`) и никогда не усредняется с другими вариантами.

**Ограничения среды, без которых числа читать нельзя** (`docs/DEVIATIONS.md`): клиент и сервер на одной ВМ
2 vCPU/8 ГиБ (1.3); собственный TCP‑шейпер вместо `tc/netem`, цена рукопожатия эмулируется и зависит от числа
соединений адаптера (1.4); сжатия в измеряемом пути нет (6.8); `t_cmd_ack` у Z включает дополнительный
`GET /api/operations/:opId` (2.2), а оптимистичная часть мутатора Zero отключена (2.5).
"""


def _inventory_head(series: dict[str, "C.Series"]) -> str:
    """Шапка: сколько серий и прогонов реально прочитано, и все ли они годны.

    Считается ПО ДАННЫМ, а не по памяти о программе: если серию добавили, убрали или пересняли,
    заголовок обязан измениться сам, иначе он превратится в описание прошлой программы.
    """
    n_series = len(series)
    total = sum(int(len(s.df)) for s in series.values())
    ok = sum(int((s.df["outcome"] == "ok").sum()) for s in series.values() if "outcome" in s.df.columns)
    ref = sum(
        int(s.df["reference_ok"].map(S.is_true).sum()) for s in series.values() if "reference_ok" in s.df.columns
    )
    per = ", ".join(f"`{n}` {len(s.df)}" for n, s in series.items())
    sigs = [S.harness_comparable_signature(s.passport) for s in series.values()]
    if sigs and all(v is not None for v in sigs):
        vals = {tuple(sorted(v[0].items())) for v in sigs}
        bench = dict(next(iter(vals))).get("benchId", "")[:16]
        ident = (
            f"Все серии сняты одной измерительной оболочкой (`passport.harness.benchId` = `{bench}`), и все поля "
            "`harness.comparableBy` у них совпадают, поэтому абсолютные величины между сериями сопоставимы; "
            "`harnessId` при этом у серий разный — он включает ещё и конфигурацию серии."
            if len(vals) == 1
            else "**Серии различаются по объявленному критерию сопоставимости `harness.comparableBy`** — "
            "абсолютные величины между ними несопоставимы, сравнивать можно только изменения внутри серии."
        )
    else:
        ident = (
            "Критерий сопоставимости (`passport.harness.comparableBy`) записан не у всех серий, поэтому "
            "сравнимость абсолютных величин между ними **не проверена**."
        )
    health = (
        f"Все {total} прогонов — `outcome=ok` и `reference_ok=true`."
        if (ok == total and ref == total)
        else f"Из {total} прогонов `outcome=ok` — {ok}, `reference_ok=true` — {ref}; расхождение разбирается в отчётах серий."
    )
    return (
        f"Числовая опора итогового отчёта: **{n_series} серий, {total} прогонов** ({per}). "
        f"{health} Источник — `results/<серия>/runs.csv` и `results/<серия>/runs/<run_id>.json`; "
        "построено пакетом `packages/analysis` (`python -m analysis.summary`). "
        + ident
    )


def build_summary(
    specs: Sequence[str],
    out: str | Path,
    *,
    seed: int = 42,
    n_boot: int = 2000,
) -> dict[str, Any]:
    series = C.load_series(specs)
    out = Path(out)
    parts = [
        HEAD.format(inventory=_inventory_head(series)),
        "\n## 1. Серии\n",
        section_series(series),
        "\n## 2. Показатели по сериям и конфигурациям\n",
        section_metrics(series, seed=seed, n_boot=n_boot),
        "\n## 3. Изменение внутри адаптера: P − F и P ÷ F\n",
        "Парная оценка — медиана поблочных разностей и отношений (блок = `repetition`: в одном повторении по одному "
        "прогону каждой конфигурации, порядок перемешан, перед каждым прогоном сброс документа и новый процесс "
        "Chromium). Непарная — разность и отношение медиан при независимом ресемплинге; печатается рядом, потому что "
        "расхождение между ними и есть мера чувствительности вывода к дрейфу машины.\n",
        section_within(series, seed=seed, n_boot=n_boot),
        "\n## 4. Сопоставление изменения между адаптерами (§1.8)\n",
        "Для каждого блока считаются d_A = P_A − F_A и d_B = P_B − F_B и сравниваются на одних и тех же блоках.\n",
        section_between(series, seed=seed, n_boot=n_boot),
        "\n## 5. Бюджеты §1.2\n",
        "Первая готовность ≤ 2 с, переход ≤ 1 с, команда до актуального холста ≤ 2 с (медианы); сценарий в пределах "
        "**бюджета своей серии** (объявлен в паспорте `scenario.budgets.scenarioMs` и зависит от числа действий "
        "маршрута: 30 с у маршрута §7.2 из 11 действий, больше у длинных маршрутов, потому что объявленные паузы "
        "§1.2 сами по себе занимают по секунде на действие; фактический порог каждой серии напечатан "
        "в столбце «Объём и надёжность доли») не менее чем в 95 % начатых прогонов; Chromium ≤ 768 МиБ; сервер ≤ 4 vCPU, ≤ 8 ГиБ, ≤ 40 ГиБ диска; "
        "эталон сошёлся во всех проверенных прогонах. «Сервер ≤ 4 vCPU» на машине с 2 vCPU означает загрузку не "
        "более 2 фактически доступных ядер (`docs/DEVIATIONS.md` 1.3).\n",
        section_budgets(series, seed=seed, n_boot=n_boot),
        "\n## 6. Удерживаемые записи против объявленного окна\n",
        "В P допустимо не более `cache + 1` страниц (активная + окно); в F ожидается удержание всех страниц "
        "документа. Вывод делается по точному скану хранилища в конце прогона (`retained_*_end_exact`) — это одна и "
        "та же проба в одной и той же точке у всех адаптеров.\n",
        section_retained(series),
        "\n## 7. Моменты команды и перекрёстная проверка обмена\n",
        section_command(series, seed=seed, n_boot=n_boot),
    ]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(parts), encoding="utf-8")
    return {"out": out, "series": list(series)}


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="analysis.summary", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--series", required=True, help="список `имя=каталог` через запятую")
    p.add_argument("--out", required=True)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--n-boot", type=int, default=2000)
    a = p.parse_args(argv)
    res = build_summary([s.strip() for s in a.series.split(",") if s.strip()], a.out, seed=a.seed, n_boot=a.n_boot)
    print(f"summary: {res['out']}; series: {', '.join(res['series'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
