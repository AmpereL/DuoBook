from __future__ import annotations

import pytest

from app.providers import UnitPlan, UnitPlanItem
from app.reading_units import unit_drafts_from_plan


def test_unit_plan_slices_the_original_chapter_once_and_in_order():
    paragraphs = [{"id": f"p{index}", "text": f"第 {index} 段"} for index in range(1, 6)]
    plan = UnitPlan(
        intro="先提出问题，再给出回应。",
        units=[
            UnitPlanItem("提出问题", "p1", "提出问题", "可以独立阅读", "低"),
            UnitPlanItem("回应问题", "p3", "给出回应", "可以独立阅读", "高"),
        ],
    )

    drafts = unit_drafts_from_plan("测试章", paragraphs, plan)

    assert [draft.source_ids for draft in drafts] == [["p1", "p2"], ["p3", "p4", "p5"]]
    assert [source for draft in drafts for source in draft.source_ids] == [
        paragraph["id"] for paragraph in paragraphs
    ]


def test_unit_plan_rejects_a_plan_that_skips_the_chapter_start():
    paragraphs = [{"id": "p1", "text": "开头"}, {"id": "p2", "text": "后文"}]
    plan = UnitPlan(
        intro="",
        units=[UnitPlanItem("后文", "p2", "", "", "")],
    )

    with pytest.raises(ValueError, match="首段"):
        unit_drafts_from_plan("测试章", paragraphs, plan)
