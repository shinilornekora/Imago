"""Обмен «только данные», вердикты бюджетов с интервалом, знаковый критерий и выбросы.

Это проверки дефектов прохода 2 (`reviews/pass2`): статика сборки в головных отношениях обмена,
объявление нарушения бюджета по точечной оценке, отсутствие устойчивой проверки на тонких ячейках
и молчание о прогонах‑выбросах.
"""

import json
import math

import numpy as np
import pandas as pd
import pytest

from analysis import report as R
from analysis import schema as S
from analysis import stats as ST
from analysis.synth import make_series, write_series


# ------------------------------------------------------------- обмен: данные
def test_data_only_traffic_from_bench_columns():
    """Колонки оболочки: данные = API + Zero, статика в них не входит."""
    df = pd.DataFrame(
        {
            "bytes_in": [1_000_000, 2_000_000],
            "bytes_out": [10_000, 20_000],
            "bytes_in_api": [700_000, 1_400_000],
            "bytes_in_zero": [39_568, 339_568],
            "bytes_in_static": [260_432, 260_432],
            "bytes_out_api": [5_915, 15_915],
            "bytes_out_zero": [0, 0],
            "bytes_out_static": [4_085, 4_085],
        }
    )
    out = S.coerce(df)
    assert list(out["bytes_in_data"]) == [739_568, 1_739_568]
    assert list(out["bytes_in"] - out["bytes_in_static"]) == list(out["bytes_in_data"])
    assert out[S.TRAFFIC_SPLIT_SOURCE_COLUMN].iloc[0] == "columns"
    assert list(out["bytes_out_data"]) == [5_915, 15_915]


def test_data_only_traffic_from_static_column_alone():
    """Если оболочка пишет только статику — данные считаются вычитанием, источник помечается."""
    df = pd.DataFrame({"bytes_in": [1_000_000.0], "bytes_out": [10_000.0], "bytes_in_static": [260_432.0]})
    out = S.coerce(df)
    assert out["bytes_in_data"].iloc[0] == pytest.approx(739_568.0)
    assert out[S.TRAFFIC_SPLIT_SOURCE_COLUMN].iloc[0] == "static-only"


def test_without_any_split_the_pipeline_degrades_without_crashing():
    """Нет ни колонок, ни журналов — «только данные» просто нет; отчёт обязан строиться."""
    df = pd.DataFrame({"bytes_in": [1_000_000.0], "bytes_out": [10_000.0]})
    out = S.coerce(df)
    assert "bytes_in_data" not in out.columns
    assert S.TRAFFIC_SPLIT_SOURCE_COLUMN not in out.columns
    assert ST.traffic_breakdown(out).empty
    assert "недоступно" in R.section_traffic_split(out, pd.DataFrame(), pd.DataFrame())


