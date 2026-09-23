import math

import numpy as np
import pytest

from analysis import schema as S
from analysis import stats as ST
from analysis.synth import centers, make_series


@pytest.fixture(scope="module")
def series():
    df, _ = make_series(name="t", runs=30, errors={("Z", "P"): 2}, timeouts={("Q", "F"): 1}, seed=5)
    return S.coerce(df)


def test_median_p95_wilson_bootstrap_primitives():
    x = [5, 1, 3, math.nan, 2, 4]
    assert ST.median(x) == 3
    assert ST.p95(np.linspace(0, 100, 101)) == pytest.approx(95.0)
    assert math.isnan(ST.median([]))
    p, lo, hi = ST.wilson_interval(29, 30)
    assert p == pytest.approx(29 / 30)
    assert lo == pytest.approx(0.8333, abs=1e-3)
    assert hi == pytest.approx(0.9941, abs=1e-3)
    assert ST.wilson_interval(0, 0) == (math.nan, math.nan, math.nan) or math.isnan(ST.wilson_interval(0, 0)[0])
    assert ST.wilson_interval(30, 30)[1] == pytest.approx(30 / (30 + ST.Z_95**2), abs=1e-6)
    a = np.arange(1, 101, dtype=float)
    lo1, hi1 = ST.bootstrap_ci(a, seed=1, n_boot=500)
    lo2, hi2 = ST.bootstrap_ci(a, seed=1, n_boot=500)
    assert (lo1, hi1) == (lo2, hi2), "seeded bootstrap must be deterministic"
    assert lo1 <= 50.5 <= hi1
    assert ST.bootstrap_ci(a, seed=2, n_boot=500) != (lo1, hi1)
    # по одному наблюдению интервал не определён (а не вырожденная точка)
    assert all(math.isnan(v) for v in ST.bootstrap_ci([7.0]))
    est, dlo, dhi = ST.bootstrap_two_sample(a + 10, a, lambda mp, mf: mp - mf, seed=0, n_boot=300)
    assert est == 10 and dlo <= 10 <= dhi


def test_p95_definition_is_linear_interpolation():
    """p95 — тип 7 (линейная интерполяция), а не «ближайший ранг»."""
    x = list(range(1, 31))  # n = 30
    # позиция 0.95·(n−1) = 27.55 → между 28-м и 29-м значением (28 и 29)
    assert ST.p95(x) == pytest.approx(28.55)
    assert ST.p95(x) < max(x)
    assert ST.p95([5.0]) == 5.0


def test_summarize_reports_n_median_p95_and_both_intervals():
    a = np.arange(1, 41, dtype=float)
    s = ST.summarize(a, seed=3, n_boot=400, key="k")
    assert s["n"] == 40 and s["median"] == pytest.approx(20.5)
    assert s["ci_lo"] <= s["median"] <= s["ci_hi"]
    assert s["p95_lo"] <= s["p95"] <= s["p95_hi"]
    assert s["ci_reliable"] is True
    small = ST.summarize([1.0, 2.0, 3.0], seed=3, n_boot=100, key="k")
    assert small["n"] == 3 and small["ci_reliable"] is False
    assert math.isnan(ST.summarize([], key="k")["median"])


def test_summary_medians_match_designed_centers(series):
    summ = ST.summarize_configs(series, ["t_first_ready_ms", "bytes_in", "chromium_private_peak_mib"], seed=0, n_boot=300)
    for a in ("H", "Q", "Z"):
        for m in ("F", "P"):
            c = centers(a, m)
            row = summ[(summ["adapter"] == a) & (summ["mode"] == m) & (summ["metric"] == "t_first_ready_ms")].iloc[0]
            if (a, m) not in (("Z", "P"), ("Q", "F")):  # без выброшенных прогонов медиана = центр точно
                assert row["median"] == pytest.approx(c["t_first_ready_ms"][0])
                assert row["p95"] == pytest.approx(c["t_first_ready_ms"][0] + 0.9 * c["t_first_ready_ms"][1], rel=1e-6)
                assert row["n"] == 30
            assert row["ci_lo"] <= row["median"] <= row["ci_hi"]
            assert row["min"] >= c["t_first_ready_ms"][0] - c["t_first_ready_ms"][1]
    zp = summ[(summ["adapter"] == "Z") & (summ["mode"] == "P") & (summ["metric"] == "bytes_in")].iloc[0]
    assert zp["n"] == 28, "error runs are excluded from metric summaries"


