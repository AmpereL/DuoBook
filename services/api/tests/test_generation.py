from __future__ import annotations

import pytest

from app.generation import _balanced_claims, _extract_claim_batches, _paragraph_batches
from app.providers import ProviderError


def test_long_chapter_is_batched_without_losing_order_or_source_ids():
    paragraphs = [
        {"id": f"p{index}", "text": "甲" * 10}
        for index in range(1, 7)
    ]
    batches = _paragraph_batches(paragraphs, max_chars=25, max_paragraphs=3)
    assert [[item["id"] for item in batch] for batch in batches] == [
        ["p1", "p2"],
        ["p3", "p4"],
        ["p5", "p6"],
    ]


def test_chapter_claim_selection_covers_each_batch_before_adding_depth():
    claims = _balanced_claims([["a1", "a2"], ["b1", "b2"], ["c1"]], limit=4)
    assert claims == ["a1", "b1", "c1", "a2"]


def test_timeout_is_retried_as_two_smaller_source_preserving_batches():
    class FlakyProvider:
        route = "test"

        def extract_claims(self, _, __, paragraphs):
            if len(paragraphs) > 2:
                raise ProviderError("模型调用或结构化输出失败：The read operation timed out")
            return [[item["id"] for item in paragraphs]]

    paragraphs = [{"id": f"p{index}", "text": "内容"} for index in range(4)]
    claim_batches = _extract_claim_batches(FlakyProvider(), "书", "章", paragraphs)
    assert claim_batches == [[['p0', 'p1']], [['p2', 'p3']]]


def test_non_recoverable_provider_error_is_not_retried():
    class BrokenProvider:
        route = "test"

        def extract_claims(self, _, __, ___):
            raise ProviderError("模型连接失败（HTTP 401）")

    with pytest.raises(ProviderError, match="401"):
        _extract_claim_batches(BrokenProvider(), "书", "章", [{"id": "p1", "text": "内容"}])
