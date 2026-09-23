import pandas as pd
import pytest

from analysis import schema as S
from analysis.synth import make_series, write_series


def test_required_columns_are_fixed_and_documented():
    assert len(S.REQUIRED_COLUMNS) == len(set(S.REQUIRED_COLUMNS))
    for c in ("run_id", "series", "adapter", "mode", "cache", "doc", "repetition", "order_index", "started_at", "outcome", "error_stage", "t_first_ready_ms", "t_nav_1_ms", "t_nav_10_ms", "t_nav_new_median_ms", "t_nav_return_median_ms", "t_cmd_ack_ms", "t_cmd_drawn_ms", "t_scenario_ms", "bytes_in", "bytes_out", "cdp_bytes_in", "js_heap_peak_mb", "js_heap_end_mb", "chromium_private_peak_mib", "chromium_private_end_mib", "client_storage_bytes", "retained_pages_end", "retained_shapes_end", "retained_pages_max", "retained_shapes_max", "loaded_pages_end", "server_api_cpu_ms", "server_api_mem_peak_mib", "server_api_mem_integral_mib_s", "server_pg_cpu_ms", "server_pg_mem_peak_mib", "server_pg_mem_integral_mib_s", "server_zero_cpu_ms", "server_zero_mem_peak_mib", "server_zero_mem_integral_mib_s", "zero_replica_bytes", "within_budget_first", "within_budget_nav", "within_budget_cmd", "within_budget_scenario", "reference_ok"):
        assert c in S.REQUIRED_COLUMNS, c
    md = S.columns_markdown()
    for c in S.REQUIRED_COLUMNS:
        if c.startswith("t_nav_") and c.endswith("_ms") and c[6:-3].isdigit():
            continue
        assert f"`{c}`" in md, f"{c} missing from COLUMNS.md text"
    # COLUMNS.md в репозитории совпадает со схемой
    from pathlib import Path

    on_disk = Path(__file__).resolve().parents[1] / "COLUMNS.md"
    if on_disk.exists():
        disk_text = on_disk.read_text(encoding="utf-8")
        if disk_text != md:
            import difflib

            diff = "\n".join(
                difflib.unified_diff(disk_text.splitlines(), md.splitlines(), "COLUMNS.md", "columns_markdown()", lineterm="", n=0)
            )
            pytest.fail(
                "COLUMNS.md разошёлся со схемой. COLUMNS.md объявлен генерируемым из "
                "`analysis/schema.py` (`columns_markdown()`), поэтому расхождение значит, что правку "
                "внесли в одно место из двух: либо перенесите описания в словарь `desc` внутри "
                "`columns_markdown()`, либо перегенерируйте файл:\n"
                '  python -c "from analysis.schema import columns_markdown; print(columns_markdown(), end=\'\')" > COLUMNS.md\n\n'
                + diff[:4000]
            )


def test_synthetic_series_is_valid(tmp_path):
    df, steps = make_series(name="t", runs=4)
    assert set(S.REQUIRED_COLUMNS) <= set(df.columns)
    write_series(tmp_path / "t", df, steps)
    loaded, vr = S.load_runs(tmp_path / "t")
    assert vr.ok, vr.message()
    assert len(loaded) == 24
    assert "server_cpu_ms_total" in loaded.columns and "success" in loaded.columns
    assert loaded["within_budget_first"].isin([True, False]).all()
    st = S.load_steps(tmp_path / "t")
    assert st is not None and set(st["adapter"]) == {"H", "Q", "Z"} and st["retained_shapes"].notna().all()


