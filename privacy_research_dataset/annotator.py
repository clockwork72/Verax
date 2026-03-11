"""Stage 2: document preprocessing and LLM-based statement extraction.

Adapted from UCI PoliGrapher-LM:
  document_preprocessor.py — pandoc AST → blocks + chunks
  annotator.py             — iterative LLM extraction of privacy statements
"""

from __future__ import annotations

import json
import logging
import os
import re
import textwrap
import time
import warnings
from collections import deque
from functools import reduce
from typing import Callable, Generator, Sequence, TypeAlias
from urllib.parse import urljoin

import litellm
import rapidjson
import regex
try:
    from rapidfuzz import fuzz
except Exception:  # pragma: no cover - optional dependency fallback
    from difflib import SequenceMatcher

    class _FallbackFuzz:
        @staticmethod
        def ratio(a: str, b: str) -> float:
            return SequenceMatcher(None, a or "", b or "").ratio() * 100.0

    fuzz = _FallbackFuzz()

try:
    from lemminflect import getAllInflections, getAllInflectionsOOV, getAllLemmas  # type: ignore
except Exception:  # pragma: no cover - optional dependency fallback
    def getAllLemmas(word: str) -> dict[str, list[str]]:  # type: ignore[override]
        base = (word or "").strip()
        return {"VERB": [base]} if base else {}

    def getAllInflections(word: str, upos: str | None = None) -> dict[str, list[str]]:  # type: ignore[override]
        base = (word or "").strip()
        if not base:
            return {}
        lowered = base.lower()
        forms = {
            base,
            lowered,
            f"{lowered}s",
            f"{lowered}ed",
            f"{lowered}ing",
        }
        if lowered.endswith("e") and len(lowered) > 1:
            forms.add(f"{lowered[:-1]}ing")
            forms.add(f"{lowered}d")
        return {"fallback": sorted(forms)}

    def getAllInflectionsOOV(word: str, upos: str | None = None) -> dict[str, list[str]]:  # type: ignore[override]
        return getAllInflections(word, upos)

from .annotation_types import (
    DocumentBlockInfo,
    DocumentChunkBlockMapItem,
    DocumentChunkInfo,
    DocumentJson,
    LlmStatement,
    PhraseIdentifier,
    Statement,
)


# ---------------------------------------------------------------------------
# Annotation model endpoint configuration
# ---------------------------------------------------------------------------

DEEPSEEK_ENDPOINT = os.getenv("PRIVACY_LLM_BASE_URL", "http://localhost:8901/v1")
DEEPSEEK_HEALTH_URL = os.getenv("PRIVACY_LLM_HEALTH_URL", "http://localhost:8901/health")
DEEPSEEK_MODEL_ID = "openai/local"   # LiteLLM prefix for OpenAI-compatible API
_TUNNEL_PROBE_TIMEOUT = 3.0
_RESOLVED_DEEPSEEK_ENDPOINT: str | None = None
_RESOLVED_DEEPSEEK_HEALTH_URL: str | None = None


def _deepseek_candidate_urls() -> list[tuple[str, str]]:
    candidates = [
        (DEEPSEEK_ENDPOINT.rstrip("/"), DEEPSEEK_HEALTH_URL),
        ("http://localhost:8901/v1", "http://localhost:8901/health"),
        ("http://127.0.0.1:8901/v1", "http://127.0.0.1:8901/health"),
        ("http://[::1]:8901/v1", "http://[::1]:8901/health"),
    ]
    deduped: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for endpoint, health in candidates:
        pair = (endpoint, health)
        if pair in seen:
            continue
        seen.add(pair)
        deduped.append(pair)
    return deduped


def _probe_endpoint_url(url: str, timeout: float) -> bool:
    import urllib.request

    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.status < 400


def resolve_deepseek_endpoint(timeout: float = _TUNNEL_PROBE_TIMEOUT) -> str | None:
    global _RESOLVED_DEEPSEEK_ENDPOINT, _RESOLVED_DEEPSEEK_HEALTH_URL

    if _RESOLVED_DEEPSEEK_ENDPOINT:
        return _RESOLVED_DEEPSEEK_ENDPOINT

    for endpoint, health in _deepseek_candidate_urls():
        try:
            if _probe_endpoint_url(health, timeout):
                _RESOLVED_DEEPSEEK_ENDPOINT = endpoint
                _RESOLVED_DEEPSEEK_HEALTH_URL = health
                return endpoint
        except Exception:
            continue
    return None


def resolve_deepseek_health_url(timeout: float = _TUNNEL_PROBE_TIMEOUT) -> str | None:
    global _RESOLVED_DEEPSEEK_HEALTH_URL

    if _RESOLVED_DEEPSEEK_HEALTH_URL:
        return _RESOLVED_DEEPSEEK_HEALTH_URL

    endpoint = resolve_deepseek_endpoint(timeout)
    if not endpoint:
        return None
    _RESOLVED_DEEPSEEK_HEALTH_URL = urljoin(f"{endpoint.rstrip('/')}/", "../health")
    return _RESOLVED_DEEPSEEK_HEALTH_URL


def check_tunnel_connection(timeout: float = _TUNNEL_PROBE_TIMEOUT) -> bool:
    """Backward-compatible alias for annotation model reachability checks."""
    return resolve_deepseek_endpoint(timeout) is not None


def describe_annotation_endpoint() -> tuple[str, str]:
    endpoint = resolve_deepseek_endpoint() or DEEPSEEK_ENDPOINT
    health = resolve_deepseek_health_url() or DEEPSEEK_HEALTH_URL
    return endpoint, health


def annotation_endpoint_help() -> str:
    endpoint, health = describe_annotation_endpoint()
    lines = [
        f"Cannot reach annotation model health URL: {health}",
        f"Expected API base URL: {endpoint}",
        "The scraper bridge on port 8910 is separate from the annotation model endpoint.",
    ]
    if os.getenv("PRIVACY_DATASET_HPC_REMOTE") == "1":
        lines.extend(
            [
                "This annotator is running on the cluster.",
                "If the model is not running on the same node, set PRIVACY_LLM_BASE_URL and",
                "PRIVACY_LLM_HEALTH_URL in the orchestrator environment before starting annotation.",
            ]
        )
    else:
        lines.extend(
            [
                "Start the model locally, or expose it through a reachable SSH tunnel, then re-run the annotator.",
            ]
        )
    return "\n".join(lines)