def test_success_table_and_wilson(series):
    st = ST.success_table(series).set_index("config")
    zp = st.loc["Z/P (cache=1)"]
    assert zp["n"] == 30 and zp["n_error"] == 2 and zp["n_success"] == 28
    assert zp["success_share"] == pytest.approx(28 / 30)
    p, lo, hi = ST.wilson_interval(28, 30)
    assert zp["success_lo"] == pytest.approx(lo) and zp["success_hi"] == pytest.approx(hi)
    qf = st.loc["Q/F"]
    assert qf["n_timeout"] == 1 and qf["n_within_budget"] == 29 and qf["n_success"] == 29
    assert set(st["scenario_budget_ms"]) == {float(S.BUDGET_SCENARIO_MS)}, "без паспорта — порог §7.4 по умолчанию"
    assert st.loc["H/F", "success_share"] == 1.0


def test_within_adapter_deltas_and_ratios(series):
    t = ST.within_adapter_deltas(series, "t_first_ready_ms", seed=0, n_boot=300).set_index("adapter")
    cF, cP = centers("H", "F")["t_first_ready_ms"][0], centers("H", "P")["t_first_ready_ms"][0]
    h = t.loc["H"]
    assert h["median_F"] == cF and h["median_P"] == cP
    assert h["delta"] == cP - cF
    assert h["ratio"] == pytest.approx(cP / cF)
    assert h["delta_lo"] <= h["delta"] <= h["delta_hi"]
    assert h["ratio_lo"] <= h["ratio"] <= h["ratio_hi"]
    assert h["delta_hi"] < 0, "P is clearly faster: interval excludes 0"
    assert h["n_F"] == 30 and h["n_P"] == 30
    assert set(t.index) == {"H", "Q", "Z"}


def test_between_adapter_comparison(series):
    t = ST.between_adapter_comparison(series, "t_first_ready_ms", seed=0, n_boot=300)
    assert {(r.adapter_a, r.adapter_b) for r in t.itertuples()} == {("H", "Q"), ("H", "Z"), ("Q", "Z")}
    hz = t[(t["adapter_a"] == "H") & (t["adapter_b"] == "Z")].iloc[0]
    dH = centers("H", "P")["t_first_ready_ms"][0] - centers("H", "F")["t_first_ready_ms"][0]
    dZ = centers("Z", "P")["t_first_ready_ms"][0] - centers("Z", "F")["t_first_ready_ms"][0]
    # у Z/P два прогона выброшены как ошибочные, поэтому медиана слегка смещена от центра
    assert hz["delta_a"] == dH and hz["delta_b"] == pytest.approx(dZ, rel=0.02)
    assert hz["delta_diff"] == pytest.approx(hz["delta_a"] - hz["delta_b"])
    assert hz["delta_diff_lo"] <= hz["delta_diff"] <= hz["delta_diff_hi"]
    assert hz["ratio_of_ratios_lo"] <= hz["ratio_of_ratios"] <= hz["ratio_of_ratios_hi"]


def test_budget_checks_and_verdicts(series):
    bc = ST.budget_checks(series)
    v = ST.budget_verdicts(bc).set_index("config")
    assert v.loc["H/F", "first_ready"] == False and v.loc["H/F", "all_ok"] == False  # noqa: E712
    assert v.loc["H/P (cache=1)", "all_ok"] == True  # noqa: E712
    assert v.loc["H/F", "failed"] == ["first_ready"]
    # 2 ошибки из 30 → доля сценариев ≤30 с = 28/30 = 93.3 % < 95 %
    assert v.loc["Z/P (cache=1)", "scenario_budget_share"] == False  # noqa: E712
    # 1 таймаут из 30 → 96.7 % ≥ 95 %, но эталон проверен и совпал во всех проверенных
    assert v.loc["Q/F", "scenario_budget_share"] == True and v.loc["Q/F", "reference_ok_share"] == True  # noqa: E712
    row = bc[(bc["config"] == "Q/F") & (bc["budget"] == "scenario_budget_share")].iloc[0]
    assert row["k"] == 29 and row["n"] == 30 and row["ci_lo"] < 0.95
    chrom = bc[(bc["config"] == "Z/F") & (bc["budget"] == "chromium_private_peak") & (bc["statistic"] == "max")].iloc[0]
    assert chrom["value"] == 710 and chrom["ok"] == True  # noqa: E712


