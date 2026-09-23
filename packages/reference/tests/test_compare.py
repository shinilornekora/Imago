import json
import subprocess
import sys
from pathlib import Path

import pytest

from reference.compare import compare_db_state, compare_snapshots, load_snapshots, main
from reference.model import ReferenceModel
from reference.operations import check_operations

from .fixture_gen import instances_of, make_document, sources_of

PKG = Path(__file__).resolve().parents[1]


@pytest.fixture
def doc():
    return make_document(pages=6, shapes_per_page=15, sources=2, instances_per_source=14, override_share=0.35, seed=3)


@pytest.fixture
def commands(doc):
    src = sources_of(doc)[0]
    inst = [i for i in instances_of(doc, src["id"]) if not i["fillOverridden"]][0]
    return [
        {"opId": "op-a", "type": "setLocalFill", "targetId": inst["id"], "fill": "#00ff00", "expectedRevision": 0},
        {"opId": "op-b", "type": "setSourceFill", "targetId": src["id"], "fill": "#ff0000", "expectedRevision": 1},
    ]


def actual_from_model(m: ReferenceModel):
    """Имитация чтения из БД по ожидаемому состоянию (совпадает с эталоном)."""
    return {
        "docId": m.docId,
        "revision": m.revision,
        "shapes": [
            {"id": s.id, "pageId": s.pageId, "fill": s.fill, "fillOverridden": s.fillOverridden}
            for s in m.shapes()
        ],
    }


def test_compare_db_ok_and_mismatch_detection(doc, commands):
    m = ReferenceModel(doc)
    m.apply_all(commands)
    actual = actual_from_model(m)
    rep = compare_db_state(m.expected_state(), actual)
    assert rep["ok"] and rep["mismatchTotal"] == 0
    assert rep["counts"]["compared"] == len(doc["shapes"])

    # порча: одна заливка, один флаг, ревизия, пропавшая и лишняя фигура
    src = sources_of(doc)[0]
    bad = json.loads(json.dumps(actual))
    bad["revision"] = 1
    by_id = {s["id"]: s for s in bad["shapes"]}
    inst = [i for i in instances_of(doc, src["id"]) if not i["fillOverridden"]][1]
    by_id[inst["id"]]["fill"] = "#123456"  # «незагруженная страница» не обновилась
    by_id[commands[0]["targetId"]]["fillOverridden"] = False  # переопределение потеряно
    bad["shapes"].remove(by_id[doc["shapes"][-1]["id"]])
    bad["shapes"].append({"id": "ghost", "pageId": doc["pages"][1]["id"], "fill": "#000000", "fillOverridden": False})
    rep = compare_db_state(m.expected_state(), bad, max_mismatches=3)
    assert not rep["ok"]
    assert rep["counts"]["revision"] == 1
    assert rep["counts"]["fill"] == 1
    assert rep["counts"]["fillOverridden"] == 1
    assert rep["counts"]["missingInDb"] == 1
    assert rep["counts"]["extraInDb"] == 1
    assert rep["mismatchTotal"] == 5
    assert len(rep["mismatches"]) == 3 and rep["truncated"] is True
    kinds = {x["kind"] for x in rep["mismatches"]}
    assert "revision" in kinds