def enable_litellm_disk_cache() -> None:
    """Enable LiteLLM disk caching (call once from CLI, not on import)."""
    try:
        litellm.enable_cache(type="disk")
    except Exception:
        pass  # diskcache not installed or other issue; proceed without cache
    # LiteLLM sometimes prints ANSI-colored debug/help lines on errors.
    # Prefer concise logs in long-running batch annotation jobs.
    try:
        if hasattr(litellm, "suppress_debug_info"):
            litellm.suppress_debug_info = True
    except Exception:
        pass

# ---------------------------------------------------------------------------
# Document preprocessor (adapted from document_preprocessor.py)
# ---------------------------------------------------------------------------

PandocElement: TypeAlias = Sequence
PandocElementPath: TypeAlias = Sequence[int]


def _get_element(li: PandocElement, indices: PandocElementPath):
    return reduce(lambda a, i: a[i], indices, li)


def _get_markdown(elt: PandocElement) -> str:
    import pandoc  # type: ignore
    return pandoc.write(elt, options=[
        "--wrap=none",
        "--to=markdown+hard_line_breaks-smart-raw_attribute-header_attributes-link_attributes",
    ])


def _list_startswith(li: Sequence, prefix: Sequence) -> bool:
    return os.path.commonprefix([li, prefix]) == prefix  # type: ignore


def _process_document(
    elements: PandocElement,
    tokenizer_function: Callable,
    token_limit: int = 500,
) -> DocumentJson:
    """Core document processing — verbatim port of PoliGrapher-LM's process_document()."""
    import pandoc.types as T  # type: ignore

    def dfs_to_block(elt, path) -> Generator[PandocElementPath, None, None]:
        if isinstance(elt, (T.Para, T.Plain, T.Table, T.Header, T.HorizontalRule,
                             T.CodeBlock, T.Figure, T.BlockQuote)):
            yield path
        elif isinstance(elt, T.BulletList):
            for i, child in enumerate(elt[0]):
                yield from dfs_to_block(child, tuple(path) + (0, i))
        elif isinstance(elt, T.OrderedList):
            for i, child in enumerate(elt[1]):
                yield from dfs_to_block(child, tuple(path) + (1, i))
        elif isinstance(elt, list):
            for i, child in enumerate(elt):
                yield from dfs_to_block(child, tuple(path) + (i,))
        else:
            raise NotImplementedError(f"Unsupported element: {type(elt)}")

    def init_blocks():
        blocks = list(dfs_to_block(elements, ()))
        block_texts = []
        for i, elt_idx in enumerate(blocks):
            prev_elt_idx = blocks[i - 1] if i > 0 else ()
            next_elt_idx = blocks[i + 1] if i < len(blocks) - 1 else ()
            prefix1 = os.path.commonprefix([prev_elt_idx, elt_idx])  # type: ignore
            prefix2 = os.path.commonprefix([next_elt_idx, elt_idx])  # type: ignore
            blocks[i] = elt_idx[: max(len(prefix1), len(prefix2)) + 1]
            elt = _get_element(elements, blocks[i])
            block_texts.append(_get_markdown(elt).strip())
        return blocks, block_texts

    def get_block_context_limit(blocks):
        context_limits = []
        for i, elt_idx in enumerate(blocks):
            elt = _get_element(elements, elt_idx)
            limit = i
            if isinstance(elt, T.Header):
                heading_level = elt[0]
                for j in range(i + 1, len(blocks)):
                    elt_j = _get_element(elements, blocks[j])
                    if _list_startswith(blocks[j], elt_idx[:-1]) and not (
                        isinstance(elt_j, T.Header) and elt_j[0] <= heading_level
                    ):
                        limit = j
                    else:
                        break
            else:
                text = _get_markdown(elt)
                if (
                    text.strip().endswith(":")
                    and i + 1 < len(blocks)
                    and _list_startswith(blocks[i + 1], elt_idx[:-1])
                ):
                    limit = i + 1
            context_limits.append(limit)
        return context_limits

    def init_chunks(blocks, block_texts):
        context_limit = get_block_context_limit(blocks)
        block_lengths = [len(tokenizer_function(text)) for text in block_texts]
        chunks: list[frozenset[int]] = []
        for start_block_idx, elt_idx in enumerate(blocks):
            context = [
                j for j, lim in enumerate(context_limit[:start_block_idx])
                if start_block_idx <= lim
            ]
            n_tokens = block_lengths[start_block_idx] + sum(block_lengths[j] for j in context)
            end_block_idx = start_block_idx + 1
            while True:
                elt_idx = tuple(elt_idx[:-1]) + (elt_idx[-1] + 1,)
                next_end = end_block_idx
                for j in range(end_block_idx, len(blocks)):
                    if _list_startswith(blocks[j], elt_idx):
                        next_end = max(next_end, context_limit[j] + 1)
                if end_block_idx == next_end:
                    break
                n_tokens += sum(block_lengths[j] for j in range(end_block_idx, next_end))
                if n_tokens < token_limit:
                    end_block_idx = next_end
                else:
                    break
            new_chunk = frozenset(range(start_block_idx, end_block_idx)) | frozenset(context)
            if all(new_chunk - ch for ch in chunks):
                chunks = [ch for ch in chunks if ch - new_chunk]
                chunks.append(new_chunk)
        return chunks

    def get_chunk_text(blocks, chunk):
        non_leaf_paths: set = {()}
        leaf_paths: set = set()
        for blk_idx in chunk:
            elt_idx = blocks[blk_idx]
            for i in range(len(elt_idx)):
                non_leaf_paths.add(elt_idx[:i])
            leaf_paths.add(elt_idx)

        def dfs(elt, path):
            if path in leaf_paths:
                return elt
            elif path in non_leaf_paths or isinstance(elt, list):
                children = [dfs(child, path + (i,)) for i, child in enumerate(elt)]
                if isinstance(elt, list):
                    return children
                elif isinstance(elt, (T.Block, T.Inline)):
                    return elt.__class__(*children)
                else:
                    assert False
            else:
                ph = "%PLACEHOLDER%"
                if isinstance(elt, tuple):
                    return elt
                elif isinstance(elt, T.Block):
                    return T.Plain([T.Str(ph)])
                elif isinstance(elt, T.Inline):
                    return T.Str(ph)
                else:
                    assert False

        elements_with_ctx = dfs(elements, ())
        text = _get_markdown(elements_with_ctx)
        previous_line = "%PLACEHOLDER%"
        processed_lines = []
        for line in text.split("\n"):
            if line != previous_line:
                processed_lines.append(line.replace("%PLACEHOLDER%", "..."))
            if line:
                previous_line = line
        text = "\n".join(processed_lines).strip() + "\n"
        text = re.sub(r"[\r\n][\r\n]{2,}", "\n\n", text)
        return text

    blocks, block_texts = init_blocks()
    chunks = init_chunks(blocks, block_texts)

    block_info: list[DocumentBlockInfo] = [
        {"element_indices": ei, "text": bt}
        for ei, bt in zip(blocks, block_texts)
    ]

    chunk_info: list[DocumentChunkInfo] = []
    for c in chunks:
        text = get_chunk_text(blocks, c)
        block_map: list[DocumentChunkBlockMapItem] = []
        for blk_idx in sorted(c):
            block_text = block_texts[blk_idx]
            re_pattern = r"\s+".join(map(re.escape, block_text.split()))
            if m := re.search(re_pattern, text):
                i_start, i_end = m.span()
                block_map.append({"index": blk_idx, "text_range": (i_start, i_end)})
            else:
                raise ValueError(f"Block not found in chunk text: {block_text[:80]!r}")
        chunk_info.append({"block_map": block_map, "text": text})

    return {"blocks": block_info, "chunks": chunk_info}