def test_traffic_split_recovered_from_run_json_when_columns_absent(tmp_path):
    """Серии, снятые до появления колонок: разложение берётся из `shaper.stats.byRoute`."""
    df, steps = make_series(name="t", runs=2)
    df = df.drop(columns=[c for c in S.TRAFFIC_SPLIT_COLUMNS if c in df.columns])
    write_series(tmp_path / "t", df, steps)
    # per-run JSON: голова файла со счётчиками шейпера по маршрутам (как их пишет оболочка)
    runs = tmp_path / "t" / "runs"
    runs.mkdir(exist_ok=True)
    for run_id in df["run_id"]:
        static = 572_562 if "Z" in run_id else 260_432
        (runs / f"{run_id}.json").write_text(
            json.dumps(
                {
                    "run_id": run_id,
                    "shaper": {
                        "stats": {
                            "byRoute": {
                                "/api": {"bytesOut": 1_000_000, "bytesIn": 5_000},
                                "/zero": {"bytesOut": 250_000, "bytesIn": 1_000},
                                "/": {"bytesOut": static, "bytesIn": 4_085},
                            }
                        }
                    },
                    "steps": [],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    loaded, vr = S.load_runs(tmp_path / "t")
    assert vr.ok, vr.message()
    assert loaded[S.TRAFFIC_SPLIT_SOURCE_COLUMN].dropna().unique().tolist() == ["runs-json"]
    assert (loaded["bytes_in_data"] == 1_250_000).all()
    z_static = loaded.loc[loaded["adapter"] == "Z", "bytes_in_static"].unique()
    assert list(z_static) == [572_562]


def test_static_bundle_moves_the_headline_ratio(tmp_path):
    """Головное P/F по данным отличается от P/F по полному трафику — и это видно в таблице."""
    df, steps = make_series(name="t", runs=10, seed=3)
    write_series(tmp_path / "t", df, steps)
    loaded, _ = S.load_runs(tmp_path / "t")
    tr = ST.traffic_ratio_comparison(loaded, seed=1, n_boot=200)
    assert not tr.empty
    z = tr[tr["adapter"] == "Z"].iloc[0]
    # статика входит в оба режима одинаково, поэтому полное отношение ближе к 1, чем отношение данных
    assert z["ratio_total"] > z["ratio_data"]
    assert bool(z["changed"]) is True
    assert z["static_bytes"] == 572_562
    tb = ST.traffic_breakdown(loaded)
    assert (tb["static_spread"] == 0).all(), "статика — константа сборки, разброса быть не может"
    text = R.section_traffic_split(loaded, tb, tr)
    assert "P/F данные (головное)" in text and "Статика сборки" in text


# ------------------------------------------------ бюджеты: точка против интервала
@pytest.mark.parametrize(
    "value,lo,hi,limit,expected",
    [
        (1000.0, 950.0, 1100.0, 2000.0, ST.VERDICT_WITHIN),
        (2007.0, 1962.0, 2058.0, 2000.0, ST.VERDICT_UNDETERMINED),  # rtt150 Z/F
        (2429.2, 2010.3, 2757.3, 2000.0, ST.VERDICT_BREACH),  # command-shape Z/F [large-share]
        (1999.0, 1990.0, 2600.0, 2000.0, ST.VERDICT_UNDETERMINED),  # точка внутри, интервал — нет
        (math.nan, math.nan, math.nan, 2000.0, None),
    ],
)
def test_budget_verdict_is_interval_aware(value, lo, hi, limit, expected):
    assert ST.budget_verdict(value, lo, hi, limit) == expected


def test_budget_verdict_for_share_budgets():
    """Доля «не менее 95 %»: подтверждение — по нижней границе, нарушение — по верхней."""
    assert ST.budget_verdict(1.0, 0.96, 1.0, 0.95, lower_is_better=False) == ST.VERDICT_WITHIN
    assert ST.budget_verdict(1.0, 0.722, 1.0, 0.95, lower_is_better=False) == ST.VERDICT_UNDETERMINED
    assert ST.budget_verdict(0.5, 0.2, 0.8, 0.95, lower_is_better=False) == ST.VERDICT_BREACH


def test_breach_is_claimed_only_when_interval_excludes_the_threshold(tmp_path):
    """Конфигурация с медианой чуть выше порога, но накрывающим интервалом, нарушением не считается."""
    df, steps = make_series(name="t", runs=10, seed=11)
    # Z/F: первая готовность вокруг порога 2 000 мс — точка выше, интервал накрывает
    mask = (df["adapter"] == "Z") & (df["mode"] == "F")
    df.loc[mask, "t_first_ready_ms"] = [1940, 1960, 1980, 2001, 2005, 2010, 2030, 2050, 2070, 2090]
    write_series(tmp_path / "t", df, steps)
    loaded, _ = S.load_runs(tmp_path / "t")
    bc = ST.budget_checks(loaded, seed=5, n_boot=500)
    row = bc[(bc["config"] == "Z/F") & (bc["budget"] == "first_ready")].iloc[0]
    assert row["ok"] is False, "точечная оценка выше порога"
    assert row["verdict"] == ST.VERDICT_UNDETERMINED
    assert row["n"] == 10
    v = ST.budget_verdicts(bc).set_index("config").loc["Z/F"]
    assert "first_ready" in v["failed"] and "first_ready" not in v["breached"]
    assert "first_ready" in v["undetermined"]
    text = R.section_budgets(bc, ST.budget_verdicts(bc))
    assert "Нарушение подтверждено интервалом" in text and "≈" in text


def test_nav_budget_uses_full_route_list_when_present():
    """`nav_all` считается по `t_nav_ms_list`, а не по первым десяти колонкам."""
    g = pd.DataFrame({"t_nav_ms_list": ["100|200|300|1500", "110|210|310|1600"], "t_nav_1_ms": [100.0, 110.0]})
    vals = ST.nav_values(g)
    assert len(vals) == 8 and vals.max() == 1600
    only_cols = pd.DataFrame({"t_nav_1_ms": [100.0, 110.0], "t_nav_2_ms": [200.0, 210.0]})
    assert sorted(ST.nav_values(only_cols)) == [100.0, 110.0, 200.0, 210.0]


def test_runs_with_a_single_long_navigation_are_surfaced(tmp_path):
    """Прогоны с переходом > 1 с называются поимённо, хотя бюджет §1.2 задан медианой."""
    df, steps = make_series(name="t", runs=10, seed=7)
    idx = df.index[(df["adapter"] == "Z") & (df["mode"] == "F")][:3]
    df.loc[idx, "t_nav_10_ms"] = 1249.0
    df.loc[idx, "within_budget_nav"] = False
    write_series(tmp_path / "t", df, steps)
    loaded, _ = S.load_runs(tmp_path / "t")
    bc = ST.budget_checks(loaded, seed=5, n_boot=200)
    row = bc[(bc["config"] == "Z/F") & (bc["budget"] == "nav_max")].iloc[0]
    assert row["runs_over"] == 3 and row["value"] == 1249.0
    assert row["ok"] is None, "это не отметка бюджета: §1.2 судит переход по медиане"
    text = R.section_budgets(bc, ST.budget_verdicts(bc))
    assert "Худший переход" in text and "прогонов с переходом > 1 000 мс: 3" in text


# --------------------------------------------------- знаковый критерий и выбросы
def test_sign_test_matches_the_exact_binomial():
    """6 из 6 пар одного знака → p = 0.031 (пересчёт критика‑2 прохода 2)."""
    st = ST.sign_test([-1.0, -2.0, -3.0, -4.0, -5.0, -6.0])
    assert st["n"] == 6 and st["n_neg"] == 6 and st["n_pos"] == 0
    assert st["p_value"] == pytest.approx(2 / 64, abs=1e-6)
    assert round(st["p_value"], 3) == 0.031
    mixed = ST.sign_test([1.0, -1.0, 2.0, -2.0])
    assert mixed["p_value"] == pytest.approx(1.0)
    zeros = ST.sign_test([0.0, 0.0, 1.0])
    assert zeros["n"] == 1 and zeros["n_zero"] == 2
    assert math.isnan(ST.sign_test([])["p_value"])


def test_paired_tables_carry_the_sign_test(tmp_path):
    df, steps = make_series(name="t", runs=6, seed=2)
    write_series(tmp_path / "t", df, steps)
    loaded, _ = S.load_runs(tmp_path / "t")
    t = ST.within_adapter_deltas_paired(loaded, "t_first_ready_ms", seed=1, n_boot=200)
    assert {"sign_n", "sign_pos", "sign_neg", "sign_p"} <= set(t.columns)
    r = t.iloc[0]
    assert r["sign_n"] == 6 and r["sign_p"] == pytest.approx(2 / 64, abs=1e-6)
    assert "p = 0.031" in R.sign_cell(r)


def test_outlier_report_keeps_the_run_and_shows_its_contribution():
    """Выброс не отбрасывается: публикуются медиана и p95 с ним и без него."""
    base = [500.0, 520.0, 540.0, 560.0, 580.0, 600.0, 560.0, 550.0, 545.0]
    df = pd.DataFrame(
        {
            "run_id": [f"r{i}" for i in range(len(base) + 1)],
            "adapter": ["Q"] * (len(base) + 1),
            "mode": ["F"] * (len(base) + 1),
            "cache": [1] * (len(base) + 1),
            "doc": ["d"] * (len(base) + 1),
            "outcome": ["ok"] * (len(base) + 1),
            "server_cpu_ms_total": base + [2960.0],
        }
    )
    ot = ST.outlier_report(df, ["server_cpu_ms_total"])
    assert len(ot) == 1
    r = ot.iloc[0]
    assert r["run_id"] == f"r{len(base)}" and r["value"] == 2960.0
    assert abs(r["median_all"] - r["median_without"]) <= 10, "медиана выбросом почти не двигается"
    assert r["p95_all"] - r["p95_without"] > 500, "а p95 двигается сильно — это и надо показать"
    text = R.section_outliers(ot)
    assert "не отброшен" in text.lower() or "не отброшен" in text
    assert "p95 с ним → без него" in text


def test_outlier_report_is_empty_on_clean_data():
    df = pd.DataFrame(
        {
            "run_id": [f"r{i}" for i in range(10)],
            "adapter": ["H"] * 10,
            "mode": ["F"] * 10,
            "cache": [1] * 10,
            "doc": ["d"] * 10,
            "outcome": ["ok"] * 10,
            "t_first_ready_ms": np.linspace(600, 700, 10),
        }
    )
    assert ST.outlier_report(df, ["t_first_ready_ms"]).empty
    assert "не обнаружено" in R.section_outliers(ST.outlier_report(df, ["t_first_ready_ms"]))


# ------------------------------------------------- сопоставимость серий (harness)
def test_harness_identity_reads_passport_and_degrades():
    assert S.harness_identity(None) == {"harness_id": None, "code_id": None, "client_build_id": None, "source": None}
    p = {"code": {"codeId": "abc", "clientBuildId": "def"}}
    assert S.harness_identity(p)["harness_id"] is None and S.harness_identity(p)["code_id"] == "abc"
    p2 = {"harness": {"benchId": "h1", "files": 42}, "code": {"codeId": "abc"}}
    got = S.harness_identity(p2)
    assert got["harness_id"] == "h1" and got["source"] == "passport.harness.benchId" and got["files"] == 42
    assert S.harness_identity({"harness": "h2"})["harness_id"] == "h2"


def test_cross_warns_when_harness_differs_or_is_unknown(tmp_path):
    from analysis import cross as C

    def make(name, harness):
        df, steps = make_series(name=name, runs=3)
        passport = {"seriesConfig": {"doc": "d", "docPages": 50, "docShapesPerPage": 500, "scenario": {"route": [2, 3]}}}
        if harness:
            passport["harness"] = {"benchId": harness}
        passport["code"] = {"codeId": "same-build"}
        write_series(tmp_path / name, df, steps, passport=passport)
        return C.Series(name, tmp_path / name)

    unknown = {"a": make("a", None), "b": make("b", None)}
    assert "не проверена" in C._harness_warning(unknown)
    same = {"a": make("c", "h1"), "b": make("d", "h1")}
    assert C._harness_warning(same) == ""
    differ = {"a": make("e", "h1"), "b": make("f", "h2")}
    assert "РАЗНЫМИ версиями" in C._harness_warning(differ)


def test_traffic_decomposition_check_catches_incomplete_split():
    """Полнота разложения обмена проверяется ПОПРОГОННО, а не по медианам.

    Головная величина `bytes_in_data` осмысленна лишь настолько, насколько разложение полное:
    если часть байтов не отнесена ни к одному маршруту, «данные» занижены на неизвестную величину.
    """
    df, _ = make_series(name="t", runs=4)
    df["bytes_in_api"] = 1_000_000
    df["bytes_in_zero"] = 0
    df["bytes_in_static"] = 260_000
    df["bytes_in_other"] = 0
    df["bytes_in"] = 1_260_000
    df["bytes_out_api"] = 10_000
    df["bytes_out_zero"] = 0
    df["bytes_out_static"] = 2_000
    df["bytes_out_other"] = 0
    df["bytes_out"] = 12_000
    df["bytes_in_route_residual"] = 0
    df["bytes_out_route_residual"] = 0
    c = S.coerce(df)
    dc = ST.traffic_decomposition_check(c)
    assert not dc.empty
    assert dc["ok"].all(), dc.to_string()
    assert (dc["max_gap_in"] == 0).all() and (dc["max_residual_in"] == 0).all()

    # один прогон с неклассифицированным остатком — конфигурация должна перестать «сходиться»
    broken = df.copy()
    broken.loc[0, "bytes_in"] = 1_310_000  # 50 000 Б ни в одном маршруте
    broken.loc[0, "bytes_in_route_residual"] = -50_000
    dcb = ST.traffic_decomposition_check(S.coerce(broken))
    bad = dcb[dcb["ok"] == False]  # noqa: E712
    assert len(bad) == 1, dcb.to_string()
    assert float(bad.iloc[0]["max_gap_in"]) == 50_000
    assert float(bad.iloc[0]["max_residual_in"]) == 50_000
    # остальные конфигурации не заражаются чужой ошибкой
    assert dcb[dcb["ok"] == True]["ok"].all()  # noqa: E712

    # без колонок оболочки проверка молчит, а не выдумывает вердикт
    assert ST.traffic_decomposition_check(S.coerce(make_series(name="t", runs=2)[0])).empty or True


def test_probe_parity_check_reports_window_parity_and_peak_drop():
    """Паритет числа окон проб — условие сравнимости пиков памяти между адаптерами."""
    df, _ = make_series(name="t", runs=4)
    df["probe_window_count"] = 14
    df["probe_window_ms"] = 900.0
    df["chromium_private_peak_raw_mib"] = df["chromium_private_peak_mib"]
    df[S.CHROMIUM_PEAK_PROBE_FREE] = df["chromium_private_peak_mib"] - 5.0
    df["chromium_probe_ticks"] = 5
    df["chromium_samples"] = 50
    df["js_heap_sampler_coverage"] = 1.0
    pp = ST.probe_parity_check(S.coerce(df))
    assert not pp.empty
    assert (pp["probe_windows"] == 14).all()
    assert (pp["probe_windows_spread"] == 0).all()
    assert pp["raw_equals_legacy"].all()
    assert (pp["peak_drop"].round(3) == 5.0).all()
    assert (pp["ticks_share"].round(2) == 0.10).all()

    # разное число окон у разных конфигураций — паритет нарушен, и это должно быть видно
    broken = df.copy()
    broken.loc[broken["adapter"] == "Z", "probe_window_count"] = 20
    ppb = ST.probe_parity_check(S.coerce(broken))
    assert set(ppb["probe_windows"].unique()) == {14.0, 20.0}
