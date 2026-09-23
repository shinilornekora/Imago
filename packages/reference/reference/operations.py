"""Проверка таблицы operations (SPEC §2.3, §6 п. 6).

Инвариант: ровно одна запись на логическую операцию (opId); `result.revision`
образует ожидаемую последовательность ревизий; `affectedPages`/`affectedShapes`
совпадают с эталоном. Повтор команды с тем же opId (обрыв ответа + ретрай)
не должен порождать вторую запись и вторую ревизию.
"""

from __future__ import annotations

from typing import Any

from .model import CommandError, ReferenceModel, dedupe_by_op_id


def check_operations(
    doc: dict[str, Any],
    commands: list[dict[str, Any]],
    op_rows: list[dict[str, Any]],
    *,
    actual_revision: int | None = None,
    check_affected: bool = True,
    allow_extra: bool = False,
    max_mismatches: int = 200,
) -> dict[str, Any]:
    """Возвращает отчёт {ok, counts, mismatches[], truncated}.

    op_rows — строки таблицы operations в camelCase (см. db.read_operations):
    [{opId, documentId, paramsHash, result:{opId?,revision,affectedPages,affectedShapes}}]
    """
    doc_id = str(doc["document"]["id"])
    unique, dropped = dedupe_by_op_id(commands)
    model = ReferenceModel(doc)
    mismatches: list[dict[str, Any]] = []
    total = 0

    def add(m: dict[str, Any]) -> None:
        nonlocal total
        total += 1
        if len(mismatches) < max_mismatches:
            mismatches.append(m)

    expected: list[dict[str, Any]] = []
    unchecked = 0
    for c in unique:
        try:
            out = model.apply(c)
        except CommandError as e:
            add({"kind": "reference_rejects_command", "opId": c.get("opId"), "detail": str(e)})
            continue
        if out.opId is None:
            unchecked += 1
            continue
        expected.append(out.as_dict())

    by_op: dict[str, list[dict[str, Any]]] = {}
    for r in op_rows:
        by_op.setdefault(str(r["opId"]), []).append(r)

    counts = {
        "commandsGiven": len(commands),
        "logicalOps": len(expected),
        "retriesDropped": len(dropped),
        "conflictsExpected": sum(1 for d in dropped if d.get("conflict")),
        "unchecked": unchecked,
        "rows": len(op_rows),
        "missing": 0,
        "duplicates": 0,
        "wrongDocument": 0,
        "revisionMismatch": 0,
        "resultMismatch": 0,
        "extra": 0,
        "finalRevisionMismatch": 0,
    }

    for exp in expected:
        rows = by_op.pop(exp["opId"], [])
        if not rows:
            counts["missing"] += 1
            add({"kind": "missing_operation", "opId": exp["opId"], "expected": exp})
            continue
        if len(rows) > 1:
            counts["duplicates"] += 1
            add({"kind": "duplicate_operation", "opId": exp["opId"], "rows": len(rows)})
        row = rows[0]
        if row.get("documentId") not in (None, doc_id):
            counts["wrongDocument"] += 1
            add({"kind": "wrong_document", "opId": exp["opId"], "actual": row.get("documentId")})
        res = row.get("result") or {}
        if not isinstance(res, dict):
            counts["resultMismatch"] += 1
            add({"kind": "bad_result_json", "opId": exp["opId"], "actual": res})
            continue
        if res.get("revision") != exp["revision"]:
            counts["revisionMismatch"] += 1
            add(
                {
                    "kind": "result_revision",
                    "opId": exp["opId"],
                    "expected": exp["revision"],
                    "actual": res.get("revision"),
                }
            )
        if check_affected:
            pages = res.get("affectedPages")
            pages_sorted = sorted(pages) if isinstance(pages, list) else pages
            if pages_sorted != exp["affectedPages"]:
                counts["resultMismatch"] += 1
                add(
                    {
                        "kind": "result_affected_pages",
                        "opId": exp["opId"],
                        "expected": exp["affectedPages"],
                        "actual": pages,
                    }
                )
            if res.get("affectedShapes") != exp["affectedShapes"]:
                counts["resultMismatch"] += 1
                add(
                    {
                        "kind": "result_affected_shapes",
                        "opId": exp["opId"],
                        "expected": exp["affectedShapes"],
                        "actual": res.get("affectedShapes"),
                    }
                )

    # Строки, которых нет среди логических операций (в т. ч. записи о повторах)
    for op, rows in by_op.items():
        counts["extra"] += len(rows)
        if not allow_extra:
            add({"kind": "extra_operation", "opId": op, "rows": len(rows)})

    if actual_revision is not None and actual_revision != model.revision:
        counts["finalRevisionMismatch"] = 1
        add({"kind": "final_revision", "expected": model.revision, "actual": actual_revision})

    ok = total == 0
    return {
        "ok": ok,
        "kind": "operations",
        "docId": doc_id,
        "expectedRevision": model.revision,
        "actualRevision": actual_revision,
        "counts": counts,
        "mismatchTotal": total,
        "mismatches": mismatches,
        "truncated": total > len(mismatches),
        "expectedResults": expected,
    }
