import subprocess
import sys
from pathlib import Path

import pytest

from analysis import schema as S
from analysis import stats as ST
from analysis import report as R
from analysis.report import build_report, main
from analysis.synth import make_series, write_series

PKG = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def series_dir(tmp_path_factory):
    base = tmp_path_factory.mktemp("results")
    df, steps = make_series(name="main", runs=30, errors={("Z", "P"): 1}, timeouts={("Q", "F"): 1}, seed=3)
    write_series(base / "main", df, steps, passport={"cpu": "2 vCPU", "node": "24.21.0", "seed": 3})
    df3, steps3 = make_series(name="cache3", runs=10, cache=3, seed=4, modes=("P",), with_steps=0)
    write_series(base / "cache3", df3, steps3)
    return base


def test_report_renders_markdown_and_figures(series_dir, tmp_path):
    out = tmp_path / "docs" / "RESULTS_main.md"
    figs = tmp_path / "docs" / "figs" / "main"
    res = build_report(series_dir / "main", out, figs, seed=1, n_boot=200)
    text = out.read_text(encoding="utf-8")
    for h in (
        "# Результаты серии «main»",
        "## 1. Паспорт серии",
        "## 2. Состав серии и доля успеха",
        "## 3. Сводные показатели по конфигурациям",
        "## 4. Моменты команды: подтверждение сервера и актуальный холст",
        "## 5. Бюджеты (§1.2 / SPEC §7.4)",
        "## 6. Изменение внутри адаптера: P − F и P / F",
        "### 6.1 Парный (блочный) анализ — основной",
        "### 6.2 Непарная оценка",
        "## 7. Сопоставление изменения между адаптерами (§1.8)",
        "### 7.1 Парное сопоставление на общих блоках — основное",
        "### 7.2 Непарное сопоставление",
        "## 8. Удерживаемые записи и объявленное окно кеша",
        "## 9. Ошибки, прерывания и выбросы",
        "## 10. Полнота данных: необязательные и новые колонки",
        "## 11. Графики",
        "## 12. Выводы",
    ):
        assert h in text, h
    assert "| H/P (cache=1) |" in text and "| Z/F |" in text
    assert "Уилсон" in text and "`node`" in text
    assert "nav_3" in text  # ошибки не отбрасываются
    # каждое заголовочное число сопровождается n, медианой, p95 и интервалами
    assert "| Конфигурация | n | Медиана | 95 % ИД медианы | p95 | 95 % ИД p95 | min | max |" in text
    # бюджеты §1.2 названы явно
    for b in ("≤ 2 с", "≤ 1 с", "≥ 95 %", "768 МиБ", "4 vCPU", "8 ГиБ", "40 ГиБ"):
        assert b in text, b
    # моменты команды разделены, разложение времени Z опубликовано
    assert "drawn − ack" in text and "`t_cmd_server_ms`" in text
    # перекрёстная проверка обмена складывает HTTP и WebSocket
    assert "CDP: WebSocket" in text and "CDP: сумма" in text
    # новые/необязательные колонки перечислены
    assert "`probe_overrun_ms`" in text
    pngs = sorted(p.name for p in figs.glob("*.png"))
    expected = sorted(f"{m}.png" for m in S.FIGURE_METRICS) + ["retained_shapes_steps.png"]
    assert pngs == sorted(expected)
    for p in figs.glob("*.png"):
        assert p.stat().st_size > 5000
        assert p.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    assert f"figs/main/t_first_ready_ms.png" in text
    assert res["verdicts"].set_index("config").loc["H/P (cache=1)", "all_ok"] == True  # noqa: E712
    # детерминизм: повторный рендер с тем же seed даёт тот же текст (кроме строки с датой)
    out2 = tmp_path / "docs" / "RESULTS_main_2.md"
    build_report(series_dir / "main", out2, figs, seed=1, n_boot=200)
    strip = lambda t: "\n".join(l for l in t.splitlines() if not l.startswith("Сформировано"))  # noqa: E731
    assert strip(out2.read_text(encoding="utf-8")) == strip(text)