def _make_simple_chunked_document(block_texts: list[str]) -> DocumentJson:
    blocks: list[DocumentBlockInfo] = [
        {"element_indices": (idx,), "text": block}
        for idx, block in enumerate(block_texts)
    ]
    chunk_info: list[DocumentChunkInfo] = []
    for idx, block in enumerate(block_texts):
        chunk_text = block if block.endswith("\n") else f"{block}\n"
        chunk_info.append({
            "block_map": [{"index": idx, "text_range": (0, len(block))}],
            "text": chunk_text,
        })
    return {"blocks": blocks, "chunks": chunk_info}


def _split_oversized_block_text(
    text: str,
    tokenizer_function: Callable,
    token_limit: int,
) -> list[str]:
    normalized = (text or "").strip()
    if not normalized:
        return []
    if len(tokenizer_function(normalized)) <= token_limit:
        return [normalized]

    for splitter in (
        lambda value: re.split(r"\n\s*\n+", value),
        lambda value: re.split(r"\n+", value),
        lambda value: re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"“(])", value),
    ):
        pieces = [piece.strip() for piece in splitter(normalized) if piece.strip()]
        if len(pieces) <= 1:
            continue
        result: list[str] = []
        current: list[str] = []
        for piece in pieces:
            if len(tokenizer_function(piece)) > token_limit:
                if current:
                    result.append("\n\n".join(current))
                    current = []
                result.extend(_split_oversized_block_text(piece, tokenizer_function, token_limit))
                continue
            candidate = "\n\n".join(current + [piece]) if current else piece
            if current and len(tokenizer_function(candidate)) > token_limit:
                result.append("\n\n".join(current))
                current = [piece]
            else:
                current.append(piece)
        if current:
            result.append("\n\n".join(current))
        if result:
            return result

    words = normalized.split()
    if not words:
        return []
    result: list[str] = []
    current: list[str] = []
    for word in words:
        candidate = " ".join(current + [word]) if current else word
        if current and len(tokenizer_function(candidate)) > token_limit:
            result.append(" ".join(current))
            current = [word]
        else:
            current.append(word)
    if current:
        result.append(" ".join(current))
    return result


def _rebalance_document_chunks(
    doc: DocumentJson,
    tokenizer_function: Callable,
    token_limit: int,
) -> DocumentJson:
    split_blocks: list[str] = []
    for block in doc["blocks"]:
        split_blocks.extend(_split_oversized_block_text(block["text"], tokenizer_function, token_limit))
    if not split_blocks:
        return {"blocks": [], "chunks": []}

    chunked_blocks: list[str] = []
    current: list[str] = []
    for block in split_blocks:
        candidate = "\n\n".join(current + [block]) if current else block
        if current and len(tokenizer_function(candidate)) > token_limit:
            chunked_blocks.append("\n\n".join(current))
            current = [block]
        else:
            current.append(block)
    if current:
        chunked_blocks.append("\n\n".join(current))

    blocks: list[DocumentBlockInfo] = []
    chunks: list[DocumentChunkInfo] = []
    block_idx = 0
    for chunk_text in chunked_blocks:
        parts = [part.strip() for part in re.split(r"\n\s*\n+", chunk_text) if part.strip()]
        if not parts:
            parts = [chunk_text.strip()]
        rendered_parts: list[str] = []
        block_map: list[DocumentChunkBlockMapItem] = []
        cursor = 0
        for part in parts:
            blocks.append({"element_indices": (block_idx,), "text": part})
            rendered_parts.append(part)
            block_map.append({"index": block_idx, "text_range": (cursor, cursor + len(part))})
            cursor += len(part) + 2
            block_idx += 1
        rendered = "\n\n".join(rendered_parts)
        chunks.append({"block_map": block_map, "text": rendered if rendered.endswith("\n") else f"{rendered}\n"})

    return {"blocks": blocks, "chunks": chunks}


def _should_rebalance_document(
    doc: DocumentJson,
    tokenizer_function: Callable,
    token_limit: int,
) -> bool:
    return any(len(tokenizer_function(block["text"])) > token_limit for block in doc["blocks"])


def preprocess_policy(policy_text: str, token_limit: int = 500) -> DocumentJson:
    """Convert clean markdown policy text into a chunked DocumentJson.

    Uses pandoc to parse the markdown AST, then slices it into token-bounded
    chunks (with heading breadcrumb context) suitable for LLM annotation.
    """
    try:
        import pandoc  # type: ignore
    except Exception:
        chunks = [
            block.strip()
            for block in re.split(r"\n\s*\n+", policy_text or "")
            if block.strip()
        ]
        if not chunks:
            chunks = [policy_text.strip()] if policy_text.strip() else []
        simple_doc = _make_simple_chunked_document(chunks)
        return _rebalance_document_chunks(simple_doc, lambda text: re.findall(r"\S+", text or ""), token_limit)

    try:
        import tiktoken

        encoder = tiktoken.encoding_for_model("gpt-4o-mini")
        tokenizer = encoder.encode
    except Exception:
        tokenizer = lambda text: re.findall(r"\S+", text or "")

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        _, elements = pandoc.read(policy_text, format="markdown")

    processed = _process_document(elements, tokenizer, token_limit)
    if _should_rebalance_document(processed, tokenizer, token_limit):
        return _rebalance_document_chunks(processed, tokenizer, token_limit)
    return processed


# ---------------------------------------------------------------------------
# LLM annotator (adapted from annotator.py)
# ---------------------------------------------------------------------------