def test_validator_reports_missing_and_bad_values(tmp_path):
    df, _ = make_series(name="t", runs=3)
    broken = df.drop(columns=["t_cmd_drawn_ms", "reference_ok"])
    broken["extra_col"] = 1
    vr = S.validate(broken)
    assert not vr.ok
    assert vr.missing == ["t_cmd_drawn_ms", "reference_ok"]
    # `unknown` содержит и колонки, которые оболочка уже пишет, а схема ещё не
    # объявила (`cdp_ws_bytes_in`, `t_cmd_server_ms`, …): они игнорируются
    # анализом и перечисляются в отчёте, а не роняют загрузку.
    assert "extra_col" in vr.unknown
    assert "MISSING required columns: t_cmd_drawn_ms, reference_ok" in vr.message()

    bad = df.copy().astype(object)  # как после чтения «грязного» CSV
    bad.loc[0, "t_first_ready_ms"] = "fast"
    bad.loc[1, "within_budget_nav"] = "maybe"
    bad.loc[2, "outcome"] = "crashed"
    bad.loc[3, "adapter"] = "X"
    bad.loc[4, "run_id"] = bad.loc[5, "run_id"]
    vr = S.validate(bad)
    assert not vr.ok
    assert set(vr.bad_values) == {"t_first_ready_ms", "within_budget_nav", "outcome", "adapter", "run_id"}

    (tmp_path / "s").mkdir()
    broken.to_csv(tmp_path / "s" / "runs.csv", index=False)
    with pytest.raises(ValueError, match="MISSING required columns"):
        S.load_runs(tmp_path / "s")
    _, vr2 = S.load_runs(tmp_path / "s", require_valid=False)
    assert vr2.missing == ["t_cmd_drawn_ms", "reference_ok"]


def test_empty_values_are_nan_not_errors():
    df, _ = make_series(name="t", runs=3, errors={("H", "F"): 1})
    vr = S.validate(df)
    assert vr.ok, vr.message()
    c = S.coerce(df)
    err = c[c["outcome"] == "error"]
    assert len(err) == 1 and pd.isna(err["t_first_ready_ms"].iloc[0])
    assert err["success"].iloc[0] == False  # noqa: E712


def test_new_route_and_variant_columns_are_optional_and_documented():
    """Колонки маршрута/повторных чтений и вариантов команды: схема их знает, валидатор не ругается."""
    new_cols = [
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
        "cmd_variant",
        "cmd_target_id",
    ]
    md = S.columns_markdown()
    for c in new_cols:
        assert c in S.OPTIONAL_COLUMNS, c
        assert c not in S.REQUIRED_COLUMNS, c
        assert f"`{c}`" in md, f"{c} не описана в COLUMNS.md"
    df, _ = make_series(name="t", runs=2)
    for c in new_cols:
        df[c] = "baseline" if c in ("cmd_variant", "cmd_target_id", "t_nav_ms_list") else 3
    vr = S.validate(df)
    assert vr.ok, vr.message()
    assert not vr.unknown
    # числовые из них действительно приводятся к числам
    coerced = S.coerce(df)
    assert coerced["nav_cache_misses"].dtype.kind == "f"
    assert coerced["cmd_variant"].iloc[0] == "baseline"


def test_scenario_budget_comes_from_passport(tmp_path):
    """Бюджет сценария — из паспорта серии, а не из константы 30 с."""
    assert S.scenario_budget_ms(None) == float(S.BUDGET_SCENARIO_MS)
    assert S.scenario_budget_ms({"scenario": {"budgets": {"scenarioMs": 70000}}}) == 70000.0
    # корень паспорта важнее seriesConfig (оболочка пишет фактически исполненный сценарий)
    passport = {"scenario": {"budgets": {"scenarioMs": 40000}}, "seriesConfig": {"scenario": {"budgets": {"scenarioMs": 70000}}}}
    assert S.scenario_budget_ms(passport) == 40000.0
    # только seriesConfig — тоже годится
    assert S.scenario_budget_ms({"seriesConfig": {"scenario": {"budgets": {"scenarioMs": 70000}}}}) == 70000.0
    # мусор в паспорте не ломает: откат к значению по умолчанию
    assert S.scenario_budget_ms({"scenario": {"budgets": {"scenarioMs": "n/a"}}}) == float(S.BUDGET_SCENARIO_MS)

    df, steps = make_series(name="long", runs=3)
    df["t_scenario_ms"] = 52000.0  # маршрут из 50 действий: 30 с недостижимы по построению
    write_series(tmp_path / "long", df, steps, passport={"scenario": {"route": list(range(2, 51)), "budgets": {"scenarioMs": 70000}}})
    loaded, vr = S.load_runs(tmp_path / "long")
    assert vr.ok, vr.message()
    assert set(loaded[S.SCENARIO_BUDGET_COLUMN]) == {70000.0}
    assert loaded["success"].all(), "52 с укладываются в объявленные серией 70 с"
    assert S.series_scenario_budget_ms(loaded) == 70000.0
    # та же серия без паспортного бюджета была бы «провалена» порогом по умолчанию
    assert not S.coerce(df)["success"].any()