def test_retained_window_check(series):
    rt = ST.retained_window_check(series).set_index("config")
    assert rt.loc["H/P (cache=1)", "declared_window_pages"] == 2
    assert rt.loc["H/P (cache=1)", "ok"] == True and rt.loc["H/P (cache=1)", "share_within_window"] == 1.0  # noqa: E712
    assert rt.loc["H/P (cache=1)", "declared_window_shapes"] == 1000
    assert rt.loc["H/F", "ok"] == True and rt.loc["H/F", "declared_window_pages"] == 50  # noqa: E712
    leaky = series.copy()
    sel = (leaky["adapter"] == "Q") & (leaky["mode"] == "P")
    leaky.loc[sel, "retained_pages_max"] = 5
    rt2 = ST.retained_window_check(leaky).set_index("config")
    assert rt2.loc["Q/P (cache=1)", "ok"] == False and rt2.loc["Q/P (cache=1)", "retained_pages_max_max"] == 5  # noqa: E712


def test_cross_check_bytes_sums_http_and_websocket(series):
    """Перекрёстная проверка должна складывать HTTP и WebSocket (иначе ложный провал у Z)."""
    bx = ST.cross_check_bytes(series).set_index("config")
    assert set(bx.index) >= {"H/F", "Z/F", "Z/P (cache=1)"}
    # у H/Q кадров WebSocket нет, у Z по ним идёт основная часть обмена
    assert bx.loc["H/F", "cdp_ws_in_median"] == 0
    assert bx.loc["Z/F", "cdp_ws_in_median"] > bx.loc["Z/F", "cdp_http_in_median"]
    assert (bx["rel_diff"] < 0.01).all()
    assert bx["ok"].all(), "сумма HTTP+WS должна сходиться с шейпером во всех конфигурациях"
    # исходящее направление — справочное: оценка CDP занижена, но не проваливает вердикт
    assert bx.loc["Z/P (cache=1)", "rel_diff_out"] > 0.1
    assert bx["ok_out"].all()


def test_cross_check_bytes_regression_without_ws_column(series):
    """Без `cdp_ws_bytes_in` проверка у Z провалилась бы — это и был исходный дефект."""
    no_ws = series.drop(columns=["cdp_ws_bytes_in", "cdp_ws_bytes_out"])
    bx = ST.cross_check_bytes(no_ws).set_index("config")
    assert S.is_false(bx.loc["Z/F", "ok"]) and bx.loc["Z/F", "rel_diff"] > 0.5
    assert S.is_true(bx.loc["H/F", "ok"])
    assert "cdp_ws_bytes_in" in bx.loc["Z/F", "missing_columns"]


def test_pairing_by_repetition_is_available_and_consistent(series):
    ok, why = ST.pairing_feasible(series)
    assert ok and "repetition" in why
    t = ST.within_adapter_deltas_paired(series, "t_first_ready_ms", seed=0, n_boot=300).set_index("adapter")
    unpaired = ST.within_adapter_deltas(series, "t_first_ready_ms", seed=0, n_boot=300).set_index("adapter")
    h = t.loc["H"]
    assert h["n_pairs"] == 30 and h["n_dropped"] == 0
    cF, cP = centers("H", "F")["t_first_ready_ms"][0], centers("H", "P")["t_first_ready_ms"][0]
    # без отказов парная и непарная оценки указывают в одну сторону и близки
    assert h["delta"] < 0 and h["delta_hi"] < 0
    assert h["delta"] == pytest.approx(cP - cF, rel=0.15)
    assert h["ratio"] == pytest.approx(unpaired.loc["H", "ratio"], rel=0.15)
    # у Z два прогона P с ошибкой → пары отброшены целиком
    z = t.loc["Z"]
    assert z["n_pairs"] == 28 and z["n_dropped"] == 2
    # блок-фактор записан явно
    assert set(t["pair_on"]) == {"repetition"}