_PROMPT = '''
### Instructions

Analyze the user-provided privacy policy excerpt and extract information about personal data processing.

Return a list of JSON objects, each with the following keys:
- action: List[str] -- List of actions applied to the personal data. For example: "collect", "share", "use".
- data: List[str] -- List of personal data types that are processed. For example: "email address", "mac address", and broader terms like "personal data", "contact info".
- processor: List[str] -- List of entities that process the personal data. For example: "we" (the first party), "our third-party partners", or specific company names.
- recipient: List[str] -- List of entities that receive personal data, when the action involves data transfer. Same examples as for "processor".
- purpose: List[str] -- List of purposes for which the personal data is processed. For example: "authentication", "to provide services".
- context: List[str] -- Other conditions associated with personal data processing. For example: "if you register an account", "when you use our services".
- prohibition: bool -- Specially, if the statement denies or prohibits the stated action (for example, "we DO NOT collect..."), include this key and set it to true.

Notes:
- Ensure that the string values are extracted exactly from the text, preserving the original wording.
- The information to extract may spread across multiple sentences. Make sure to analyze the entire excerpt.
- Omit any of the keys if the corresponding information is not present in the text.
- Only include affirmative and negative statements concerning personal data processing. Ignore other types of statements.
- Return a list of JSON objects, one for each relevant statement found in the excerpt. If there are no relevant statements, simply return an empty list `[]`.

### Examples

Input 1:
> When you create an account, or when you contact us, we may collect a variety of information,
> including your name, mailing address, contact preferences, and credit card information.

Output 1:
[
  {
    "action": ["collect"],
    "processor": ["we"],
    "data": ["name", "mailing address", "contact preferences", "credit card information"],
    "context": ["When you create an account", "when you contact us"]
  }
]

Input 2:
> Here are the types of personal information we collect:
> * Identity Information: such as your user identification number.
> * Contact Information: such as your email address and telephone number.
> We will never share these data with third parties.

Output 2:
[
  {
    "action": ["collect"],
    "processor": ["we"],
    "data": ["Identity Information", "user identification number", "Contact Information", "email address", "telephone number"]
  },
  {
    "action": ["share"],
    "processor": ["We"],
    "recipient": ["third parties"],
    "data": ["Identity Information", "user identification number", "Contact Information", "email address", "telephone number"],
    "prohibition": true
  }
]

Input 3:

> We may share your personal information with CompanyX.
> CompanyX uses your personal information to operate, provide, and improve the products that we offer.
> These purposes include: Purchase and delivery of products.

Output 3:
[
  {
    "action": ["share"],
    "processor": ["We"],
    "recipient": ["CompanyX"],
    "data": ["personal information"]
  },
  {
    "action": ["uses"],
    "processor": ["CompanyX"],
    "data": ["personal information"],
    "purpose": ["to operate, provide, and improve the products that we offer", "Purchase and delivery of products"]
  }
]

Input 4:

> As required by law, we will never disclose sensitive personal information to third parties without your explicit consent.
> When you use third party services, including cloud services and customer service providers, they may share information about that usage with us.

Output 4:
[
  {
    "action": ["disclose"],
    "processor": ["We"],
    "recipient": ["third parties"],
    "data": ["sensitive personal information"],
    "context": ["As required by law", "without your explicit consent"],
    "prohibition": true
  },
  {
    "action": ["share"],
    "processor": ["third party services", "cloud services", "customer service providers"],
    "recipient": ["us"],
    "data": ["information about that usage"],
    "context": ["When you use third party services, including cloud services and customer service providers"]
  }
]

Input 5:
> You have the right to access, update, and correct inaccuracies in your personal information in our custody.
> However, you may not disable certain types of data processing.

Output 5:
[]
'''

_LOCAL_PROMPT = """\
Extract privacy-policy processing statements from the excerpt.
Return ONLY a JSON array and nothing else.

Each array item must be an object with optional keys:
- action: array of exact action phrases from the excerpt
- data: array of exact personal-data phrases from the excerpt
- processor: array of exact processor phrases from the excerpt
- recipient: array of exact recipient phrases from the excerpt
- purpose: array of exact purpose phrases from the excerpt
- context: array of exact context phrases from the excerpt
- prohibition: true only when the excerpt explicitly denies or prohibits the action

Rules:
- Copy wording exactly from the excerpt.
- Omit keys that are not present.
- Use one object per distinct processing statement.
- Do not include prose, markdown, code fences, or commentary.
- Start with `[` and end with `]`.
- If there are no relevant statements, return [].
"""

_EXHAUSTION_PROMPT = """\
You are validating extraction completeness for privacy-policy statements.
Given:
1) a policy excerpt
2) statements already extracted from it
Answer strictly with one token: YES or NO.
- YES = there are still missing statements about personal-data processing.
- NO = no additional statements are missing.
Do not add any other text.
"""

_LOCAL_EXHAUSTION_PROMPT = """\
Check whether the excerpt still contains any missing personal-data processing statements.
Return ONLY one token:
- YES if at least one statement is still missing
- NO if nothing is missing
Do not add any other text.
"""

_JSON_REPAIR_PROMPT = """\
Convert the input into a valid JSON array of privacy-policy processing statements.
Return ONLY JSON.

Allowed keys per object:
- action
- data
- processor
- recipient
- purpose
- context
- prohibition

Rules:
- Use arrays of strings for all keys except prohibition.
- If the input already contains JSON, repair it instead of rewriting it.
- If the input contains no usable statements, return [].
- No prose, no markdown, no code fences.
"""

_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*m")
_CHAT_TEMPLATE_TOKEN_RE = re.compile(r"<\|[^>]+?\|>")
_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)
_ANSWER_BLOCK_RE = re.compile(r"<answer>(.*?)</answer>", re.IGNORECASE | re.DOTALL)
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.IGNORECASE | re.DOTALL)
_LOCAL_STOP_SEQUENCES = ["<|im_end|>", "<|eot_id|>"]

_DEFAULT_MODEL_TPM: dict[str, int] = {
    "gpt-4o": 30000,
    "gpt-4o-mini": 200000,
    "gpt-4.1": 30000,
    "gpt-4.1-mini": 200000,
    "gpt-4.1-nano": 1000000,
    # Local HPC model: no remote quota — throughput bounded by GPU, not API tier.
    "local": 0,
}

_DEFAULT_MODEL_MAX_OUTPUT: dict[str, int] = {
    "gpt-4o": 900,
    "gpt-4o-mini": 1200,
    "gpt-4.1": 900,
    "gpt-4.1-mini": 1200,
    "gpt-4.1-nano": 1200,
    # DeepSeek-R1-Distill-Llama-70B (Q4_K_M, 131k context) on HPC GPU node.
    "local": 2048,
}


def _strip_ansi(value: str) -> str:
    return _ANSI_ESCAPE_RE.sub("", value or "")


