"""Интеграционный тест против PostgreSQL: собственная тестовая БД
`stand_reference_test` на локальном кластере (SPEC §0). Пропускается, если
кластер недоступен. БД `editor` стенда не затрагивается.
"""

import json
import os

import pytest

psycopg = pytest.importorskip("psycopg")

from reference import db as dbmod
from reference.compare import compare_db_state, main
from reference.model import ReferenceModel
from reference.operations import check_operations

from .fixture_gen import instances_of, make_document, sources_of

ADMIN_DSN = os.environ.get("STAND_TEST_ADMIN_DSN", "postgres://postgres:postgres@127.0.0.1:5432/postgres")
TEST_DB = "stand_reference_test"
TEST_DSN = ADMIN_DSN.rsplit("/", 1)[0] + "/" + TEST_DB

SCHEMA = """
CREATE TABLE users(id text primary key, login text unique, password_hash text);
CREATE TABLE documents(id text primary key, owner_id text references users(id), name text, revision int not null default 0);
CREATE TABLE pages(id text primary key, document_id text references documents(id), index int, name text);
CREATE TABLE shapes(id text primary key, document_id text, page_id text references pages(id), kind text,
  x double precision, y double precision, w double precision, h double precision, z int,
  text text, fill text, is_source bool, source_id text, fill_overridden bool);
CREATE INDEX ON shapes(page_id); CREATE INDEX ON shapes(source_id); CREATE INDEX ON shapes(document_id);
CREATE TABLE operations(op_id text primary key, document_id text, params_hash text, result jsonb, created_at timestamptz default now());
"""


@pytest.fixture(scope="module")
def dsn():
    try:
        conn = psycopg.connect(ADMIN_DSN, autocommit=True, connect_timeout=3)
    except Exception as e:  # pragma: no cover
        pytest.skip(f"PostgreSQL unavailable: {e}")
    with conn:
        conn.execute(f"DROP DATABASE IF EXISTS {TEST_DB}")
        conn.execute(f"CREATE DATABASE {TEST_DB}")
    with psycopg.connect(TEST_DSN) as c:
        c.execute(SCHEMA)
        c.commit()
    yield TEST_DSN
    with psycopg.connect(ADMIN_DSN, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {TEST_DB}")


def load_doc(conn, doc):
    d = doc["document"]
    conn.execute("INSERT INTO users(id, login, password_hash) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING", (d["ownerId"], d["ownerId"], "x"))
    conn.execute("INSERT INTO documents(id, owner_id, name, revision) VALUES (%s,%s,%s,%s)", (d["id"], d["ownerId"], d["name"], d["revision"]))
    for p in doc["pages"]:
        conn.execute("INSERT INTO pages(id, document_id, index, name) VALUES (%s,%s,%s,%s)", (p["id"], d["id"], p["index"], p["name"]))
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO shapes(id, document_id, page_id, kind, x, y, w, h, z, text, fill, is_source, source_id, fill_overridden) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            [
                (s["id"], s["documentId"], s["pageId"], s["kind"], s["x"], s["y"], s["w"], s["h"], s["z"], s["text"], s["fill"], s["isSource"], s["sourceId"], s["fillOverridden"])
                for s in doc["shapes"]
            ],
        )


def server_like_apply(conn, doc_id, cmd):
    """Имитация серверной транзакции (независимая от эталона, чистый SQL)."""
    with conn.transaction():
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
            (cmd["opId"], doc_id, "h", json.dumps(result)),
        )


@pytest.mark.parametrize("backend", ["psycopg", "psql"])
def test_compare_db_against_real_postgres(dsn, tmp_path, backend):
    doc = make_document(pages=8, shapes_per_page=25, sources=3, instances_per_source=20, override_share=0.3, seed=11, doc_id=f"doc-{backend}")
    src = sources_of(doc)[0]
    inst = [i for i in instances_of(doc, src["id"]) if not i["fillOverridden"]][0]
    cmds = [
        {"opId": f"{backend}-1", "type": "setLocalFill", "targetId": inst["id"], "fill": "#0000ff"},
        {"opId": f"{backend}-2", "type": "setSourceFill", "targetId": src["id"], "fill": "#00ff00"},
    ]
    with psycopg.connect(dsn) as conn:
        load_doc(conn, doc)
        conn.commit()
        for c in cmds:
            server_like_apply(conn, doc["document"]["id"], c)
        conn.commit()

    if backend == "psql":
        import shutil

        if shutil.which("psql") is None:
            pytest.skip("psql not installed")

    actual = dbmod.read_document_state(dsn, doc["document"]["id"], backend=backend)
    m = ReferenceModel(doc)
    m.apply_all(cmds)
    rep = compare_db_state(m.expected_state(), actual)
    assert rep["ok"], rep["mismatches"][:5]
    ops = dbmod.read_operations(dsn, doc["document"]["id"], backend=backend)
    assert len(ops) == 2 and isinstance(ops[0]["result"], dict)
    op_rep = check_operations(doc, cmds, ops, actual_revision=actual["revision"])
    assert op_rep["ok"], op_rep["mismatches"]

    # CLI end-to-end
    doc_path = tmp_path / "doc.json"
    cmd_path = tmp_path / "cmds.json"
    rep_path = tmp_path / "rep.json"
    doc_path.write_text(json.dumps(doc))
    cmd_path.write_text(json.dumps(cmds))
    rc = main(["compare-db", "--doc", str(doc_path), "--commands", str(cmd_path), "--db", dsn, "--backend", backend, "--check-operations", "--out", str(rep_path)])
    assert rc == 0
    assert json.loads(rep_path.read_text())["ok"]

    # порча в БД: экземпляр на «незагруженной» странице остался со старым цветом
    victim = [i for i in instances_of(doc, src["id"]) if not i["fillOverridden"]][2]
    with psycopg.connect(dsn) as conn:
        conn.execute("UPDATE shapes SET fill=%s WHERE id=%s", (src["fill"], victim["id"]))
        conn.commit()
    rc = main(["compare-db", "--doc", str(doc_path), "--commands", str(cmd_path), "--db", dsn, "--backend", backend, "--out", str(rep_path)])
    assert rc == 1
    rep = json.loads(rep_path.read_text())
    assert rep["counts"]["fill"] == 1 and rep["mismatches"][0]["shapeId"] == victim["id"]

    # дамп psql → JSON и сравнение по дампу
    dump_path = tmp_path / "dump.json"
    assert main(["dump-db", "--db", dsn, "--doc-id", doc["document"]["id"], "--backend", backend, "--out", str(dump_path)]) == 0
    rc = main(["compare-db", "--doc", str(doc_path), "--commands", str(cmd_path), "--db-dump", str(dump_path), "--out", str(rep_path)])
    assert rc == 1