def test_pairing_reports_why_it_is_impossible():
    df, _ = make_series(name="t2", runs=2, seed=9)
    df = S.coerce(df)
    ok, why = ST.pairing_feasible(df)
    assert not ok and "блок" in why
    no_rep = S.coerce(make_series(name="t3", runs=30, seed=9)[0]).drop(columns=["repetition"])
    ok2, why2 = ST.pairing_feasible(no_rep)
    assert not ok2 and "repetition" in why2
    assert ST.within_adapter_deltas_paired(no_rep, "t_first_ready_ms", n_boot=50).empty


def test_between_adapter_paired_uses_common_blocks(series):
    t = ST.between_adapter_comparison_paired(series, "bytes_in", seed=0, n_boot=300)
    assert {(r.adapter_a, r.adapter_b) for r in t.itertuples()} == {("H", "Q"), ("H", "Z"), ("Q", "Z")}
    hz = t[(t["adapter_a"] == "H") & (t["adapter_b"] == "Z")].iloc[0]
    assert hz["n_blocks"] == 28, "блоки, где есть все четыре прогона пары адаптеров"
    assert hz["delta_diff_lo"] <= hz["delta_diff"] <= hz["delta_diff_hi"]


def test_command_timing_separates_ack_and_drawn(series):
    ct = ST.command_timing_table(series, seed=0, n_boot=300).set_index("config")
    hf = ct.loc["H/F"]
    # у H/Q холст обновляется ПОСЛЕ подтверждения
    assert hf["drawn_minus_ack_median"] > 0 and hf["share_drawn_before_ack"] == 0
    assert hf["t_cmd_ack_ms_median"] < hf["t_cmd_drawn_ms_median"]
    assert hf["t_cmd_ack_ms_p95"] >= hf["t_cmd_ack_ms_median"]
    # у Z синхронизация опережает подтверждение — разность отрицательна
    zf = ct.loc["Z/F"]
    assert zf["drawn_minus_ack_median"] < 0
    assert zf["share_drawn_before_ack"] > 0
    assert zf["n_pairs"] == 30
    # вырождение drawn ≡ ack распознаётся отдельной долей
    degenerate = series.copy()
    degenerate.loc[degenerate["adapter"] == "Z", "t_cmd_drawn_ms"] = degenerate.loc[degenerate["adapter"] == "Z", "t_cmd_ack_ms"]
    ct2 = ST.command_timing_table(degenerate, seed=0, n_boot=100).set_index("config")
    assert ct2.loc["Z/F", "share_equal"] == 1.0
    assert ct2.loc["H/F", "share_equal"] == 0.0


def test_command_timing_reports_optional_z_columns(series):
    ct = ST.command_timing_table(series, seed=0, n_boot=100).set_index("config")
    assert ct.loc["Z/F", "t_cmd_server_ms_median"] == pytest.approx(140, abs=1)
    assert ct.loc["Z/F", "t_cmd_opget_ms_median"] == pytest.approx(70, abs=1)
    assert "t_cmd_server_ms_median" not in ct.columns or math.isnan(ct.loc["H/F"].get("t_cmd_server_ms_median", math.nan))


def test_optional_columns_status_lists_present_and_new(series):
    oc = ST.optional_columns_status(series).set_index("column")
    assert bool(oc.loc["t_cmd_server_ms", "present"]) and oc.loc["t_cmd_server_ms", "n_values"] > 0
    assert bool(oc.loc["t_cmd_opget_ms", "present"])
    assert not bool(oc.loc["probe_total_ms", "present"]), "отсутствующая метрика помечается, а не падает"
    # колонки, ставшие обязательными, в «необязательных» не перечисляются
    assert not (set(oc.index) & set(S.REQUIRED_COLUMNS))
    # производные и используемые анализом колонки не выдаются за «новые»
    assert "success" not in set(oc[oc["source"] != "известная необязательная метрика"].index)
    assert "cdp_ws_bytes_in" not in set(oc[oc["source"] != "известная необязательная метрика"].index)
    with_new = series.assign(some_new_metric_ms=1.0)
    oc2 = ST.optional_columns_status(with_new).set_index("column")
    assert oc2.loc["some_new_metric_ms", "source"].startswith("новая колонка")