def _model_key(model_name: str) -> str:
    m = (model_name or "").strip().lower()
    if "/" in m:
        m = m.split("/")[-1]
    return m


def _resolve_model_tpm(model_name: str, explicit: int | None = None) -> int | None:
    if explicit is not None and explicit > 0:
        return int(explicit)
    key = _model_key(model_name)
    exact_env = os.getenv(f"PRIVACY_DATASET_TPM_{re.sub(r'[^A-Za-z0-9]', '_', key).upper()}")
    if exact_env:
        try:
            v = int(exact_env)
            if v > 0:
                return v
        except Exception:
            pass
    for prefix, tpm in _DEFAULT_MODEL_TPM.items():
        if key == prefix or key.startswith(prefix + "-"):
            return tpm
    fallback_env = os.getenv("PRIVACY_DATASET_DEFAULT_TPM")
    if fallback_env:
        try:
            v = int(fallback_env)
            if v > 0:
                return v
        except Exception:
            pass
    return None


def _resolve_model_max_output(model_name: str, explicit: int | None = None) -> int:
    if explicit is not None and explicit > 0:
        return int(explicit)
    key = _model_key(model_name)
    for prefix, max_out in _DEFAULT_MODEL_MAX_OUTPUT.items():
        if key == prefix or key.startswith(prefix + "-"):
            return max_out
    return 900


def get_inflections(word: str) -> set[str]:
    """Get all possible inflections of a word."""
    results: set[str] = set()
    for upos, lemmas in getAllLemmas(word).items():
        for lemma in lemmas:
            results.add(lemma)
            for inflection_list in getAllInflections(lemma, upos).values():
                results.update(inflection_list)
    if not results:
        for inflection_list in getAllInflectionsOOV(word, "NOUN").values():
            results.update(inflection_list)
    results.add(word)
    return results


def _strip_model_wrappers(text: str) -> str:
    cleaned = _CHAT_TEMPLATE_TOKEN_RE.sub("", text or "")
    return cleaned.replace("<|endoftext|>", "").strip()


def _iter_json_candidates(text: str) -> Generator[str, None, None]:
    cleaned = _strip_model_wrappers(text)
    if not cleaned:
        return

    yielded: set[str] = set()

    def push(candidate: str) -> Generator[str, None, None]:
        normalized = candidate.strip()
        if normalized and normalized not in yielded:
            yielded.add(normalized)
            yield normalized

    for match in _ANSWER_BLOCK_RE.finditer(cleaned):
        yield from push(match.group(1))

    for match in _JSON_FENCE_RE.finditer(cleaned):
        yield from push(match.group(1))

    without_think = _THINK_BLOCK_RE.sub(" ", cleaned)
    yield from push(without_think)

    for source in (without_think, cleaned):
        depth = 0
        start: int | None = None
        in_string = False
        escaped = False
        for idx, ch in enumerate(source):
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue

            if ch == '"':
                in_string = True
                continue

            if ch in "[{":
                if depth == 0:
                    start = idx
                depth += 1
                continue

            if ch in "]}":
                if depth == 0:
                    continue
                depth -= 1
                if depth == 0 and start is not None:
                    yield from push(source[start : idx + 1])
                    start = None


def _coerce_statement_list(value: object) -> list[LlmStatement]:
    if isinstance(value, dict):
        for key in ("statements", "privacy_statements", "items", "results", "data"):
            nested = value.get(key)
            if isinstance(nested, list):
                value = nested
                break
        else:
            for nested in value.values():
                if isinstance(nested, list):
                    value = nested
                    break

    if not isinstance(value, list):
        raise ValueError("response did not contain a JSON list")

    normalized: list[LlmStatement] = []
    for item in value:
        parsed_item = item
        if isinstance(parsed_item, str):
            stripped = parsed_item.strip()
            if stripped.startswith("{") or stripped.startswith("["):
                parsed_item = rapidjson.loads(
                    stripped,
                    parse_mode=rapidjson.PM_COMMENTS | rapidjson.PM_TRAILING_COMMAS,
                )
            else:
                raise ValueError("statement item was not a JSON object")
        if not isinstance(parsed_item, dict):
            raise ValueError("statement item was not a JSON object")
        normalized.append(parsed_item)
    return normalized


def extract_json_list(text: str) -> list[LlmStatement]:
    """Extract and parse a JSON list from an LLM response string."""
    last_error: Exception | None = None
    for candidate in _iter_json_candidates(text):
        try:
            parsed = rapidjson.loads(
                candidate,
                parse_mode=rapidjson.PM_COMMENTS | rapidjson.PM_TRAILING_COMMAS,
            )
            return _coerce_statement_list(parsed)
        except Exception as exc:  # pragma: no cover - exercised via fallback cases
            last_error = exc
            continue

    if last_error is not None:
        raise ValueError(f"no valid JSON statement list found: {last_error}") from last_error
    raise ValueError("no valid JSON statement list found")


def fuzzy_finditer(text: str, value: str) -> list[regex.Match]:
    """Fuzzy search for a value in the text; returns best matches first."""
    re_patterns = []
    for item in regex.finditer(r"(\w+)|(\s+)|([^\w\s]+)", value):
        if m := item.group(1):
            inflections = map(regex.escape, sorted(get_inflections(m), key=len, reverse=True))
            re_patterns.append(rf'(?:{"|".join(inflections)})')
        elif item.group(2):
            re_patterns.append(r"\W+")
        elif m := item.group(3):
            re_patterns.append(rf"(?:{regex.escape(m)})?")
    return sorted(
        regex.finditer(r"\W*".join(re_patterns), text, regex.IGNORECASE),
        key=lambda m: -fuzz.ratio(value, m[0]),
    )


def convert_statements_to_llm_input(statements: list[Statement]) -> str:
    """Serialize statements for multi-turn LLM prompting (phrase text only, no block indices)."""
    serialized = []
    for st in statements:
        llm_st: dict[str, bool | list[str]] = {}
        for key, value in st.items():
            if isinstance(value, bool):
                llm_st[key] = value
            elif isinstance(value, list):
                llm_st[key] = [i[1] for i in value]
        json_string = rapidjson.dumps(
            llm_st, indent=2, write_mode=rapidjson.WM_SINGLE_LINE_ARRAY
        )
        serialized.append(textwrap.indent(json_string, "  "))
    return "[\n" + ",\n".join(serialized) + "\n]"


