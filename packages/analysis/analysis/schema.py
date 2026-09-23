"""Схема `results/<series>/runs.csv` (SPEC §7.3) и валидатор.

Список колонок зафиксирован здесь и продублирован в COLUMNS.md — измерительная
оболочка (packages/bench) обязана писать ровно эти имена. Валидатор сообщает
об отсутствующих/неизвестных колонках и о нечисловых значениях явно.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

# --------------------------------------------------------------- идентификация
ID_COLUMNS = ["run_id", "series", "adapter", "mode", "cache", "doc", "repetition", "order_index", "started_at"]
OUTCOME_COLUMNS = ["outcome", "error_stage"]
NAV_COLUMNS = [f"t_nav_{i}_ms" for i in range(1, 11)]
TIME_COLUMNS = [
    "t_first_ready_ms",
    *NAV_COLUMNS,
    "t_nav_new_median_ms",
    "t_nav_return_median_ms",
    "t_cmd_ack_ms",
    "t_cmd_drawn_ms",
    "t_scenario_ms",
]
TRAFFIC_COLUMNS = ["bytes_in", "bytes_out", "cdp_bytes_in"]
CLIENT_MEM_COLUMNS = [
    "js_heap_peak_mb",
    "js_heap_end_mb",
    "chromium_private_peak_mib",
    "chromium_private_end_mib",
    "client_storage_bytes",
]
RETAINED_COLUMNS = [
    "retained_pages_end",
    "retained_shapes_end",
    "retained_pages_max",
    "retained_shapes_max",
    "loaded_pages_end",
]
SERVER_COLUMNS = [
    "server_api_cpu_ms",
    "server_api_mem_peak_mib",
    "server_api_mem_integral_mib_s",
    "server_pg_cpu_ms",
    "server_pg_mem_peak_mib",
    "server_pg_mem_integral_mib_s",
    "server_zero_cpu_ms",
    "server_zero_mem_peak_mib",
    "server_zero_mem_integral_mib_s",
    "zero_replica_bytes",
]
BUDGET_COLUMNS = [
    "within_budget_first",
    "within_budget_nav",
    "within_budget_cmd",
    "within_budget_scenario",
    "reference_ok",
]

REQUIRED_COLUMNS: list[str] = [
    *ID_COLUMNS,
    *OUTCOME_COLUMNS,
    *TIME_COLUMNS,
    *TRAFFIC_COLUMNS,
    *CLIENT_MEM_COLUMNS,
    *RETAINED_COLUMNS,
    *SERVER_COLUMNS,
    *BUDGET_COLUMNS,
]

# Необязательные колонки: используются, если присутствуют.
OPTIONAL_COLUMNS: list[str] = [
    "doc_pages",  # число страниц документа (для проверки окна в F)
    "doc_shapes_per_page",  # фигур на страницу (для проверки retained_shapes)
    "rtt_ms",  # RTT шейпера
    "bandwidth_mbps",
    "seed",
    "finished_at",
    "error_message",
    "commit",
    "notes",
    # разложение команды по моментам (§1.8): drawn фиксируется по фактической отрисовке и
    # может опережать ack — у Z ровно на стоимость GET /api/operations/:opId (t_cmd_opget_ms)
    "t_cmd_server_ms",
    "t_cmd_synced_ms",
    "t_cmd_opget_ms",
    "cmd_drawn_before_ack",
    # учёт накладных расходов измерительной оболочки (в сериях до 2026-09-13 колонок нет)
    "t_scenario_wall_ms",
    "probe_overrun_ms",
    "t_scenario_model_ms",
    "t_scenario_model_residual_ms",
    "probe_total_ms",
    # политика проб retained (§3.2 bench/README): дешёвая проба на каждом шаге, точный скан — в двух
    # фиксированных точках; сравнимая между адаптерами величина — именно `retained_*_end_exact`
    "retained_probe_mode",
    "retained_pages_end_exact",
    "retained_shapes_end_exact",
    "js_heap_samples",
    "js_heap_sample_interval_ms",
    # паритет давления сборщика мусора (дефект N2)
    "js_heap_gc_count",
    "js_heap_post_gc_mb",
    "js_heap_suspended_ms",
    # честность сэмплирования (§7.3) и общий диск серверной части (§1.7)
    "sampling_incomplete",
    "sampling_ticks",
    "server_zero_applicable",
    "server_disk_used_bytes",
    # маршрут произвольной длины и повторные чтения (packages/bench/README §3, §5;
    # серии route-full / route-repeat / command-shape, 2026-09-13)
    "route_len",
    "route_distinct_pages",
    "t_nav_count",
    "t_nav_new_count",
    "t_nav_return_count",
    "t_nav_median_ms",
    "t_nav_ms_list",
    "nav_cache_hits",
    "nav_cache_misses",
    "page_loads_observed",
    "api_page_reads",
    "api_page_reads_distinct",
    "api_page_read_bytes",
    # вариант команды серии (packages/bench/README §4.2)
    "cmd_variant",
    "cmd_target_id",
    # служебные колонки оболочки (packages/bench/README §5) — принимаются, но не анализируются
    "wall_ms",
    "browser_launch_ms",
    "cdp_bytes_out",
    "cdp_ws_bytes_in",
    "cdp_ws_bytes_out",
    "shaper_requests",
    "shaper_connections",
    "cmd_revision",
    "cmd_affected_pages",
    "cmd_affected_shapes",
    "server_api_rss_peak_mib",
    "server_pg_rss_peak_mib",
    "server_zero_rss_peak_mib",
    "chromium_processes_peak",
    "client_transfer_bytes_in",
    "client_transfer_bytes_out",
    # --- разложение обмена по назначению (оболочка ≥ 2026-09-14) ---------------
    # `DEVIATIONS.md` §3.1: в `bytes_in` входит поадаптерная КОНСТАНТА — статика сборки
    # (H 260 432, Q 291 444, Z 572 562 Б в выполненной программе), которая не является данными
    # документа. Пока оболочка не пишет эти колонки, анализ восстанавливает их из
    # `shaper.stats.byRoute` в per-run JSON (`traffic_split_from_runs`), поэтому таблицы «только
    # данные» строятся и на старых сериях.
    "bytes_in_api",
    "bytes_in_zero",
    "bytes_in_static",
    "bytes_out_api",
    "bytes_out_zero",
    "bytes_out_static",
    # пик частной памяти Chromium БЕЗ окон измерительной пробы (точный скан хранилища): у Z/F
    # проба стоит ~955 мс и материализует ≈25 000 объектов, поэтому сырой пик содержит
    # инструмент, а не адаптер. Оболочка может писать колонку под одним из синонимов ниже —
    # `coerce()` приводит их к каноническому имени.
    "chromium_private_peak_excl_probe_mib",
    "chromium_private_peak_noprobe_mib",
    "chromium_private_end_excl_probe_mib",
    # --- оболочка программы 2 (2026-09-14): полнота разложения обмена и учёт окон проб -------
    # Остаток разложения по маршрутам шейпера («всё прочее»: `/`, favicon, служебные запросы,
    # не попавшие ни в `/api`, ни в `/zero`) и КОНТРОЛЬНЫЙ остаток «сумма по маршрутам − итог».
    # Последний обязан быть нулём в каждом прогоне: это и есть доказательство, что головная
    # величина `bytes_in_data = bytes_in_api + bytes_in_zero` ничего не теряет.
    "bytes_in_other",
    "bytes_out_other",
    "bytes_in_route_residual",
    "bytes_out_route_residual",
    # Сырой пик частной памяти Chromium и учёт выборок, попавших в окна проб.
    "chromium_private_peak_raw_mib",
    "chromium_probe_ticks",
    "chromium_samples",
    # Пики памяти серверных групп с той же политикой исключения окон проб.
    "server_api_mem_peak_excl_probe_mib",
    "server_pg_mem_peak_excl_probe_mib",
    "server_zero_mem_peak_excl_probe_mib",
    # Паритет политики проб между конфигурациями и покрытие сэмплера кучи.
    "probe_window_count",
    "probe_window_ms",
    "js_heap_sampler_coverage",
    # Идентичность измерительной оболочки, продублированная в каждую строку CSV.
    "harness_id",
]

#: Колонки разложения обмена по назначению.
TRAFFIC_IN_PARTS = ("bytes_in_api", "bytes_in_zero", "bytes_in_static")
TRAFFIC_OUT_PARTS = ("bytes_out_api", "bytes_out_zero", "bytes_out_static")
TRAFFIC_SPLIT_COLUMNS = [*TRAFFIC_IN_PARTS, *TRAFFIC_OUT_PARTS]

#: Полное разложение обмена по маршрутам шейпера: три именованных маршрута и «прочее».
#: Сумма всех четырёх обязана равняться итогу (`bytes_in` / `bytes_out`), а оболочка публикует
#: расхождение отдельной колонкой `*_route_residual`. `bytes_*_other` в головную величину
#: «данные» НЕ входит: это служебные запросы вне `/api` и `/zero` (в выполненной программе 0).
TRAFFIC_IN_ALL_PARTS = (*TRAFFIC_IN_PARTS, "bytes_in_other")
TRAFFIC_OUT_ALL_PARTS = (*TRAFFIC_OUT_PARTS, "bytes_out_other")
TRAFFIC_RESIDUAL_IN = "bytes_in_route_residual"
TRAFFIC_RESIDUAL_OUT = "bytes_out_route_residual"

#: Пик Chromium без окон пробы: каноническое имя и принимаемые синонимы оболочки.
CHROMIUM_PEAK_PROBE_FREE = "chromium_private_peak_excl_probe_mib"
CHROMIUM_PEAK_PROBE_FREE_ALIASES = ("chromium_private_peak_noprobe_mib",)
#: Сырой пик (все выборки). Оболочка программы 2 пишет его И под этим именем, И под историческим
#: `chromium_private_peak_mib` — вторая колонка оставлена равной первой ради совместимости схемы.
CHROMIUM_PEAK_RAW = "chromium_private_peak_raw_mib"
#: Пики памяти серверных групп без окон проб: колонка оболочки → соответствующий сырой пик.
SERVER_MEM_PEAK_PROBE_FREE: dict[str, str] = {
    "server_api_mem_peak_excl_probe_mib": "server_api_mem_peak_mib",
    "server_pg_mem_peak_excl_probe_mib": "server_pg_mem_peak_mib",
    "server_zero_mem_peak_excl_probe_mib": "server_zero_mem_peak_mib",
}

NUMERIC_COLUMNS: list[str] = [
    "cache",
    "repetition",
    "order_index",
    *TIME_COLUMNS,
    *TRAFFIC_COLUMNS,
    *CLIENT_MEM_COLUMNS,
    *RETAINED_COLUMNS,
    *SERVER_COLUMNS,
    "doc_pages",
    "doc_shapes_per_page",
    "rtt_ms",
    "bandwidth_mbps",
    "t_cmd_server_ms",
    "t_cmd_synced_ms",
    "t_cmd_opget_ms",
    "t_scenario_wall_ms",
    "probe_overrun_ms",
    "t_scenario_model_ms",
    "t_scenario_model_residual_ms",
    "probe_total_ms",
    "retained_pages_end_exact",
    "retained_shapes_end_exact",
    "js_heap_samples",
    "js_heap_sample_interval_ms",
    "js_heap_gc_count",
    "js_heap_post_gc_mb",
    "js_heap_suspended_ms",
    "server_disk_used_bytes",
    "route_len",
    "route_distinct_pages",
    "t_nav_count",
    "t_nav_new_count",
    "t_nav_return_count",
    "t_nav_median_ms",
    "nav_cache_hits",
    "nav_cache_misses",
    "page_loads_observed",
    "api_page_reads",
    "api_page_reads_distinct",
    "api_page_read_bytes",
    *TRAFFIC_SPLIT_COLUMNS,
    "bytes_in_other",
    "bytes_out_other",
    TRAFFIC_RESIDUAL_IN,
    TRAFFIC_RESIDUAL_OUT,
    CHROMIUM_PEAK_PROBE_FREE,
    *CHROMIUM_PEAK_PROBE_FREE_ALIASES,
    "chromium_private_end_excl_probe_mib",
    CHROMIUM_PEAK_RAW,
    "chromium_probe_ticks",
    "chromium_samples",
    *SERVER_MEM_PEAK_PROBE_FREE,
    "probe_window_count",
    "probe_window_ms",
    "js_heap_sampler_coverage",
]
BOOL_COLUMNS: list[str] = [*BUDGET_COLUMNS, "cmd_drawn_before_ack", "server_zero_applicable"]
STRING_COLUMNS: list[str] = [
    "run_id",
    "series",
    "adapter",
    "mode",
    "doc",
    "started_at",
    "outcome",
    "error_stage",
    "retained_probe_mode",
    "sampling_incomplete",
    "sampling_ticks",
    "t_nav_ms_list",
    "cmd_variant",
    "cmd_target_id",
    "harness_id",
]

ADAPTERS = ["H", "Q", "Z"]
MODES = ["F", "P"]
OUTCOMES = ["ok", "error", "timeout"]
#: Ключ конфигурации. `cmd_variant` входит в ключ, потому что серия с `variants`
#: (packages/bench/README §4.2) измеряет одну и ту же конфигурацию адаптера РАЗНЫМИ
#: командами: слить их в одну строку значило бы усреднить 81 изменённую фигуру с 2001.
#: В сериях без вариантов колонки нет (или она пуста) — ключ вырождается в прежний.
CONFIG_KEY = ["adapter", "mode", "cache", "doc", "cmd_variant"]
#: Колонка варианта команды: отдельно, потому что по ней дополнительно разбиваются
#: парные/непарные оценки P−F, которые группируются не по ключу конфигурации.
VARIANT_COLUMN = "cmd_variant"

# Производные колонки (считаются при загрузке)
DERIVED_COLUMNS = {
    "server_cpu_ms_total": ["server_api_cpu_ms", "server_pg_cpu_ms", "server_zero_cpu_ms"],
    "server_mem_peak_mib_total": ["server_api_mem_peak_mib", "server_pg_mem_peak_mib", "server_zero_mem_peak_mib"],
    "server_mem_integral_mib_s_total": [
        "server_api_mem_integral_mib_s",
        "server_pg_mem_integral_mib_s",
        "server_zero_mem_integral_mib_s",
    ],
    "bytes_total": ["bytes_in", "bytes_out"],
    # обмен ДАННЫМИ: всё, кроме статики сборки (см. `traffic_data_columns`)
    "bytes_in_data": ["bytes_in_api", "bytes_in_zero"],
    "bytes_out_data": ["bytes_out_api", "bytes_out_zero"],
    # измеренный фон zero-cache в прогонах, где он НЕ входит в бюджет адаптера (H/Q)
    "server_zero_background_cpu_ms": ["server_zero_cpu_ms", "server_zero_applicable"],
    "server_zero_background_mem_peak_mib": ["server_zero_mem_peak_mib", "server_zero_applicable"],
}

#: Слагаемые серверных сумм; последнее — группа zero-cache.
#: С 2026-09-13 zero-cache сэмплируется в КАЖДОМ прогоне (§1.2, дефект A8), поэтому слепая сумма
#: api+pg+zero приписала бы H/Q расход компонента, который нужен только профилю Z. Колонка
#: `server_zero_applicable` разделяет случаи: в бюджет конфигурации zero-cache входит только там,
#: где она `true` (прогоны Z); в прогонах H/Q измеренная величина публикуется отдельно как фон
#: (`server_zero_background_*`). Если колонки нет (серии до 2026-09-13, где `server_zero_*` были
#: нулями по построению), сумма считается по-старому — слагаемое входит в неё как есть.
SERVER_TOTAL_PARTS: dict[str, tuple[str, ...]] = {
    "server_cpu_ms_total": ("server_api_cpu_ms", "server_pg_cpu_ms", "server_zero_cpu_ms"),
    "server_mem_peak_mib_total": ("server_api_mem_peak_mib", "server_pg_mem_peak_mib", "server_zero_mem_peak_mib"),
    "server_mem_integral_mib_s_total": (
        "server_api_mem_integral_mib_s",
        "server_pg_mem_integral_mib_s",
        "server_zero_mem_integral_mib_s",
    ),
}
SERVER_ZERO_BACKGROUND: dict[str, str] = {
    "server_zero_background_cpu_ms": "server_zero_cpu_ms",
    "server_zero_background_mem_peak_mib": "server_zero_mem_peak_mib",
}

# Бюджеты SPEC §7.4
BUDGET_FIRST_READY_MS = 2000
BUDGET_NAV_MS = 1000
BUDGET_CMD_DRAWN_MS = 2000
#: Бюджет сценария §1.2 для маршрута §7.2 (11 действий, 11 объявленных пауз). Это ЗНАЧЕНИЕ ПО
#: УМОЛЧАНИЮ, а не универсальный порог: серия с другим маршрутом объявляет свой бюджет в паспорте
#: (`scenario.budgets.scenarioMs`), потому что объявленные паузы сами по себе дают 18 с у
#: `route-repeat` и 49 с у `route-full`. Читать по нему длинный маршрут — значит объявить нарушением
#: паузы, заданные методикой. Фактический бюджет серии берётся функцией `scenario_budget_ms()`.
BUDGET_SCENARIO_MS = 30000
#: Ключ бюджета сценария в паспорте серии (`passport.scenario.budgets` и
#: `passport.seriesConfig.scenario.budgets`).
SCENARIO_BUDGET_KEY = "scenarioMs"
#: Колонка, в которую `coerce()` кладёт бюджет сценария серии (в CSV её нет: это производная).
SCENARIO_BUDGET_COLUMN = "scenario_budget_ms"
BUDGET_SCENARIO_SHARE = 0.95
BUDGET_CHROMIUM_MIB = 768
BUDGET_SERVER_VCPU = 4
BUDGET_SERVER_MEM_MIB = 8 * 1024
BUDGET_SERVER_DISK_BYTES = 40 * 1024**3


def scenario_budget_ms(passport: dict[str, Any] | None) -> float:
    """Бюджет сценария серии, мс: из паспорта, иначе §7.4 по умолчанию (30 000).

    Ищется `scenario.budgets.scenarioMs` — сперва в корне паспорта (его пишет оболочка по
    фактически исполненному сценарию), затем в `seriesConfig.scenario.budgets` (как задано в
    конфигурации серии). Обе записи в выполненной программе совпадают; порядок важен лишь тогда,
    когда серию перезапускали с изменённой конфигурацией.

    Зачем вообще: §1.2 объявляет «не более 30 с» для пути из 11 действий с паузой в секунду между
    ними. Маршрут `route-full` состоит из 50 действий, и одни только объявленные паузы дают 49 с,
    поэтому 30 с для него — не бюджет, а арифметическая невозможность. Серия объявляет собственный
    порог, и отчёт обязан называть его явно.
    """
    if not isinstance(passport, dict):
        return float(BUDGET_SCENARIO_MS)
    for holder in (passport.get("scenario"), (passport.get("seriesConfig") or {}).get("scenario") if isinstance(passport.get("seriesConfig"), dict) else None):
        if not isinstance(holder, dict):
            continue
        budgets = holder.get("budgets")
        if not isinstance(budgets, dict):
            continue
        v = budgets.get(SCENARIO_BUDGET_KEY)
        try:
            if v is not None and float(v) > 0:
                return float(v)
        except (TypeError, ValueError):
            continue
    return float(BUDGET_SCENARIO_MS)


def series_scenario_budget_ms(df: pd.DataFrame, default: float = float(BUDGET_SCENARIO_MS)) -> float:
    """Бюджет сценария, записанный в загруженный кадр (`coerce`/`load_runs`), иначе `default`."""
    if SCENARIO_BUDGET_COLUMN not in df.columns:
        return float(default)
    vals = pd.to_numeric(df[SCENARIO_BUDGET_COLUMN], errors="coerce").dropna().unique()
    if vals.size == 0:
        return float(default)
    return float(vals[0])


def is_true(v: Any) -> bool:
    """True для Python/NumPy True; False для False/None/NaN/строк."""
    return isinstance(v, (bool, np.bool_)) and bool(v)


def is_false(v: Any) -> bool:
    return isinstance(v, (bool, np.bool_)) and not bool(v)


def is_bool(v: Any) -> bool:
    return isinstance(v, (bool, np.bool_))


@dataclass
class MetricSpec:
    column: str
    label_ru: str
    unit: str
    lower_is_better: bool = True
    budget: float | None = None
    group: str = "time"


# Порядок = порядок в отчёте и графиках
METRICS: list[MetricSpec] = [
    MetricSpec("t_first_ready_ms", "Первая готовность (стр. 1)", "мс", budget=BUDGET_FIRST_READY_MS),
    # «новый / возврат» оболочка определяет по ходу маршрута (множество посещённых), а не по номерам
    # шагов: в маршруте §7.2 новыми оказываются переходы 1,2,4,6,8,10, а в серии doc5x100
    # (маршрут [2,3,1,4,2,5,1,3,2,5] на 5 страницах) — только 1,2,4,6. Поэтому величины сравнимы
    # ВНУТРИ серии; между сериями с разными маршрутами это медианы по разным наборам переходов.
    MetricSpec("t_nav_new_median_ms", "Переход на новую страницу (медиана по прогону, набор переходов зависит от маршрута серии)", "мс", budget=BUDGET_NAV_MS),
    MetricSpec("t_nav_return_median_ms", "Возврат на посещённую страницу (медиана по прогону, набор переходов зависит от маршрута серии)", "мс", budget=BUDGET_NAV_MS),
    MetricSpec("t_cmd_server_ms", "Команда: подтверждение транспорта (Z — .server, H/Q — ответ POST)", "мс"),
    MetricSpec("t_cmd_ack_ms", "Команда: подтверждение сервера (результат операции)", "мс"),
    MetricSpec("t_cmd_opget_ms", "Команда: цена протокола подтверждения (ack − транспорт)", "мс"),
    MetricSpec("t_cmd_synced_ms", "Команда: данные в хранилище активной страницы", "мс"),
    # §1.8: время отсчитывается до ФАКТИЧЕСКОГО обновления холста; у Z этот момент может
    # опережать t_cmd_ack_ms (подтверждение требует отдельного чтения журнала операций).
    # ИСТОЧНИК всех t_cmd_*: журнал событий страницы (момент диспетчеризации события), а не
    # drawnInfo.at / timing.* — точные моменты лежат в scenario.command_timings[] записи прогона.
    # Смещение измерено на 540 прогонах: медиана +0.5 мс, максимум +3.2 мс, одинаково у H, Q и Z
    # (медианы 0.40-0.50 мс), т. е. на сравнение адаптеров не влияет (COLUMNS.md, врезка).
    MetricSpec("t_cmd_drawn_ms", "Команда: актуальный холст", "мс", budget=BUDGET_CMD_DRAWN_MS),
    MetricSpec("t_nav_median_ms", "Переход, медиана всех переходов прогона (маршрут любой длины)", "мс", budget=BUDGET_NAV_MS),
    MetricSpec("t_scenario_ms", "Сценарий целиком (с паузами, без проб оболочки)", "мс", budget=BUDGET_SCENARIO_MS),
    MetricSpec("t_scenario_wall_ms", "Сценарий целиком, сырое время (с пробами оболочки)", "мс"),
    MetricSpec("probe_overrun_ms", "Пробы оболочки сверх объявленных пауз", "мс"),
    # ГОЛОВНАЯ величина обмена — «только данные»: статика сборки одинакова в F и P и разная у
    # адаптеров, поэтому в отношениях P/F она их искажает (`_apply_traffic_split`).
    MetricSpec("bytes_in_data", "Входящий трафик: ДАННЫЕ (API + WebSocket Zero, без статики сборки)", "байт", group="traffic"),
    MetricSpec("bytes_in", "Входящий трафик, всего (данные + статика сборки)", "байт", group="traffic"),
    MetricSpec("bytes_in_static", "Статика сборки за прогон (поадаптерная константа)", "байт", group="traffic"),
    MetricSpec("bytes_out_data", "Исходящий трафик: данные (без статики)", "байт", group="traffic"),
    MetricSpec("bytes_out", "Исходящий трафик, всего (шейпер)", "байт", group="traffic"),
    MetricSpec("cdp_bytes_in", "Входящий трафик (CDP, перекрёстная проверка)", "байт", group="traffic"),
    # пик БЕЗ окон измерительной пробы — сравнимая между адаптерами величина: точный скан
    # хранилища у Z/F стоит ~955 мс и сам поднимает частную память (критик‑2 прохода 2, дефект 3)
    MetricSpec(CHROMIUM_PEAK_PROBE_FREE, "Chromium, частная память, пик без окон пробы", "МиБ", budget=BUDGET_CHROMIUM_MIB, group="client_mem"),
    MetricSpec("chromium_private_peak_mib", "Chromium, частная память, пик (сырой, с окнами пробы)", "МиБ", budget=BUDGET_CHROMIUM_MIB, group="client_mem"),
    MetricSpec("chromium_private_end_mib", "Chromium, частная память, конец", "МиБ", group="client_mem"),
    MetricSpec("js_heap_peak_mb", "JS‑куча, пик", "МБ", group="client_mem"),
    MetricSpec("js_heap_end_mb", "JS‑куча, конец", "МБ", group="client_mem"),
    MetricSpec("js_heap_post_gc_mb", "JS‑куча после принудительной сборки (остановка часов)", "МБ", group="client_mem"),
    MetricSpec("js_heap_gc_count", "Принудительных сборок мусора за прогон", "шт.", lower_is_better=False, group="client_mem"),
    MetricSpec("client_storage_bytes", "Постоянное хранилище клиента", "байт", group="client_mem"),
    MetricSpec("retained_shapes_max", "Удерживаемые фигуры, максимум (дешёвые пробы шагов)", "шт.", group="retained"),
    # §3.2 bench/README: сравнимая между адаптерами величина — точный скан в общей точке
    MetricSpec("retained_shapes_end_exact", "Удерживаемые фигуры, конец — точный скан", "шт.", group="retained"),
    MetricSpec("retained_shapes_end", "Удерживаемые фигуры, конец", "шт.", group="retained"),
    MetricSpec("retained_pages_max", "Удерживаемые страницы, максимум (дешёвые пробы шагов)", "шт.", group="retained"),
    MetricSpec("retained_pages_end_exact", "Удерживаемые страницы, конец — точный скан", "шт.", group="retained"),
    MetricSpec("retained_pages_end", "Удерживаемые страницы, конец", "шт.", group="retained"),
    MetricSpec("loaded_pages_end", "Загруженные страницы, конец", "шт.", group="retained"),
    # сумма бюджета конфигурации: zero-cache входит только там, где `server_zero_applicable=true`
    MetricSpec("server_cpu_ms_total", "Сервер: CPU бюджета конфигурации (API+PG, +zero у Z)", "мс", group="server"),
    MetricSpec("server_api_cpu_ms", "Сервер: CPU API", "мс", group="server"),
    MetricSpec("server_pg_cpu_ms", "Сервер: CPU PostgreSQL", "мс", group="server"),
    # у H/Q это измеренный фон постоянно работающего компонента: results/main, медианы 40-50 мс CPU
    # и 603 МиБ частной памяти против 655-2075 мс и 604 МиБ у Z (DEVIATIONS 4.2)
    MetricSpec("server_zero_cpu_ms", "Сервер: CPU zero‑cache (у H/Q — измеренный фон, не их бюджет)", "мс", group="server"),
    # server_*_mem_* — ЧАСТНАЯ память (Private_Clean+Private_Dirty из smaps_rollup), не RSS;
    # полный RSS публикуется служебными server_*_rss_peak_mib (packages/bench/src/sampling/procs.mjs)
    MetricSpec("server_mem_peak_mib_total", "Сервер: частная память, пик (сумма бюджета конфигурации)", "МиБ", budget=BUDGET_SERVER_MEM_MIB, group="server"),
    MetricSpec("server_mem_integral_mib_s_total", "Сервер: интеграл частной памяти (сумма бюджета конфигурации)", "МиБ·с", group="server"),
    # замеряется в каждом прогоне, а не только у Z (в выполненной программе — 35.7 МиБ во всех 540)
    MetricSpec("zero_replica_bytes", "Диск реплики zero‑cache", "байт", budget=BUDGET_SERVER_DISK_BYTES, group="server"),
    # маршрут и повторные чтения: считаются одинаково у H, Q и Z (§3 bench/README), поэтому
    # промах окна сравним между адаптерами; `api_page_*` наблюдаемы только у H/Q (у Z HTTP‑чтений
    # страниц нет вовсе, и 0 здесь — измерение, а не пропуск)
    MetricSpec("nav_cache_misses", "Переходы с промахом окна (страница требовала загрузки)", "шт.", group="route"),
    MetricSpec("nav_cache_hits", "Переходы с попаданием в окно (страница удерживалась)", "шт.", lower_is_better=False, group="route"),
    MetricSpec("page_loads_observed", "Загрузок страниц за прогон (промахи + открытие)", "шт.", group="route"),
    MetricSpec("api_page_reads", "HTTP‑чтений страниц `GET /api/…/pages/*` (у Z — 0 по устройству)", "шт.", group="route"),
    MetricSpec("api_page_reads_distinct", "Разных страниц среди HTTP‑чтений", "шт.", group="route"),
    MetricSpec("api_page_read_bytes", "Байт в ответах на HTTP‑чтения страниц", "байт", group="route"),
]
METRIC_BY_COLUMN = {m.column: m for m in METRICS}

# Метрики, по которым строятся графики (по одному PNG на метрику)
FIGURE_METRICS = [
    "t_first_ready_ms",
    "t_nav_new_median_ms",
    "t_nav_return_median_ms",
    "t_cmd_drawn_ms",
    "bytes_in_data",
    "bytes_in",
    "chromium_private_peak_mib",
    "js_heap_peak_mb",
    "retained_shapes_max",
    "server_cpu_ms_total",
    "server_mem_peak_mib_total",
]

# Метрики для таблиц дельт P−F внутри адаптера
DELTA_METRICS = [
    "t_first_ready_ms",
    "t_nav_new_median_ms",
    "t_nav_return_median_ms",
    "t_cmd_drawn_ms",
    "t_scenario_ms",
    "bytes_in_data",
    "bytes_in",
    CHROMIUM_PEAK_PROBE_FREE,
    "chromium_private_peak_mib",
    "js_heap_peak_mb",
    "retained_shapes_max",
    "server_cpu_ms_total",
    "server_mem_peak_mib_total",
]


@dataclass
class ValidationResult:
    ok: bool
    missing: list[str] = field(default_factory=list)
    unknown: list[str] = field(default_factory=list)
    bad_values: dict[str, str] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    rows: int = 0

    def message(self) -> str:
        parts = [f"rows={self.rows}"]
        if self.missing:
            parts.append("MISSING required columns: " + ", ".join(self.missing))
        if self.unknown:
            parts.append("unknown columns (ignored): " + ", ".join(self.unknown))
        for col, msg in self.bad_values.items():
            parts.append(f"{col}: {msg}")
        parts.extend(self.warnings)
        return ("OK" if self.ok else "INVALID") + " — " + "; ".join(parts)


def _to_bool_series(s: pd.Series) -> pd.Series:
    def conv(v: Any):
        if v is None or (isinstance(v, float) and np.isnan(v)):
            return np.nan
        if isinstance(v, (bool, np.bool_)):
            return bool(v)
        if isinstance(v, (int, np.integer)):
            return bool(v)
        t = str(v).strip().lower()
        if t in ("true", "1", "yes", "y", "t"):
            return True
        if t in ("false", "0", "no", "n", "f"):
            return False
        if t in ("", "nan", "none", "null", "na"):
            return np.nan
        return "BAD"

    return s.map(conv)


def validate(df: pd.DataFrame, *, strict: bool = False) -> ValidationResult:
    """Проверяет наличие колонок и типы значений; не меняет df."""
    cols = list(df.columns)
    missing = [c for c in REQUIRED_COLUMNS if c not in cols]
    known = set(REQUIRED_COLUMNS) | set(OPTIONAL_COLUMNS) | set(DERIVED_COLUMNS)
    unknown = [c for c in cols if c not in known]
    bad: dict[str, str] = {}
    warnings: list[str] = []
    for c in NUMERIC_COLUMNS:
        if c not in cols:
            continue
        conv = pd.to_numeric(df[c], errors="coerce")
        n_bad = int((conv.isna() & df[c].notna() & (df[c].astype(str).str.strip() != "")).sum())
        if n_bad:
            bad[c] = f"{n_bad} non-numeric value(s)"
    for c in BOOL_COLUMNS:
        if c not in cols:
            continue
        conv = _to_bool_series(df[c])
        n_bad = int((conv == "BAD").sum())
        if n_bad:
            bad[c] = f"{n_bad} non-boolean value(s)"
    if "outcome" in cols:
        vals = set(df["outcome"].dropna().astype(str).unique())
        extra = sorted(vals - set(OUTCOMES))
        if extra:
            bad["outcome"] = f"unexpected values {extra} (expected {OUTCOMES})"
    if "adapter" in cols:
        extra = sorted(set(df["adapter"].dropna().astype(str).unique()) - set(ADAPTERS))
        if extra:
            bad["adapter"] = f"unexpected values {extra} (expected {ADAPTERS})"
    if "mode" in cols:
        extra = sorted(set(df["mode"].dropna().astype(str).unique()) - set(MODES))
        if extra:
            bad["mode"] = f"unexpected values {extra} (expected {MODES})"
    if "run_id" in cols and df["run_id"].duplicated().any():
        bad["run_id"] = f"{int(df['run_id'].duplicated().sum())} duplicate run_id(s)"
    if unknown:
        warnings.append(f"{len(unknown)} unknown column(s) ignored")
    ok = not missing and not bad and (not strict or not unknown)
    return ValidationResult(ok=ok, missing=missing, unknown=unknown, bad_values=bad, warnings=warnings, rows=len(df))


def _apply_zero_applicability(out: pd.DataFrame) -> None:
    """Учитывает `server_zero_applicable` в серверных суммах (см. `SERVER_TOTAL_PARTS`).

    В бюджет конфигурации zero-cache входит только там, где колонка `true`; в прогонах H/Q его
    измеренный расход — фон компонента, нужного лишь профилю Z, и попадает в отдельные колонки
    `server_zero_background_*`, а не в `server_*_total`. Без колонки (старые серии) ничего не меняет.
    """
    if "server_zero_applicable" not in out.columns:
        return
    applicable = out["server_zero_applicable"].map(is_true)
    for name, parts in SERVER_TOTAL_PARTS.items():
        zero_col, base_cols = parts[-1], list(parts[:-1])
        if zero_col not in out.columns or not all(c in out.columns for c in base_cols):
            continue
        base = out[base_cols].sum(axis=1, min_count=len(base_cols))
        z = pd.to_numeric(out[zero_col], errors="coerce")
        # applicable → слагаемое входит как есть (в т. ч. NaN «не измерено» делает сумму NaN);
        # not applicable → в бюджет не входит, вклад 0
        out[name] = base + z.where(applicable, 0.0)
    for bg, zero_col in SERVER_ZERO_BACKGROUND.items():
        if zero_col in out.columns:
            out[bg] = pd.to_numeric(out[zero_col], errors="coerce").where(~applicable)


#: Производные колонки обмена данными и колонка-источник их разложения.
TRAFFIC_DATA_COLUMNS = ("bytes_in_data", "bytes_out_data")
TRAFFIC_SPLIT_SOURCE_COLUMN = "traffic_split_source"


def _apply_traffic_split(out: pd.DataFrame) -> None:
    """Считает обмен ДАННЫМИ: `bytes_*_data` = API + WebSocket Zero, без статики сборки.

    Зачем (`docs/DEVIATIONS.md` §3.1, критик‑2 прохода 2): `bytes_in` содержит поадаптерную
    константу — статику сборки, разную у H, Q и Z (260 432 / 291 444 / 572 562 Б в выполненной
    программе). Она не зависит ни от режима загрузки, ни от документа, ни от маршрута, поэтому
    входит в P и в F ОДИНАКОВО и систематически тянет любое отношение P/F к единице тем сильнее,
    чем меньше данных в прогоне. Головная величина обмена — «только данные»; полный `bytes_in`
    остаётся рядом как проверочная.

    Порядок предпочтения:
    1. колонки оболочки `bytes_in_api` + `bytes_in_zero` (точное разложение по маршрутам шейпера);
    2. `bytes_in − bytes_in_static`, если оболочка пишет только статику;
    3. ничего (колонки не появляются, отчёт печатает «—» и говорит, почему).

    Источник записывается в `traffic_split_source` (`columns` / `static-only` / пусто).
    """
    src = ""
    for direction, parts in (("in", TRAFFIC_IN_PARTS), ("out", TRAFFIC_OUT_PARTS)):
        api, zero, static = parts
        total, data = f"bytes_{direction}", f"bytes_{direction}_data"
        if api in out.columns and zero in out.columns:
            a = pd.to_numeric(out[api], errors="coerce")
            z = pd.to_numeric(out[zero], errors="coerce")
            out[data] = a.add(z, fill_value=0.0).where(a.notna() | z.notna())
            src = src or "columns"
        elif static in out.columns and total in out.columns:
            out[data] = pd.to_numeric(out[total], errors="coerce") - pd.to_numeric(out[static], errors="coerce")
            src = src or "static-only"
    if src:
        out[TRAFFIC_SPLIT_SOURCE_COLUMN] = src


def traffic_split_from_runs(series: str | Path) -> pd.DataFrame | None:
    """Разложение обмена из per-run JSON (`shaper.stats.byRoute`), если в CSV его ещё нет.

    Оболочка до 2026‑09‑14 не писала колонок `bytes_*_api|zero|static`, но сами величины в каждом
    прогоне есть: счётчики шейпера по маршрутам. Читается ТОЛЬКО голова файла (объект `byRoute`
    лежит в первых ~1.5 КБ), поэтому восстановление целой программы (1 014 прогонов) стоит доли
    секунды и не требует разбора многомегабайтных журналов шагов. В программе 2 колонки есть, и этот
    путь остаётся резервным — для серий из `results/archive/**`.

    Соглашение направлений: шейпер считает со своей стороны, поэтому `byRoute[...]​.bytesOut` —
    это байты К КЛИЕНТУ (`bytes_in` в CSV), а `bytesIn` — от клиента (`bytes_out`).
    Возвращает DataFrame `[run_id, bytes_in_api, …]` или None, если журналов нет.
    """
    import json

    p = Path(series)
    base = p if p.is_dir() else p.parent
    files = sorted((base / "runs").glob("*.json")) if (base / "runs").is_dir() else []
    rows: list[dict[str, Any]] = []
    for f in files:
        try:
            head = f.open("rb").read(65536)
        except OSError:
            continue
        i = head.find(b'"byRoute"')
        if i < 0:
            continue
        j = head.find(b"{", i)
        depth, end = 0, -1
        for k in range(j, len(head)):
            ch = head[k : k + 1]
            if ch == b"{":
                depth += 1
            elif ch == b"}":
                depth -= 1
                if depth == 0:
                    end = k + 1
                    break
        if end < 0:
            continue
        try:
            by_route = json.loads(head[j:end].decode("utf-8"))
        except Exception:
            continue
        if not isinstance(by_route, dict):
            continue

        def part(route: str, key: str) -> float:
            v = by_route.get(route)
            return float(v.get(key, 0) or 0) if isinstance(v, dict) else 0.0

        rows.append(
            {
                "run_id": f.stem,
                "bytes_in_api": part("/api", "bytesOut"),
                "bytes_in_zero": part("/zero", "bytesOut"),
                "bytes_in_static": part("/", "bytesOut"),
                "bytes_out_api": part("/api", "bytesIn"),
                "bytes_out_zero": part("/zero", "bytesIn"),
                "bytes_out_static": part("/", "bytesIn"),
            }
        )
    return pd.DataFrame(rows) if rows else None


def harness_identity(passport: dict[str, Any] | None) -> dict[str, Any]:
    """Идентификация ИЗМЕРИТЕЛЬНОЙ ОБОЛОЧКИ серии (`packages/bench`, `scripts`) из паспорта.

    `code.codeId` покрывает собранные клиент и сервер, но НЕ оболочку, а она между половинами
    ПЕРВОЙ программы менялась (`reviews/pass2/critic-3-code.md`, дефект 2). В программе 2 оболочка
    пишет свой хеш сама, и правильный критерий сопоставимости — `harness.comparableBy`
    (`harness_comparable_signature`), а НЕ `harnessId`: последний включает конфигурацию серии и у
    разных серий различается закономерно. Эта функция остаётся для серий, где `comparableBy` нет:
    она возвращает то, что есть, с `harness_id = None`, если хеша нет вовсе, и тогда межсерийные
    сравнения абсолютных величин помечаются как непроверенные.

    Принимаются формы: `passport.harness` (строка или объект с `id`/`benchId`/`sha256`) и
    `passport.code.benchId`.
    """
    out: dict[str, Any] = {"harness_id": None, "code_id": None, "client_build_id": None, "source": None}
    if not isinstance(passport, dict):
        return out
    code = passport.get("code") if isinstance(passport.get("code"), dict) else {}
    out["code_id"] = code.get("codeId")
    out["client_build_id"] = code.get("clientBuildId")
    h = passport.get("harness")
    if isinstance(h, str) and h.strip():
        out["harness_id"], out["source"] = h.strip(), "passport.harness"
    elif isinstance(h, dict):
        for k in ("id", "benchId", "harnessId", "sha256", "hash"):
            v = h.get(k)
            if isinstance(v, str) and v.strip():
                out["harness_id"], out["source"] = v.strip(), f"passport.harness.{k}"
                break
        out.update({k: v for k, v in h.items() if k not in ("id", "benchId", "harnessId", "sha256", "hash")})
    elif isinstance(code.get("benchId"), str):
        out["harness_id"], out["source"] = code["benchId"], "passport.code.benchId"
    return out


def harness_comparable_signature(passport: dict[str, Any] | None) -> tuple[dict[str, str], list[str]] | None:
    """Подпись сопоставимости серии: значения полей, перечисленных в `harness.comparableBy`.

    Оболочка сама объявляет, ПО КАКИМ полям две серии сопоставимы по построению
    (`benchId`, `benchSrcSha256`, `netshaperSrcSha256`, `columnsSha256`, `referenceSha256`), и
    отдельно пишет `harnessId`, который включает ещё и конфигурацию серии — поэтому у разных серий
    он различается ЗАКОНОМЕРНО и сравнивать серии по нему нельзя. Возвращает
    `({поле: значение}, [список полей])` или None, если паспорт такой записи не несёт.
    """
    if not isinstance(passport, dict):
        return None
    h = passport.get("harness")
    if not isinstance(h, dict):
        return None
    fields = h.get("comparableBy")
    if not isinstance(fields, list) or not fields:
        return None
    sig = {str(f): str(h.get(f)) for f in fields if h.get(f) is not None}
    if len(sig) != len(fields):
        return None
    return (sig, [str(f) for f in fields])


def coerce(df: pd.DataFrame, *, scenario_budget: float | None = None) -> pd.DataFrame:
    """Приводит типы и добавляет производные колонки. Отсутствующие колонки не добавляет.

    `scenario_budget` — бюджет сценария серии в мс (см. `scenario_budget_ms`); по нему считается
    `success`. Значение записывается в колонку `scenario_budget_ms`, чтобы дальше его не нужно было
    передавать отдельно и чтобы в отчёте было видно, против какого порога проверена серия.
    """
    out = df.copy()
    budget = float(BUDGET_SCENARIO_MS if scenario_budget is None else scenario_budget)
    for c in NUMERIC_COLUMNS:
        if c in out.columns:
            out[c] = pd.to_numeric(out[c], errors="coerce").astype("float64")
    for c in BOOL_COLUMNS:
        if c in out.columns:
            b = _to_bool_series(out[c])
            out[c] = b.map(lambda v: bool(v) if is_bool(v) else np.nan).astype("object")
    for c in STRING_COLUMNS:
        if c in out.columns:
            out[c] = out[c].astype("object").where(out[c].notna(), None)
            out[c] = out[c].map(lambda v: None if v is None else str(v))
    for c in ("cache", "repetition", "order_index"):
        if c in out.columns:
            out[c] = out[c].astype("Int64")
    # синонимы оболочки для пика Chromium без окон измерительной пробы → каноническое имя
    if CHROMIUM_PEAK_PROBE_FREE not in out.columns:
        for alias in CHROMIUM_PEAK_PROBE_FREE_ALIASES:
            if alias in out.columns:
                out[CHROMIUM_PEAK_PROBE_FREE] = pd.to_numeric(out[alias], errors="coerce")
                break
    for name, parts in DERIVED_COLUMNS.items():
        if name in SERVER_ZERO_BACKGROUND or name in TRAFFIC_DATA_COLUMNS:
            continue  # считается ниже: по `server_zero_applicable` / по разложению обмена
        if all(p in out.columns for p in parts):
            out[name] = out[parts].sum(axis=1, min_count=len(parts))
    _apply_zero_applicability(out)
    _apply_traffic_split(out)
    out[SCENARIO_BUDGET_COLUMN] = budget
    # успех прогона (§7.3): outcome=ok, сценарий в бюджете СЕРИИ, эталон совпал
    if {"outcome", "t_scenario_ms"} <= set(out.columns):
        ref_ok = out["reference_ok"].map(is_true) if "reference_ok" in out.columns else True
        out["success"] = (out["outcome"] == "ok") & (out["t_scenario_ms"] <= budget) & ref_ok
    return out


def load_runs(series: str | Path, *, require_valid: bool = True) -> tuple[pd.DataFrame, ValidationResult]:
    """Загружает runs.csv серии (каталог с runs.csv или путь к CSV).

    Бюджет сценария берётся из паспорта серии (`scenario_budget_ms`), а не из константы §7.4:
    у длинных маршрутов он объявлен явно (40 с у `route-repeat`, 70 с у `route-full`).
    """
    p = Path(series)
    csv_path = p / "runs.csv" if p.is_dir() else p
    if not csv_path.exists():
        raise FileNotFoundError(f"runs.csv not found: {csv_path}")
    df = pd.read_csv(csv_path)
    vr = validate(df)
    if require_valid and not vr.ok:
        raise ValueError(f"{csv_path}: {vr.message()}")
    # Разложение обмена: колонки оболочки — приоритет; если их нет, восстанавливаем из per-run
    # JSON, чтобы «только данные» считались и на сериях, снятых до появления колонок.
    from_runs = False
    if not any(c in df.columns for c in TRAFFIC_IN_PARTS) and "run_id" in df.columns:
        split = traffic_split_from_runs(series)
        if split is not None and not split.empty:
            df = df.merge(split, on="run_id", how="left")
            from_runs = True
    df = coerce(df, scenario_budget=scenario_budget_ms(load_passport(series)))
    if from_runs and TRAFFIC_SPLIT_SOURCE_COLUMN in df.columns:
        df[TRAFFIC_SPLIT_SOURCE_COLUMN] = "runs-json"
    if "series" not in df.columns or df["series"].isna().all():
        df["series"] = p.name if p.is_dir() else p.parent.name
    return df, vr


def load_passport(series: str | Path) -> dict[str, Any] | None:
    p = Path(series)
    f = (p if p.is_dir() else p.parent) / "passport.json"
    if not f.exists():
        return None
    import json

    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_steps(series: str | Path) -> pd.DataFrame | None:
    """Пошаговые данные из per‑run JSON: results/<series>/runs/<run_id>.json
    (или `*.json` в каталоге серии, кроме passport.json) с полем
    `steps:[{step, action?, page_id?, retained_pages, retained_shapes, loaded_pages?, t_ms?}]`.
    Возвращает DataFrame [run_id, adapter, mode, cache, step, retained_pages, retained_shapes, ...] или None.
    """
    import json

    p = Path(series)
    base = p if p.is_dir() else p.parent
    candidates = sorted((base / "runs").glob("*.json")) if (base / "runs").is_dir() else []
    if not candidates:
        candidates = [f for f in sorted(base.glob("*.json")) if f.name != "passport.json"]
    rows: list[dict[str, Any]] = []
    for f in candidates:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(d, dict) or not isinstance(d.get("steps"), list):
            continue
        run_id = d.get("run_id", f.stem)
        cfg = d.get("config", {}) if isinstance(d.get("config"), dict) else {}
        for i, s in enumerate(d["steps"]):
            if not isinstance(s, dict):
                continue
            ret = s.get("retained") if isinstance(s.get("retained"), dict) else {}
            rows.append(
                {
                    "run_id": run_id,
                    "adapter": d.get("adapter", cfg.get("adapter")),
                    "mode": d.get("mode", cfg.get("mode")),
                    "cache": d.get("cache", cfg.get("cache")),
                    "step": s.get("step", i),
                    "action": s.get("action", s.get("type")),
                    "page_id": s.get("page_id", s.get("pageId")),
                    "retained_pages": s.get("retained_pages", ret.get("pages")),
                    "retained_shapes": s.get("retained_shapes", ret.get("shapes")),
                    "loaded_pages": s.get("loaded_pages", s.get("loadedPages")),
                    "t_ms": s.get("t_ms", s.get("t")),
                }
            )
    if not rows:
        return None
    out = pd.DataFrame(rows)
    for c in ("step", "retained_pages", "retained_shapes", "loaded_pages", "t_ms", "cache"):
        out[c] = pd.to_numeric(out[c], errors="coerce")
    return out


def columns_markdown() -> str:
    """Текст COLUMNS.md (генерируется из этого модуля, чтобы не расходиться).

    Описания живут ЗДЕСЬ, а не в COLUMNS.md: файл на диске — вывод этой функции, и тест
    `tests/test_schema.py::test_required_columns_are_fixed_and_documented` сверяет их побайтно.
    Правка описания → правка словарей ниже → регенерация:
        python -c "from analysis.schema import columns_markdown; print(columns_markdown(), end='')" > COLUMNS.md
    """
    lines = [
        "# Колонки `results/<series>/runs.csv` (SPEC §7.3)",
        "",
        "Источник истины — `packages/analysis/analysis/schema.py` (`REQUIRED_COLUMNS`). Одна строка = один прогон.",
        "Единицы: время — миллисекунды (`_ms`), память — МБ (`_mb`, JS‑куча, 10⁶ байт) или МиБ (`_mib`, 2²⁰ байт), трафик — байты.",
        "Пустое значение (`\'\'`) = метрика не измерена (например, прогон с `outcome=error`). Булевы — `true`/`false`.",
        "",
        "## Обязательные колонки",
        "",
        "| Колонка | Тип | Смысл |",
        "|---|---|---|",
    ]
    desc = {
        "run_id": ("str", "уникальный идентификатор прогона (UUID или `<series>-<order_index>`)"),
        "series": (
            "str",
            "имя серии выполненной программы (одиннадцать серий, 1 014 прогонов): приёмочная `main`; "
            "контролируемая ось размера при фиксированной доле посещения — `size-fraction-25x500`, "
            "`size-fraction-50x500`, `size-fraction-100x500`; окно кеша с армом F — `route-repeat` (1/3/10) и "
            "`cache3`; форма команды — `command-shape`; доля просмотренного документа — `route-full`; канал — "
            "`rtt150`; крайние точки неконтролируемой оси размера — `doc5x100`, `doc50x1000`. Серии программы 1 "
            "`cache10`, `doc10x200`, `doc100x500` не переснимались (неинформативны или перекрыты) и лежат в "
            "`results/archive/programme-1`",
        ),
        "adapter": ("H|Q|Z", "адаптер данных"),
        "mode": ("F|P", "режим загрузки: полный / частичный"),
        "cache": ("int", "окно кеша неактивных страниц (P); в F — как задано в URL (1)"),
        "doc": ("str", "id документа"),
        "repetition": ("int", "номер повторения конфигурации (0..N-1)"),
        "order_index": ("int", "порядковый номер прогона в перемешанной серии"),
        "started_at": ("ISO‑8601", "время начала прогона"),
        "outcome": ("ok|error|timeout", "исход прогона; ошибки не отбрасываются"),
        "error_stage": ("str", "этап ошибки (`open`, `nav_3`, `command`, `sampling`, `reference`, …) или пусто"),
        "t_first_ready_ms": ("float", "navigation start → готовность страницы 1"),
        "t_nav_1_ms … t_nav_10_ms": (
            "float",
            "клик по странице → готовность; маршрут задаётся серией "
            "(`passport.json → seriesConfig.scenario.route`), в приёмочном §7.2 это 2,3,1,4,2,5,1,6,3,50. "
            "Колонок ровно десять, поэтому у маршрутов длиннее §7.2 (`route-full` — 49 переходов, "
            "`route-repeat` — 18) здесь видны только **первые десять**, а полный список — в `t_nav_ms_list`",
        ),
        "t_nav_new_median_ms": (
            "float",
            "медиана переходов на страницы, которые в этом прогоне ещё **не посещались**. Принадлежность "
            "«новый/возврат» оболочка определяет ПО ХОДУ маршрута (множество посещённых, "
            "`packages/bench/src/scenario/acceptance.mjs`), а не по фиксированным номерам, поэтому набор переходов "
            "зависит от маршрута серии. Для приёмочного маршрута §7.2 (`main`, `cache3`, `doc50x1000`, `rtt150`, "
            "`command-shape`) новые — переходы **1, 2, 4, 6, 8, 10**; в серии "
            "`doc5x100` маршрут `[2,3,1,4,2,5,1,3,2,5]` на документе из 5 страниц, и новых там только **1, 2, 4, 6**; "
            "в `route-full` новые — **все 49**, возвратов нет вовсе (медиана возвратов пуста); в `route-repeat` — "
            "**12 новых и 6 возвратов**. Сколько значений вошло в каждую медиану, видно в `t_nav_new_count` / "
            "`t_nav_return_count`. "
            "**Следствие: `t_nav_new/return` сравнимы только ВНУТРИ серии** — между сериями с разными маршрутами "
            "это медианы по разным наборам переходов",
        ),
        "t_nav_return_median_ms": (
            "float",
            "медиана возвратов на уже посещённую страницу. Для маршрута §7.2 — переходы 3, 5, 7, 9; в `doc5x100` — "
            "3, 5, 7, 8, 9, 10 (см. предыдущую строку)",
        ),
        "t_cmd_ack_ms": (
            "float",
            "отправка команды → подтверждение сервера с результатом операции (`command-acked`). Как и все "
            "`t_cmd_*`, считается по журналу событий страницы (см. врезку «Откуда берутся `t_cmd_*`» ниже)",
        ),
        "t_cmd_drawn_ms": (
            "float",
            "отправка команды → **фактическое** обновление холста (`command-drawn`). Фиксируется по отрисовке страницы "
            "с ревизией ≥ `expectedRevision+1` и **не ждёт подтверждения**: у Z это значение регулярно МЕНЬШЕ "
            "`t_cmd_ack_ms` (ack требует отдельного `GET /api/operations/:opId`). §1.8: «время отсчитывается до "
            "фактического обновления холста, подтверждение сервера регистрируется отдельно». Значение — из журнала "
            "событий (диспетчеризация `command-drawn`), точный момент отрисовки — "
            "`scenario.command_timings[].drawnAt`; разница +0.5 мс медиана, +3.2 мс максимум по 540 прогонам "
            "(врезка ниже)",
        ),
        "t_scenario_ms": (
            "float",
            "время сценария с объявленными паузами, **без** накладных расходов оболочки: "
            "`t_scenario_wall_ms − probe_overrun_ms`. По нему считается `success` — но **против бюджета серии**, а не "
            "против общего порога: бюджет берётся из паспорта (`scenario.budgets.scenarioMs`) и равен 30 000 мс для "
            "маршрута §7.2, **40 000** у `route-repeat` и **70 000** у `route-full` (объявленные паузы длинных "
            "маршрутов сами по себе дают 18 и 49 с). Границы: от navigationStart до готовности ПОСЛЕДНЕГО действия "
            "маршрута; завершающей паузы после него нет — сценарий кончается действием, а не паузой, поэтому "
            "объявленных пауз ровно столько же, сколько действий (11 в маршруте §7.2: по одной перед каждым из "
            "10 переходов и одна перед командой)",
        ),
        "bytes_in": ("int", "байт к клиенту по шейперу"),
        "bytes_out": ("int", "байт от клиента по шейперу"),
        "cdp_bytes_in": ("int", "байт к клиенту по CDP `Network.*` (перекрёстная проверка)"),
        "js_heap_peak_mb": (
            "float",
            "пик `Runtime.getHeapUsage().usedSize`, МБ. Опрос по таймеру `js_heap_sample_interval_ms` (250 мс, как "
            "частная память) плюс по одной пробе на границе каждого шага, снимаемой ДО обращения к странице и ДО "
            "сборки мусора. Опрос приостановлен только на время двух точных сканов хранилища и выгрузки снимков — "
            "три окна, одни и те же у всех адаптеров (суммарно `js_heap_suspended_ms`), — поэтому копия строк, "
            "созданная инструментом, в пик не попадает. Число фактических сэмплов — `js_heap_samples`; расписание "
            "принудительных сборок одинаково у всех конфигураций, что подтверждается `js_heap_gc_count`",
        ),
        "js_heap_end_mb": (
            "float",
            "`usedJSHeapSize` в момент остановки часов сценария (до выгрузки снимков и заключительного скана хранилища), МБ",
        ),
        "chromium_private_peak_mib": (
            "float",
            "пик суммы Private_Clean+Private_Dirty всех процессов Chromium, МиБ. Пусто, если сэмплер не нашёл процессов "
            "экземпляра: такой прогон помечен `sampling_incomplete` и учтён как `outcome=error` (память клиента — "
            "существенная величина), нуля здесь не бывает",
        ),
        "chromium_private_end_mib": ("float", "та же сумма в конце сценария, МиБ"),
        "client_storage_bytes": ("int", "оценка IndexedDB/localStorage приложения в конце"),
        "retained_pages_end": (
            "int",
            "удерживаемые страницы в конце: **точный** подсчёт `getRetainedAsync()` (у Z — скан клиентского хранилища), "
            "выполняется после остановки часов сценария. Численно равен `retained_pages_end_exact` — это один и тот же "
            "скан в одной и той же точке; сравнивать адаптеры между собой следует по нему",
        ),
        "retained_shapes_end": ("int", "то же для фигур (равен `retained_shapes_end_exact`)"),
        "retained_pages_max": (
            "int",
            "максимум по шагам + после команды + конечный. С 2026-09-13 расписание проб одинаково у всех адаптеров "
            "(`retained_probe_mode = cached-steps+exact-after-cmd-and-end`): **ни один шаг** точного скана не делает, "
            "шаг берёт собственное (кешированное) значение адаптера, а точные сканы остаются ровно в двух точках — "
            "после команды и в конце. Поэтому максимум отвечает на вопрос «что адаптер сам считает удержанным» "
            "(у H/Q это точный размер `Map`/`queryCache`, у Z — кеш, обновляемый асинхронно после complete/вытеснения); "
            "вывод об окне кеша делается по `retained_*_end_exact`",
        ),
        "retained_shapes_max": ("int", "то же для фигур"),
        "loaded_pages_end": ("int", "`getLoadedPages().length` в конце"),
        "server_api_cpu_ms": ("float", "CPU‑время процесса API за прогон, мс"),
        "server_api_mem_peak_mib": (
            "float",
            "пик **частной** памяти API (`Private_Clean+Private_Dirty` из `smaps_rollup`; при недоступности "
            "`smaps_rollup` — RSS, тогда в записи прогона `mem_fallback_rss`), МиБ. Полный RSS — в служебной "
            "`server_api_rss_peak_mib`",
        ),
        "server_api_mem_integral_mib_s": ("float", "∫ частной памяти API dt, МиБ·с"),
        "server_pg_cpu_ms": ("float", "CPU‑время процессов PostgreSQL, мс"),
        "server_pg_mem_peak_mib": (
            "float",
            "пик суммарной частной памяти процессов PostgreSQL, МиБ (RSS — в `server_pg_rss_peak_mib`)",
        ),
        "server_pg_mem_integral_mib_s": ("float", "∫ частной памяти PostgreSQL dt, МиБ·с"),
        "server_zero_cpu_ms": (
            "float",
            "CPU‑время zero‑cache, мс. С 2026-09-13 группа сэмплируется в **каждом** прогоне (§1.2, дефект A8), "
            "поэтому в прогонах H/Q здесь **не ноль**, а измеренный фон компонента, который работает на стенде "
            "постоянно и нужен только профилю Z. Принадлежность бюджету конфигурации — в `server_zero_applicable`: "
            "`true` (прогон Z) — часть серверного бюджета, `false` (H/Q) — фон, к их бюджету не прибавляется. "
            "**Пусто** — сэмплер работал и не нашёл ни одного процесса, то есть измерения не было "
            "(`sampling_incomplete`; в прогоне Z такой прогон ещё и `outcome=error`). Нуля «по построению» больше нет",
        ),
        "server_zero_mem_peak_mib": (
            "float",
            "пик частной памяти zero‑cache, МиБ (RSS — в `server_zero_rss_peak_mib`). В H/Q это измеренный фон, "
            "см. `server_zero_applicable`; пусто — не измерено. Величина почти не зависит от адаптера: в "
            "`results/main` медианы 603.2–603.4 МиБ у H/Q и 604.4–604.9 у Z (RSS ≈ 929 и ≈ 930), то есть "
            "zero‑cache резидентен и в прогонах H/Q — DEVIATIONS 4.2",
        ),
        "server_zero_mem_integral_mib_s": ("float", "∫ частной памяти zero‑cache dt, МиБ·с (в H/Q — фон; пусто — не измерено)"),
        "zero_replica_bytes": (
            "int",
            "размер каталога реплики zero‑cache на диске. С 2026-09-13 замеряется в **каждом** прогоне "
            "(в выполненной программе — 35.7 МиБ во всех 540, независимо от адаптера); прежнего «0 для H/Q» больше нет",
        ),
        "within_budget_first": ("bool", "t_first_ready_ms ≤ 2000"),
        "within_budget_nav": ("bool", "все t_nav_i_ms ≤ 1000"),
        "within_budget_cmd": ("bool", "t_cmd_drawn_ms ≤ 2000"),
        "within_budget_scenario": (
            "bool",
            "t_scenario_ms ≤ бюджета сценария СЕРИИ (по инструмент‑free значению): 30 000 мс для маршрута §7.2, "
            "40 000 у `route-repeat`, 70 000 у `route-full` — порог объявлен в паспорте "
            "(`scenario.budgets.scenarioMs`) и повторён анализом в производной колонке `scenario_budget_ms`",
        ),
        "reference_ok": ("bool", "все проверки эталона (БД + снимки) прошли"),
    }
    listed: set[str] = set()
    for c in REQUIRED_COLUMNS:
        if c in NAV_COLUMNS:
            key = "t_nav_1_ms … t_nav_10_ms"
        else:
            key = c
        if key in listed:
            continue
        listed.add(key)
        t, d = desc.get(key, ("", ""))
        lines.append(f"| `{key}` | {t} | {d} |")

    # Необязательные колонки: ключ → описание (одна колонка «Смысл», тип выводится из значения).
    optional_desc: list[tuple[str, str]] = [
        ("doc_pages", "число страниц документа — для проверки «удержано ≤ окно» в F и абсолютных долей"),
        ("doc_shapes_per_page", "фигур на страницу — для проверки `retained_shapes_max ≤ (cache+1)·shapes_per_page`"),
        ("rtt_ms`, `bandwidth_mbps", "параметры шейпера прогона"),
        ("seed`, `finished_at`, `error_message`, `commit`, `notes", "служебные"),
        (
            "t_cmd_server_ms",
            "отправка → подтверждение мутации **транспортом**: Z — `mutate().server`, H/Q — ответ POST. Без чтения журнала операций",
        ),
        (
            "t_cmd_opget_ms",
            "`t_cmd_ack_ms − t_cmd_server_ms` — цена протокола подтверждения. У H/Q ≈ 0 (результат в теле ответа), "
            "у Z — HTTP‑круг `GET /api/operations/:opId` (через шейпер ≈ 60 мс). Именно эта величина раньше молча "
            "входила в `t_cmd_drawn_ms` у Z",
        ),
        (
            "t_cmd_synced_ms",
            "отправка → данные команды в клиентском хранилище активной страницы (Z — синхронизация со сверкой "
            "содержимого, H/Q — завершённое перечитывание). Отрисовка ещё не выполнена: "
            "`t_cmd_drawn_ms − t_cmd_synced_ms` — цена кадра",
        ),
        ("cmd_drawn_before_ack", "bool: холст обновился раньше подтверждения сервера (норма для Z)"),
        ("t_scenario_wall_ms", "сырое время сценария: navigationStart → последняя готовность, включая накладные расходы оболочки"),
        (
            "probe_overrun_ms",
            "суммарное превышение объявленных пауз измерительной пробой. Пауза 1 с отсчитывается от готовности "
            "предыдущего действия, следующее действие выполняется ровно в `t_ready + 1000` мс (ожидание идёт в часах "
            "страницы); если проба не уложилась, разница попадает сюда и вычитается из `t_scenario_ms`",
        ),
        (
            "t_scenario_model_ms",
            "**независимая** реконструкция `t_scenario_ms` по журналу событий страницы "
            "(`bench` → `scenarioModelFromJournal`): `t` первого `page-ready` + Σ (`page-ready` − `page-select`) по "
            "переходам + (число пауз)·`pauseMs` + (max(`command-acked`, `command-drawn`) − `command-sent`). Слагаемые "
            "берутся из событий страницы, а не из бухгалтерии оболочки, поэтому это настоящая сверка: прежняя "
            "«модель» складывалась из тех же `t_nav`, из которых вычиталась, и её остаток был нулевым **по "
            "построению** (дефект N5)",
        ),
        (
            "t_scenario_model_residual_ms",
            "`t_scenario_ms − t_scenario_model_ms`. В остаток входит время от клика до `page-select` (диспетчеризация) "
            "и любое расхождение в сопоставлении событий. Норма — единицы миллисекунд (выполненная программа, "
            "540 прогонов: **3.9–15.1 мс**, медиана 5.2, 95‑й процентиль 6.6; по сериям медианы 5.0–5.3); "
            "десятки и больше означают пропущенный шаг, лишний `page-select`, "
            "не ту страницу или не ту команду — повод смотреть `events[]` прогона",
        ),
        ("probe_total_ms", "суммарная длительность измерительных проб (диагностика; в паузах, не в часах сценария)"),
        (
            "retained_probe_mode",
            "политика проб удержания. С 2026-09-13 она ОДИНАКОВА для всех адаптеров, режимов и документов и равна "
            "`cached-steps+exact-after-cmd-and-end`: на каждом шаге — только дешёвая проба `getRetained()` "
            "(собственное значение адаптера), точный скан `getRetainedAsync()` — ровно в двух фиксированных точках "
            "(сразу после команды и в конце, после остановки часов сценария). Прежние значения `exact` / "
            "`exact-until-step` (скан на каждом шаге, пока он дешевле порога 150 мс) встречаются только в сериях до "
            "этой даты: при них расписание проб и, как следствие, давление сборщика мусора зависели от адаптера "
            "(дефекты N2/N4)",
        ),
        (
            "retained_pages_end_exact`, `retained_shapes_end_exact",
            "результат точного скана хранилища в конце прогона — тот же скан и та же точка у всех адаптеров, то есть "
            "**сравнимая** между ними величина; по ней и делается вывод об окне кеша. Численно совпадает с "
            "`retained_*_end`, но названа отдельно, чтобы сравнение не опиралось на колонку, смысл которой у "
            "адаптеров мог бы разойтись",
        ),
        ("js_heap_samples`, `js_heap_sample_interval_ms", "сколько сэмплов кучи и с каким шагом дали `js_heap_peak_mb`"),
        (
            "js_heap_gc_count",
            "число принудительных `HeapProfiler.collectGarbage` за прогон. Точки вызова фиксированы и не зависят ни от "
            "адаптера, ни от режима, ни от вида пробы (после каждой шаговой пробы — 11, после снимка каждого "
            "посещения — 11, после пробы вслед за командой, в момент остановки часов, после выгрузки снимков и после "
            "заключительного скана) — **26 вызовов** при штатном маршруте. Величина обязана совпадать у всех "
            "конфигураций: расхождение означает, что `js_heap_peak_mb` и `chromium_private_peak_mib` измерены при "
            "разном давлении сборщика и между адаптерами несравнимы (дефект N2; выполненная программа — **26 во "
            "всех 540 прогонах** восьми серий, было ≈13 у H/Q против 2–3 у Z/F)",
        ),
        (
            "js_heap_post_gc_mb",
            "куча сразу после принудительной сборки в фиксированной точке «остановка часов сценария», МБ. В отличие "
            "от `js_heap_peak_mb` / `js_heap_end_mb` не зависит от того, когда сборщик решил сработать сам; в пик не "
            "входит (опрос на это время приостановлен)",
        ),
        (
            "js_heap_suspended_ms",
            "сколько всего опрос кучи был приостановлен: два точных скана хранилища + выгрузка снимков. Окна одни и "
            "те же у всех адаптеров; у Z/F величина больше просто потому, что дороже сам скан (≈25 000 строк)",
        ),
        (
            "sampling_incomplete",
            "перечень сэмплеров (разделены вертикальной чертой), не нашедших ни одного процесса в этом прогоне: "
            "`chromium`, `api`, `pg`, "
            "`zero`. Пусто = все нужные прогону сэмплеры измеряли реальные процессы. Соответствующие `server_*` / "
            "`chromium_*` колонки в такой строке ПУСТЫ, а не нули; если не измерена существенная величина (память "
            "Chromium, API или PostgreSQL в любом прогоне, zero‑cache в прогоне Z), прогон записан как `outcome=error` "
            "с `error_stage=sampling` и результатом не считается",
        ),
        (
            "sampling_ticks",
            "полнота выборки по каждому сэмплеру: `имя=совпало/ожидалось`, записи разделены вертикальной чертой "
            "(например `chromium=54/54` `api=54/54` `pg=54/54` `zero=54/54`). Полнота перестала быть двоичной "
            "(дефект N6): группа, "
            "найденная лишь в части опросов, публикует заниженные `cpu_ms` и `mem_integral_mib_s`, поэтому при "
            "покрытии < 90 % она помечается `<имя>:partial` в `sampling_incomplete`, а если существенна для "
            "прогона — прогон записан как ошибочный, а не как «результат»",
        ),
        (
            "server_zero_applicable",
            "входит ли zero‑cache в серверный бюджет адаптера этого прогона. `true` — прогон Z (§1.2: «дополнительный "
            "сервер нельзя исключать из бюджета»); `false` — прогон H/Q: группа **сэмплирована**, её расход измерен, "
            "но это фон компонента, нужного только профилю Z, и к бюджету H/Q он не прибавляется. Это не «не "
            "применимо» и не «не измерено»: неизмеренная величина — пустая ячейка `server_zero_*`. Анализ учитывает "
            "колонку в суммах `server_*_total` (вклад zero — только при `true`) и публикует фон отдельно "
            "(`server_zero_background_*`)",
        ),
        (
            "server_disk_used_bytes",
            "занято на диске серверной частью на конец прогона: каталог данных PostgreSQL + каталог реплики "
            "zero‑cache, байты. §1.7: бюджет 40 ГиБ, порог остановки 32 ГиБ; разложение по каталогам — в записи "
            "прогона (`server_disk.dirs`)",
        ),
        (
            "route_len`, `route_distinct_pages",
            "длина маршрута серии (число переходов) и число РАЗНЫХ страниц, которых он касается, включая страницу "
            "открытия. Вместе они задают долю документа, которую сценарий вообще просматривает: `main` — 10 переходов "
            "и 7 из 50 страниц, `route-repeat` — 18 и 13, `route-full` — 49 и все 50. Без этой пары строка CSV не "
            "говорит, что именно измерено, и серии с разными маршрутами нельзя сравнивать осознанно",
        ),
        (
            "t_nav_count`, `t_nav_new_count`, `t_nav_return_count",
            "сколько переходов измерено всего и сколько из них классифицированы как новые / возвраты (по факту "
            "посещения, см. `t_nav_new_median_ms`). У маршрута §7.2 — 10/6/4, у `route-full` — 49/49/**0**, у "
            "`route-repeat` — 18/12/6. Это знаменатели медиан `t_nav_new/return`: при `t_nav_return_count = 0` "
            "медиана возвратов пуста не по ошибке, а потому, что возвратов в маршруте нет",
        ),
        (
            "t_nav_median_ms`, `t_nav_ms_list",
            "медиана ВСЕХ переходов прогона и полный их список через `|`, в порядке маршрута. Нужны длинным "
            "маршрутам: колонок `t_nav_1…10` хватает только маршруту §7.2, поэтому у `route-full` (49 переходов) и "
            "`route-repeat` (18) суждение о переходах делается по `t_nav_median_ms`, а поэлементная проверка — по "
            "`t_nav_ms_list` (там же видно, какой именно переход не уложился в 1 с)",
        ),
        (
            "nav_cache_hits`, `nav_cache_misses",
            "переходы, при которых страница **ещё удерживалась** клиентом перед кликом (`getLoadedPages()` из пробы "
            "предыдущего шага), и переходы, при которых её пришлось загружать. Считаются ОДИНАКОВО у H, Q и Z, "
            "поэтому промах окна — единственная величина повторной материализации, сравнимая между всеми тремя "
            "адаптерами (у Z HTTP‑чтений страниц нет). Промах определяется кешем, а не маршрутом: возврат на "
            "вытесненную страницу — одновременно `is_return` и промах (`packages/bench/README.md` §3)",
        ),
        (
            "page_loads_observed",
            "`nav_cache_misses + 1` — загрузок страниц за прогон вместе с открытием документа. В F равно 1: все "
            "страницы приходят при открытии, промахов нет по устройству режима",
        ),
        (
            "api_page_reads`, `api_page_reads_distinct`, `api_page_read_bytes",
            "HTTP‑чтения `GET /api/documents/*/pages/*` по CDP: сколько всего, сколько разных страниц и сколько байт "
            "в ответах. **У Z это 0 — измерение, а не пропуск**: страницы приходят синхронизацией, и сравнивать "
            "его повторные чтения с H/Q можно только через `nav_cache_misses`. У H/Q величина восстанавливает модель "
            "перечитывания: `api_page_reads = 1 (открытие) + nav_cache_misses + возвраты на удерживаемую страницу, "
            "которую команда пометила устаревшей` — последнее слагаемое и есть цена перечитывания после изменения",
        ),
        (
            "cmd_variant`, `cmd_target_id",
            "вариант команды серии (`variants`, `packages/bench/README.md` §4.2) и фактический `targetId` "
            "`setSourceFill`. Пусто в сериях без вариантов. В `command-shape` это `baseline` (81 изменённая фигура на "
            "10 страницах), `concentrated` (81 на 2), `spread` (51 на 50), `large-share` (2001 на 50); анализ "
            "включает колонку в ключ конфигурации, поэтому варианты не усредняются друг с другом",
        ),
        (
            "wall_ms`, `browser_launch_ms`, `cdp_bytes_out`, `cdp_ws_bytes_in`, `cdp_ws_bytes_out`, `shaper_requests`, "
            "`shaper_connections`, `cmd_revision`, `cmd_affected_pages`, `cmd_affected_shapes`, `server_*_rss_peak_mib`, "
            "`chromium_processes_peak",
            "служебные колонки оболочки (`packages/bench/README.md` §5); принимаются валидатором, в отчёт не выносятся",
        ),
        (
            "client_transfer_bytes_in`, `client_transfer_bytes_out",
            "сумма РАСПАКОВАННЫХ тел запросов/ответов в байтах UTF‑8, посчитанная самим клиентом "
            "(`window.__stand.transfer`). Не трафик: без заголовков, без WebSocket и без транспортного сжатия — "
            "с `bytes_*` (шейпер) и `cdp_bytes_*` не сопоставима",
        ),
        (
            "bytes_in_api`, `bytes_in_zero`, `bytes_in_static",
            "**разложение входящего обмена по назначению** (счётчики шейпера по маршрутам `/api`, `/zero`, `/`): "
            "данные API, кадры синхронизации Zero и статика сборки. Статика — поадаптерная КОНСТАНТА "
            "(в выполненной программе 260 432 Б у H, 291 444 у Q, 572 562 у Z), одинаковая в F и в P, поэтому "
            "в отношении P/F она тянет результат к единице тем сильнее, чем меньше в прогоне данных; "
            "`docs/DEVIATIONS.md` §3.1 требует её вычитать. Если колонок нет, анализ восстанавливает их из "
            "`shaper.stats.byRoute` в per‑run JSON (`traffic_split_from_runs`) и помечает источник в "
            "`traffic_split_source`",
        ),
        ("bytes_out_api`, `bytes_out_zero`, `bytes_out_static", "то же для исходящего направления"),
        (
            "chromium_private_peak_excl_probe_mib",
            "пик частной памяти Chromium **с исключением окон измерительной пробы** (точный скан хранилища). "
            "Сэмплер кучи на время скана приостанавливается, сэмплер `procfs` — исторически нет, а скан после "
            "команды у Z/F стоит ≈ 955 мс против 38.7 у H/F и материализует ≈ 25 000 объектов, то есть сырой "
            "`chromium_private_peak_mib` у Z содержит инструмент, а не адаптер. Сравнимая между адаптерами "
            "величина — эта; сырой пик остаётся рядом. Принимается также синоним "
            "`chromium_private_peak_noprobe_mib`, а для конца прогона — "
            "`chromium_private_end_excl_probe_mib` (та же политика, но для последней выборки, "
            "а не для максимума)",
        ),
        (
            "bytes_in_other`, `bytes_out_other",
            "остаток разложения обмена по маршрутам шейпера: всё, что не попало ни в `/api`, ни в `/zero`, ни в "
            "статику сборки (служебные запросы вроде `favicon.ico`, редиректы, ответы вне известных префиксов). "
            "В головную величину «данные» **не входит**: `bytes_in_data = bytes_in_api + bytes_in_zero`. "
            "В выполненной программе равен 0 во всех 1 014 прогонах, поэтому «данные + статика» исчерпывают "
            "весь обмен; ненулевое значение означало бы, что часть обмена осталась неклассифицированной и "
            "отношения P/F считаются по неполному разложению",
        ),
        (
            "bytes_in_route_residual`, `bytes_out_route_residual",
            "**контрольная величина**: (`*_api + *_zero + *_static + *_other`) − итог (`bytes_in` / `bytes_out`). "
            "Обязана быть нулём в КАЖДОМ прогоне — это доказательство полноты разложения, а не оценка. До "
            "2026‑09‑13 кадры уже открытого WebSocket не относились ни к какому маршруту, и остаток был "
            "отрицательным; в выполненной программе он равен 0 везде (проверка — раздел «Обмен данными против "
            "полного объёма» в отчёте серии). Ненулевой остаток обесценивает любое число «только данные»",
        ),
        (
            "chromium_private_peak_raw_mib",
            "тот же пик частной памяти Chromium, но по ВСЕМ выборкам `procfs`, включая попавшие в окна "
            "измерительных проб. Историческая колонка `chromium_private_peak_mib` оставлена равной ей ради "
            "совместимости схемы (проверяется тождеством при чтении), поэтому две эти колонки — одно и то же "
            "число под двумя именами, а сравнимая между адаптерами величина — `chromium_private_peak_excl_probe_mib`",
        ),
        (
            "chromium_probe_ticks`, `chromium_samples",
            "сколько выборок сэмплера `procfs` пришлось на окна измерительных проб и сколько выборок было "
            "всего за прогон. Отношение `ticks / samples` — доля наблюдений, которые исключены из "
            "`chromium_private_peak_excl_probe_mib`: по нему видно, насколько «пик без пробы» опирается на "
            "меньшую выборку, чем сырой (у Z доля выше, потому что точный скан хранилища там длиннее)",
        ),
        (
            "server_api_mem_peak_excl_probe_mib`, `server_pg_mem_peak_excl_probe_mib`, "
            "`server_zero_mem_peak_excl_probe_mib",
            "пики памяти серверных групп (`api`, `postgres`, `zero-cache`) с исключением тех же окон проб — "
            "политика у всех сэмплеров одна. Нужны, чтобы бюджет «сервер ≤ 8 ГиБ» проверялся по величине, не "
            "содержащей инструмент; в выполненной программе серверные пики от окон проб практически не зависят "
            "(скан идёт в браузере), и совпадение с сырыми пиками — самостоятельная проверка того, что "
            "исключение окон не удаляет полезный сигнал",
        ),
        (
            "probe_window_count`, `probe_window_ms",
            "сколько окон измерительных проб было в прогоне и сколько миллисекунд они заняли суммарно. "
            "**`probe_window_count` — проверка паритета политики проб**: он обязан совпадать у всех конфигураций "
            "серии (в `main` это 14 у всех шести), иначе адаптеры измерены разным инструментом. "
            "`probe_window_ms` при этом у адаптеров разная — это измеренное свойство адаптера (точный скан "
            "хранилища у Z/F дороже), а не нарушение паритета",
        ),
        (
            "js_heap_sampler_coverage",
            "`js_heap_samples × js_heap_sample_interval_ms / t_scenario_wall_ms` — доля времени прогона, "
            "покрытая опросом JS‑кучи. Сэмплер кучи ПРИОСТАНАВЛИВАЕТСЯ на время точного скана и выгрузки "
            "снимков, а длительность этих пауз у адаптеров разная, поэтому `js_heap_peak_mb` снят по разному "
            "окну наблюдения и читается только вместе с этой колонкой: покрытие 0.79 означает, что пятая часть "
            "прогона в пик кучи не попала вовсе",
        ),
        (
            "harness_id",
            "первые 16 символов `passport.harness.harnessId` — идентичность измерительной оболочки "
            "(sha256 по `packages/bench/src/**`, `packages/netshaper/src/**`, конфигурации серии и набору "
            "колонок), продублированная в каждую строку CSV. **Различается у разных серий по построению**, "
            "потому что включает конфигурацию серии; сопоставимость абсолютных величин задаёт не он, а "
            "`passport.harness.comparableBy` (`benchId`, `benchSrcSha256`, `netshaperSrcSha256`, "
            "`columnsSha256`, `referenceSha256`) — у всех одиннадцати серий выполненной программы они совпадают",
        ),
    ]
    lines += ["", "## Необязательные колонки", "", "| Колонка | Смысл |", "|---|---|"]
    for key, text in optional_desc:
        lines.append(f"| `{key}` | {text} |")

    lines += [
        "",
        "### Откуда берутся `t_cmd_*` (и чем они отличаются от `command_timings[]`)",
        "",
        "Все колонки `t_cmd_ack_ms`, `t_cmd_drawn_ms`, `t_cmd_server_ms`, `t_cmd_synced_ms` считаются оболочкой",
        "**по журналу событий страницы**: `t` события (`command-acked` / `command-drawn` / `command-server` /",
        "`command-synced`) минус `t` события `command-sent`, где `t = performance.now()` в момент",
        "**диспетчеризации** события (`packages/bench/src/scenario/acceptance.mjs`, `emit` в",
        "`packages/client/src/stand.ts`). Это НЕ `drawnInfo.at` и не поля `timing.*`: сам клиент фиксирует",
        "момент отрисовки во втором `requestAnimationFrame` после `draw()` и кладёт его в",
        "`scenario.command_timings[]` (`sentAt`, `serverAt`, `syncedAt`, `ackedAt`, `drawnAt`, `opGetMs`) —",
        "**это и есть точный источник**, если нужны моменты без накладных расходов диспетчеризации.",
        "",
        "Расхождение между CSV и `command_timings[]` измерено по всем 540 прогонам выполненной программы",
        "(4 величины × 540 = 2 160 сравнений): смещение **равномерное и положительное, медиана +0.5 мс,",
        "максимум +3.2 мс** (минимум +0.2). По адаптерам оно одинаково — медианы 0.40–0.50 мс у H, Q и Z",
        "(`t_cmd_drawn`: 0.50 / 0.50 / 0.50; максимум +3.2 мс — один прогон Z), поэтому на сравнение",
        "адаптеров не влияет и на бюджет команды (2 000 мс) не влияет тем более. Если нужна точность лучше",
        "миллисекунды — брать `command_timings[]` из записи прогона, а не колонки CSV.",
        "",
        "**Чего в CSV сознательно нет.** `RetainedStats.bytesEstimate` (= `shapes × 200 Б`) — СИНТЕТИЧЕСКАЯ константа,",
        "одинаковая для всех адаптеров и не зависящая от фактического представления строк (`Map`, `queryCache`,",
        "b‑tree Zero). В записи прогона она доступна как `steps[].retained_bytes_synthetic`, но метрикой памяти",
        "не является и в отчёт как память не выносится; память клиента — только `chromium_private_*`, `js_heap_*`",
        "и `client_storage_bytes`.",
        "",
        "## Производные (считает анализ, в CSV не пишутся)",
        "",
        "`scenario_budget_ms` — бюджет сценария СЕРИИ, прочитанный из паспорта (`scenario.budgets.scenarioMs`)",
        "и по умолчанию равный 30 000 мс (§7.4). По нему считаются `success` и бюджет «сценарий в пределах порога»,",
        "поэтому у `route-repeat` (40 000) и `route-full` (70 000) отчёт проверяет их собственный порог и называет его",
        "в заголовке таблицы. Проверять длинный маршрут порогом 30 с нельзя: объявленные паузы §1.2 дают там 18 и 49 с",
        "сами по себе.",
        "",
        "`server_cpu_ms_total`, `server_mem_peak_mib_total`, `server_mem_integral_mib_s_total` — серверные суммы",
        "**бюджета конфигурации**: слагаемое zero‑cache входит в них только там, где `server_zero_applicable=true`",
        "(прогоны Z). В прогонах H/Q измеренный расход zero‑cache — фон, он публикуется отдельными производными",
        "`server_zero_background_cpu_ms` и `server_zero_background_mem_peak_mib`. Если колонки `server_zero_applicable`",
        "в серии нет (до 2026-09-13, когда `server_zero_*` были нулями по построению), суммы считаются по‑старому.",
        "Также `bytes_total` и `success` = `outcome==\'ok\' ∧ t_scenario_ms ≤ scenario_budget_ms ∧ reference_ok`.",
        "",
        "`bytes_in_data` / `bytes_out_data` — **обмен данными**: `*_api + *_zero`, то есть весь обмен, кроме статики",
        "сборки. Это ГОЛОВНАЯ величина обмена во всех таблицах и во всех отношениях P/F; полный `bytes_in`",
        "печатается рядом как проверочный, а размер статики — отдельной строкой, чтобы разницу можно было",
        "восстановить. Если оболочка пишет только `bytes_in_static`, данные считаются вычитанием;",
        "`traffic_split_source` говорит, откуда взято разложение (`columns` — колонки оболочки, `runs-json` —",
        "восстановлено из счётчиков шейпера в записях прогонов, пусто — разложения нет и таблицы «только данные»",
        "не строятся).",
        "",
        "## Per‑run JSON (необязательно, для графика удержания по шагам)",
        "",
        "`results/<series>/runs/<run_id>.json`:",
        "```json",
        '{"run_id": "...", "adapter": "H", "mode": "P", "cache": 1,',
        ' "steps": [{"step": 0, "action": "open", "page_id": "p1", "t_ms": 812, "retained_pages": 1, "retained_shapes": 500, "loaded_pages": 1},',
        '           {"step": 1, "action": "nav", "page_id": "p2", "t_ms": 410, "retained_pages": 2, "retained_shapes": 1000, "loaded_pages": 2}]}',
        "```",
        "Также принимается `retained: {pages, shapes}` вместо плоских полей.",
        "",
        "Дополнительно в `scenario`: `command_timings[]` — моменты каждой команды в часах страницы",
        "(`sentAt`, `clientAt`, `serverAt`, `syncedAt`, `ackedAt`, `drawnAt`, `opGetMs`, `targetRevision`),",
        "то есть метрики команды восстановимы по сырым данным без пересчёта (**это точный источник**, см.",
        "врезку «Откуда берутся `t_cmd_*`»); `heap_sampler`",
        "(`peak_mib`, `samples`, `interval_ms`, `suspended_ms`); `retained_probe`; а в `steps[]` —",
        "`probe_ms`, `probe_overrun_ms`, `retained_source`, `retained_bytes_synthetic`.",
        "",
        "В корне записи прогона — `sampling` (по каждому сэмплеру: `matched`, `essential`, причина отсутствия",
        "совпадений) и `server_disk` (`dirs`, `total_bytes`, `budget_bytes`): по ним видно, какие колонки пусты",
        "потому, что величина не измерялась.",
        "",
        "## Паспорт серии",
        "",
        "`results/<series>/passport.json` — свободный JSON (SPEC §7.4); в отчёт попадают ключи верхнего уровня.",
        "Обязательный состав ключей — `docs/PASSPORT.md` §2.1 (`host`, `versions`, `packages`, `shaper.effective`,",
        "`seed`, `plan`, `api.logLevel`, `adapters`, `client.dist`, `client.buildId`, `zero.config`,",
        "`preSeriesChecks`, `commit`). Идентификация кода серии — `code.codeId` / `code.clientBuildId` /",
        "`code.serverDistSha256`: `commit` в этой среде всегда `null` (каталог не является репозиторием git),",
        "см. `docs/PASSPORT.md` §2.2.",
    ]
    return "\n".join(lines) + "\n"