def test_compare_snapshots_exact_sets_and_revision(doc, commands):
    m = ReferenceModel(doc)
    m.apply_all(commands)
    src = sources_of(doc)[0]
    pages = sorted({i["pageId"] for i in instances_of(doc, src["id"])})
    snaps = [m.expected_page(p) for p in pages]
    rep = compare_snapshots(doc, commands, snaps)
    assert rep["ok"], rep
    assert rep["counts"]["pagesCompared"] == len(pages)

    # ревизия выше ожидаемой — допустимо
    s2 = json.loads(json.dumps(snaps))
    s2[0]["revision"] = 99
    assert compare_snapshots(doc, commands, s2)["ok"]

    # ревизия ниже, лишняя фигура, пропавшая фигура, устаревшая заливка
    s3 = json.loads(json.dumps(snaps))
    s3[0]["revision"] = 1
    s3[1]["shapes"].append({"id": "extra", "fill": "#000000", "fillOverridden": False})
    removed = s3[2]["shapes"].pop()
    stale = [s for s in s3[3]["shapes"] if s["fill"] == "#ff0000"]
    if stale:
        stale[0]["fill"] = src["fill"]
    rep = compare_snapshots(doc, commands, s3)
    assert not rep["ok"]
    assert rep["counts"]["revisionTooLow"] == 1
    assert rep["counts"]["extraInSnapshot"] == 1
    assert rep["counts"]["missingInSnapshot"] == 1
    assert rep["counts"]["fill"] == (1 if stale else 0)
    assert any(x["kind"] == "missing_in_snapshot" and x["shapeId"] == removed["id"] for x in rep["mismatches"])

    # неизвестная страница
    rep = compare_snapshots(doc, commands, [{"pageId": "nope", "revision": 2, "shapes": []}])
    assert not rep["ok"] and rep["counts"]["unknownPage"] == 1


def test_compare_snapshots_after_n_commands(doc, commands):
    m1 = ReferenceModel(doc)
    m1.apply(commands[0])
    pid = doc["shapes"][0]["pageId"]
    snap = m1.expected_page(pid)
    snap["afterCommands"] = 1
    assert compare_snapshots(doc, commands, [snap])["ok"]
    # тот же снимок против финального состояния — ревизия слишком низкая
    del snap["afterCommands"]
    assert not compare_snapshots(doc, commands, [snap])["ok"]


# --- A11: в режиме P сверяются снимки ВСЕХ загруженных страниц, а не только последней ----------
def _visit_snapshots(doc, commands, route):
    """Снимки «как их обязан писать сценарий»: по снимку на каждое посещение страницы,
    снятые пока страница ещё в окне кеша, с `visitSeq` и `afterCommands`."""
    models = {}

    def model(n):
        if n not in models:
            m = ReferenceModel(doc)
            m.apply_all(commands[:n])
            models[n] = m
        return models[n]

    visits, snaps = [], []
    for seq, (pid, after) in enumerate(route):
        visits.append({"seq": seq, "step": seq, "pageId": pid, "afterCommands": after})
        s = model(after).expected_page(pid)
        s["visitSeq"] = seq
        s["afterCommands"] = after
        snaps.append(s)
    return visits, snaps


def test_visit_coverage_requires_a_snapshot_per_visit(doc, commands):
    pages = [p["id"] for p in doc["pages"]]
    # маршрут с возвратами: страница 0 посещается до и после команд — два разных ожидаемых состояния
    route = [(pages[0], 0), (pages[1], 0), (pages[2], 0), (pages[0], 2), (pages[3], 2)]
    visits, snaps = _visit_snapshots(doc, commands, route)

    rep = compare_snapshots(doc, commands, snaps, visits=visits)
    assert rep["ok"], rep["mismatches"]
    assert rep["counts"]["visits"] == 5 and rep["counts"]["visitsCovered"] == 5
    assert rep["counts"]["pagesCompared"] == 5

    # окно кеша вытеснило промежуточные страницы — записан снимок только последней (нынешнее
    # поведение сценария в режиме P). Это обязано быть провалом, а не «эталон совпал».
    rep = compare_snapshots(doc, commands, [snaps[-1]], visits=visits)
    assert not rep["ok"]
    assert rep["counts"]["visitSnapshotMissing"] == 4
    assert {m["pageId"] for m in rep["mismatches"] if m["kind"] == "visit_snapshot_missing"} == {
        pages[0], pages[1], pages[2]
    }

    # снимок промежуточной страницы записан, но с устаревшей заливкой → расхождение ловится
    bad = json.loads(json.dumps(snaps))
    bad[3]["shapes"][0]["fill"] = "#123456"
    rep = compare_snapshots(doc, commands, bad, visits=visits)
    assert not rep["ok"] and rep["counts"]["fill"] == 1

    # снимок не удалось снять (страница уже вытеснена) — не «совпало»
    err = json.loads(json.dumps(snaps))
    err[1] = {"pageId": pages[1], "visitSeq": 1, "error": "page evicted"}
    rep = compare_snapshots(doc, commands, err, visits=visits)
    assert not rep["ok"] and rep["counts"]["snapshotError"] == 1

    # снимок подменён другой страницей
    swapped = json.loads(json.dumps(snaps))
    swapped[2]["pageId"] = pages[4]
    rep = compare_snapshots(doc, commands, swapped, visits=visits)
    assert not rep["ok"] and rep["counts"]["visitPageMismatch"] == 1

    # снимок снят не в тот момент (до команды вместо после)
    moment = json.loads(json.dumps(snaps))
    moment[3]["afterCommands"] = 0
    rep = compare_snapshots(doc, commands, moment, visits=visits)
    assert not rep["ok"] and rep["counts"]["visitMomentMismatch"] == 1