def match_parameters_to_blocks(
    chunk: DocumentChunkInfo, statement: dict
) -> Statement:
    """Align each statement parameter phrase back to a block index in the chunk."""
    text = chunk["text"]
    block_map = chunk["block_map"]

    assign_candidates: dict[str, dict[int, str]] = {}
    _unique_blocks: set[int] = set()

    for value_list in statement.values():
        if not isinstance(value_list, list):
            continue
        for value in value_list:
            if value in assign_candidates or not value:
                continue
            for match in fuzzy_finditer(text, value):
                v_start, v_end = match.span()
                matched_str = text[v_start:v_end]
                for item in block_map:
                    i_start, i_end = item["text_range"]
                    block_idx = item["index"]
                    if i_start <= v_start < v_end <= i_end:
                        assign_candidates.setdefault(value, {}).setdefault(block_idx, matched_str)
                        _unique_blocks.add(block_idx)

    unique_blocks = sorted(_unique_blocks)
    best_match_range = len(unique_blocks) + 1
    best_matches: dict[str, PhraseIdentifier] = {}

    for i in range(len(unique_blocks)):
        matches: dict[str, PhraseIdentifier] = {}
        for j in range(i + 1, len(unique_blocks) + 1):
            block_idx = unique_blocks[j - 1]
            for value, candidate_matches in assign_candidates.items():
                if block_idx in candidate_matches:
                    matches[value] = (block_idx, candidate_matches[block_idx])
            if len(matches) == len(assign_candidates):
                if j - i < best_match_range:
                    best_match_range = j - i
                    best_matches = matches
                break

    transformed: dict = {}
    for key, value_list in statement.items():
        if isinstance(value_list, bool):
            transformed[key] = value_list
        elif isinstance(value_list, list):
            for value in value_list:
                if value in best_matches:
                    phrase_id = best_matches[value]
                    transformed.setdefault(key, []).append(phrase_id)
                    if phrase_id[1] != value:
                        logging.info("Value %r matched to %r", value, phrase_id)
                else:
                    logging.info("Value %r not found in any blocks", value)

    return transformed  # type: ignore


def validate_and_fix_statement(
    chunk: DocumentChunkInfo, statement: LlmStatement
) -> Statement | None:
    """Validate and fix an LLM-format statement; return None if core keys missing."""
    str_list_keys = ["action", "processor", "recipient", "data", "purpose", "context"]
    bool_keys = ["prohibition"]
    core_keys = ["action", "data"]

    fixed: dict = {}
    for key in str_list_keys:
        value = statement.get(key)
        if isinstance(value, list) and value:
            fixed[key] = value
        elif isinstance(value, str):
            fixed[key] = [value]
    for key in bool_keys:
        value = statement.get(key)
        if isinstance(value, bool) and value:
            fixed[key] = True
        elif isinstance(value, str) and value.lower() in ("true", "yes"):
            fixed[key] = True

    fixed2 = match_parameters_to_blocks(chunk, fixed)
    for key in core_keys:
        if key not in fixed2:
            logging.error("Core key %r not found in chunk text; dropping statement", key)
            return None
    return fixed2