def test_metrics_tolerate_missing_optional_columns(series):
    """Отсутствие необязательных колонок не должно ломать ни один раздел."""
    stripped = series.drop(columns=[c for c in ST.OPTIONAL_METRICS if c in series.columns])
    assert not ST.command_timing_table(stripped, n_boot=50).empty
    assert not ST.cross_check_bytes(stripped.drop(columns=["cdp_ws_bytes_in", "cdp_ws_bytes_out"])).empty
    assert not ST.budget_checks(stripped).empty
    assert not ST.within_adapter_deltas_paired(stripped, "t_scenario_ms", n_boot=50).empty


def _with_variants(df):
    """Тот же набор прогонов, размеченный двумя вариантами команды."""
    import pandas as pd

    a = df.copy()
    a["cmd_variant"] = "baseline"
    b = df.copy()
    b["cmd_variant"] = "large-share"
    b["run_id"] = b["run_id"].astype(str) + "-ls"
    # у «большой» команды холст обновляется заметно позже — эффект, который нельзя усреднять
    b["t_cmd_drawn_ms"] = b["t_cmd_drawn_ms"] * 4
    return pd.concat([a, b], ignore_index=True)


def test_variants_split_configs_and_deltas(series):
    v = _with_variants(series)
    assert ST.variants(series) == [None]
    assert ST.variants(v) == ["baseline", "large-share"]
    assert S.VARIANT_COLUMN in ST.config_key_columns(v)
    assert S.VARIANT_COLUMN not in ST.config_key_columns(series), "пустой колонки варианта в ключе быть не должно"
    labels = set(ST.success_table(v)["config"])
    assert "H/F [baseline]" in labels and "H/F [large-share]" in labels
    # дельты P−F считаются ОТДЕЛЬНО по вариантам, иначе 81 изменённая фигура усреднится с 2001
    t = ST.within_adapter_deltas(v, "t_cmd_drawn_ms", seed=0, n_boot=200)
    assert set(t["variant"]) == {"baseline", "large-share"}
    base = t[(t["adapter"] == "H") & (t["variant"] == "baseline")].iloc[0]
    big = t[(t["adapter"] == "H") & (t["variant"] == "large-share")].iloc[0]
    assert big["median_F"] == pytest.approx(4 * base["median_F"])
    tp = ST.within_adapter_deltas_paired(v, "t_cmd_drawn_ms", seed=0, n_boot=200)
    assert set(tp["variant"]) == {"baseline", "large-share"}
    assert int(tp[(tp["adapter"] == "H") & (tp["variant"] == "baseline")].iloc[0]["n_pairs"]) == 30
    bt = ST.between_adapter_comparison(v, "t_cmd_drawn_ms", seed=0, n_boot=200)
    assert set(bt["variant"]) == {"baseline", "large-share"}
    btp = ST.between_adapter_comparison_paired(v, "t_cmd_drawn_ms", seed=0, n_boot=200)
    assert set(btp["variant"]) == {"baseline", "large-share"}


def test_budget_share_uses_series_budget(series):
    """Доля «сценарий в бюджете» считается против порога серии, а не против 30 с."""
    long = series.copy()
    long["t_scenario_ms"] = 52000.0
    bc30 = ST.budget_checks(long)
    row30 = bc30[(bc30["budget"] == "scenario_budget_share") & (bc30["config"] == "H/F")].iloc[0]
    assert row30["k"] == 0 and S.is_false(row30["ok"])
    bc70 = ST.budget_checks(long, scenario_budget_ms=70000)
    row70 = bc70[(bc70["budget"] == "scenario_budget_share") & (bc70["config"] == "H/F")].iloc[0]
    assert row70["k"] == row70["n"] and S.is_true(row70["ok"]) and row70["scenario_budget_ms"] == 70000
    st = ST.success_table(long, scenario_budget_ms=70000)
    assert int(st[st["config"] == "H/F"].iloc[0]["n_within_budget"]) == 30
    # бюджет, записанный в кадр загрузчиком, используется без явного аргумента
    long[S.SCENARIO_BUDGET_COLUMN] = 70000.0
    assert int(ST.success_table(long)[lambda d: d["config"] == "H/F"].iloc[0]["n_within_budget"]) == 30