def test_report_compare_series(series_dir, tmp_path):
    out = tmp_path / "RESULTS.md"
    res = build_report(series_dir / "main", out, tmp_path / "figs", compare=[series_dir / "cache3"], seed=1, n_boot=100)
    text = out.read_text(encoding="utf-8")
    assert "## 12. Сравнение серий" in text and "## 13. Выводы" in text
    assert "| Конфигурация | main | cache3 |" in text
    assert "H/P (cache=3)" in text
    assert any(p.name.startswith("compare_") for p in res["figs"])


def test_report_without_optional_columns_and_without_pairing(tmp_path):
    """Серия старого формата: нет новых колонок и слишком мало повторений для блоков."""
    df, steps = make_series(name="smoke", runs=2, seed=7)
    optional = set(ST.OPTIONAL_METRICS) | {"cdp_ws_bytes_in", "cdp_ws_bytes_out"}
    drop = [c for c in df.columns if c in optional and c not in S.REQUIRED_COLUMNS]
    write_series(tmp_path / "smoke", df.drop(columns=drop), steps)
    out = tmp_path / "R.md"
    res = build_report(tmp_path / "smoke", out, tmp_path / "f", seed=1, n_boot=50)
    text = out.read_text(encoding="utf-8")
    assert res["paired"] is False
    assert "### 6.1 Парный (блочный) анализ — не выполняется" in text
    assert "### 7.1 Парное сопоставление не выполняется" in text
    # отсутствующие необязательные колонки названы, а не пропущены молча
    assert "Разложение времени команды у Z не опубликовано" in text
    assert "Отсутствуют колонки CDP" in text
    assert "† — интервал построен по n <" in text or "Знак † — интервал" in text


def test_report_lenient_builds_without_required_column(tmp_path):
    df, steps = make_series(name="broken", runs=6, seed=8)
    write_series(tmp_path / "broken", df.drop(columns=["js_heap_peak_mb"]), steps)
    out = tmp_path / "B.md"
    with pytest.raises(ValueError):
        build_report(tmp_path / "broken", out, tmp_path / "bf", seed=1, n_boot=50)
    res = build_report(tmp_path / "broken", out, tmp_path / "bf", seed=1, n_boot=50, lenient=True)
    assert not res["validation"].ok
    assert "MISSING required columns: js_heap_peak_mb" in out.read_text(encoding="utf-8")


def test_cli(series_dir, tmp_path):
    out = tmp_path / "R.md"
    assert main(["--series", str(series_dir / "main"), "--out", str(out), "--figs", str(tmp_path / "f"), "--n-boot", "50"]) == 0
    assert out.exists()
    assert main(["--series", str(series_dir / "main"), "--validate-only"]) == 0
    broken = tmp_path / "broken"
    broken.mkdir()
    df, _ = make_series(name="b", runs=2)
    df.drop(columns=["bytes_in"]).to_csv(broken / "runs.csv", index=False)
    assert main(["--series", str(broken), "--validate-only"]) == 1
    assert main(["--series", str(broken), "--out", str(tmp_path / "x.md")]) == 2
    assert main(["--series", str(tmp_path / "nope"), "--out", str(tmp_path / "x.md")]) == 2
    proc = subprocess.run([sys.executable, "-m", "analysis.report", "--series", str(series_dir / "main"), "--out", str(tmp_path / "m.md"), "--figs", str(tmp_path / "mf"), "--n-boot", "50"], cwd=PKG, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert "report:" in proc.stdout


def test_md_table_escapes_pipes_from_data():
    """Значение из данных не должно ломать таблицу: в паспорте лежат регулярные выражения с `|`."""
    t = R.md_table(["Ключ", "Значение"], [["`procGroups`", '[{"patterns": ["(^|/)postgres .*16/main"]}]']])
    body = [ln for ln in t.split("\n") if ln.startswith("|")]
    assert all(ln.count("|") - ln.count("\\|") == 3 for ln in body), t
    assert "(^\\|/)postgres" in t
    # перевод строки внутри значения тоже разрывал бы таблицу
    assert R.md_table(["a"], [["x\ny"]]) == "| a |\n|---|\n| x y |\n"