class Annotator:
    """LLM-based privacy statement extractor.

    For each chunk of a DocumentJson, runs up to `reflection_rounds` LLM calls
    to iteratively extract all personal data processing statements. Deduplicates
    globally across the entire document.
    """

    def __init__(
        self,
        model_name: str = "gpt-4o-mini",
        *,
        model_tpm: int | None = None,
        llm_max_output_tokens: int | None = None,
        rate_limit_retries: int = 8,
        tpm_headroom_ratio: float = 0.75,
        tpm_safety_factor: float = 1.2,
        disable_exhaustion_check: bool = False,
    ) -> None:
        self.model_name = model_name
        self.reflection_rounds = 3
        self.error_retries = 3
        self.rate_limit_retries = max(1, int(rate_limit_retries))
        self.model_tpm = _resolve_model_tpm(model_name, explicit=model_tpm)
        env_headroom = os.getenv("PRIVACY_DATASET_TPM_HEADROOM")
        env_safety = os.getenv("PRIVACY_DATASET_TPM_SAFETY_FACTOR")
        if env_headroom:
            try:
                tpm_headroom_ratio = float(env_headroom)
            except Exception:
                pass
        if env_safety:
            try:
                tpm_safety_factor = float(env_safety)
            except Exception:
                pass
        self.tpm_headroom_ratio = min(1.0, max(0.3, float(tpm_headroom_ratio)))
        self.tpm_safety_factor = max(1.0, float(tpm_safety_factor))
        self.disable_exhaustion_check = bool(disable_exhaustion_check)
        self.effective_model_tpm = (
            int(self.model_tpm * self.tpm_headroom_ratio)
            if self.model_tpm and self.model_tpm > 0
            else None
        )
        self.llm_max_output_tokens = _resolve_model_max_output(model_name, explicit=llm_max_output_tokens)
        self.usage: dict[str, int] = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        self._token_events: deque[tuple[float, int]] = deque()
        self._provider_used_hint: int = 0
        self._provider_used_hint_ts: float = 0.0
        # Streaming context — set externally before annotating each site/chunk
        self.current_site: str = ""
        self._current_chunk_idx: int = 0
        self._current_chunk_total: int = 0
        self._current_round: int = 0
        logging.info(
            "Annotator model=%s max_output_tokens=%d model_tpm=%s effective_tpm=%s headroom=%.2f safety=%.2f exhaustion_check=%s",
            self.model_name,
            self.llm_max_output_tokens,
            (str(self.model_tpm) if self.model_tpm else "unlimited"),
            (str(self.effective_model_tpm) if self.effective_model_tpm else "unlimited"),
            self.tpm_headroom_ratio,
            self.tpm_safety_factor,
            ("off" if self.disable_exhaustion_check else "on"),
        )

    @property
    def _is_local_model(self) -> bool:
        return _model_key(self.model_name) == "local"

    def _estimate_prompt_tokens(self, messages: list[dict[str, str]]) -> int:
        if _model_key(self.model_name) == "local":
            # tiktoken has no encoding for "local"; use char-based estimate.
            chars = sum(len(str(m.get("content") or "")) for m in messages)
            return max(1, chars // 4)
        try:
            return int(litellm.token_counter(model=self.model_name, messages=messages))
        except Exception:
            chars = sum(len(str(m.get("content") or "")) for m in messages)
            return max(1, chars // 4)

    def _prune_token_window(self, now: float) -> None:
        cutoff = now - 60.0
        while self._token_events and self._token_events[0][0] < cutoff:
            self._token_events.popleft()

    def _throttle_for_tpm(self, messages: list[dict[str, str]], *, max_tokens: int) -> None:
        if not self.effective_model_tpm or self.effective_model_tpm <= 0:
            return
        prompt_est = self._estimate_prompt_tokens(messages)
        requested = int((prompt_est + max(0, int(max_tokens))) * self.tpm_safety_factor)
        if requested <= 0:
            return
        # If a single request estimate exceeds TPM, we still attempt once after waiting
        # for a clear window; caller-level retries will handle residual 429s.
        requested_for_window = min(requested, self.effective_model_tpm)

        while True:
            now = time.monotonic()
            self._prune_token_window(now)
            used = sum(tokens for _, tokens in self._token_events)
            # Incorporate provider-side "Used" hints parsed from recent 429 responses.
            if self._provider_used_hint and (now - self._provider_used_hint_ts) < 60.0:
                used = max(used, self._provider_used_hint)
            if used + requested_for_window <= self.effective_model_tpm:
                self._token_events.append((now, requested_for_window))
                return
            if self._token_events:
                wait_s = max(0.05, (self._token_events[0][0] + 60.0) - now)
            else:
                wait_s = 0.5
            if self._provider_used_hint and (now - self._provider_used_hint_ts) < 60.0:
                provider_wait = 60.0 - (now - self._provider_used_hint_ts)
                wait_s = max(wait_s, min(10.0, provider_wait))
            logging.info(
                "TPM throttle (%s): used=%d requested=%d limit=%d; sleeping %.2fs",
                self.model_name,
                used,
                requested_for_window,
                self.effective_model_tpm,
                wait_s,
            )
            time.sleep(wait_s)

    def _is_rate_limit_error(self, err: Exception) -> bool:
        msg = _strip_ansi(str(err)).lower()
        cls = err.__class__.__name__.lower()
        return "ratelimit" in cls or "rate limit" in msg or "429" in msg

    def _retry_after_seconds(self, err: Exception, attempt: int) -> float:
        for attr in ("retry_after", "retry_after_seconds"):
            value = getattr(err, attr, None)
            if isinstance(value, (int, float)) and value > 0:
                return float(value)
        msg = _strip_ansi(str(err))
        m = re.search(r"try again in\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|s)", msg, re.I)
        if m:
            num = float(m.group(1))
            unit = m.group(2).lower()
            return num / 1000.0 if unit == "ms" else num
        # Fallback exponential backoff with a small floor.
        return min(8.0, 0.5 * (2 ** max(0, attempt)))

    def _capture_provider_tpm_hint(self, err: Exception) -> None:
        msg = _strip_ansi(str(err))
        m = re.search(r"Limit\s+([0-9]+),\s*Used\s+([0-9]+),\s*Requested\s+([0-9]+)", msg, re.I)
        if not m:
            return
        try:
            limit = int(m.group(1))
            used = int(m.group(2))
        except Exception:
            return
        if limit > 0 and used >= 0:
            now = time.monotonic()
            self._provider_used_hint = used
            self._provider_used_hint_ts = now
            # If provider limit differs from local default (plan/account changes), adapt.
            if self.model_tpm is None or abs(self.model_tpm - limit) > 100:
                self.model_tpm = limit
                self.effective_model_tpm = int(limit * self.tpm_headroom_ratio)

    def _record_usage(self, response) -> None:
        if hasattr(response, "usage") and response.usage:
            self.usage["prompt_tokens"] += getattr(response.usage, "prompt_tokens", 0) or 0
            self.usage["completion_tokens"] += getattr(response.usage, "completion_tokens", 0) or 0
            self.usage["total_tokens"] += getattr(response.usage, "total_tokens", 0) or 0

    def _llm_completion_streaming(
        self,
        *,
        messages: list[dict[str, str]],
        max_tokens: int,
        tag: str,
        extra: dict,
    ):
        """Stream a local-model completion, emitting [STREAM] JSON lines per delta to stdout."""
        import sys

        is_exhaustion = "exhaustion" in tag.lower()
        stream_gen = litellm.completion(
            model=self.model_name,
            messages=messages,
            temperature=0,
            max_tokens=max_tokens,
            stream=True,
            stream_options={"include_usage": True},
            **extra,
        )
        parts: list[str] = []
        extraction_started = False
        usage_data: dict[str, int] = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        for chunk in stream_gen:
            if not getattr(chunk, "choices", None):
                # Final usage-only chunk
                if hasattr(chunk, "usage") and chunk.usage:
                    usage_data["prompt_tokens"] = getattr(chunk.usage, "prompt_tokens", 0) or 0
                    usage_data["completion_tokens"] = getattr(chunk.usage, "completion_tokens", 0) or 0
                    usage_data["total_tokens"] = getattr(chunk.usage, "total_tokens", 0) or 0
                continue
            delta_obj = chunk.choices[0].delta
            delta = getattr(delta_obj, "content", None) or ""
            if not delta:
                if hasattr(chunk, "usage") and chunk.usage:
                    usage_data["prompt_tokens"] = getattr(chunk.usage, "prompt_tokens", 0) or 0
                    usage_data["completion_tokens"] = getattr(chunk.usage, "completion_tokens", 0) or 0
                    usage_data["total_tokens"] = getattr(chunk.usage, "total_tokens", 0) or 0
                continue

            parts.append(delta)
            joined = "".join(parts)
            latest_think_open = joined.rfind("<think>")
            latest_think_close = joined.rfind("</think>")
            in_think = latest_think_open > latest_think_close
            if not extraction_started:
                stripped = _THINK_BLOCK_RE.sub(" ", _strip_model_wrappers(joined))
                extraction_started = "[" in stripped or "{" in stripped
            phase = "exhaustion" if is_exhaustion else ("reasoning" if in_think or not extraction_started else "extraction")

            event = json.dumps({
                "site": self.current_site,
                "chunk_idx": self._current_chunk_idx,
                "chunk_total": self._current_chunk_total,
                "round": self._current_round,
                "phase": phase,
                "tag": tag,
                "delta": delta,
            }, ensure_ascii=False)
            sys.stdout.write(f"[STREAM] {event}\n")
            sys.stdout.flush()

        text = "".join(parts)

        # Build a minimal response-compatible object
        class _Msg:
            content = text

        class _Choice:
            message = _Msg()

        class _Usage:
            prompt_tokens = usage_data["prompt_tokens"]
            completion_tokens = usage_data["completion_tokens"]
            total_tokens = usage_data["total_tokens"]

        class _Response:
            choices = [_Choice()]
            usage = _Usage()

        return _Response()

    def _llm_completion(
        self,
        *,
        messages: list[dict[str, str]],
        max_tokens: int,
        caching: bool,
        tag: str,
    ):
        attempts = max(self.error_retries, self.rate_limit_retries)
        for i_retry in range(attempts):
            self._throttle_for_tpm(messages, max_tokens=max_tokens)
            try:
                # Route to the local HPC endpoint for DeepSeek (openai/local).
                extra: dict = {}
                if self._is_local_model:
                    extra["api_base"] = resolve_deepseek_endpoint() or DEEPSEEK_ENDPOINT
                    extra["api_key"] = "not-needed"
                    extra["stop"] = _LOCAL_STOP_SEQUENCES
                    # Stream local model and emit [STREAM] events for live UI
                    return self._llm_completion_streaming(
                        messages=messages,
                        max_tokens=max_tokens,
                        tag=tag,
                        extra=extra,
                    )
                return litellm.completion(
                    model=self.model_name,
                    messages=messages,
                    caching=caching,
                    temperature=0,
                    max_tokens=max_tokens,
                    **extra,
                )
            except Exception as e:
                clean_err = _strip_ansi(str(e))
                if self._is_rate_limit_error(e):
                    self._capture_provider_tpm_hint(e)
                    delay = self._retry_after_seconds(e, i_retry)
                    logging.warning(
                        "%s rate-limited on %s (attempt %d/%d). Backing off %.3fs. %s",
                        tag,
                        self.model_name,
                        i_retry + 1,
                        attempts,
                        delay,
                        clean_err,
                    )
                    time.sleep(max(0.05, delay))
                    continue
                logging.error("%s failed (attempt %d/%d): %s", tag, i_retry + 1, attempts, clean_err)
                time.sleep(min(2.0, 0.2 * (i_retry + 1)))
        return None

    def _repair_json_response(self, raw_message: str) -> str | None:
        if not raw_message.strip():
            return None
        response = self._llm_completion(
            messages=[
                {"role": "system", "content": _JSON_REPAIR_PROMPT},
                {"role": "user", "content": raw_message},
            ],
            max_tokens=min(max(256, self.llm_max_output_tokens), 1024),
            caching=False,
            tag="JSON repair",
        )
        if response is None:
            return None
        repaired = response.choices[0].message.content
        self._record_usage(response)
        return repaired

    def run(self, doc: DocumentJson) -> Generator[tuple[int, Statement], None, None]:
        """Yield (chunk_index, statement) for every statement found in the document."""
        seen_statements: set[str] = set()
        chunks = doc["chunks"]
        self._current_chunk_total = len(chunks)

        for chunk_idx, chunk in enumerate(chunks):
            self._current_chunk_idx = chunk_idx
            statements: list[Statement] = []

            for round_i in range(self.reflection_rounds):
                self._current_round = round_i
                if (not self.disable_exhaustion_check) and statements and self._check_if_exhausted(chunk, statements):
                    logging.info("Chunk %d exhausted after %d round(s), %d statements",
                                 chunk_idx, round_i, len(statements))
                    break

                logging.info("Chunk %d, round %d", chunk_idx, round_i + 1)
                new_statements = self._llm_extract(chunk, statements)
                logging.info("%d new statements", len(new_statements))

                if not new_statements:
                    break
                statements.extend(new_statements)

            for st in statements:
                st_key = json.dumps(st, sort_keys=True)
                if st_key in seen_statements:
                    continue
                seen_statements.add(st_key)
                yield chunk_idx, st

    def _llm_extract(
        self, chunk: DocumentChunkInfo, current_statements: list[Statement]
    ) -> list[Statement]:
        text = chunk["text"]

        for i_retry in range(self.error_retries):
            messages = [
                {"role": "system", "content": _LOCAL_PROMPT if self._is_local_model else _PROMPT},
                {"role": "user", "content": f"### INPUT\n\n{text}"},
            ]
            if current_statements:
                messages.extend([
                    {
                        "role": "assistant",
                        "content": convert_statements_to_llm_input(current_statements),
                    },
                    {
                        "role": "user",
                        "content": "Some statements were missed in the last extraction. Please continue.",
                    },
                ])

            response = self._llm_completion(
                messages=messages,
                max_tokens=self.llm_max_output_tokens,
                caching=(i_retry == 0),
                tag="Extraction call",
            )
            if response is None:
                continue
            raw_message = response.choices[0].message.content
            logging.info("LLM response: %r", (raw_message or "")[:200])
            self._record_usage(response)

            try:
                new_statements = extract_json_list(raw_message)
            except (rapidjson.JSONDecodeError, ValueError, AttributeError) as e:
                logging.error("Failed to decode JSON response: %s", e)
                if self._is_local_model:
                    repaired = self._repair_json_response(str(raw_message or ""))
                    if repaired:
                        logging.info("Attempting repaired JSON parse: %r", repaired[:200])
                        try:
                            new_statements = extract_json_list(repaired)
                        except (rapidjson.JSONDecodeError, ValueError, AttributeError) as repair_error:
                            logging.error("Failed to decode repaired JSON response: %s", repair_error)
                            continue

                        fixed_statements = []
                        for statement in new_statements:
                            if st := validate_and_fix_statement(chunk, statement):
                                fixed_statements.append(st)
                        return fixed_statements
                continue

            fixed_statements = []
            for statement in new_statements:
                if st := validate_and_fix_statement(chunk, statement):
                    fixed_statements.append(st)
            return fixed_statements

        return []

    def _check_if_exhausted(
        self, chunk: DocumentChunkInfo, current_statements: list[Statement]
    ) -> bool:
        text = chunk["text"]
        messages = [
            {"role": "system", "content": _LOCAL_EXHAUSTION_PROMPT if self._is_local_model else _EXHAUSTION_PROMPT},
            {"role": "user", "content": f"### INPUT\n\n{text}"},
            {
                "role": "assistant",
                "content": convert_statements_to_llm_input(current_statements),
            },
            {
                "role": "user",
                "content": "Are there still more statements to be added? Answer 'YES' or 'NO'.",
            },
        ]
        response = self._llm_completion(
            messages=messages,
            max_tokens=8,
            caching=False,
            tag="Exhaustion check",
        )
        if response is None:
            # Do not assume exhausted on transient failures/rate limits; let extraction continue.
            logging.warning("Exhaustion check unavailable; continuing extraction rounds.")
            return False

        raw_message = response.choices[0].message.content
        clean_message = _strip_ansi(_strip_model_wrappers(str(raw_message or ""))).strip().upper()
        logging.info("Exhaustion check response: %r", clean_message)
        self._record_usage(response)
        yes_present = bool(re.search(r"\bYES\b", clean_message))
        no_present = bool(re.search(r"\bNO\b", clean_message))
        if yes_present and not no_present:
            return False
        if no_present and not yes_present:
            return True
        logging.warning("Ambiguous exhaustion response; continuing extraction rounds.")
        return False