def test_cli_require_visits(tmp_path, doc, commands):
    pages = [p["id"] for p in doc["pages"]]
    route = [(pages[0], 0), (pages[1], 0), (pages[2], 2)]
    visits, snaps = _visit_snapshots(doc, commands, route)
    doc_path = tmp_path / "doc.json"
    doc_path.write_text(json.dumps(doc))
    cmd_path = tmp_path / "cmds.json"
    cmd_path.write_text(json.dumps(commands))
    visits_path = tmp_path / "visits.json"
    visits_path.write_text(json.dumps({"visits": visits}))
    snap_dir = tmp_path / "snaps"
    snap_dir.mkdir()
    for s in snaps:
        (snap_dir / f"v{s['visitSeq']:03d}.json").write_text(json.dumps(s))
    argv = ["compare-snapshots", "--doc", str(doc_path), "--commands", str(cmd_path), "--snapshots", str(snap_dir)]
    assert main([*argv, "--require-visits", str(visits_path)]) == 0

    # убираем снимок промежуточного посещения — прогон обязан упасть
    (snap_dir / "v001.json").unlink()
    assert main([*argv, "--require-visits", str(visits_path)]) == 1
    # без --require-visits та же выборка проходит — это и есть дефект A11
    assert main(argv) == 0

    # пустой журнал посещений — ошибка входа, а не «нечего проверять»
    empty = tmp_path / "empty.json"
    empty.write_text(json.dumps({"visits": []}))
    assert main([*argv, "--require-visits", str(empty)]) == 2


def test_check_operations_one_row_per_logical_op(doc, commands):
    m = ReferenceModel(doc)
    outs = m.apply_all(commands)
    rows = [
        {"opId": o.opId, "documentId": m.docId, "paramsHash": "x", "result": o.as_dict()} for o in outs
    ]
    # повтор команды (ретрай) в журнале команд — логическая операция одна
    cmds = [commands[0], commands[0], commands[1]]
    rep = check_operations(doc, cmds, rows, actual_revision=2)
    assert rep["ok"], rep
    assert rep["counts"]["logicalOps"] == 2 and rep["counts"]["retriesDropped"] == 1

    # вторая строка/ревизия для того же opId — нарушение идемпотентности
    rows_dup = rows + [{"opId": "op-a", "documentId": m.docId, "paramsHash": "x", "result": {**outs[0].as_dict(), "revision": 3}}]
    rep = check_operations(doc, cmds, rows_dup, actual_revision=3)
    assert not rep["ok"]
    assert rep["counts"]["duplicates"] == 1 and rep["counts"]["finalRevisionMismatch"] == 1

    # ревизия в result не по порядку; лишняя операция; пропавшая операция
    rows_bad = [dict(rows[0]), {"opId": "op-zzz", "documentId": m.docId, "result": {"revision": 5}}]
    rows_bad[0]["result"] = {**rows_bad[0]["result"], "revision": 7, "affectedShapes": 42}
    rep = check_operations(doc, commands, rows_bad)
    assert not rep["ok"]
    assert rep["counts"]["missing"] == 1
    assert rep["counts"]["extra"] == 1
    assert rep["counts"]["revisionMismatch"] == 1
    assert rep["counts"]["resultMismatch"] == 1
    rep2 = check_operations(doc, commands, rows_bad, allow_extra=True)
    assert rep2["counts"]["extra"] == 1 and not any(x["kind"] == "extra_operation" for x in rep2["mismatches"])


