"""Unit tests for Stage 2 annotation pipeline."""

import pytest
from urllib.error import URLError


SAMPLE_POLICY = """\
# Privacy Policy

Last updated: January 2024

## Information We Collect

We collect personal information that you provide to us directly,
such as your name, email address, and phone number.

We also automatically collect your IP address and browser type when you visit our site.

## How We Share Your Information

We may share your personal information with third-party analytics providers
to help us understand how you use our services.

We will never sell your personal data to advertisers.

## Data Retention

We retain your personal information for as long as your account is active.
"""


def test_preprocess_short_policy():
    """A short 3-section policy should produce at least one chunk with correct structure."""
    from privacy_research_dataset.annotator import preprocess_policy

    doc = preprocess_policy(SAMPLE_POLICY, token_limit=500)

    assert "blocks" in doc
    assert "chunks" in doc
    assert len(doc["blocks"]) >= 1
    assert len(doc["chunks"]) >= 1


def test_chunk_has_block_map_and_text():
    """Every chunk must have a non-empty block_map and a non-empty text string."""
    from privacy_research_dataset.annotator import preprocess_policy

    doc = preprocess_policy(SAMPLE_POLICY, token_limit=500)

    for chunk in doc["chunks"]:
        assert "block_map" in chunk
        assert "text" in chunk
        assert len(chunk["block_map"]) >= 1
        assert chunk["text"].strip()


def test_blocks_have_text():
    """Every block must have non-empty text."""
    from privacy_research_dataset.annotator import preprocess_policy

    doc = preprocess_policy(SAMPLE_POLICY, token_limit=500)

    for block in doc["blocks"]:
        assert "text" in block
        assert "element_indices" in block


def test_small_token_limit_creates_more_chunks():
    """A very small token limit should produce more chunks than a large one."""
    from privacy_research_dataset.annotator import preprocess_policy

    doc_small = preprocess_policy(SAMPLE_POLICY, token_limit=50)
    doc_large = preprocess_policy(SAMPLE_POLICY, token_limit=2000)

    assert len(doc_small["chunks"]) >= len(doc_large["chunks"])


def test_preprocess_rebalances_oversized_single_block():
    """Large scraped plaintext blobs should be split even if they arrive as one block."""
    from privacy_research_dataset.annotator import preprocess_policy

    blob = "\n".join(
        [
            "Privacy Policy",
            "We collect your name and email address to provide the service.",
            "We share your information with analytics providers for fraud prevention.",
        ]
        * 40
    )

    doc = preprocess_policy(blob, token_limit=80)

    assert len(doc["chunks"]) > 1
    assert all(chunk["text"].strip() for chunk in doc["chunks"])


def test_extract_json_list_clean():
    """Standard JSON list parses correctly."""
    from privacy_research_dataset.annotator import extract_json_list

    raw = '[{"action": ["collect"], "data": ["email address"]}]'
    result = extract_json_list(raw)
    assert len(result) == 1
    assert result[0]["action"] == ["collect"]


def test_extract_json_list_trailing_comma():
    """rapidjson should handle trailing commas that LLMs sometimes produce."""
    from privacy_research_dataset.annotator import extract_json_list

    raw = '[{"action": ["collect"], "data": ["email address"],}]'
    result = extract_json_list(raw)
    assert len(result) == 1


def test_extract_json_list_with_preamble():
    """JSON buried in LLM prose (before/after the list) is extracted correctly."""
    from privacy_research_dataset.annotator import extract_json_list

    raw = 'Here are the statements:\n[{"action": ["share"]}]\nDone.'
    result = extract_json_list(raw)
    assert result[0]["action"] == ["share"]


def test_extract_json_list_empty():
    """Empty list is valid output."""
    from privacy_research_dataset.annotator import extract_json_list

    result = extract_json_list("[]")
    assert result == []


def test_extract_json_list_with_think_and_template_tokens():
    """DeepSeek-style reasoning wrappers and template tokens should be stripped."""
    from privacy_research_dataset.annotator import extract_json_list

    raw = (
        "<think>I should reason first.</think>\n"
        '[{"action":["collect"],"data":["email address"]}]<|im_end|>'
    )
    result = extract_json_list(raw)
    assert result == [{"action": ["collect"], "data": ["email address"]}]


def test_extract_json_list_from_wrapped_object_and_stringified_items():
    """Some local-model outputs wrap the list or stringify each object; both should parse."""
    from privacy_research_dataset.annotator import extract_json_list

    raw = (
        '{'
        '"privacy_statements":['
        '"{\\"action\\":[\\"share\\"],\\"data\\":[\\"email address\\"],\\"recipient\\":[\\"analytics providers\\"]}"'
        ']'
        '}'
    )
    result = extract_json_list(raw)
    assert result == [
        {
            "action": ["share"],
            "data": ["email address"],
            "recipient": ["analytics providers"],
        }
    ]


def test_validate_and_fix_statement_valid(monkeypatch):
    """A well-formed statement with action+data passes validation."""
    from privacy_research_dataset.annotator import validate_and_fix_statement

    # Build a minimal chunk whose text contains the phrases
    chunk = {
        "text": "We collect your email address for authentication.",
        "block_map": [{"index": 0, "text_range": (0, 48)}],
    }
    statement = {
        "action": ["collect"],
        "data": ["email address"],
        "processor": ["We"],
        "purpose": ["authentication"],
    }
    result = validate_and_fix_statement(chunk, statement)
    assert result is not None
    assert "action" in result
    assert "data" in result


def test_validate_and_fix_statement_missing_core():
    """A statement missing both 'action' and 'data' is rejected (returns None)."""
    from privacy_research_dataset.annotator import validate_and_fix_statement

    chunk = {
        "text": "We collect your email address.",
        "block_map": [{"index": 0, "text_range": (0, 29)}],
    }
    result = validate_and_fix_statement(chunk, {"purpose": ["marketing"]})
    assert result is None


def test_get_inflections_basic():
    """get_inflections should include the original word and at least one variant."""
    from privacy_research_dataset.annotator import get_inflections

    forms = get_inflections("collect")
    assert "collect" in forms
    assert len(forms) > 1  # should have collects, collected, collecting, etc.


def test_resolve_deepseek_endpoint_falls_back_to_ipv4(monkeypatch):
    from privacy_research_dataset import annotator

    annotator._RESOLVED_DEEPSEEK_ENDPOINT = None
    annotator._RESOLVED_DEEPSEEK_HEALTH_URL = None

    class _Resp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_urlopen(url, timeout):
        if "127.0.0.1" in url:
            return _Resp()
        raise URLError("connection refused")

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    assert annotator.resolve_deepseek_endpoint() == "http://127.0.0.1:8901/v1"
    assert annotator.resolve_deepseek_health_url() == "http://127.0.0.1:8901/health"
    assert annotator.check_tunnel_connection() is True

    annotator._RESOLVED_DEEPSEEK_ENDPOINT = None
    annotator._RESOLVED_DEEPSEEK_HEALTH_URL = None
