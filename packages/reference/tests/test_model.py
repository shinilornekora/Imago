import copy

import pytest

from reference.model import (
    DocumentError,
    ForbiddenTargetError,
    InvalidCommandError,
    ReferenceModel,
    RevisionMismatchError,
    TargetNotFoundError,
    dedupe_by_op_id,
)

from .fixture_gen import instances_of, make_document, sources_of


@pytest.fixture
def doc():
    return make_document(pages=6, shapes_per_page=12, sources=2, instances_per_source=12, override_share=0.4, seed=7)


def test_initial_state_matches_document(doc):
    m = ReferenceModel(doc)
    st = m.expected_state()
    assert st["revision"] == 0
    assert len(st["shapes"]) == len(doc["shapes"])
    for s in doc["shapes"]:
        e = st["shapes"][s["id"]]
        assert e["fill"] == s["fill"]
        assert e["fillOverridden"] == s["fillOverridden"]
        assert e["pageId"] == s["pageId"]


def test_set_source_fill_updates_source_and_unoverridden_instances_on_all_pages(doc):
    m = ReferenceModel(doc)
    src = sources_of(doc)[0]
    inst = instances_of(doc, src["id"])
    assert len({i["pageId"] for i in inst}) > 1, "instances must live on several pages"
    out = m.apply({"type": "setSourceFill", "targetId": src["id"], "fill": "#0a0b0c", "opId": "op-1"})
    assert out.revision == 1
    st = m.expected_state()
    assert st["revision"] == 1
    assert st["shapes"][src["id"]]["fill"] == "#0a0b0c"
    expected_changed = 1
    pages = {src["pageId"]}
    for i in inst:
        e = st["shapes"][i["id"]]
        if i["fillOverridden"]:
            assert e["fill"] == i["fill"], "overridden instance must keep its local fill"
            assert e["fillOverridden"] is True
        else:
            assert e["fill"] == "#0a0b0c", "unloaded pages are affected too — model is page-agnostic"
            assert e["fillOverridden"] is False
            expected_changed += 1
            pages.add(i["pageId"])
    assert out.affectedShapes == expected_changed
    assert out.affectedPages == sorted(pages)
    assert out.affectedPages == sorted(set(out.affectedPages))
    # фигуры других источников не тронуты
    other = sources_of(doc)[1]
    assert st["shapes"][other["id"]]["fill"] == other["fill"]


def test_set_local_fill_sets_override_even_if_color_equals_source(doc):
    m = ReferenceModel(doc)
    src = sources_of(doc)[0]
    inst = [i for i in instances_of(doc, src["id"]) if not i["fillOverridden"]][0]
    out = m.apply({"type": "setLocalFill", "targetId": inst["id"], "fill": src["fill"]})
    assert out.revision == 1
    assert out.affectedPages == [inst["pageId"]]
    assert out.affectedShapes == 1
    e = m.expected_state()["shapes"][inst["id"]]
    assert e["fill"] == src["fill"]
    assert e["fillOverridden"] is True, "same color as source must still be overridden (§1.1)"
    # последующая общая заливка источника не трогает переопределённый экземпляр
    m.apply({"type": "setSourceFill", "targetId": src["id"], "fill": "#111111"})
    e2 = m.expected_state()["shapes"][inst["id"]]
    assert e2["fill"] == src["fill"]
    assert e2["fillOverridden"] is True
    assert m.revision == 2


def test_local_fill_on_plain_shape(doc):
    m = ReferenceModel(doc)
    plain = [s for s in doc["shapes"] if not s["isSource"] and s["sourceId"] is None][0]
    m.apply({"type": "setLocalFill", "targetId": plain["id"], "fill": "#abcdef"})
    e = m.expected_state()["shapes"][plain["id"]]
    assert e == {"fill": "#abcdef", "fillOverridden": True, "pageId": plain["pageId"]}


