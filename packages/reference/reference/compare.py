"""CLI эталона: сравнение ожидаемого состояния с БД и со снимками клиента (SPEC §6).

    python -m reference.compare compare-db        --doc data/x.json --commands cmds.json --db postgres://... [--out report.json]
    python -m reference.compare compare-snapshots --doc data/x.json --commands cmds.json --snapshots dir/ [--require-pages a,b] [--require-visits visits.json] [--out report.json]
    python -m reference.compare check-operations  --doc data/x.json --commands cmds.json --db postgres://... [--out report.json]
    python -m reference.compare expected          --doc data/x.json --commands cmds.json [--out expected.json]
    python -m reference.compare dump-db           --db postgres://... --doc-id <id> [--out dump.json]

Код возврата: 0 — расхождений нет, 1 — есть расхождения, 2 — ошибка входа.
Отчёт — JSON: {ok, kind, docId, expectedRevision, actualRevision, counts, mismatches[], truncated}.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import db as dbmod
from .model import CommandError, DocumentError, ReferenceModel, dedupe_by_op_id, load_commands, load_document
from .operations import check_operations

DEFAULT_MAX_MISMATCHES = 200


class _Collector:
    def __init__(self, cap: int) -> None:
        self.cap = cap
        self.items: list[dict[str, Any]] = []
        self.total = 0

    def add(self, m: dict[str, Any]) -> None:
        self.total += 1
        if len(self.items) < self.cap:
            self.items.append(m)


# ----------------------------------------------------------------- pure checks
def compare_db_state(
    expected: dict[str, Any],
    actual: dict[str, Any],
    *,
    max_mismatches: int = DEFAULT_MAX_MISMATCHES,
) -> dict[str, Any]:
    """Сравнивает expected_state() модели с состоянием БД (db.read_document_state).

    Проверяются ревизия документа, fill/fillOverridden/pageId каждой фигуры,
    отсутствие лишних и недостающих фигур.
    """
    col = _Collector(max_mismatches)
    exp_shapes: dict[str, dict[str, Any]] = expected["shapes"]
    act_shapes: dict[str, dict[str, Any]] = {s["id"]: s for s in actual["shapes"]}
    counts = {
        "shapesExpected": len(exp_shapes),
        "shapesActual": len(act_shapes),
        "compared": 0,
        "fill": 0,
        "fillOverridden": 0,
        "pageId": 0,
        "missingInDb": 0,
        "extraInDb": 0,
        "revision": 0,
    }
    if actual.get("revision") != expected["revision"]:
        counts["revision"] = 1
        col.add({"kind": "revision", "expected": expected["revision"], "actual": actual.get("revision")})
    for sid in sorted(exp_shapes):
        e = exp_shapes[sid]
        a = act_shapes.get(sid)
        if a is None:
            counts["missingInDb"] += 1
            col.add({"kind": "missing_in_db", "shapeId": sid, "pageId": e["pageId"]})
            continue
        counts["compared"] += 1
        if a.get("fill") != e["fill"]:
            counts["fill"] += 1
            col.add(
                {"kind": "fill", "shapeId": sid, "pageId": e["pageId"], "expected": e["fill"], "actual": a.get("fill")}
            )
        if bool(a.get("fillOverridden")) != bool(e["fillOverridden"]):
            counts["fillOverridden"] += 1
            col.add(
                {
                    "kind": "fillOverridden",
                    "shapeId": sid,
                    "pageId": e["pageId"],
                    "expected": e["fillOverridden"],
                    "actual": a.get("fillOverridden"),
                }
            )
        if a.get("pageId") is not None and a.get("pageId") != e["pageId"]:
            counts["pageId"] += 1
            col.add({"kind": "pageId", "shapeId": sid, "expected": e["pageId"], "actual": a.get("pageId")})
    for sid in sorted(set(act_shapes) - set(exp_shapes)):
        counts["extraInDb"] += 1
        col.add({"kind": "extra_in_db", "shapeId": sid, "pageId": act_shapes[sid].get("pageId")})
    return {
        "ok": col.total == 0,
        "kind": "db",
        "docId": expected.get("docId"),
        "expectedRevision": expected["revision"],
        "actualRevision": actual.get("revision"),
        "counts": counts,
        "mismatchTotal": col.total,
        "mismatches": col.items,
        "truncated": col.total > len(col.items),
    }


def compare_page_snapshot(
    expected_page: dict[str, Any],
    snapshot: dict[str, Any],
    *,
    collector: _Collector,
    counts: dict[str, int],
) -> None:
    """Один снимок страницы против ожидаемого снимка (в тот же collector/counts)."""
    pid = expected_page["pageId"]
    exp = {s["id"]: s for s in expected_page["shapes"]}
    act = {s["id"]: s for s in snapshot.get("shapes") or []}
    counts["pagesCompared"] += 1
    rev = snapshot.get("revision")
    if not isinstance(rev, int) or rev < expected_page["revision"]:
        counts["revisionTooLow"] += 1
        collector.add(
            {"kind": "revision_too_low", "pageId": pid, "expected": expected_page["revision"], "actual": rev}
        )
    for sid in sorted(exp):
        e = exp[sid]
        a = act.get(sid)
        if a is None:
            counts["missingInSnapshot"] += 1
            collector.add({"kind": "missing_in_snapshot", "pageId": pid, "shapeId": sid})
            continue
        counts["compared"] += 1
        if a.get("fill") != e["fill"]:
            counts["fill"] += 1
            collector.add(
                {"kind": "fill", "pageId": pid, "shapeId": sid, "expected": e["fill"], "actual": a.get("fill")}
            )
        if bool(a.get("fillOverridden")) != bool(e["fillOverridden"]):
            counts["fillOverridden"] += 1
            collector.add(
                {
                    "kind": "fillOverridden",
                    "pageId": pid,
                    "shapeId": sid,
                    "expected": e["fillOverridden"],
                    "actual": a.get("fillOverridden"),
                }
            )
    for sid in sorted(set(act) - set(exp)):
        counts["extraInSnapshot"] += 1
        collector.add({"kind": "extra_in_snapshot", "pageId": pid, "shapeId": sid})


def check_visit_coverage(
    visits: list[dict[str, Any]],
    snapshots: list[dict[str, Any]],
    *,
    collector: _Collector,
    counts: dict[str, int],
) -> None:
    """Покрытие журнала посещений снимками (дефект A11).

    `visits` — журнал прогона: по записи на каждое посещение страницы, дошедшее до `page-ready`
    (см. формат в docstring `load_visits`). Требование: у КАЖДОГО посещения есть свой снимок,
    снятый пока страница ещё была в окне кеша. Без этого в режиме P эталону была обязательна
    только последняя страница маршрута, а предметная правильность промежуточных «поздних
    переходов» в измерительной серии не проверялась вовсе.

    Сами значения сверяет общий цикл `compare_snapshots` (снимок несёт `afterCommands`); здесь
    проверяется только то, что ни одно посещение не осталось без снимка и что снимок относится
    к той странице и к тому моменту, что заявлены в журнале.
    """
    by_seq: dict[int, dict[str, Any]] = {}
    by_page: dict[str, list[dict[str, Any]]] = {}
    for s in snapshots:
        if not isinstance(s, dict):
            continue
        seq = s.get("visitSeq")
        if isinstance(seq, int):
            by_seq[seq] = s
        pid = s.get("pageId")
        if pid is not None:
            by_page.setdefault(str(pid), []).append(s)

    counts["visits"] = len(visits)
    for v in visits:
        if not isinstance(v, dict) or "pageId" not in v:
            counts["badVisit"] += 1
            collector.add({"kind": "bad_visit", "detail": "visit must be an object with pageId and seq", "visit": v})
            continue
        pid = str(v["pageId"])
        seq = v.get("seq")
        after = v.get("afterCommands")
        snap = by_seq.get(seq) if isinstance(seq, int) else None
        if snap is None:
            # запасной путь: снимок без visitSeq, но той же страницы и того же момента
            cands = [
                s
                for s in by_page.get(pid, [])
                if after is None or s.get("afterCommands") is None or int(s["afterCommands"]) == int(after)
            ]
            snap = cands[0] if cands else None
        if snap is None:
            counts["visitSnapshotMissing"] += 1
            collector.add(
                {
                    "kind": "visit_snapshot_missing",
                    "pageId": pid,
                    "seq": seq,
                    "step": v.get("step"),
                    "afterCommands": after,
                    "detail": "страница была загружена в прогоне, но её снимок не записан — сверить с эталоном нечего",
                }
            )
            continue
        if str(snap.get("pageId")) != pid:
            counts["visitPageMismatch"] += 1
            collector.add(
                {"kind": "visit_page_mismatch", "seq": seq, "expected": pid, "actual": snap.get("pageId"), "source": snap.get("_source")}
            )
            continue
        if after is not None and snap.get("afterCommands") is not None and int(snap["afterCommands"]) != int(after):
            counts["visitMomentMismatch"] += 1
            collector.add(
                {
                    "kind": "visit_moment_mismatch",
                    "seq": seq,
                    "pageId": pid,
                    "expected": int(after),
                    "actual": int(snap["afterCommands"]),
                }
            )
            continue
        counts["visitsCovered"] += 1


def compare_snapshots(
    doc: dict[str, Any],
    commands: list[dict[str, Any]],
    snapshots: list[dict[str, Any]],
    *,
    visits: list[dict[str, Any]] | None = None,
    max_mismatches: int = DEFAULT_MAX_MISMATCHES,
) -> dict[str, Any]:
    """Снимки страниц клиента ({pageId, revision, shapes:[{id,fill,fillOverridden}]})
    против ожидаемого состояния. Множества id должны совпадать точно; ревизия
    снимка ≥ ожидаемой. Снимок может нести `afterCommands:n` — тогда он
    сверяется с состоянием после первых n команд (по умолчанию — после всех).

    `visits` (необязательный) — журнал посещений страниц прогона; тогда дополнительно требуется,
    чтобы у каждого посещения был свой снимок (дефект A11, см. `check_visit_coverage`).
    """
    col = _Collector(max_mismatches)
    counts = {
        "snapshots": len(snapshots),
        "pagesCompared": 0,
        "compared": 0,
        "fill": 0,
        "fillOverridden": 0,
        "missingInSnapshot": 0,
        "extraInSnapshot": 0,
        "revisionTooLow": 0,
        "unknownPage": 0,
        "badSnapshot": 0,
        "visits": 0,
        "visitsCovered": 0,
        "visitSnapshotMissing": 0,
        "visitPageMismatch": 0,
        "visitMomentMismatch": 0,
        "badVisit": 0,
        "snapshotError": 0,
    }
    models: dict[int, ReferenceModel] = {}

    def model_after(n: int) -> ReferenceModel:
        if n not in models:
            m = ReferenceModel(doc)
            m.apply_all(commands[:n])
            models[n] = m
        return models[n]

    full = model_after(len(commands))
    for snap in snapshots:
        if not isinstance(snap, dict) or "pageId" not in snap:
            counts["badSnapshot"] += 1
            col.add({"kind": "bad_snapshot", "detail": "snapshot must be an object with pageId", "source": snap.get("_source") if isinstance(snap, dict) else None})
            continue
        # Снимок, который клиент не смог снять (страница вытеснена, адаптер бросил), — это НЕ
        # «совпало»: его нельзя молча пропустить, иначе сверка проходит на пустом месте.
        if snap.get("error") is not None:
            counts["snapshotError"] += 1
            col.add({"kind": "snapshot_error", "pageId": snap.get("pageId"), "detail": str(snap.get("error")), "source": snap.get("_source")})
            continue
        pid = str(snap["pageId"])
        if pid not in full.pages and pid not in {s.pageId for s in full.shapes()}:
            counts["unknownPage"] += 1
            col.add({"kind": "unknown_page", "pageId": pid, "source": snap.get("_source")})
            continue
        n = snap.get("afterCommands")
        m = full if n is None else model_after(int(n))
        compare_page_snapshot(m.expected_page(pid), snap, collector=col, counts=counts)
    if visits is not None:
        check_visit_coverage(visits, snapshots, collector=col, counts=counts)
    return {
        "ok": col.total == 0,
        "kind": "snapshots",
        "docId": full.docId,
        "expectedRevision": full.revision,
        "counts": counts,
        "mismatchTotal": col.total,
        "mismatches": col.items,
        "truncated": col.total > len(col.items),
    }


def load_visits(path: str | Path) -> list[dict[str, Any]]:
    """Журнал посещений страниц прогона (дефект A11).

    Файл — либо список записей, либо объект `{"visits": [...]}`. Запись посещения:

        {"seq": 0,                      # порядковый номер посещения в прогоне, 0..N-1, уникален
         "step": 0,                     # номер шага сценария (для диагностики)
         "pageIndex": 1,                # индекс страницы в документе (для диагностики)
         "pageId": "doc-…-p1",          # обязательное поле
         "afterCommands": 0}            # сколько команд прогона ЗАВЕРШИЛОСЬ к моменту снимка

    Требование к снимку, покрывающему посещение: тот же `pageId`, `visitSeq == seq` и тот же
    `afterCommands` (снимок сверяется с состоянием эталона после первых `afterCommands` команд).
    """
    p = Path(path)
    with open(p, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        data = data.get("visits", [])
    if not isinstance(data, list):
        raise ValueError(f"{p}: visits file must be a list or an object with a 'visits' list")
    return [v for v in data]


def load_snapshots(path: str | Path) -> list[dict[str, Any]]:
    """Каталог *.json (или один файл): объект, список или {snapshots:[...]}."""
    p = Path(path)
    files = sorted(p.glob("*.json")) if p.is_dir() else [p]
    out: list[dict[str, Any]] = []
    for f in files:
        with open(f, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and "snapshots" in data:
            data = data["snapshots"]
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            raise ValueError(f"{f}: snapshot file must be an object or a list")
        for s in data:
            if isinstance(s, dict):
                s = dict(s)
                s["_source"] = str(f)
            out.append(s)
    return out


# --------------------------------------------------------------------- helpers
def _prepare(args: argparse.Namespace) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    doc = load_document(args.doc)
    commands = load_commands(args.commands) if args.commands else []
    info: dict[str, Any] = {"commandsGiven": len(commands)}
    if getattr(args, "dedupe", True):
        commands, dropped = dedupe_by_op_id(commands)
        info["retriesDropped"] = len(dropped)
        if dropped:
            print(
                f"note: {len(dropped)} repeated opId(s) dropped (logical ops = {len(commands)}); "
                f"use --no-dedupe to apply every command",
                file=sys.stderr,
            )
    return doc, commands, info


def _write_report(report: dict[str, Any], out: str | None) -> None:
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)


def _summary(report: dict[str, Any]) -> str:
    c = report.get("counts", {})
    status = "OK" if report.get("ok") else "MISMATCH"
    return f"[{report.get('kind')}] {status}: mismatches={report.get('mismatchTotal', 0)} counts={json.dumps(c, ensure_ascii=False)}"


def _load_actual(args: argparse.Namespace, doc_id: str) -> dict[str, Any]:
    if getattr(args, "db_dump", None):
        with open(args.db_dump, "r", encoding="utf-8") as f:
            return json.load(f)
    if not getattr(args, "db", None):
        raise SystemExit("either --db DSN or --db-dump file.json is required")
    return dbmod.dump_db(args.db, doc_id, backend=args.backend)


# ------------------------------------------------------------------ commands
def cmd_expected(args: argparse.Namespace) -> int:
    doc, commands, info = _prepare(args)
    model = ReferenceModel(doc)
    outcomes = model.apply_all(commands)
    state = model.expected_state()
    state["results"] = [o.as_dict() for o in outcomes]
    state.update(info)
    _write_report(state, args.out)
    if args.out:
        print(f"expected state written to {args.out}: revision={state['revision']} shapes={len(state['shapes'])}")
    return 0


def cmd_compare_db(args: argparse.Namespace) -> int:
    doc, commands, info = _prepare(args)
    model = ReferenceModel(doc)
    model.apply_all(commands)
    actual = _load_actual(args, model.docId)
    report = compare_db_state(model.expected_state(), actual, max_mismatches=args.max_mismatches)
    report.update(info)
    report["expectedResults"] = model.expected_results()
    if args.check_operations:
        ops = actual.get("operations")
        if ops is None:
            ops = dbmod.read_operations(args.db, model.docId, backend=args.backend)
        op_report = check_operations(
            doc,
            load_commands(args.commands) if args.commands else [],
            ops,
            actual_revision=actual.get("revision"),
            allow_extra=args.allow_extra_ops,
            max_mismatches=args.max_mismatches,
        )
        report["operations"] = {k: v for k, v in op_report.items() if k != "expectedResults"}
        report["ok"] = report["ok"] and op_report["ok"]
    _write_report(report, args.out)
    print(_summary(report), file=sys.stderr)
    if args.check_operations:
        print(_summary(report["operations"]), file=sys.stderr)
    return 0 if report["ok"] else 1


def cmd_compare_snapshots(args: argparse.Namespace) -> int:
    doc, commands, info = _prepare(args)
    snapshots = load_snapshots(args.snapshots)
    visits = load_visits(args.require_visits) if args.require_visits else None
    if visits is not None and not visits:
        # Пустой журнал посещений — это не «нечего проверять», а отсутствие проверки: прогон
        # не мог не посетить ни одной страницы.
        print("error: visits file is empty — a run always visits at least one page", file=sys.stderr)
        return 2
    report = compare_snapshots(doc, commands, snapshots, visits=visits, max_mismatches=args.max_mismatches)
    report.update(info)
    if args.require_pages:
        seen = {str(s.get("pageId")) for s in snapshots if isinstance(s, dict) and s.get("error") is None}
        missing = [p for p in args.require_pages.split(",") if p and p not in seen]
        if missing:
            report["ok"] = False
            report["counts"]["requiredPagesMissing"] = len(missing)
            report["mismatches"].append({"kind": "required_page_missing", "pages": missing})
            report["mismatchTotal"] += 1
    _write_report(report, args.out)
    print(_summary(report), file=sys.stderr)
    return 0 if report["ok"] else 1


def cmd_check_operations(args: argparse.Namespace) -> int:
    doc = load_document(args.doc)
    commands = load_commands(args.commands) if args.commands else []
    actual = _load_actual(args, str(doc["document"]["id"]))
    ops = actual.get("operations")
    if ops is None:
        ops = dbmod.read_operations(args.db, str(doc["document"]["id"]), backend=args.backend)
    report = check_operations(
        doc,
        commands,
        ops,
        actual_revision=actual.get("revision"),
        allow_extra=args.allow_extra_ops,
        max_mismatches=args.max_mismatches,
    )
    _write_report(report, args.out)
    print(_summary(report), file=sys.stderr)
    return 0 if report["ok"] else 1


def cmd_dump_db(args: argparse.Namespace) -> int:
    dump = dbmod.dump_db(args.db, args.doc_id, backend=args.backend)
    _write_report(dump, args.out)
    if args.out:
        print(f"dump written to {args.out}: revision={dump['revision']} shapes={len(dump['shapes'])} ops={len(dump['operations'])}")
    return 0


# ----------------------------------------------------------------------- main
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="reference.compare", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp: argparse.ArgumentParser, *, need_commands: bool = True) -> None:
        sp.add_argument("--doc", required=True, help="JSON документа (экспорт генератора)")
        sp.add_argument("--commands", required=False, help="JSON списка команд (пустой список, если не задан)")
        sp.add_argument("--out", help="файл JSON‑отчёта (по умолчанию — stdout)")
        sp.add_argument("--max-mismatches", type=int, default=DEFAULT_MAX_MISMATCHES, help="ограничение списка расхождений в отчёте")
        sp.add_argument("--no-dedupe", dest="dedupe", action="store_false", help="не схлопывать повторы одного opId (применять каждую команду)")

    def dbargs(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--db", help="DSN PostgreSQL, напр. postgres://postgres:postgres@127.0.0.1:5432/editor")
        sp.add_argument("--db-dump", help="вместо БД — JSON‑дамп (см. dump-db)")
        sp.add_argument("--backend", choices=["auto", "psycopg", "psql"], default="auto")
        sp.add_argument("--allow-extra-ops", action="store_true", help="не считать лишние строки operations расхождением")

    sp = sub.add_parser("expected", help="вычислить ожидаемое состояние")
    common(sp)
    sp.set_defaults(func=cmd_expected)

    sp = sub.add_parser("compare-db", help="сравнить ожидаемое состояние с БД")
    common(sp)
    dbargs(sp)
    sp.add_argument("--check-operations", action="store_true", help="дополнительно проверить таблицу operations")
    sp.set_defaults(func=cmd_compare_db)

    sp = sub.add_parser("compare-snapshots", help="сравнить снимки страниц клиента")
    common(sp)
    sp.add_argument("--snapshots", required=True, help="каталог с *.json снимками (или один файл)")
    sp.add_argument("--require-pages", help="список pageId через запятую, снимки которых обязаны присутствовать")
    sp.add_argument(
        "--require-visits",
        help="журнал посещений страниц прогона (JSON): у КАЖДОГО посещения обязан быть свой снимок (дефект A11)",
    )
    sp.set_defaults(func=cmd_compare_snapshots)

    sp = sub.add_parser("check-operations", help="проверить таблицу operations")
    common(sp)
    dbargs(sp)
    sp.set_defaults(func=cmd_check_operations)

    sp = sub.add_parser("dump-db", help="выгрузить состояние документа из БД в JSON")
    sp.add_argument("--db", required=True)
    sp.add_argument("--doc-id", required=True)
    sp.add_argument("--out")
    sp.add_argument("--backend", choices=["auto", "psycopg", "psql"], default="auto")
    sp.set_defaults(func=cmd_dump_db)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (CommandError, DocumentError, dbmod.DbError, FileNotFoundError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


def main_compare_db(argv: list[str] | None = None) -> int:
    return main(["compare-db", *(sys.argv[1:] if argv is None else argv)])


def main_compare_snapshots(argv: list[str] | None = None) -> int:
    return main(["compare-snapshots", *(sys.argv[1:] if argv is None else argv)])


if __name__ == "__main__":
    sys.exit(main())
