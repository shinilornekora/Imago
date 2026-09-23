"""Чтение фактического состояния из PostgreSQL (SPEC §3) — psycopg или psql --csv.

Эталон читает таблицы напрямую явными SQL‑запросами; серверный код не
используется. Результат приводится к camelCase, как в снимках клиента.
"""

from __future__ import annotations

import csv
import io
import json
import shutil
import subprocess
from typing import Any

try:  # psycopg[binary] — предпочтительный путь
    import psycopg  # type: ignore

    HAVE_PSYCOPG = True
except Exception:  # pragma: no cover — зависит от окружения
    psycopg = None  # type: ignore
    HAVE_PSYCOPG = False


class DbError(RuntimeError):
    pass


SQL_REVISION = "SELECT revision FROM documents WHERE id = {p}"
SQL_SHAPES = (
    "SELECT id, page_id, fill, fill_overridden, is_source, source_id "
    "FROM shapes WHERE document_id = {p} ORDER BY id"
)
SQL_OPERATIONS = (
    "SELECT op_id, document_id, params_hash, result::text AS result, created_at::text AS created_at "
    "FROM operations WHERE document_id = {p} ORDER BY created_at, op_id"
)


def _rows_psycopg(dsn: str, sql: str, params: tuple[Any, ...], conn: Any = None) -> list[dict[str, Any]]:
    def run(c: Any) -> list[dict[str, Any]]:
        with c.cursor() as cur:
            cur.execute(sql.format(p="%s"), params)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    if conn is not None:  # переданное соединение (например, внутри транзакции теста)
        return run(conn)
    with psycopg.connect(dsn) as c:  # type: ignore[union-attr]
        return run(c)


def _quote_literal(v: Any) -> str:
    s = str(v).replace("'", "''")
    return f"'{s}'"


def _rows_psql(dsn: str, sql: str, params: tuple[Any, ...]) -> list[dict[str, Any]]:
    if shutil.which("psql") is None:
        raise DbError("neither psycopg nor psql is available")
    q = sql.format(p=_quote_literal(params[0]))
    proc = subprocess.run(
        ["psql", dsn, "--csv", "-v", "ON_ERROR_STOP=1", "-X", "-q", "-c", q],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise DbError(f"psql failed: {proc.stderr.strip()}")
    reader = csv.DictReader(io.StringIO(proc.stdout))
    out = []
    for row in reader:
        out.append(dict(row))
    return out


def _rows(dsn: str, sql: str, params: tuple[Any, ...], backend: str, conn: Any = None) -> list[dict[str, Any]]:
    if conn is not None or backend == "psycopg" or (backend == "auto" and HAVE_PSYCOPG):
        if not HAVE_PSYCOPG:
            raise DbError("psycopg is not installed")
        return _rows_psycopg(dsn, sql, params, conn)
    return _rows_psql(dsn, sql, params)


def _to_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    s = str(v).strip().lower()
    return s in ("t", "true", "1", "yes")


def _to_int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    return int(v)


def read_document_state(dsn: str, doc_id: str, *, backend: str = "auto", conn: Any = None) -> dict[str, Any]:
    """{docId, revision, shapes:[{id,pageId,fill,fillOverridden,isSource,sourceId}]}

    `conn` — открытое соединение psycopg (тогда чтение идёт в его транзакции)."""
    rev_rows = _rows(dsn, SQL_REVISION, (doc_id,), backend, conn)
    if not rev_rows:
        raise DbError(f"document {doc_id} not found in DB")
    revision = _to_int(rev_rows[0]["revision"])
    shapes = []
    for r in _rows(dsn, SQL_SHAPES, (doc_id,), backend, conn):
        shapes.append(
            {
                "id": r["id"],
                "pageId": r["page_id"],
                "fill": r["fill"],
                "fillOverridden": _to_bool(r["fill_overridden"]),
                "isSource": _to_bool(r.get("is_source")),
                "sourceId": r.get("source_id") or None,
            }
        )
    return {"docId": doc_id, "revision": revision, "shapes": shapes}


def read_operations(dsn: str, doc_id: str, *, backend: str = "auto", conn: Any = None) -> list[dict[str, Any]]:
    """[{opId, documentId, paramsHash, result:dict|None, createdAt}]"""
    out = []
    for r in _rows(dsn, SQL_OPERATIONS, (doc_id,), backend, conn):
        res = r.get("result")
        if isinstance(res, str):
            res = json.loads(res) if res else None
        out.append(
            {
                "opId": r["op_id"],
                "documentId": r["document_id"],
                "paramsHash": r.get("params_hash"),
                "result": res,
                "createdAt": r.get("created_at"),
            }
        )
    return out


def dump_db(dsn: str, doc_id: str, *, backend: str = "auto", conn: Any = None) -> dict[str, Any]:
    """Полный дамп для офлайн‑сравнения (`psql → JSON`, SPEC §6)."""
    state = read_document_state(dsn, doc_id, backend=backend, conn=conn)
    state["operations"] = read_operations(dsn, doc_id, backend=backend, conn=conn)
    return state