def test_revision_increments_per_applied_command_and_double_application_is_not_idempotent(doc):
    m = ReferenceModel(doc)
    src = sources_of(doc)[0]
    cmd = {"type": "setSourceFill", "targetId": src["id"], "fill": "#222222", "opId": "same-op"}
    m.apply(cmd)
    m.apply(cmd)  # модель применяет то, что ей дали; идемпотентность — свойство таблицы operations
    assert m.revision == 2
    assert [o.revision for o in m.outcomes] == [1, 2]
    unique, dropped = dedupe_by_op_id([cmd, cmd])
    assert len(unique) == 1 and len(dropped) == 1 and dropped[0]["conflict"] is False
    unique2, dropped2 = dedupe_by_op_id([cmd, {**cmd, "fill": "#333333"}])
    assert len(unique2) == 1 and dropped2[0]["conflict"] is True


def test_missing_and_foreign_targets_raise(doc):
    m = ReferenceModel(doc)
    with pytest.raises(TargetNotFoundError):
        m.apply({"type": "setLocalFill", "targetId": "no-such-shape", "fill": "#000000"})
    with pytest.raises(ForbiddenTargetError):
        m.apply({"type": "setSourceFill", "targetId": sources_of(doc)[0]["id"], "fill": "#000000", "actorId": "u-bob"})
    assert m.revision == 0
    assert m.outcomes == []


def test_invalid_commands_raise(doc):
    m = ReferenceModel(doc)
    src = sources_of(doc)[0]
    inst = instances_of(doc, src["id"])[0]
    with pytest.raises(InvalidCommandError):
        m.apply({"type": "setSourceFill", "targetId": inst["id"], "fill": "#000000"})
    with pytest.raises(InvalidCommandError):
        m.apply({"type": "setLocalFill", "targetId": src["id"], "fill": "#000000"})
    with pytest.raises(InvalidCommandError):
        m.apply({"type": "setSourceFill", "targetId": src["id"], "fill": "#ABCDEF"})
    with pytest.raises(InvalidCommandError):
        m.apply({"type": "paint", "targetId": src["id"], "fill": "#abcdef"})
    with pytest.raises(RevisionMismatchError):
        m.apply({"type": "setSourceFill", "targetId": src["id"], "fill": "#abcdef", "expectedRevision": 5})
    assert m.revision == 0


def test_expected_revision_is_honoured(doc):
    m = ReferenceModel(doc)
    src = sources_of(doc)[0]
    m.apply({"type": "setSourceFill", "targetId": src["id"], "fill": "#abcdef", "expectedRevision": 0})
    m.apply({"type": "setSourceFill", "targetId": src["id"], "fill": "#abcdee", "expectedRevision": 1})
    assert m.revision == 2


def test_expected_page_snapshot_shape(doc):
    m = ReferenceModel(doc)
    pid = doc["pages"][2]["id"]
    snap = m.expected_page(pid)
    assert snap["pageId"] == pid and snap["revision"] == 0
    ids = [s["id"] for s in snap["shapes"]]
    assert ids == sorted(ids)
    assert set(ids) == {s["id"] for s in doc["shapes"] if s["pageId"] == pid}
    assert set(snap["shapes"][0].keys()) == {"id", "fill", "fillOverridden"}


def test_document_invariants_are_validated(doc):
    bad = copy.deepcopy(doc)
    src = sources_of(bad)[0]
    inst = [i for i in instances_of(bad, src["id"]) if not i["fillOverridden"]][0]
    inst["fill"] = "#000001" if src["fill"] != "#000001" else "#000002"
    with pytest.raises(DocumentError):
        ReferenceModel(bad)
    ReferenceModel(bad, strict=False)  # нестрогий режим допускает
    bad2 = copy.deepcopy(doc)
    bad2["shapes"].append(dict(bad2["shapes"][0]))
    with pytest.raises(DocumentError):
        ReferenceModel(bad2)


def test_initial_revision_from_document():
    d = make_document(pages=2, shapes_per_page=5, sources=1, instances_per_source=2, revision=17)
    m = ReferenceModel(d)
    m.apply({"type": "setSourceFill", "targetId": sources_of(d)[0]["id"], "fill": "#010203"})
    assert m.revision == 18
