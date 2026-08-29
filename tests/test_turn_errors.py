from lightrp.llm import turn_http_status


def test_turn_http_status_maps_upstream() -> None:
    assert turn_http_status(RuntimeError("LLM HTTP 429: Too Many Requests")) == 429
    assert turn_http_status(RuntimeError("LLM HTTP 401: Missing Authentication header")) == 401
    assert turn_http_status(RuntimeError("LLM 超时（120s）")) == 504
    assert turn_http_status(RuntimeError("LLM 返回空回复")) == 502
    assert turn_http_status(RuntimeError("boom")) == 502
