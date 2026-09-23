"""Интеграционный тест против реальной БД стенда `editor` и экспорта генератора
`data/acceptance.json` (SPEC §5, §6). Пишущая часть выполняется в транзакции,
которая откатывается: постоянных изменений в `editor` не остаётся.
Пропускается, если БД/документ/файл недоступны.
"""

import json
import os
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")

from reference import db as dbmod
from reference.compare import compare_db_state, compare_snapshots
from reference.model import ReferenceModel
from reference.operations import check_operations

ROOT = Path(__file__).resolve().parents[3]
DOC_PATH = Path(os.environ.get("STAND_ACCEPTANCE_JSON", ROOT / "data" / "acceptance.json"))
EDITOR_DSN = os.environ.get("STAND_DB_DSN", "postgres://postgres:postgres@127.0.0.1:5432/editor")


@pytest.fixture(scope="module")
def doc():
    if not DOC_PATH.exists():
        pytest.skip(f"{DOC_PATH} not found (generator has not exported yet)")
    return json.loads(DOC_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def conn(doc):
    try:
        c = psycopg.connect(EDITOR_DSN, connect_timeout=3)
    except Exception as e:  # pragma: no cover
        pytest.skip(f"editor DB unavailable: {e}")
    row = c.execute("SELECT revision FROM documents WHERE id=%s", (doc["document"]["id"],)).fetchone()
    if row is None:
        c.close()
        pytest.skip(f"document {doc['document']['id']} is not loaded into editor DB")
    yield c
    c.rollback()
    c.close()


def test_acceptance_document_matches_reference_model(doc):
    m = ReferenceModel(doc)  # строгая валидация инвариантов §1.1 на реальном экспорте
    meta = doc.get("meta", {})
    assert len(m) == meta.get("shapeCount", len(doc["shapes"]))
    assert len(m.pages) == meta.get("pageCount", len(doc["pages"]))
    s1 = meta.get("s1", {}).get("id")
    if s1:
        inst = m.instances_of(s1)
        assert len(inst) == 100
        assert len({m.shape(i).pageId for i in inst}) == 10


def test_pristine_editor_db_matches_export_or_is_explained(doc, conn):
    """Без команд БД должна совпадать с экспортом; если другие агенты уже
    выполняли команды — расхождение объяснимо через operations."""
    doc_id = doc["document"]["id"]
    actual = dbmod.read_document_state(EDITOR_DSN, doc_id, conn=conn)
    ops = dbmod.read_operations(EDITOR_DSN, doc_id, conn=conn)
    m = ReferenceModel(doc)
    rep = compare_db_state(m.expected_state(), actual)
    if actual["revision"] == doc["document"]["revision"] and not ops:
        assert rep["ok"], rep["mismatches"][:5]
    else:
        # документ уже менялся: как минимум ревизия должна быть ≥ числа операций
        assert actual["revision"] >= doc["document"]["revision"] + len(ops)


def test_scenario_command_in_rolled_back_transaction(doc, conn):
    """Приёмочная команда setSourceFill(S*) + локальная заливка, применённые
    server‑like SQL в транзакции; чтение эталоном через то же соединение; откат."""
    doc_id = doc["document"]["id"]
    meta = doc.get("meta", {})
    s1 = meta.get("s1", {}).get("id") or max(
        (s["id"] for s in doc["shapes"] if s["isSource"]),
        key=lambda sid: sum(1 for s in doc["shapes"] if s["sourceId"] == sid),
    )
    # экземпляр S* на последней странице (не переопределённый) для локальной заливки
    last_page = max(doc["pages"], key=lambda p: p["index"])["id"]
    local_target = next(s["id"] for s in doc["shapes"] if s["sourceId"] == s1 and s["pageId"] == last_page and not s["fillOverridden"])
    cmds = [
        {"opId": "ref-test-op-1", "type": "setSourceFill", "targetId": s1, "fill": "#123456"},
        {"opId": "ref-test-op-2", "type": "setLocalFill", "targetId": local_target, "fill": "#123456"},
    ]

    with conn.transaction():
        # привести БД к состоянию экспорта (если другие агенты меняли документ) — внутри транзакции
        conn.execute(
            "UPDATE shapes s SET fill=b.fill, fill_overridden=b.fill_overridden FROM shapes_baseline b "
            "WHERE b.shape_id=s.id AND s.document_id=%s AND (s.fill<>b.fill OR s.fill_overridden<>b.fill_overridden)",
            (doc_id,),
        )
        conn.execute("UPDATE documents SET revision=%s WHERE id=%s", (doc["document"]["revision"], doc_id))
        conn.execute("DELETE FROM operations WHERE document_id=%s", (doc_id,))
        pristine = dbmod.read_document_state(EDITOR_DSN, doc_id, conn=conn)
        base = ReferenceModel(doc)
        assert compare_db_state(base.expected_state(), pristine)["ok"], "baseline reset must reproduce the export"

        for cmd in cmds:
            rev = conn.execute("SELECT revision FROM documents WHERE id=%s FOR UPDATE", (doc_id,)).fetchone()[0]
            if cmd["type"] == "setSourceFill":
                rows = conn.execute(
                    "UPDATE shapes SET fill=%s WHERE document_id=%s AND (id=%s OR (source_id=%s AND NOT fill_overridden)) RETURNING page_id",
                    (cmd["fill"], doc_id, cmd["targetId"], cmd["targetId"]),
                ).fetchall()
            else:
                rows = conn.execute(
                    "UPDATE shapes SET fill=%s, fill_overridden=true WHERE document_id=%s AND id=%s RETURNING page_id",
                    (cmd["fill"], doc_id, cmd["targetId"]),
                ).fetchall()
            conn.execute("UPDATE documents SET revision=%s WHERE id=%s", (rev + 1, doc_id))
            result = {"opId": cmd["opId"], "revision": rev + 1, "affectedPages": sorted({r[0] for r in rows}), "affectedShapes": len(rows)}
            conn.execute(
                "INSERT INTO operations(op_id, document_id, params_hash, result) VALUES (%s,%s,%s,%s::jsonb)",
                (cmd["opId"], doc_id, "test", json.dumps(result)),
            )

        actual = dbmod.dump_db(EDITOR_DSN, doc_id, conn=conn)
        m = ReferenceModel(doc)
        outs = m.apply_all(cmds)
        assert outs[0].affectedShapes == 1 + sum(1 for s in doc["shapes"] if s["sourceId"] == s1 and not s["fillOverridden"])
        assert len(outs[0].affectedPages) == 10
        rep = compare_db_state(m.expected_state(), actual)
        assert rep["ok"], rep["mismatches"][:5]
        op_rep = check_operations(doc, cmds + [cmds[0]], actual["operations"], actual_revision=actual["revision"])
        assert op_rep["ok"], op_rep["mismatches"][:5]

        # снимок страницы 50, как его отдал бы клиент: изменённые и переопределённые экземпляры S*
        page50 = {
            "pageId": last_page,
            "revision": actual["revision"],
            "shapes": [{"id": s["id"], "fill": s["fill"], "fillOverridden": s["fillOverridden"]} for s in actual["shapes"] if s["pageId"] == last_page],
        }
        assert compare_snapshots(doc, cmds, [page50])["ok"]
        exp50 = m.expected_page(last_page)
        by_id = {s["id"]: s for s in exp50["shapes"]}
        inst50 = [s for s in doc["shapes"] if s["sourceId"] == s1 and s["pageId"] == last_page]
        changed = [i for i in inst50 if not i["fillOverridden"]]
        kept = [i for i in inst50 if i["fillOverridden"]]
        assert changed and kept, "page 50 must hold both changeable and overridden instances (SPEC §5)"
        for i in changed:
            assert by_id[i["id"]]["fill"] == "#123456"
            assert by_id[i["id"]]["fillOverridden"] == (i["id"] == local_target)
        for i in kept:
            assert by_id[i["id"]]["fill"] == i["fill"] and by_id[i["id"]]["fillOverridden"] is True
        raise psycopg.Rollback()  # откат: в editor ничего не остаётся

    row = conn.execute("SELECT count(*) FROM operations WHERE op_id LIKE 'ref-test-op-%%'").fetchone()
    assert row[0] == 0