def test_cli_expected_snapshots_and_dump(tmp_path, doc, commands):
    doc_path = tmp_path / "doc.json"
    cmd_path = tmp_path / "cmds.json"
    doc_path.write_text(json.dumps(doc))
    cmd_path.write_text(json.dumps({"commands": commands}))
    out = tmp_path / "expected.json"
    assert main(["expected", "--doc", str(doc_path), "--commands", str(cmd_path), "--out", str(out)]) == 0
    exp = json.loads(out.read_text())
    assert exp["revision"] == 2 and len(exp["results"]) == 2

    m = ReferenceModel(doc)
    m.apply_all(commands)
    snap_dir = tmp_path / "snaps"
    snap_dir.mkdir()
    for p in doc["pages"][:3]:
        (snap_dir / f"{p['id']}.json").write_text(json.dumps(m.expected_page(p["id"])))
    rep_path = tmp_path / "rep.json"
    rc = main(["compare-snapshots", "--doc", str(doc_path), "--commands", str(cmd_path), "--snapshots", str(snap_dir), "--out", str(rep_path)])
    assert rc == 0
    rep = json.loads(rep_path.read_text())
    assert rep["ok"] and rep["counts"]["pagesCompared"] == 3
    assert len(load_snapshots(snap_dir)) == 3
    # обязательная страница отсутствует
    rc = main(["compare-snapshots", "--doc", str(doc_path), "--commands", str(cmd_path), "--snapshots", str(snap_dir), "--require-pages", doc["pages"][5]["id"]])
    assert rc == 1

    # compare-db по дампу (psql → JSON), с проверкой operations
    dump = {
        "docId": m.docId,
        "revision": m.revision,
        "shapes": [{"id": s.id, "pageId": s.pageId, "fill": s.fill, "fillOverridden": s.fillOverridden} for s in m.shapes()],
        "operations": [{"opId": o.opId, "documentId": m.docId, "result": o.as_dict()} for o in m.outcomes],
    }
    dump_path = tmp_path / "dump.json"
    dump_path.write_text(json.dumps(dump))
    rc = main(["compare-db", "--doc", str(doc_path), "--commands", str(cmd_path), "--db-dump", str(dump_path), "--check-operations", "--out", str(rep_path)])
    assert rc == 0
    rep = json.loads(rep_path.read_text())
    assert rep["ok"] and rep["operations"]["ok"]
    dump["revision"] = 1
    dump_path.write_text(json.dumps(dump))
    rc = main(["compare-db", "--doc", str(doc_path), "--commands", str(cmd_path), "--db-dump", str(dump_path), "--out", str(rep_path)])
    assert rc == 1
    assert json.loads(rep_path.read_text())["counts"]["revision"] == 1

    # запуск как модуля
    proc = subprocess.run(
        [sys.executable, "-m", "reference.compare", "compare-db", "--doc", str(doc_path), "--commands", str(cmd_path), "--db-dump", str(dump_path)],
        cwd=PKG,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 1
    assert "MISMATCH" in proc.stderr


def test_cli_bad_input_returns_2(tmp_path):
    p = tmp_path / "x.json"
    p.write_text("{}")
    assert main(["expected", "--doc", str(p)]) == 2
