"""CLI отчёта: `python -m analysis.report --series results/main --out docs/RESULTS_main.md --figs docs/figs/main`.

Дополнительно: `--compare results/cache3,results/route-repeat` — таблицы и графики
сравнения серий (окна кеша, размеры документа, RTT); `--seed`, `--n-boot`.
Отчёт — Markdown с русскими заголовками; графики — PNG (matplotlib).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

import pandas as pd

from . import figures as F
from . import schema as S
from . import stats as ST


# ------------------------------------------------------------- formatting
def fmt(v: Any, digits: int = 0) -> str:
    if v is None:
        return "—"
    if isinstance(v, (bool,)):
        return "да" if v else "нет"
    if isinstance(v, str):
        return v
    try:
        if pd.isna(v):
            return "—"
    except (TypeError, ValueError):
        pass
    if isinstance(v, (int,)) or (isinstance(v, float) and digits == 0 and abs(v) < 1e15 and float(v).is_integer()):
        return f"{int(round(v)):,}".replace(",", " ")
    if isinstance(v, float):
        if digits == 0:
            return f"{v:,.0f}".replace(",", " ")
        return f"{v:,.{digits}f}".replace(",", " ")
    return str(v)


def fmt_pct(v: Any) -> str:
    try:
        if v is None or pd.isna(v):
            return "—"
    except (TypeError, ValueError):
        pass
    return f"{100 * float(v):.1f} %"


def fmt_ok(v: Any) -> str:
    if not S.is_bool(v):
        return "н/д"
    return "✓" if bool(v) else "✗"


def fmt_ci(lo: Any, hi: Any, digits: int = 0) -> str:
    return f"[{fmt(lo, digits)}; {fmt(hi, digits)}]"


def md_cell(v: Any) -> str:
    """Значение как ячейка Markdown‑таблицы: вертикальная черта экранируется.

    Нужно потому, что в таблицы попадают значения ИЗ ДАННЫХ, а не только наши подписи: в паспорте
    серии лежит, например, регулярное выражение `(^|/)postgres .*16/main`, и неэкранированная `|`
    разрывает строку на лишние столбцы — таблица рендерится со сдвигом, и читатель видит не то
    значение, которое стоит в паспорте. Переводы строк схлопываются по той же причине.
    """
    s = str(v)
    return s.replace("|", "\\|").replace("\n", " ")


def md_table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> str:
    if not rows:
        return "_нет данных_\n"
    out = ["| " + " | ".join(md_cell(h) for h in headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(md_cell(c) for c in r) + " |")
    return "\n".join(out) + "\n"


def metric_digits(metric: str) -> int:
    spec = S.METRIC_BY_COLUMN.get(metric)
    if spec and spec.unit in ("МиБ", "МБ"):
        return 1
    return 0


# ------------------------------------------------------------- sections
def section_passport(passport: dict[str, Any] | None, series_name: str) -> str:
    if not passport:
        return f"Паспорт серии `{series_name}` (`passport.json`) не найден.\n"
    h = S.harness_identity(passport)
    note = ""
    if not h.get("harness_id"):
        note = (
            "> **Версия измерительной оболочки в паспорте не записана** (`harness` / `code.benchId`): `code.codeId` "
            "покрывает собранные клиент и сервер, но не `packages/bench` и не конфигурацию серии. Пока это так, "
            "сравнивать абсолютные величины этой серии с другими можно только с оговоркой — сравнимы отношения "
            "внутри адаптера.\n\n"
        )
    rows = []
    for k, v in passport.items():
        if isinstance(v, (dict, list)):
            v = json.dumps(v, ensure_ascii=False)
        rows.append((f"`{k}`", str(v)[:200]))
    return note + md_table(["Параметр", "Значение"], rows)


def section_composition(df: pd.DataFrame, succ: pd.DataFrame) -> str:
    rows = []
    ref_failed_total = 0
    for _, r in succ.iterrows():
        ref_failed = int(r.get("n_ok_reference_failed", 0) or 0)
        ref_failed_total += ref_failed
        rows.append(
            (
                r["config"],
                fmt(r["n"]),
                fmt(r["n_ok"]),
                fmt(r["n_error"]),
                fmt(r["n_timeout"]),
                fmt(r["n_reference_ok"]),
                fmt(ref_failed),
                fmt(r["n_success"]),
                f"{fmt_pct(r['success_share'])} {fmt_ci(fmt_pct(r['success_lo']), fmt_pct(r['success_hi']))}",
            )
        )
    t = md_table(
        ["Конфигурация", "Прогонов", "ok", "error", "timeout", "эталон ✓", "ok, но эталон ✗", "успех", "Доля успеха [Уилсон 95 %]"],
        rows,
    )
    note = (
        "Доли считаются по **всем** начатым прогонам конфигурации (ошибка и таймаут = неуспех); сводки времени и ресурсов "
        "ниже — только по прогонам `outcome=ok`.\n\n"
    )
    if ref_failed_total:
        note += (
            f"> **Внимание:** {ref_failed_total} прогон(ов) завершились `outcome=ok`, но не сошлись с эталоном. "
            "Они остаются в сводках метрик (прогон состоялся и измерен), но §1.8 требует допуска по эталону до сравнения — "
            "такие прогоны нужно разобрать до публикации выводов.\n\n"
        )
    return note + t


CI_NOTE = (
    "Для каждого показателя приводятся n, медиана с 95 % перцентильным бутстреп‑интервалом, p95 (линейная интерполяция "
    f"порядковых статистик) с таким же интервалом, min и max. Знак † — интервал построен по n < {ST.MIN_N_FOR_CI} наблюдениям "
    "и ненадёжен; «—» вместо интервала — n < 2, интервал не определён.\n\n"
)


def _ci(r: pd.Series, lo: str, hi: str, d: int) -> str:
    """Интервал с пометкой ненадёжности при малом n."""
    if pd.isna(r.get(lo)) or pd.isna(r.get(hi)):
        return "—"
    mark = "" if bool(r.get("ci_reliable", True)) else " †"
    return fmt_ci(r[lo], r[hi], d) + mark


def metric_label(m: str) -> tuple[str, str]:
    """Подпись и единица метрики: из схемы, иначе из списка необязательных, иначе имя колонки."""
    spec = S.METRIC_BY_COLUMN.get(m)
    if spec is not None:
        return (spec.label_ru, spec.unit)
    if m in ST.OPTIONAL_METRICS:
        return ST.OPTIONAL_METRICS[m]
    return (f"`{m}`", "")


def section_metric_tables(summary: pd.DataFrame, metrics: Sequence[str], *, require_spec: bool = True) -> str:
    parts = []
    for m in metrics:
        if require_spec and S.METRIC_BY_COLUMN.get(m) is None:
            continue
        label, unit = metric_label(m)
        sub = summary[summary["metric"] == m]
        if sub.empty or sub["n"].sum() == 0:
            continue
        d = metric_digits(m)
        rows = []
        for _, r in sub.iterrows():
            rows.append(
                (
                    r["config"],
                    fmt(r["n"]),
                    fmt(r["median"], d),
                    _ci(r, "ci_lo", "ci_hi", d),
                    fmt(r["p95"], d),
                    _ci(r, "p95_lo", "p95_hi", d),
                    fmt(r["min"], d),
                    fmt(r["max"], d),
                )
            )
        parts.append(
            f"**{label}{', ' + unit if unit else ''}**\n\n"
            + md_table(["Конфигурация", "n", "Медиана", "95 % ИД медианы", "p95", "95 % ИД p95", "min", "max"], rows)
        )
    return "\n".join(parts)


BUDGET_LABELS = {
    "first_ready": "Первая готовность, медиана ≤ 2 000 мс",
    "nav_all": "Переход (все 10), медиана ≤ 1 000 мс",
    "nav_new": "Переход на новую страницу, медиана ≤ 1 000 мс",
    "nav_return": "Возврат, медиана ≤ 1 000 мс",
    "cmd_drawn": "Команда до холста, медиана ≤ 2 000 мс",
    "scenario_budget_share": "Сценарий в бюджете серии, доля ≥ 95 %",
    "chromium_private_peak": "Chromium, частная память ≤ 768 МиБ",
    "chromium_private_peak_raw": "Chromium, сырой пик (с окнами пробы) ≤ 768 МиБ",
    "nav_max": "Худший одиночный переход (не бюджет §1.2: он задан медианой)",
    "server_vcpu": "Сервер, CPU ≤ 4 vCPU (медиана загрузки)",
    "server_mem_peak": "Сервер, память ≤ 8 ГиБ",
    "zero_replica_disk": "Диск реплики ≤ 40 ГиБ",
    "server_disk": "Диск сервера ≤ 40 ГиБ",
    "reference_ok_share": "Эталон совпал во всех прогонах",
}


BUDGET_MATRIX = [
    # (budget, statistic, короткий заголовок)
    ("first_ready", "median", "Первая готовность, мс (≤ 2 000)"),
    ("nav_all", "median", "Переход, мс (≤ 1 000)"),
    ("cmd_drawn", "median", "Команда до холста, мс (≤ 2 000)"),
    ("scenario_budget_share", "share", "Сценарий в бюджете серии (≥ 95 %)"),
    ("nav_max", "max", "Худший переход, мс (справочно)"),
    ("chromium_private_peak", "median", "Chromium, МиБ, медиана (≤ 768)"),
    ("chromium_private_peak", "max", "Chromium, МиБ, максимум"),
    ("server_vcpu", "median", "Сервер, vCPU (≤ 4)"),
    ("server_mem_peak", "median", "Сервер, МиБ (≤ 8 192)"),
    ("zero_replica_disk", "max", "Реплика, байт (≤ 40 ГиБ)"),
    ("server_disk", "max", "Диск сервера, байт (≤ 40 ГиБ)"),
    ("reference_ok_share", "share", "Эталон (100 %)"),
]


#: Как читать отметку бюджета. `✓`/`✗` — ТОЧЕЧНАЯ оценка; знак вердикта — что говорит интервал.
VERDICT_MARK = {ST.VERDICT_WITHIN: "", ST.VERDICT_BREACH: "!", ST.VERDICT_UNDETERMINED: "≈"}


def _budget_cell(r: pd.Series | None) -> str:
    """Ячейка бюджета: значение, интервал, отметка точечной оценки и вердикт по интервалу.

    `≈` означает «интервал накрывает порог»: точечная оценка вне бюджета ещё не нарушение
    (`rtt150` Z/F — 2 007 мс при пороге 2 000 с интервалом [1 962; 2 058] и тремя прогонами из
    десяти внутри бюджета), а точечная оценка внутри — ещё не подтверждённое выполнение.
    `!` ставится там, где интервал порог ИСКЛЮЧАЕТ, то есть нарушение подтверждено.
    """
    if r is None:
        return "—"
    val = r["value"]
    digits = 0
    if r["statistic"] == "share":
        v = fmt_pct(val)
        if "ci_lo" in r and not pd.isna(r.get("ci_lo")):
            v += f" [{fmt_pct(r['ci_lo'])}; {fmt_pct(r['ci_hi'])}]"
    elif r["budget"] == "server_vcpu":
        digits = 2
        v = fmt(val, digits)
    else:
        digits = 1 if str(r["budget"]).startswith(("chromium_private_peak", "server_mem_peak")) else 0
        v = fmt(val, digits)
    if r["statistic"] == "median" and not pd.isna(r.get("ci_lo")) and not pd.isna(r.get("ci_hi")):
        v += f" {fmt_ci(r['ci_lo'], r['ci_hi'], digits)}"
    n = r.get("n")
    n_txt = f" (n={int(n)})" if n is not None and not pd.isna(n) else ""
    if r["budget"] == "nav_max":
        over, total = r.get("runs_over"), r.get("runs_total")
        extra = ""
        if over is not None and not pd.isna(over) and int(over) > 0:
            extra = f", прогонов с переходом > 1 000 мс: {int(over)} из {int(total)}"
        return f"{v}{n_txt}{extra}"
    mark = VERDICT_MARK.get(r.get("verdict"), "")
    return f"{v}{n_txt} {fmt_ok(r['ok'])}{mark}"


def scenario_budget_note(budget_ms: float) -> str:
    """Как называть бюджет сценария в тексте: «≤ 30 с» или «≤ 70 с (бюджет серии)»."""
    s_ = budget_ms / 1000.0
    txt = f"{s_:.0f} с" if float(s_).is_integer() else f"{s_:.1f} с"
    if abs(budget_ms - S.BUDGET_SCENARIO_MS) < 1e-9:
        return f"≤ {txt}"
    return f"≤ {txt} (бюджет серии, объявлен в паспорте; §1.2 задаёт 30 с для маршрута §7.2 из 11 действий)"


def section_budgets(bc: pd.DataFrame, verdicts: pd.DataFrame, *, scenario_budget_ms: float = float(S.BUDGET_SCENARIO_MS)) -> str:
    """Матрица «конфигурация × бюджет» (значение и отметка) и итог по конфигурациям."""
    budget_txt = scenario_budget_note(scenario_budget_ms)
    headers = [h if b != "scenario_budget_share" else f"Сценарий {budget_txt.split(' (')[0]} (≥ 95 %)" for b, _, h in BUDGET_MATRIX]
    rows = []
    for cfg, g in bc.groupby("config", sort=False):
        row = [cfg]
        for b, st, _ in BUDGET_MATRIX:
            sel = g[(g["budget"] == b) & (g["statistic"] == st)]
            row.append(_budget_cell(None if sel.empty else sel.iloc[0]))
        rows.append(row)
    t1 = md_table(["Конфигурация", *headers], rows)
    rows2 = []
    for _, r in verdicts.iterrows():
        failed = ", ".join(BUDGET_LABELS.get(b, b) for b in r["failed"]) or "—"
        breached = ", ".join(BUDGET_LABELS.get(b, b) for b in (r.get("breached") or [])) or "—"
        undet = ", ".join(BUDGET_LABELS.get(b, b) for b in (r.get("undetermined") or [])) or "—"
        rows2.append((r["config"], fmt_ok(r["all_ok"]), failed, breached, undet))
    t2 = md_table(
        [
            "Конфигурация",
            "Все бюджеты выполнены (точечно)",
            "Точечная оценка вне бюджета",
            "**Нарушение подтверждено интервалом**",
            "Интервал накрывает порог (не решено)",
        ],
        rows2,
    )
    note = (
        "Бюджеты §1.2: первая готовность ≤ 2 с, переход ≤ 1 с, команда до **актуального холста** ≤ 2 с (всё — медианы); "
        f"сценарий с объявленными паузами {budget_txt} не менее чем в 95 % **начатых** прогонов (с интервалом Уилсона); "
        "пиковая суммарная частная память выделенного Chromium ≤ 768 МиБ; серверная конфигурация целиком "
        "(API + PostgreSQL + zero‑cache) ≤ 4 vCPU, ≤ 8 ГиБ памяти, ≤ 40 ГиБ диска.\n\n"
        f"Как считается: времена — медианы по прогонам `outcome=ok`; доля сценариев {budget_txt.split(' (')[0]} — по всем прогонам "
        "(ошибка/таймаут = не уложился), в скобках интервал Уилсона 95 %; Chromium — медиана и максимум пика; "
        "сервер — медиана загрузки (сумма CPU‑мс групп api+pg+zero / мс сценария) и медиана пика суммарной памяти; "
        "диск — максимум по прогонам; эталон — доля прогонов с `reference_ok=true` среди проверенных.\n\n"
        "Объём выборки и интервалы для каждой медианы этой матрицы — в разделе 3 (там же p95 и его интервал); "
        "n для медиан равен числу прогонов `ok` из раздела 2, n для долей — числу начатых прогонов. "
        "\n\n**Как читать отметки.** `✓`/`✗` относятся к ТОЧЕЧНОЙ оценке (медиане, доле). Рядом стоит знак вердикта по "
        "интервалу: пусто — интервал целиком по нужную сторону порога (выполнение или нарушение подтверждено), "
        "`≈` — интервал порог накрывает и данные вопрос не решают, `!` — интервал порог исключает, то есть "
        "**нарушение подтверждено**. Утверждать «бюджет §1.2 нарушен» допустимо только при `!`: медиана 2 007 мс "
        "при пороге 2 000 с интервалом [1 962; 2 058] — это «точечная оценка вне бюджета», а не нарушение. "
        "Для доли сценариев интервал — Уилсона, и выполнение подтверждено только при нижней границе не ниже 95 %.\n\n"
        "**К какой серии §1.2 применим.** Глава 1 говорит: «Приёмочные требования проверяются на контрольном "
        "сценарии, а дополнительные нагрузки выявляют границы применимости». Формальный вердикт §1.2 поэтому "
        "относится к приёмочной серии (`main`: документ 50×500, маршрут §7.2, команда на 81 фигуру, RTT 50 мс); "
        "в сериях другого документа, маршрута, команды или канала те же пороги — **ориентир**, и превышение "
        "называется превышением ориентира при нагрузке вне приёмочного сценария, а не нарушением требования.\n\n"
        "Столбец «Худший переход» — справочный: §1.2 задаёт бюджет перехода **медианой**, поэтому отдельный длинный "
        "переход нарушением не считается; но если в конфигурации есть прогоны, где хотя бы один переход вышел за "
        "секунду (`within_budget_nav=false`), их число печатается тут же — умолчание о них противоречило бы §1.7.\n\n"
        "> Оговорки к бюджетам, которые нельзя опускать при чтении отметок: (1) бюджет команды проверяется по "
        "`t_cmd_drawn_ms`, поэтому он зависит от того, как оболочка определяет момент отрисовки — см. раздел о моментах "
        "команды; (2) бюджет диска проверяется по реплике zero‑cache, а полная занятость серверного диска "
        "(PostgreSQL + WAL + реплика + журналы) попадает в отметку `Диск сервера` только если оболочка пишет "
        "соответствующую колонку, иначе там «—»; (3) «сервер ≤ 4 vCPU» на машине с 2 vCPU означает загрузку не более "
        "2 фактически доступных ядер (`docs/DEVIATIONS.md` 1.3).\n\n"
    )
    return note + t1 + "\n**Итог по конфигурациям**\n\n" + t2


def _row_suffix(r: pd.Series) -> str:
    """Хвост подписи строки таблицы дельт: окно кеша и вариант команды, если они есть."""
    out = ""
    c = r.get("cache")
    if c is not None and not pd.isna(c):
        out += f" (cache={int(c)})"
    v = r.get("variant")
    if v is not None and not (isinstance(v, float) and pd.isna(v)) and str(v).strip():
        out += f" [{str(v).strip()}]"
    return out


#: §1.8 требует «не менее 30 повторений». Ячейки с меньшим n помечаются, чтобы объём выборки был
#: виден рядом с каждым числом, а не только в разделе о составе серии.
N_SPEC_MIN = 30


def n_mark(n: Any) -> str:
    """Пометка объёма выборки: `†` — интервал по n < 8 (ненадёжен), `‡` — n < 30 (§1.8 п. 4)."""
    try:
        k = int(n)
    except (TypeError, ValueError):
        return ""
    if k < ST.MIN_N_FOR_CI:
        return "†"
    if k < N_SPEC_MIN:
        return "‡"
    return ""


N_MARK_LEGEND = (
    "Пометки объёма выборки: `†` — n < 8, перцентильный интервал ненадёжен; `‡` — n < 30, то есть меньше, чем "
    "требует §1.8 («первоначально планируется не менее 30 повторений»); объём выборки указан при каждом числе.\n\n"
)


def sign_cell(r: pd.Series) -> str:
    """Знаковый критерий по поблочным разностям: «6/6, p = 0.031» или «—»."""
    n = r.get("sign_n")
    if n is None or pd.isna(n) or int(n) == 0:
        return "—"
    n, pos, neg, p = int(n), int(r.get("sign_pos", 0)), int(r.get("sign_neg", 0)), r.get("sign_p")
    same = max(pos, neg)
    p_txt = "< 0.001" if (p is not None and not pd.isna(p) and p < 0.0005) else f"= {fmt(p, 3)}"
    return f"{same}/{n} {'+' if pos >= neg else '−'}, p {p_txt}"


def section_deltas(df: pd.DataFrame, metrics: Sequence[str], seed: int, n_boot: int) -> tuple[str, dict[str, pd.DataFrame]]:
    parts = []
    tables: dict[str, pd.DataFrame] = {}
    for m in metrics:
        spec = S.METRIC_BY_COLUMN.get(m)
        if spec is None or m not in df.columns:
            continue
        t = ST.within_adapter_deltas(df, m, seed=seed, n_boot=n_boot)
        if t.empty:
            continue
        tables[m] = t
        d = metric_digits(m)
        rows = []
        for _, r in t.iterrows():
            rows.append(
                (
                    f"{r['adapter']}{_row_suffix(r)}",
                    f"{fmt(r['n_F'])}/{fmt(r['n_P'])}",
                    fmt(r["median_F"], d),
                    fmt(r["median_P"], d),
                    f"{fmt(r['delta'], d)} {fmt_ci(r['delta_lo'], r['delta_hi'], d)}",
                    f"{fmt(r['ratio'], 2)} {fmt_ci(r['ratio_lo'], r['ratio_hi'], 2)}",
                )
            )
        parts.append(f"**{spec.label_ru}, {spec.unit}**\n\n" + md_table(["Адаптер", "n (F/P)", "Медиана F", "Медиана P", "P − F [95 %]", "P / F [95 %]"], rows))
    return "\n".join(parts), tables


def section_deltas_paired(df: pd.DataFrame, metrics: Sequence[str], seed: int, n_boot: int) -> tuple[str, dict[str, pd.DataFrame]]:
    """P − F и P / F по блокам повторений (парный анализ §1.8)."""
    parts = []
    tables: dict[str, pd.DataFrame] = {}
    for m in metrics:
        spec = S.METRIC_BY_COLUMN.get(m)
        if spec is None or m not in df.columns:
            continue
        t = ST.within_adapter_deltas_paired(df, m, seed=seed, n_boot=n_boot)
        if t.empty:
            continue
        tables[m] = t
        d = metric_digits(m)
        rows = []
        for _, r in t.iterrows():
            rows.append(
                (
                    f"{r['adapter']}{_row_suffix(r)}",
                    f"{fmt(r['n_pairs'])}{n_mark(r['n_pairs'])}",
                    fmt(r["n_dropped"]),
                    f"{fmt(r['delta'], d)} {fmt_ci(r['delta_lo'], r['delta_hi'], d)}",
                    f"{fmt(r['ratio'], 2)} {fmt_ci(r['ratio_lo'], r['ratio_hi'], 2)}",
                    sign_cell(r),
                )
            )
        parts.append(
            f"**{spec.label_ru}, {spec.unit}**\n\n"
            + md_table(
                ["Адаптер", "Пар (блоков)", "Отброшено прогонов", "med(P − F) [95 %]", "med(P / F) [95 %]", "Знаковый критерий"],
                rows,
            )
        )
    return N_MARK_LEGEND + (
        "Столбец «знаковый критерий» — точный двусторонний критерий знаков по поблочным разностям: он не зависит "
        "ни от формы распределения, ни от величины выбросов, и именно он держит выводы на тонких ячейках "
        "(при 6 парах одного знака p = 0.031 — меньше, чем может дать бутстреп по шести точкам).\n\n"
    ) + "\n".join(parts), tables


def section_between_paired(df: pd.DataFrame, metrics: Sequence[str], seed: int, n_boot: int) -> str:
    parts = []
    for m in metrics:
        spec = S.METRIC_BY_COLUMN.get(m)
        if spec is None or m not in df.columns:
            continue
        t = ST.between_adapter_comparison_paired(df, m, seed=seed, n_boot=n_boot)
        if t.empty:
            continue
        d = metric_digits(m)
        rows = []
        for _, r in t.iterrows():
            rows.append(
                (
                    f"{r['adapter_a']} vs {r['adapter_b']}{_row_suffix(r)}",
                    f"{fmt(r['n_blocks'])}{n_mark(r['n_blocks'])}",
                    fmt(r["delta_a"], d),
                    fmt(r["delta_b"], d),
                    f"{fmt(r['delta_diff'], d)} {fmt_ci(r['delta_diff_lo'], r['delta_diff_hi'], d)}",
                    f"{fmt(r['ratio_of_ratios'], 2)} {fmt_ci(r['ratio_of_ratios_lo'], r['ratio_of_ratios_hi'], 2)}",
                    sign_cell(r),
                )
            )
        parts.append(
            f"**{spec.label_ru}, {spec.unit}**\n\n"
            + md_table(
                ["Пара адаптеров", "Блоков", "med Δ_A", "med Δ_B", "med(Δ_A − Δ_B) [95 %]", "med((P/F)_A / (P/F)_B) [95 %]", "Знаковый критерий"],
                rows,
            )
        )
    return "\n".join(parts)


def section_between(df: pd.DataFrame, metrics: Sequence[str], seed: int, n_boot: int) -> str:
    parts = []
    for m in metrics:
        spec = S.METRIC_BY_COLUMN.get(m)
        if spec is None or m not in df.columns:
            continue
        t = ST.between_adapter_comparison(df, m, seed=seed, n_boot=n_boot)
        if t.empty:
            continue
        d = metric_digits(m)
        rows = []
        for _, r in t.iterrows():
            rows.append(
                (
                    f"{r['adapter_a']} vs {r['adapter_b']}{_row_suffix(r)}",
                    fmt(r["delta_a"], d),
                    fmt(r["delta_b"], d),
                    f"{fmt(r['delta_diff'], d)} {fmt_ci(r['delta_diff_lo'], r['delta_diff_hi'], d)}",
                    f"{fmt(r['ratio_of_ratios'], 2)} {fmt_ci(r['ratio_of_ratios_lo'], r['ratio_of_ratios_hi'], 2)}",
                )
            )
        parts.append(f"**{spec.label_ru}, {spec.unit}**\n\n" + md_table(["Пара адаптеров", "Δ_A = P−F (A)", "Δ_B = P−F (B)", "Δ_A − Δ_B [95 %]", "(P/F)_A / (P/F)_B [95 %]"], rows))
    return "\n".join(parts)


def section_heap_gc(df: pd.DataFrame) -> str:
    """Паритет давления сборщика мусора (§3.2 `packages/bench/README.md`, дефект N2).

    Пики кучи и частной памяти сравнимы между адаптерами, только если расписание принудительных
    сборок одинаково. Число фактических вызовов — `js_heap_gc_count`; `js_heap_post_gc_mb` снимается
    в фиксированной точке «остановка часов сценария» и не зависит от того, когда сборщик решил
    сработать сам.
    """
    if "js_heap_gc_count" not in df.columns:
        return (
            "Колонки `js_heap_gc_count` в серии нет: расписание принудительных сборок мусора не задокументировано, "
            "поэтому сравнивать `js_heap_peak_mb` между адаптерами нельзя без оговорки (дефект N2).\n"
        )
    ok = ST.ok_runs(df)
    keys = ST.config_key_columns(ok)
    rows = []
    counts: list[float] = []
    for kv, g in ok.groupby(keys, dropna=False, sort=True):
        kv = kv if isinstance(kv, tuple) else (kv,)
        base = dict(zip(keys, kv))
        gc = pd.to_numeric(g["js_heap_gc_count"], errors="coerce").dropna()
        if gc.empty:
            continue
        counts.extend(gc.tolist())
        rows.append(
            (
                ST.config_label(base),
                fmt(len(g)),
                fmt(gc.min()) if gc.min() == gc.max() else f"{fmt(gc.min())}…{fmt(gc.max())}",
                fmt(ST.median(g["js_heap_peak_mb"]) if "js_heap_peak_mb" in g else None, 1),
                fmt(ST.median(g["js_heap_post_gc_mb"]) if "js_heap_post_gc_mb" in g else None, 1),
                fmt(ST.median(g["js_heap_suspended_ms"]) if "js_heap_suspended_ms" in g else None),
            )
        )
    t = md_table(
        [
            "Конфигурация",
            "n",
            "`js_heap_gc_count`",
            "`js_heap_peak_mb`, медиана",
            "`js_heap_post_gc_mb`, медиана",
            "`js_heap_suspended_ms`, медиана",
        ],
        rows,
    )
    if counts and min(counts) == max(counts):
        verdict = (
            f"**Расписание принудительных сборок мусора одинаково у всех конфигураций: {fmt(counts[0])} вызовов "
            "`HeapProfiler.collectGarbage` на прогон.** Точки вызова заданы оболочкой и не зависят ни от адаптера, "
            "ни от режима, ни от вида пробы, поэтому `js_heap_peak_mb` и `chromium_private_peak_mib` измерены при "
            "одинаковом давлении сборщика и сравнимы между адаптерами (раньше было ≈13 у H/Q против 2–3 у Z/F — "
            "дефект N2).\n\n"
        )
    elif counts:
        verdict = (
            f"**Расписание сборок РАЗЛИЧАЕТСЯ между конфигурациями ({fmt(min(counts))}…{fmt(max(counts))} вызовов).** "
            "Значит, пики кучи и частной памяти сняты при разном давлении сборщика и между адаптерами несравнимы; "
            "различие нужно объяснить прежде, чем пользоваться числами памяти.\n\n"
        )
    else:
        verdict = ""
    note = (
        "`js_heap_post_gc_mb` — куча сразу после принудительной сборки в фиксированной точке «остановка часов "
        "сценария»: величина, не зависящая от момента самопроизвольной сборки, и потому более устойчивая мера "
        "удерживаемой памяти, чем пик. `js_heap_suspended_ms` — сколько опрос кучи был приостановлен (два точных "
        "скана хранилища и выгрузка снимков); у Z/F больше просто потому, что дороже сам скан.\n\n"
    )
    return verdict + note + t


def section_server_zero(df: pd.DataFrame) -> str:
    """zero-cache во ВСЕХ прогонах: бюджет профиля Z против измеренного фона у H/Q (§1.2, дефект A8)."""
    if "server_zero_cpu_ms" not in df.columns:
        return ""
    has_flag = "server_zero_applicable" in df.columns
    ok = ST.ok_runs(df)
    keys = ST.config_key_columns(ok)
    rows = []
    for kv, g in ok.groupby(keys, dropna=False, sort=True):
        kv = kv if isinstance(kv, tuple) else (kv,)
        base = dict(zip(keys, kv))
        flag = None
        if has_flag:
            vals = [v for v in g["server_zero_applicable"] if S.is_bool(v)]
            flag = bool(vals[0]) if vals and all(bool(v) == bool(vals[0]) for v in vals) else None
        rows.append(
            (
                ST.config_label(base),
                fmt(len(g)),
                fmt(ST.median(g["server_zero_cpu_ms"])),
                fmt(ST.median(g["server_zero_mem_peak_mib"]) if "server_zero_mem_peak_mib" in g else None, 1),
                fmt(ST.median(g["zero_replica_bytes"]) if "zero_replica_bytes" in g else None),
                "бюджет конфигурации" if flag else ("фон (не в бюджете)" if flag is False else "н/д"),
            )
        )
    t = md_table(
        ["Конфигурация", "n", "CPU zero‑cache, мс", "Память zero‑cache, МиБ", "Реплика, байт", "`server_zero_applicable`"],
        rows,
    )
    note = (
        "zero‑cache работает на стенде постоянно и с 2026-09-13 сэмплируется в **каждом** прогоне, а не только в "
        "прогонах Z (§1.2, дефект A8: раньше `server_zero_*` были нулями «по построению», и оценка фона ничем не "
        "проверялась). Поэтому у H/Q здесь не ноль, а измеренная величина — **фон простоя компонента, который нужен "
        "только профилю Z**. Прибавлять его к серверному бюджету H/Q нельзя (они этот компонент не используют), "
        "скрывать тоже нельзя (это измеренная цена того, что стенд держит zero‑cache постоянно): различие несёт "
        "колонка `server_zero_applicable`.\n\n"
        "Суммы `server_cpu_ms_total` / `server_mem_peak_mib_total` выше и бюджеты §7.4 ниже считаются как **бюджет "
        "конфигурации**: слагаемое zero‑cache входит в них только там, где `server_zero_applicable = true`. Пустая "
        "ячейка `server_zero_*` означала бы, что сэмплер не нашёл процесса, то есть измерения не было "
        "(`sampling_incomplete`), — нуля вместо неизмеренной величины не бывает.\n\n"
    )
    if not has_flag:
        note = (
            "Колонки `server_zero_applicable` в серии нет: принадлежность расхода zero‑cache бюджету конфигурации "
            "не задокументирована, и суммы `server_*_total` включают его для всех адаптеров (поведение серий до "
            "2026-09-13, где `server_zero_*` были нулями по построению).\n\n"
        )
    return note + t


def section_retained(rt: pd.DataFrame) -> str:
    rows = []
    for _, r in rt.iterrows():
        rows.append(
            (
                r["config"],
                fmt(r["n"]),
                fmt(r["declared_window_pages"]),
                fmt(r["retained_pages_end_median"]),
                fmt(r.get("retained_shapes_end_median")),
                fmt(r["declared_window_shapes"]),
                fmt(r["retained_pages_max_median"]),
                fmt(r["retained_pages_max_max"]),
                fmt(r["retained_shapes_max_median"]),
                fmt_pct(r["share_within_window"]),
                fmt_ok(r["ok"]),
            )
        )
    sources = {str(v) for v in rt.get("retained_end_source", pd.Series(dtype=object)).dropna().unique()}
    if sources == {"exact"}:
        note = (
            "**Конец прогона — точный скан хранилища** (`retained_pages_end_exact` / `retained_shapes_end_exact`): "
            "один и тот же скан в одной и той же точке у всех адаптеров, поэтому именно он сравним между ними и "
            "именно по нему делается вывод об окне кеша (§3.2 `packages/bench/README.md`).\n\n"
            "Колонки `retained_*_max` — максимум по ДЕШЁВЫМ шаговым пробам, то есть по собственному значению "
            "адаптера (у H/Q — точный размер `Map`/`queryCache`, у Z — кеш, обновляемый асинхронно после "
            "`complete`/вытеснения). Расписание проб одинаково у всех конфигураций "
            "(`retained_probe_mode = cached-steps+exact-after-cmd-and-end`), но сами величины отвечают на другой "
            "вопрос — «что адаптер сам считает удержанным», — и приводятся как диагностика.\n\n"
        )
    else:
        note = (
            "Точного конца прогона (`retained_*_end_exact`) в серии нет — использован `retained_*_end`. "
            "В сериях до 2026-09-13 расписание точных сканов зависело от адаптера "
            "(`retained_probe_mode` = `exact` / `exact-until-step`), поэтому сравнение удержания между адаптерами "
            "требует оговорки (дефект N4).\n\n"
        )
    return note + md_table(
        [
            "Конфигурация",
            "n",
            "Объявленное окно (страниц, вкл. активную)",
            "Конец, страниц (точный скан)",
            "Конец, фигур (точный скан)",
            "Предел фигур",
            "retained_pages_max, медиана",
            "retained_pages_max, максимум",
            "retained_shapes_max, медиана",
            "Доля прогонов в окне",
            "Соответствие",
        ],
        rows,
    )


def section_traffic_decomposition(dc: pd.DataFrame) -> str:
    """Полнота разложения обмена: сумма слагаемых против итога, по каждому прогону."""
    if dc.empty:
        return (
            "_Проверка полноты разложения недоступна: оболочка не пишет `bytes_*_other` и "
            "`bytes_*_route_residual`, поэтому «сумма по маршрутам = итог» по сырым данным не проверяется._\n"
        )
    rows = [
        (
            r["config"],
            f"{fmt(r['n'])}{n_mark(r['n'])}",
            fmt(r["max_gap_in"]),
            fmt(r["max_gap_out"]),
            fmt(r["max_residual_in"]),
            fmt(r["max_residual_out"]),
            fmt(r["other_in_median"]),
            fmt_ok(r["ok"]),
        )
        for _, r in dc.iterrows()
    ]
    bad = [str(r["config"]) for _, r in dc.iterrows() if r["ok"] is False]
    tail = (
        "\nВсе конфигурации сошлись побайтно: «данные + статика + прочее» исчерпывают весь наблюдаемый обмен, "
        "и головная величина `bytes_in_data` ничего не теряет.\n"
        if not bad
        else "\n**Разложение НЕ полное** в конфигурациях: " + ", ".join(bad) + ". Числа «только данные» для них "
        "занижены на неклассифицированный остаток, и читать их как обмен данными нельзя.\n"
    )
    return (
        "Головное число обмена — `bytes_in_data = bytes_in_api + bytes_in_zero`. Оно осмысленно ровно "
        "настолько, насколько разложение полное, поэтому проверка идёт **по каждому прогону**, а не по "
        "медианам: столбцы «расхождение» — максимум по прогонам конфигурации от |(api + zero + статика + "
        "прочее) − итог|, столбцы «остаток» — максимум собственной контрольной колонки оболочки "
        "`bytes_*_route_residual`. Ожидаемое значение всех четырёх — ноль.\n\n"
        + md_table(
            [
                "Конфигурация",
                "n",
                "Расхождение вход, Б",
                "Расхождение исход, Б",
                "Остаток вход, Б",
                "Остаток исход, Б",
                "Прочее (вход), Б",
                "Сошлось",
            ],
            rows,
        )
        + tail
    )


def section_probe_parity(pp: pd.DataFrame) -> str:
    """Паритет политики проб и цена исключения их окон из пика памяти Chromium."""
    if pp.empty:
        return ""
    rows = [
        (
            r["config"],
            f"{fmt(r['n'])}{n_mark(r['n'])}",
            fmt(r["probe_windows"]),
            fmt(r["probe_windows_spread"]),
            fmt(r["probe_window_ms_median"]),
            fmt(r["peak_raw"], 1),
            fmt(r["peak_free"], 1),
            fmt(r["peak_drop"], 1),
            fmt_pct(r["ticks_share"]),
            fmt(r["heap_coverage"], 3),
        )
        for _, r in pp.iterrows()
    ]
    wins = {v for v in pp["probe_windows"].dropna().tolist()}
    spread_bad = [str(r["config"]) for _, r in pp.iterrows() if float(r["probe_windows_spread"] or 0) != 0]
    legacy_ok = bool(pp["raw_equals_legacy"].all()) if "raw_equals_legacy" in pp.columns else False
    parity = (
        f"Число окон проб одинаково во всех конфигурациях серии ({fmt(sorted(wins)[0]) if wins else '—'}) — "
        "политика проб к адаптерам не привязана, и пики памяти между ними сравнимы."
        if len(wins) == 1 and not spread_bad
        else "**Паритет проб нарушен**: число окон различается между конфигурациями ("
        + ", ".join(f"{fmt(v)}" for v in sorted(wins))
        + (", разброс внутри конфигурации у " + ", ".join(spread_bad) if spread_bad else "")
        + "), поэтому адаптеры измерены разным инструментом."
    )
    legacy = (
        " Историческая колонка `chromium_private_peak_mib` во всех прогонах совпадает с "
        "`chromium_private_peak_raw_mib` — сырой пик доступен под обоими именами, и старые таблицы читаются "
        "как «пик с окнами пробы»."
        if legacy_ok
        else " **`chromium_private_peak_mib` ≠ `chromium_private_peak_raw_mib`** — совместимость схемы нарушена, "
        "и сравнивать её значения с прежними сериями нельзя."
    )
    return (
        parity
        + legacy
        + "\n\nДлительность окон у адаптеров различается законно: это измеренное свойство адаптера (точный скан "
        "хранилища у Z/F дороже), а не нарушение паритета. «Доля выборок в окнах» показывает, какая часть "
        "наблюдений исключена из пика без пробы; «покрытие кучи» — доля времени прогона, покрытая опросом "
        "JS‑кучи (сэмплер кучи на время скана приостанавливается, поэтому пик кучи читается только вместе с ним).\n\n"
        + md_table(
            [
                "Конфигурация",
                "n",
                "Окон проб",
                "Разброс окон",
                "В окнах, мс",
                "Пик сырой, МиБ",
                "**Пик без проб, МиБ**",
                "Разница, МиБ",
                "Доля выборок в окнах",
                "Покрытие кучи",
            ],
            rows,
        )
    )


def section_traffic_split(df: pd.DataFrame, tb: pd.DataFrame, tr: pd.DataFrame) -> str:
    """Обмен: данные против полного объёма, и какие головные числа от этого меняются.

    `docs/DEVIATIONS.md` §3.1 требует вычитать статику сборки при чтении разницы обмена: она
    поадаптерная константа, входит в F и в P одинаково и поэтому тянет P/F к единице — тем
    сильнее, чем меньше данных в прогоне. Головная величина — «только данные».
    """
    if tb.empty:
        return (
            "_Разложение обмена недоступно: в `runs.csv` нет колонок `bytes_in_api`/`bytes_in_zero`/`bytes_in_static`, "
            "а в записях прогонов — счётчиков шейпера по маршрутам. Все числа обмена ниже — ПОЛНЫЙ трафик, "
            "включающий поадаптерную статику сборки._\n"
        )
    src = ""
    if S.TRAFFIC_SPLIT_SOURCE_COLUMN in df.columns:
        vals = [v for v in df[S.TRAFFIC_SPLIT_SOURCE_COLUMN].dropna().unique()]
        src = str(vals[0]) if vals else ""
    src_txt = {
        "columns": "колонки оболочки `bytes_in_api` / `bytes_in_zero` / `bytes_in_static`",
        "runs-json": "счётчики шейпера по маршрутам из записей прогонов (`shaper.stats.byRoute`), так как колонок оболочки в этой серии ещё нет",
        "static-only": "вычитание `bytes_in_static` из полного объёма",
    }.get(src, "неизвестен")
    rows = [
        (
            r["config"],
            f"{fmt(r['n'])}{n_mark(r['n'])}",
            fmt(r["bytes_in_data_median"]),
            fmt(r["bytes_in_static_median"]),
            fmt(r["bytes_in_median"]),
            fmt_pct(r["static_share"]),
            fmt(r["static_spread"]),
        )
        for _, r in tb.iterrows()
    ]
    t1 = md_table(
        [
            "Конфигурация",
            "n",
            "**Данные (API + WS), байт**",
            "Статика сборки, байт",
            "Всего, байт",
            "Доля статики",
            "Разброс статики",
        ],
        rows,
    )
    t2 = ""
    if not tr.empty:
        rows2 = []
        for _, r in tr.iterrows():
            suffix = _row_suffix(r)
            rows2.append(
                (
                    f"{r['adapter']}{suffix}",
                    f"{fmt(r['n_pairs'])}{n_mark(r['n_pairs'])}",
                    fmt(r["static_bytes"]),
                    f"{fmt(r['ratio_total'], 3)} {fmt_ci(r['ratio_total_lo'], r['ratio_total_hi'], 3)}",
                    f"**{fmt(r['ratio_data'], 3)}** {fmt_ci(r['ratio_data_lo'], r['ratio_data_hi'], 3)}",
                    ("да, " + fmt(r["shift"], 3) if r["changed"] else "нет"),
                )
            )
        t2 = (
            "\n**P/F обмена: по полному трафику и по данным** (парная оценка, блок = повторение)\n\n"
            + md_table(
                ["Адаптер", "Пар", "Статика, байт", "P/F полный (как публиковалось)", "**P/F данные (головное)**", "Изменилось"],
                rows2,
            )
            + "\nПоследний столбец отвечает на вопрос «какие опубликованные числа двигает вычитание статики»: "
            "величина сдвига = P/F(данные) − P/F(полный).\n"
        )
    return (
        f"Источник разложения: {src_txt}.\n\n"
        "Разброс статики внутри конфигурации обязан быть нулевым — это константа сборки, а не измеряемая "
        "величина; ненулевой разброс означал бы, что в статику попало что‑то ещё, и его надо разбирать.\n\n"
        + t1
        + t2
    )


def section_outliers(ot: pd.DataFrame) -> str:
    """Выбросы: что именно изменилось бы, если бы их отбросили (их не отбрасывают)."""
    if ot.empty:
        return "Прогонов‑выбросов (за границей 3·IQR от квартилей конфигурации) не обнаружено.\n"
    rows = [
        (
            r["config"],
            metric_label(r["metric"])[0],
            r["run_id"],
            fmt(r["value"], metric_digits(r["metric"])),
            f"{fmt(r['n'])}{n_mark(r['n'])}",
            f"{fmt(r['median_all'], metric_digits(r['metric']))} → {fmt(r['median_without'], metric_digits(r['metric']))}",
            f"{fmt(r['p95_all'], metric_digits(r['metric']))} → {fmt(r['p95_without'], metric_digits(r['metric']))}",
        )
        for _, r in ot.iterrows()
    ]
    return (
        "Выброс — прогон за границей `Q3 + 3·IQR` (или `Q1 − 3·IQR`) внутри своей конфигурации. "
        "**Ни один такой прогон не отброшен**: он входит во все таблицы отчёта, в долю успеха и в p95. "
        "Таблица показывает обратное — насколько сдвинулись бы медиана и p95, если бы его отбросили, "
        "чтобы вклад одного прогона был виден явно (§1.7: ошибочные и аномальные прогоны не подменяются).\n\n"
        + md_table(
            ["Конфигурация", "Показатель", "Прогон", "Значение", "n", "Медиана с ним → без него", "p95 с ним → без него"],
            rows,
        )
    )


def section_errors(df: pd.DataFrame) -> str:
    if "outcome" not in df.columns:
        return "_нет данных_\n"
    bad = df[df["outcome"] != "ok"]
    if bad.empty:
        return "Ошибок и прерываний не зафиксировано.\n"
    g = bad.groupby([c for c in ("adapter", "mode", "cache", "outcome", "error_stage") if c in bad.columns], dropna=False).size().reset_index(name="n")
    rows = []
    for _, r in g.iterrows():
        rows.append((ST.config_label(r), r["outcome"], r.get("error_stage") if not pd.isna(r.get("error_stage")) else "—", fmt(r["n"])))
    return md_table(["Конфигурация", "Исход", "Этап", "Прогонов"], rows)


def section_bytes_check(bx: pd.DataFrame, *, tolerance: float = 0.10, tolerance_out: float = 0.50) -> str:
    if bx.empty:
        return "_нет данных_\n"
    rows = [
        (
            r["config"],
            fmt(r["bytes_in_median"]),
            fmt(r["cdp_http_in_median"]),
            fmt(r["cdp_ws_in_median"]),
            fmt(r["cdp_in_total_median"]),
            fmt_pct(r["rel_diff"]),
            fmt_ok(r["ok"]),
        )
        for _, r in bx.iterrows()
    ]
    t = md_table(
        [
            "Конфигурация",
            "bytes_in (шейпер)",
            "CDP: HTTP",
            "CDP: WebSocket",
            "CDP: сумма",
            "Расхождение",
            f"≤ {round(tolerance * 100)} %",
        ],
        rows,
    )
    rows_out = [
        (r["config"], fmt(r["bytes_out_median"]), fmt(r["cdp_out_total_median"]), fmt_pct(r["rel_diff_out"]), fmt_ok(r["ok_out"]))
        for _, r in bx.iterrows()
    ]
    t_out = md_table(
        ["Конфигурация", "bytes_out (шейпер)", "CDP: сумма (оценка)", "Расхождение", f"≤ {round(tolerance_out * 100)} %"], rows_out
    )
    missing = str(bx["missing_columns"].iloc[0]) if "missing_columns" in bx.columns and len(bx) else ""
    note_in = (
        "Шейпер считает байты TCP‑полезной нагрузки всех соединений клиента; CDP даёт их двумя счётчиками — "
        "`cdp_bytes_in` (`encodedDataLength` HTTP‑ответов) и `cdp_ws_bytes_in` (кадры WebSocket). "
        "У H/Q второй счётчик нулевой, у Z по WebSocket идёт почти весь обмен, поэтому сверять нужно **сумму**: "
        "сравнение только с `cdp_bytes_in` давало ложный провал у Z (в прежнем `results/smoke/report.md` — Z/F 92.5 %, Z/P 76.6 %).\n\n"
    )
    note_out = (
        "\n**Исходящее направление — справочно.** `cdp_bytes_out` не измеряется, а оценивается по "
        "`Network.requestWillBeSent` (стартовая строка + известные CDP заголовки + тело) и систематически занижен на "
        "заголовки, которые добавляет сетевой стек браузера, и на рукопожатие WebSocket. Расхождение 20–40 % здесь — "
        "свойство оценки, а не признак ошибки измерения; в вердикт конфигурации это направление не входит.\n\n"
    )
    warn = f"\n> Отсутствуют колонки CDP: `{missing}` — соответствующие слагаемые считаются нулевыми.\n\n" if missing else ""
    return note_in + t + warn + note_out + t_out


def section_command_timing(ct: pd.DataFrame, df: pd.DataFrame, summary_cmd: pd.DataFrame) -> str:
    """Моменты команды: подтверждение сервера и актуальный холст — по отдельности (§1.2, §1.8)."""
    if ct.empty:
        return "_нет данных_\n"
    intro = (
        "§1.8 требует отсчитывать время **до фактического обновления холста**, а подтверждение сервера регистрировать "
        "отдельно. Поэтому `t_cmd_ack` (событие `command-acked`) и `t_cmd_drawn` (`command-drawn`) приводятся как две "
        "независимые величины, а их разность считается **внутри одного прогона** (настоящая пара) и может быть любого "
        "знака: у HTTP‑адаптеров холст обновляется после ответа сервера и перечитывания страницы (разность > 0), "
        "у Z данные приходят синхронизацией и могут опередить подтверждение (разность < 0). Бюджет §1.2 «команда до "
        "актуального холста ≤ 2 с» проверяется по `t_cmd_drawn`.\n\n"
        "> Разность, равная нулю с точностью до 0.1 мс, — не результат, а признак того, что одно событие выпускается из "
        "обработчика другого; доля таких прогонов вынесена в отдельную колонку, её ненулевое значение требует объяснения.\n\n"
    )
    rows = []
    for _, r in ct.iterrows():
        def cell(col: str) -> str:
            if f"{col}_median" not in r or pd.isna(r.get(f"{col}_median")):
                return "—"
            return f"{fmt(r[f'{col}_median'], 1)} {fmt_ci(r.get(f'{col}_ci_lo'), r.get(f'{col}_ci_hi'), 1)} / {fmt(r[f'{col}_p95'], 1)}"

        rows.append(
            (
                r["config"],
                fmt(r.get("t_cmd_ack_ms_n")),
                cell("t_cmd_ack_ms"),
                cell("t_cmd_drawn_ms"),
                f"{fmt(r.get('drawn_minus_ack_median'), 1)} {fmt_ci(r.get('drawn_minus_ack_lo'), r.get('drawn_minus_ack_hi'), 1)}",
                fmt_pct(r.get("share_drawn_before_ack")),
                fmt_pct(r.get("share_equal")),
            )
        )
    t = md_table(
        [
            "Конфигурация",
            "n",
            "`t_cmd_ack`: медиана [95 %] / p95, мс",
            "`t_cmd_drawn`: медиана [95 %] / p95, мс",
            "drawn − ack: медиана [95 %], мс",
            "Доля прогонов drawn < ack",
            "Доля drawn = ack (±0.5 мс)",
        ],
        rows,
    )
    extra_cols = [c for c in ("t_cmd_server_ms", "t_cmd_synced_ms", "t_cmd_opget_ms") if c in df.columns]
    if extra_cols:
        extra = (
            "\n**Разложение времени команды у Z** (колонки пишутся оболочкой, если доступны): `t_cmd_server_ms` — момент "
            "разрешения серверной части мутатора (`.server`), `t_cmd_synced_ms` — момент, когда клиент увидел "
            "синхронизированную ревизию, `t_cmd_opget_ms` — стоимость дополнительного `GET /api/operations/:opId`, "
            "который нужен только для получения `revision`/`affectedPages` (DEVIATIONS 2.2).\n\n"
        ) + section_metric_tables(summary_cmd, extra_cols, require_spec=False)
    else:
        extra = (
            "\n**Разложение времени команды у Z не опубликовано:** колонок `t_cmd_server_ms` / `t_cmd_synced_ms` / "
            "`t_cmd_opget_ms` в `runs.csv` нет, поэтому по сырым данным нельзя отделить синхронизацию от "
            "дополнительного HTTP‑чтения журнала операций. Требование к оболочке — писать эти три момента "
            "(`packages/analysis/README.md`, раздел «Чего анализ ждёт от оболочки»).\n\n"
        )
    return intro + t + extra


def section_optional_columns(oc: pd.DataFrame) -> str:
    """Какие необязательные/новые колонки присутствуют — чтобы смена семантики была видна."""
    if oc.empty:
        return "_нет данных_\n"
    known = oc[oc["source"] == "известная необязательная метрика"]
    new = oc[oc["source"] != "известная необязательная метрика"]
    rows = [(f"`{r['column']}`", r["label"], fmt_ok(bool(r["present"])), fmt(r["n_values"])) for _, r in known.iterrows()]
    t = md_table(["Колонка", "Смысл", "Есть в серии", "Значений"], rows)
    t2 = ""
    if not new.empty:
        rows2 = [(f"`{r['column']}`", fmt(r["n_values"])) for _, r in new.iterrows()]
        t2 = (
            "\nКолонки, которых нет ни в обязательной, ни в необязательной части схемы "
            "(`packages/analysis/analysis/schema.py`). Анализ их не использует, но и не отбрасывает молча: "
            "если это новая метрика оболочки, её нужно описать в схеме и `COLUMNS.md`.\n\n"
            + md_table(["Колонка", "Значений"], rows2)
        )
    return (
        "Анализ рассчитан на то, что оболочка может добавлять колонки (новая семантика моментов команды, учёт "
        "накладных расходов пробы) и может какие‑то ещё не писать. Отсутствующие необязательные колонки пропускаются, "
        "присутствующие попадают в соответствующие разделы; и те и другие перечислены здесь.\n\n"
    ) + t + t2


def section_conclusions(
    verdicts: pd.DataFrame,
    deltas: dict[str, pd.DataFrame],
    rt: pd.DataFrame,
    succ: pd.DataFrame,
    *,
    paired: bool = False,
    bytes_check: pd.DataFrame | None = None,
    command: pd.DataFrame | None = None,
) -> str:
    lines = []
    lines.append(
        "* Оценки изменения P−F ниже — "
        + ("**парные** (медиана поблочных разностей, блок = повторение)." if paired else "**непарные** (разность медиан).")
    )
    ok_cfgs = [r["config"] for _, r in verdicts.iterrows() if S.is_true(r["all_ok"])]
    bad_cfgs = [(r["config"], r["failed"]) for _, r in verdicts.iterrows() if S.is_false(r["all_ok"])]
    if ok_cfgs:
        lines.append(f"* Все бюджеты §7.4 выполнены для конфигураций: {', '.join(ok_cfgs)}.")
    for cfg, failed in bad_cfgs:
        lines.append(f"* {cfg}: нарушены бюджеты — {', '.join(BUDGET_LABELS.get(b, b) for b in failed)}.")
    for m, lab in (("t_first_ready_ms", "первая готовность"), ("chromium_private_peak_mib", "пик частной памяти Chromium"), ("bytes_in", "входящий трафик"), ("retained_shapes_max", "максимум удерживаемых фигур"), ("t_nav_new_median_ms", "переход на новую страницу")):
        t = deltas.get(m)
        if t is None or t.empty:
            continue
        for _, r in t.iterrows():
            if pd.isna(r["ratio"]):
                continue
            signif = not (r["delta_lo"] <= 0 <= r["delta_hi"])
            direction = "меньше" if r["ratio"] < 1 else "больше"
            pct = abs(1 - r["ratio"]) * 100
            cache = "" if r["cache"] is None or pd.isna(r["cache"]) else f", cache={int(r['cache'])}"
            var = r.get("variant")
            var = f", команда {var}" if var is not None and not (isinstance(var, float) and pd.isna(var)) and str(var).strip() else ""
            lines.append(
                f"* {r['adapter']}{cache}{var}: в режиме P {lab} на {pct:.0f} % {direction}, чем в F "
                f"(P/F = {r['ratio']:.2f}, 95 % интервал [{r['ratio_lo']:.2f}; {r['ratio_hi']:.2f}]; "
                f"{'интервал Δ не содержит 0' if signif else 'интервал Δ содержит 0 — различие не подтверждено'})."
            )
    for _, r in rt.iterrows():
        if r.get("mode") == "P" and S.is_false(r["ok"]):
            lines.append(f"* {r['config']}: удерживаемые записи превышают объявленное окно (максимум {fmt(r['retained_pages_max_max'])} стр. при окне {fmt(r['declared_window_pages'])}).")
    if bytes_check is not None and not bytes_check.empty:
        bad = [r["config"] for _, r in bytes_check.iterrows() if S.is_false(r["ok"])]
        if bad:
            lines.append(f"* Перекрёстная проверка обмена (шейпер vs CDP HTTP+WebSocket) не сошлась: {', '.join(bad)} — числа обмена этих конфигураций использовать нельзя, пока расхождение не объяснено.")
        else:
            worst = float(bytes_check["rel_diff"].max()) if bytes_check["rel_diff"].notna().any() else float("nan")
            lines.append(f"* Перекрёстная проверка обмена сошлась во всех конфигурациях (наибольшее расхождение шейпера и суммы CDP HTTP+WebSocket — {fmt_pct(worst)}).")
    if command is not None and not command.empty and "share_equal" in command.columns:
        degenerate = [r["config"] for _, r in command.iterrows() if not pd.isna(r.get("share_equal")) and float(r["share_equal"]) >= 0.5]
        if degenerate:
            lines.append(
                f"* У конфигураций {', '.join(degenerate)} `t_cmd_drawn` совпадает с `t_cmd_ack` более чем в половине прогонов. "
                "Это не измерение момента отрисовки, а признак того, что одно событие выпускается из обработчика другого; "
                "бюджет «команда до актуального холста ≤ 2 с» по таким данным проверять нельзя."
            )
        early = [r["config"] for _, r in command.iterrows() if not pd.isna(r.get("share_drawn_before_ack")) and float(r["share_drawn_before_ack"]) > 0]
        if early:
            lines.append(f"* У конфигураций {', '.join(early)} холст успевает обновиться раньше подтверждения сервера — доставка синхронизацией опережает ответ по HTTP; обе величины приведены отдельно в разделе 4.")
    point_ok = [r["config"] for _, r in succ.iterrows() if not pd.isna(r["success_share"]) and r["success_share"] >= S.BUDGET_SCENARIO_SHARE]
    low = [r["config"] for _, r in succ.iterrows() if not pd.isna(r["success_lo"]) and r["success_lo"] < S.BUDGET_SCENARIO_SHARE]
    confident = [r["config"] for _, r in succ.iterrows() if not pd.isna(r["success_lo"]) and r["success_lo"] >= S.BUDGET_SCENARIO_SHARE]
    n_min = int(math.ceil(S.BUDGET_SCENARIO_SHARE * ST.Z_95**2 / (1 - S.BUDGET_SCENARIO_SHARE)))
    if point_ok:
        lines.append(f"* Точечная доля успеха ≥ 95 %: {', '.join(point_ok)}.")
    if confident:
        lines.append(f"* Нижняя граница интервала Уилсона ≥ 95 % (надёжность подтверждена): {', '.join(confident)}.")
    if low:
        lines.append(
            f"* Нижняя граница интервала Уилсона ниже 95 % для: {', '.join(low)}. "
            f"При n < {n_min} прогонов она не достигает 95 % даже без единого отказа, поэтому здесь это ограничение объёма серии, "
            f"а не свидетельство ненадёжности; при наличии отказов — см. раздел «Ошибки»."
        )
    if not lines:
        lines.append("* Данных недостаточно для выводов.")
    lines.append("* Условия применимости частичной загрузки: режим P оправдан, когда его выигрыш по первой готовности/памяти/трафику подтверждён интервалом (не содержащим 0) и при этом переходы на новые страницы и команда до холста остаются в бюджете, а удерживаемые записи не выходят за объявленное окно.")
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------- compare series
def section_compare(summaries: dict[str, pd.DataFrame], metrics: Sequence[str]) -> str:
    parts = []
    names = list(summaries)
    for m in metrics:
        spec = S.METRIC_BY_COLUMN.get(m)
        if spec is None:
            continue
        configs: list[str] = []
        for n in names:
            s = summaries[n]
            for c in s.loc[s["metric"] == m, "config"].tolist():
                if c not in configs:
                    configs.append(c)
        if not configs:
            continue
        d = metric_digits(m)
        rows = []
        for c in configs:
            row = [c]
            for n in names:
                s = summaries[n]
                r = s[(s["metric"] == m) & (s["config"] == c)]
                row.append("—" if r.empty else f"{fmt(r['median'].iloc[0], d)} {fmt_ci(r['ci_lo'].iloc[0], r['ci_hi'].iloc[0], d)} (n={fmt(r['n'].iloc[0])})")
            rows.append(row)
        parts.append(f"**{spec.label_ru}, {spec.unit}** — медиана [95 % интервал]\n\n" + md_table(["Конфигурация", *names], rows))
    return "\n".join(parts) if parts else "_нет данных_\n"


# ------------------------------------------------------------- main build
def build_report(
    series: str | Path,
    out: str | Path,
    figs: str | Path | None = None,
    *,
    compare: Sequence[str | Path] = (),
    seed: int = 42,
    n_boot: int = ST.DEFAULT_N_BOOT,
    figure_metrics: Sequence[str] = S.FIGURE_METRICS,
    delta_metrics: Sequence[str] = S.DELTA_METRICS,
    lenient: bool = False,
) -> dict[str, Any]:
    series = Path(series)
    out = Path(out)
    figs = Path(figs) if figs else out.parent / "figs" / series.name
    # lenient: строить отчёт даже при отсутствии обязательных колонок — нужно,
    # когда оболочка переименовала/переопределила метрику, а отчёт всё равно
    # должен показать, что именно изменилось (раздел «Полнота данных»).
    df, vr = S.load_runs(series, require_valid=not lenient)
    series_name = str(df["series"].dropna().iloc[0]) if df["series"].notna().any() else series.name
    passport = S.load_passport(series)
    steps = S.load_steps(series)
    # Бюджет сценария — свой у каждой серии (§1.2 задаёт 30 с для маршрута §7.2 из 11 действий;
    # у длинных маршрутов одни только объявленные паузы дают 18 и 49 с, и порог объявлен в паспорте).
    scenario_budget = S.series_scenario_budget_ms(df)
    budget_txt = scenario_budget_note(scenario_budget)

    summary = ST.summarize_configs(df, seed=seed, n_boot=n_boot)
    extra_metrics = [c for c in ST.OPTIONAL_METRICS if c in df.columns and c not in S.METRIC_BY_COLUMN]
    summary_extra = ST.summarize_configs(df, extra_metrics, seed=seed, n_boot=n_boot) if extra_metrics else pd.DataFrame(columns=["metric", "n"])
    succ = ST.success_table(df)
    bc = ST.budget_checks(df, seed=seed, n_boot=n_boot)
    verdicts = ST.budget_verdicts(bc)
    tb = ST.traffic_breakdown(df)
    tr = ST.traffic_ratio_comparison(df, seed=seed, n_boot=n_boot)
    dc = ST.traffic_decomposition_check(df)
    pp = ST.probe_parity_check(df)
    ot = ST.outlier_report(df)
    rt = ST.retained_window_check(df)
    bx = ST.cross_check_bytes(df)
    ct = ST.command_timing_table(df, seed=seed, n_boot=n_boot)
    oc = ST.optional_columns_status(df)
    deltas_md, deltas = section_deltas(df, delta_metrics, seed, n_boot)
    between_md = section_between(df, delta_metrics, seed, n_boot)
    can_pair, pair_reason = ST.pairing_feasible(df)
    if can_pair:
        paired_md, paired = section_deltas_paired(df, delta_metrics, seed, n_boot)
        between_paired_md = section_between_paired(df, delta_metrics, seed, n_boot)
    else:
        paired_md, paired, between_paired_md = "", {}, ""

    # графики
    fig_paths: list[tuple[str, Path]] = []
    figs.mkdir(parents=True, exist_ok=True)
    for m in figure_metrics:
        sub = summary[summary["metric"] == m]
        # Пустой график хуже отсутствующего: у маршрута без возвратов
        # `t_nav_return_median_ms` есть колонкой, но не имеет ни одного значения.
        if m not in df.columns or sub.empty or float(sub["n"].fillna(0).sum()) == 0:
            continue
        spec = S.METRIC_BY_COLUMN.get(m)
        p = F.plot_grouped_bars(summary, m, figs / f"{m}.png", budget=spec.budget if spec else None)
        fig_paths.append((spec.label_ru if spec else m, p))
    if steps is not None and not steps.empty:
        p = F.plot_retained_steps(steps, figs / "retained_shapes_steps.png")
        fig_paths.append(("Удерживаемые фигуры по шагам", p))

    # сравнение серий
    compare_md = ""
    compare_figs: list[tuple[str, Path]] = []
    if compare:
        summaries = {series_name: summary}
        for c in compare:
            cdf, _ = S.load_runs(c)
            cname = str(cdf["series"].dropna().iloc[0]) if cdf["series"].notna().any() else Path(c).name
            summaries[cname] = ST.summarize_configs(cdf, seed=seed, n_boot=n_boot)
        compare_md = section_compare(summaries, delta_metrics)
        for m in ("t_first_ready_ms", "t_nav_new_median_ms", "chromium_private_peak_mib", "bytes_in", "retained_shapes_max"):
            if all(not s[s["metric"] == m].empty for s in summaries.values()):
                p = F.plot_series_comparison(summaries, m, figs / f"compare_{m}.png")
                compare_figs.append((S.METRIC_BY_COLUMN[m].label_ru, p))

    def rel(p: Path) -> str:
        try:
            return os.path.relpath(p, out.parent).replace(os.sep, "/")
        except ValueError:
            return str(p)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    md = [
        f"# Результаты серии «{series_name}»",
        "",
        f"Сформировано {now} из `{series / 'runs.csv' if series.is_dir() else series}` ({len(df)} прогонов, "
        f"{df[ST.config_key_columns(df)].drop_duplicates().shape[0] if ST.config_key_columns(df) else '?'} конфигураций). "
        f"Бутстреп: {n_boot} ресемплов, seed={seed}, перцентильные 95 % интервалы. Времена и ресурсы считаются по прогонам с `outcome=ok`; доли — по всем начатым прогонам.",
        "",
        "**Определения статистик** (одинаковы во всех таблицах): медиана — обычная выборочная; p95 — перцентиль по линейной "
        "интерполяции порядковых статистик (`numpy.percentile`, тип 7), при n = 30 это интерполяция между 29‑м и 30‑м "
        "значением, поэтому p95 не превышает максимум выборки и при малых n смещён вниз; интервалы медианы и p95 — "
        "перцентильный бутстреп по одной матрице ресемплов (согласованы между собой); доли — интервал Уилсона 95 % "
        f"без поправки на непрерывность; при n < {ST.MIN_N_FOR_CI} интервалы помечены † как ненадёжные, при n < 2 не строятся.",
        "",
        f"Проверка схемы: {vr.message()}",
        "",
        "## 1. Паспорт серии",
        "",
        section_passport(passport, series_name),
        "## 2. Состав серии и доля успеха",
        "",
        f"Успех прогона = `outcome=ok` ∧ `t_scenario {budget_txt}` ∧ все проверки эталона прошли (SPEC §7.3).",
        "",
        section_composition(df, succ),
        "## 3. Сводные показатели по конфигурациям",
        "",
        CI_NOTE,
        "### 3.1 Время",
        "",
        section_metric_tables(summary, [m.column for m in S.METRICS if m.group == "time"]),
        "### 3.2 Объём обмена",
        "",
        "**Головная величина обмена — «только данные»** (`bytes_in_data`: API + кадры синхронизации Zero). Полный "
        "`bytes_in` включает статику сборки — поадаптерную константу, одинаковую в F и в P, поэтому в отношениях "
        "P/F она искажает сравнение (`docs/DEVIATIONS.md` §3.1). Оба числа приводятся рядом, разложение — ниже.",
        "",
        section_metric_tables(summary, [m.column for m in S.METRICS if m.group == "traffic"]),
        "**Обмен данными против полного объёма**",
        "",
        section_traffic_split(df, tb, tr),
        "**Полнота разложения: сумма по маршрутам против итога**",
        "",
        section_traffic_decomposition(dc),
        "**Перекрёстная проверка трафика (шейпер vs CDP)**",
        "",
        section_bytes_check(bx),
        "### 3.3 Память клиента",
        "",
        section_metric_tables(summary, [m.column for m in S.METRICS if m.group == "client_mem"]),
        "**Окна измерительных проб: паритет политики и цена их исключения**",
        "",
        section_probe_parity(pp),
        "**Паритет давления сборщика мусора**",
        "",
        section_heap_gc(df),
        "### 3.4 Удерживаемые записи",
        "",
        section_metric_tables(summary, [m.column for m in S.METRICS if m.group == "retained"]),
        *(
            [
                "### 3.4.1 Маршрут и повторные чтения",
                "",
                "`nav_cache_misses` — переходы, при которых страница уже не удерживалась и её пришлось загружать; "
                "считается одинаково у H, Q и Z и потому сравним между всеми тремя адаптерами. `api_page_reads` — "
                "прямой счётчик HTTP‑чтений страниц; **у Z он равен нулю по устройству адаптера** (страницы приходят "
                "синхронизацией), и это измерение, а не пропуск.",
                "",
                section_metric_tables(summary, [m.column for m in S.METRICS if m.group == "route"]),
            ]
            if any(m.column in df.columns for m in S.METRICS if m.group == "route")
            else []
        ),
        "### 3.5 Сервер",
        "",
        section_metric_tables(summary, [m.column for m in S.METRICS if m.group == "server"]),
        "**zero‑cache: бюджет профиля Z и измеренный фон у H/Q**",
        "",
        section_server_zero(df),
        "## 4. Моменты команды: подтверждение сервера и актуальный холст",
        "",
        section_command_timing(ct, df, pd.concat([summary, summary_extra], ignore_index=True) if not summary_extra.empty else summary),
        "## 5. Бюджеты (§1.2 / SPEC §7.4)",
        "",
        section_budgets(bc, verdicts, scenario_budget_ms=scenario_budget),
        "## 6. Изменение внутри адаптера: P − F и P / F",
        "",
        (
            "### 6.1 Парный (блочный) анализ — основной\n\n"
            f"Парность возможна: {pair_reason}. Раннер выполняет каждое повторение как блок — по одному прогону каждой "
            "конфигурации, порядок внутри блока перемешан, перед каждым прогоном сброс документа и новый процесс Chromium. "
            "Поэтому разность P − F берётся внутри блока: медленный дрейф машины между блоками (прогрев, фоновая нагрузка, "
            "рост реплики) сокращается. Точечная оценка — **медиана поблочных разностей** (и поблочных отношений), а не "
            "разность медиан; интервал — перцентильный бутстреп по блокам.\n\n"
            "Чего парность не делает: прогоны блока разнесены во времени и идут в разном порядке, поэтому это блок, а не "
            "одновременное измерение; эффект позиции внутри блока не снимается. Пара, в которой хотя бы один прогон не `ok`, "
            "отбрасывается целиком (колонка «Отброшено прогонов»), поэтому при несимметричных отказах парная и непарная "
            "оценки считаются по разным подмножествам — расхождение между ними и есть мера этой чувствительности.\n\n"
            + (paired_md or "_нет данных_\n")
            if can_pair
            else (
                "### 6.1 Парный (блочный) анализ — не выполняется\n\n"
                f"Причина: {pair_reason}. Приводится только непарная оценка ниже.\n"
            )
        ),
        "",
        "### 6.2 Непарная оценка (независимый ресемплинг F и P)",
        "",
        "Разность и отношение **медиан** при независимом ресемплинге двух выборок. Не использует блоки повторений, "
        "поэтому включает все прогоны `outcome=ok`, но не снимает дрейф между блоками.",
        "",
        deltas_md or "_нет данных_\n",
        "## 7. Сопоставление изменения между адаптерами (§1.8)",
        "",
        (
            "### 7.1 Парное сопоставление на общих блоках — основное\n\n"
            "Для каждого блока считаются d_A = P_A − F_A и d_B = P_B − F_B, затем сравниваются на **одних и тех же** блоках: "
            "общий для обоих адаптеров дрейф машины сокращается. Интервал, не содержащий 0 (для отношения отношений — 1), "
            "означает, что частичная загрузка влияет на адаптеры по‑разному.\n\n" + (between_paired_md or "_нет данных_\n")
            if can_pair
            else "### 7.1 Парное сопоставление не выполняется\n\n" + f"Причина: {pair_reason}.\n"
        ),
        "",
        "### 7.2 Непарное сопоставление",
        "",
        "Δ_A − Δ_B — разность изменений P−F двух адаптеров; отношение отношений — (P/F)_A / (P/F)_B, при независимом "
        "ресемплинге четырёх групп.",
        "",
        between_md or "_нет данных_\n",
        "## 8. Удерживаемые записи и объявленное окно кеша",
        "",
        "В режиме P допустимо не более `cache + 1` страниц (активная + окно); в F ожидается удержание всех страниц документа (если `doc_pages` известно).",
        "",
        section_retained(rt),
        "## 9. Ошибки, прерывания и выбросы",
        "",
        section_errors(df),
        "",
        "**Выбросы и их вклад**",
        "",
        section_outliers(ot),
        "## 10. Полнота данных: необязательные и новые колонки",
        "",
        section_optional_columns(oc),
        "## 11. Графики",
        "",
        "\n".join(f"![{lab}]({rel(p)})\n" for lab, p in fig_paths) or "_нет графиков_",
        "",
    ]
    if compare:
        md += [
            "## 12. Сравнение серий",
            "",
            compare_md,
            "\n".join(f"![{lab}]({rel(p)})\n" for lab, p in compare_figs),
            "",
            "## 13. Выводы",
        ]
    else:
        md += ["## 12. Выводы"]
    md += ["", section_conclusions(verdicts, paired or deltas, rt, succ, paired=bool(paired), bytes_check=bx, command=ct)]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(md), encoding="utf-8")
    return {
        "out": out,
        "figs": [p for _, p in fig_paths] + [p for _, p in compare_figs],
        "summary": summary,
        "success": succ,
        "budgets": bc,
        "verdicts": verdicts,
        "retained": rt,
        "deltas": deltas,
        "deltas_paired": paired,
        "bytes_check": bx,
        "traffic_breakdown": tb,
        "traffic_ratios": tr,
        "outliers": ot,
        "command_timing": ct,
        "optional_columns": oc,
        "paired": can_pair,
        "validation": vr,
    }


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="analysis.report", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--series", required=True, help="каталог серии с runs.csv (или путь к CSV)")
    p.add_argument("--out", help="Markdown‑отчёт (обязателен без --validate-only)")
    p.add_argument("--figs", help="каталог PNG (по умолчанию <out dir>/figs/<series>)")
    p.add_argument("--compare", help="дополнительные серии через запятую")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--n-boot", type=int, default=ST.DEFAULT_N_BOOT)
    p.add_argument("--validate-only", action="store_true", help="только проверить схему runs.csv")
    p.add_argument(
        "--lenient",
        action="store_true",
        help="строить отчёт даже при отсутствии обязательных колонок (результат проверки схемы попадёт в отчёт)",
    )
    args = p.parse_args(argv)
    if args.validate_only:
        try:
            _, vr = S.load_runs(args.series, require_valid=False)
        except FileNotFoundError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        print(vr.message())
        return 0 if vr.ok else 1
    if not args.out:
        p.error("--out is required")
    try:
        res = build_report(
            args.series,
            args.out,
            args.figs,
            compare=[c.strip() for c in args.compare.split(",") if c.strip()] if args.compare else (),
            seed=args.seed,
            n_boot=args.n_boot,
            lenient=args.lenient,
        )
    except (FileNotFoundError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(f"report: {res['out']}; figures: {len(res['figs'])}; {res['validation'].message()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
