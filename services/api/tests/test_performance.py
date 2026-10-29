from __future__ import annotations

import math
import time


def percentile(values: list[float], point: float) -> float:
    ordered = sorted(values)
    index = max(0, math.ceil(len(ordered) * point) - 1)
    return ordered[index]


def test_cached_map_endpoint_p95_is_under_product_budget(client):
    durations: list[float] = []
    for _ in range(20):
        started = time.perf_counter()
        response = client.get("/api/v1/books/book_learning/map")
        durations.append(time.perf_counter() - started)
        assert response.status_code == 200

    p95 = percentile(durations, 0.95)
    assert p95 < 0.5, f"map endpoint p95 was {p95:.3f}s"
