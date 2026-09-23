"""Эталонная модель документа: применение команд по правилам SPEC §1 / §2.3.

Модель намеренно проста и «тупа»: она применяет ровно те команды, которые ей
передали, в том порядке, в котором передали. Дедупликация повторов по opId —
не её задача (это свойство таблицы operations сервера, см. operations.py).

Формат документа (экспорт генератора, data/<name>.json):
    {meta:{...}, document:{id, ownerId, name, revision},
     pages:[{id,index,name}], shapes:[Shape…]}
Shape — как в packages/shared/src/index.ts (camelCase).

Формат команды:
    {type:'setSourceFill'|'setLocalFill', targetId, fill:'#rrggbb',
     opId?:str, expectedRevision?:int, actorId?:str}
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator

HEX_COLOR_RE = re.compile(r"^#[0-9a-f]{6}$")
COMMAND_TYPES = ("setSourceFill", "setLocalFill")


class DocumentError(ValueError):
    """Документ не соответствует предметной модели (SPEC §1)."""


class CommandError(ValueError):
    """Команда не может быть применена (сервер обязан её отклонить)."""


class TargetNotFoundError(CommandError):
    """Цель команды отсутствует в документе (чужая или несуществующая фигура)."""


class ForbiddenTargetError(CommandError):
    """Команда от имени пользователя, который не владеет документом (403)."""


class InvalidCommandError(CommandError):
    """Неверный тип команды, неверная заливка, неверный вид цели."""


class RevisionMismatchError(CommandError):
    """expectedRevision не совпал с текущей ревизией (409 revision_mismatch)."""


@dataclass(frozen=True)
class ShapeState:
    id: str
    pageId: str
    fill: str
    fillOverridden: bool
    isSource: bool
    sourceId: str | None


@dataclass
class CommandOutcome:
    """Ожидаемый результат одной команды — сверяется с CommandResult сервера."""

    index: int
    type: str
    targetId: str
    fill: str
    revision: int
    affectedPages: list[str]
    affectedShapes: int
    opId: str | None = None

    def as_dict(self) -> dict[str, Any]:
        d = {
            "index": self.index,
            "opId": self.opId,
            "type": self.type,
            "targetId": self.targetId,
            "fill": self.fill,
            "revision": self.revision,
            "affectedPages": list(self.affectedPages),
            "affectedShapes": self.affectedShapes,
        }
        return d


@dataclass
class Command:
    type: str
    targetId: str
    fill: str
    opId: str | None = None
    expectedRevision: int | None = None
    actorId: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Command":
        if not isinstance(d, dict):
            raise InvalidCommandError(f"command must be an object, got {type(d).__name__}")
        ctype = d.get("type")
        if ctype not in COMMAND_TYPES:
            raise InvalidCommandError(f"unknown command type {ctype!r}")
        target = d.get("targetId")
        if not isinstance(target, str) or not target:
            raise InvalidCommandError("targetId must be a non-empty string")
        fill = d.get("fill")
        if not isinstance(fill, str) or not HEX_COLOR_RE.match(fill):
            raise InvalidCommandError(f"fill must match #rrggbb (lowercase), got {fill!r}")
        exp = d.get("expectedRevision")
        if exp is not None and not isinstance(exp, int):
            raise InvalidCommandError("expectedRevision must be an integer")
        op = d.get("opId")
        if op is not None and not isinstance(op, str):
            raise InvalidCommandError("opId must be a string")
        actor = d.get("actorId", d.get("userId"))
        return cls(
            type=ctype,
            targetId=target,
            fill=fill,
            opId=op,
            expectedRevision=exp,
            actorId=actor,
            raw=dict(d),
        )


def _as_bool(v: Any, what: str) -> bool:
    if isinstance(v, bool):
        return v
    if v in (0, 1):
        return bool(v)
    if isinstance(v, str) and v.lower() in ("true", "false", "t", "f"):
        return v.lower() in ("true", "t")
    raise DocumentError(f"{what}: expected boolean, got {v!r}")


class ReferenceModel:
    """Состояние документа и применение команд.

    Хранит только то, что нужно оракулу: заливку, флаг переопределения,
    страницу, признак источника и ссылку на источник у каждой фигуры.
    """

    def __init__(self, doc: dict[str, Any], *, strict: bool = True) -> None:
        if not isinstance(doc, dict) or "document" not in doc or "shapes" not in doc:
            raise DocumentError("document JSON must contain 'document' and 'shapes'")
        d = doc["document"]
        self.docId: str = str(d["id"])
        self.ownerId: str | None = d.get("ownerId")
        self.name: str | None = d.get("name")
        self.initialRevision: int = int(d.get("revision", 0))
        self.revision: int = self.initialRevision
        self.pages: dict[str, dict[str, Any]] = {}
        for p in doc.get("pages", []):
            pid = str(p["id"])
            if pid in self.pages:
                raise DocumentError(f"duplicate page id {pid}")
            self.pages[pid] = {"id": pid, "index": p.get("index"), "name": p.get("name")}
        self._shapes: dict[str, ShapeState] = {}
        # index: sourceId -> [instance ids] (порядок появления — детерминирован)
        self._instances: dict[str, list[str]] = {}
        for s in doc["shapes"]:
            sid = str(s["id"])
            if sid in self._shapes:
                raise DocumentError(f"duplicate shape id {sid}")
            page_id = str(s["pageId"])
            if strict and self.pages and page_id not in self.pages:
                raise DocumentError(f"shape {sid} refers to unknown page {page_id}")
            if strict and "documentId" in s and str(s["documentId"]) != self.docId:
                raise DocumentError(f"shape {sid} belongs to document {s['documentId']}, not {self.docId}")
            fill = s.get("fill")
            if not isinstance(fill, str) or (strict and not HEX_COLOR_RE.match(fill)):
                raise DocumentError(f"shape {sid}: bad fill {fill!r}")
            src = s.get("sourceId")
            st = ShapeState(
                id=sid,
                pageId=page_id,
                fill=fill,
                fillOverridden=_as_bool(s.get("fillOverridden", False), f"shape {sid}.fillOverridden"),
                isSource=_as_bool(s.get("isSource", False), f"shape {sid}.isSource"),
                sourceId=None if src is None else str(src),
            )
            self._shapes[sid] = st
            if st.sourceId is not None:
                self._instances.setdefault(st.sourceId, []).append(sid)
        if strict:
            self._validate_invariants()
        self.outcomes: list[CommandOutcome] = []

    # ------------------------------------------------------------------ loading
    @classmethod
    def load(cls, path: str | Path, *, strict: bool = True) -> "ReferenceModel":
        return cls(load_document(path), strict=strict)

    def _validate_invariants(self) -> None:
        for sid, st in self._shapes.items():
            if st.sourceId is not None:
                src = self._shapes.get(st.sourceId)
                if src is None:
                    raise DocumentError(f"instance {sid} refers to unknown source {st.sourceId}")
                if not src.isSource:
                    raise DocumentError(f"instance {sid} refers to {st.sourceId} which is not a source")
                if st.isSource:
                    raise DocumentError(f"shape {sid} is both a source and an instance")
                # §1.1: экземпляр без переопределения всегда имеет fill источника
                if not st.fillOverridden and st.fill != src.fill:
                    raise DocumentError(
                        f"instance {sid} is not overridden but fill {st.fill} != source fill {src.fill}"
                    )

    # ------------------------------------------------------------------ queries
    def shape(self, shape_id: str) -> ShapeState:
        return self._shapes[shape_id]

    def shapes(self) -> Iterator[ShapeState]:
        return iter(self._shapes.values())

    def __len__(self) -> int:
        return len(self._shapes)

    def instances_of(self, source_id: str) -> list[str]:
        return list(self._instances.get(source_id, []))

    def page_ids(self) -> list[str]:
        return list(self.pages.keys())

    def page_shape_ids(self, page_id: str) -> list[str]:
        return [s.id for s in self._shapes.values() if s.pageId == page_id]

    # ------------------------------------------------------------------ commands
    def apply(self, command: dict[str, Any] | Command) -> CommandOutcome:
        """Применяет одну команду; при нарушении правил бросает CommandError.

        При ошибке состояние модели не меняется (как транзакция сервера).
        """
        cmd = command if isinstance(command, Command) else Command.from_dict(command)
        if cmd.actorId is not None and self.ownerId is not None and cmd.actorId != self.ownerId:
            raise ForbiddenTargetError(
                f"actor {cmd.actorId} does not own document {self.docId} (owner {self.ownerId})"
            )
        target = self._shapes.get(cmd.targetId)
        if target is None:
            raise TargetNotFoundError(f"target {cmd.targetId} is not in document {self.docId}")
        if cmd.expectedRevision is not None and cmd.expectedRevision != self.revision:
            raise RevisionMismatchError(
                f"expectedRevision {cmd.expectedRevision} != current revision {self.revision}"
            )

        if cmd.type == "setSourceFill":
            if not target.isSource:
                raise InvalidCommandError(f"setSourceFill target {cmd.targetId} is not a source")
            changed_ids = [target.id]
            for iid in self._instances.get(target.id, []):
                inst = self._shapes[iid]
                if not inst.fillOverridden:
                    changed_ids.append(iid)
            for sid in changed_ids:
                st = self._shapes[sid]
                self._shapes[sid] = ShapeState(
                    id=st.id,
                    pageId=st.pageId,
                    fill=cmd.fill,
                    fillOverridden=st.fillOverridden,
                    isSource=st.isSource,
                    sourceId=st.sourceId,
                )
        elif cmd.type == "setLocalFill":
            if target.isSource:
                raise InvalidCommandError(
                    f"setLocalFill target {cmd.targetId} is a source; use setSourceFill"
                )
            changed_ids = [target.id]
            self._shapes[target.id] = ShapeState(
                id=target.id,
                pageId=target.pageId,
                fill=cmd.fill,
                fillOverridden=True,  # §1.1: совпадение с цветом источника не снимает переопределение
                isSource=False,
                sourceId=target.sourceId,
            )
        else:  # pragma: no cover — отсекается в Command.from_dict
            raise InvalidCommandError(f"unknown command type {cmd.type}")

        self.revision += 1
        pages = sorted({self._shapes[sid].pageId for sid in changed_ids})
        outcome = CommandOutcome(
            index=len(self.outcomes),
            opId=cmd.opId,
            type=cmd.type,
            targetId=cmd.targetId,
            fill=cmd.fill,
            revision=self.revision,
            affectedPages=pages,
            affectedShapes=len(changed_ids),
        )
        self.outcomes.append(outcome)
        return outcome

    def apply_all(self, commands: Iterable[dict[str, Any] | Command]) -> list[CommandOutcome]:
        return [self.apply(c) for c in commands]

    # ------------------------------------------------------------------ export
    def expected_state(self) -> dict[str, Any]:
        """{revision, shapes:{id:{fill, fillOverridden, pageId}}}"""
        return {
            "docId": self.docId,
            "revision": self.revision,
            "shapes": {
                s.id: {"fill": s.fill, "fillOverridden": s.fillOverridden, "pageId": s.pageId}
                for s in self._shapes.values()
            },
        }

    def expected_page(self, page_id: str) -> dict[str, Any]:
        """Ожидаемый снимок страницы в формате getPageSnapshot (+pageId)."""
        shapes = [
            {"id": s.id, "fill": s.fill, "fillOverridden": s.fillOverridden}
            for s in self._shapes.values()
            if s.pageId == page_id
        ]
        shapes.sort(key=lambda x: x["id"])
        return {"pageId": page_id, "revision": self.revision, "shapes": shapes}

    def expected_results(self) -> list[dict[str, Any]]:
        return [o.as_dict() for o in self.outcomes]


# ---------------------------------------------------------------------- helpers
def load_document(path: str | Path) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_commands(path: str | Path) -> list[dict[str, Any]]:
    """Список команд из JSON: массив, {commands:[...]} или один объект."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        if "commands" in data:
            data = data["commands"]
        elif "type" in data:
            data = [data]
        else:
            raise InvalidCommandError("commands JSON must be a list or {commands:[...]}")
    if not isinstance(data, list):
        raise InvalidCommandError("commands JSON must be a list")
    return data


def dedupe_by_op_id(commands: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Оставляет первое вхождение каждого opId (логическая операция).

    Возвращает (уникальные команды, отброшенные повторы). Команды без opId
    не дедуплицируются. Повтор с иными параметрами помечается conflict=True —
    сервер обязан ответить на него 409 op_conflict и ничего не менять.
    """
    seen: dict[str, dict[str, Any]] = {}
    unique: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for c in commands:
        op = c.get("opId") if isinstance(c, dict) else None
        if op is None:
            unique.append(c)
            continue
        if op in seen:
            first = seen[op]
            same = all(first.get(k) == c.get(k) for k in ("type", "targetId", "fill"))
            dropped.append({"opId": op, "conflict": not same, "command": c})
            continue
        seen[op] = c
        unique.append(c)
    return unique, dropped


def replay(doc: dict[str, Any], commands: list[dict[str, Any]], upto: int | None = None) -> ReferenceModel:
    """Новая модель с применёнными первыми `upto` командами (все — если None)."""
    m = ReferenceModel(doc)
    m.apply_all(commands if upto is None else commands[:upto])
    return m
