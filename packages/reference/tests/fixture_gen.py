"""Малый детерминированный генератор документов для тестов эталона.

Повторяет форму экспорта packages/generator (SPEC §5): страница «library»
с источниками, экземпляры на нескольких страницах, часть — с локальным
переопределением. Не является генератором стенда — только тестовая опора.
"""

from __future__ import annotations

import random
from typing import Any


def color(rng: random.Random) -> str:
    return "#%06x" % rng.randrange(0, 0x1000000)


def make_document(
    *,
    pages: int = 5,
    shapes_per_page: int = 20,
    sources: int = 3,
    instances_per_source: int = 10,
    override_share: float = 0.3,
    seed: int = 1,
    owner: str = "u-alice",
    doc_id: str = "doc-test",
    name: str = "test-doc",
    revision: int = 0,
) -> dict[str, Any]:
    rng = random.Random(seed)
    page_list = [{"id": f"{doc_id}-p{i + 1}", "index": i, "name": "library" if i == 0 else f"page {i + 1}"} for i in range(pages)]
    shapes: list[dict[str, Any]] = []
    counts = {p["id"]: 0 for p in page_list}

    def add(page_id: str, **kw: Any) -> dict[str, Any]:
        n = counts[page_id]
        counts[page_id] += 1
        s = {
            "id": f"{page_id}-s{n}",
            "documentId": doc_id,
            "pageId": page_id,
            "kind": rng.choice(["rect", "ellipse", "text"]),
            "x": float(rng.randrange(0, 1000)),
            "y": float(rng.randrange(0, 1000)),
            "w": float(rng.randrange(10, 200)),
            "h": float(rng.randrange(10, 200)),
            "z": n,
            "text": None,
            "fill": color(rng),
            "isSource": False,
            "sourceId": None,
            "fillOverridden": False,
        }
        s.update(kw)
        if s["kind"] == "text":
            s["text"] = f"t{n}"
        shapes.append(s)
        return s

    lib = page_list[0]["id"]
    src_list = []
    for _ in range(sources):
        src_list.append(add(lib, isSource=True))
    other_pages = [p["id"] for p in page_list[1:]] or [lib]
    for src in src_list:
        for k in range(instances_per_source):
            pid = other_pages[k % len(other_pages)]
            overridden = rng.random() < override_share
            add(
                pid,
                sourceId=src["id"],
                fill=color(rng) if overridden else src["fill"],
                fillOverridden=overridden,
            )
    # добить страницы обычными фигурами до shapes_per_page
    for p in page_list:
        while counts[p["id"]] < shapes_per_page:
            add(p["id"])
    return {
        "meta": {"generator": "tests/fixture_gen.py", "seed": seed, "version": 1},
        "document": {"id": doc_id, "ownerId": owner, "name": name, "revision": revision},
        "pages": page_list,
        "shapes": shapes,
    }


def sources_of(doc: dict[str, Any]) -> list[dict[str, Any]]:
    return [s for s in doc["shapes"] if s["isSource"]]


def instances_of(doc: dict[str, Any], source_id: str) -> list[dict[str, Any]]:
    return [s for s in doc["shapes"] if s["sourceId"] == source_id]