def test_programme2_columns_are_declared_and_documented():
    """Колонки оболочки программы 2: схема их знает, валидатор молчит, COLUMNS.md описывает.

    Смысл теста — не «колонка объявлена», а «колонка не игнорируется молча»: до программы 2
    валидатор писал по ним `unknown columns (ignored)`, то есть анализ читал файл, в котором
    четверть колонок ему неизвестна, и не сообщал об этом в отчёт.
    """
    new_cols = [
        "bytes_in_other",
        "bytes_out_other",
        "bytes_in_route_residual",
        "bytes_out_route_residual",
        "chromium_private_peak_raw_mib",
        "chromium_probe_ticks",
        "chromium_samples",
        "server_api_mem_peak_excl_probe_mib",
        "server_pg_mem_peak_excl_probe_mib",
        "server_zero_mem_peak_excl_probe_mib",
        "probe_window_count",
        "probe_window_ms",
        "js_heap_sampler_coverage",
        "harness_id",
    ]
    md = S.columns_markdown()
    for c in new_cols:
        assert c in S.OPTIONAL_COLUMNS, c
        assert c not in S.REQUIRED_COLUMNS, c
        assert f"`{c}`" in md, f"{c} не описана в COLUMNS.md"
    assert "harness_id" in S.STRING_COLUMNS and "harness_id" not in S.NUMERIC_COLUMNS
    for c in new_cols:
        if c != "harness_id":
            assert c in S.NUMERIC_COLUMNS, c

    df, _ = make_series(name="t", runs=2)
    for c in new_cols:
        df[c] = "ab2103e73b1655e7" if c == "harness_id" else 0
    vr = S.validate(df)
    assert vr.ok, vr.message()
    assert not vr.unknown, f"валидатор всё ещё считает колонки неизвестными: {vr.unknown}"
    coerced = S.coerce(df)
    assert coerced["probe_window_count"].dtype.kind == "f"
    assert coerced["harness_id"].iloc[0] == "ab2103e73b1655e7"


def test_every_optional_column_is_documented():
    """Ни одна объявленная колонка не остаётся без описания в COLUMNS.md."""
    md = S.columns_markdown()
    missing = [c for c in S.OPTIONAL_COLUMNS if f"`{c}`" not in md]
    assert not missing, f"нет описания в COLUMNS.md: {missing}"


def test_harness_comparable_signature():
    """Сопоставимость серий читается по `comparableBy`, а не по `harnessId`."""
    def passport(bench: str, series_cfg: str) -> dict:
        return {
            "harness": {
                "harnessId": series_cfg,
                "benchId": bench,
                "benchSrcSha256": bench,
                "columnsSha256": "cols",
                "comparableBy": ["benchId", "benchSrcSha256", "columnsSha256"],
            }
        }

    a = S.harness_comparable_signature(passport("B1", "cfgA"))
    b = S.harness_comparable_signature(passport("B1", "cfgB"))
    c = S.harness_comparable_signature(passport("B2", "cfgA"))
    assert a is not None and a[1] == ["benchId", "benchSrcSha256", "columnsSha256"]
    # разный harnessId при одинаковых comparableBy — серии СОПОСТАВИМЫ
    assert a[0] == b[0]
    # разный benchId — несопоставимы
    assert a[0] != c[0]
    assert S.harness_comparable_signature(None) is None
    assert S.harness_comparable_signature({"harness": {"benchId": "B1"}}) is None  # нет comparableBy
    # объявленное поле отсутствует в паспорте — подпись не строится, а не строится наполовину
    assert S.harness_comparable_signature({"harness": {"comparableBy": ["benchId", "x"], "benchId": "B"}}) is None
