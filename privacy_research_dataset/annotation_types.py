"""Type annotations for the Stage 2 annotation pipeline."""

from __future__ import annotations

from typing import Sequence, TypeAlias, TypedDict

# (block_index, phrase_text) — identifies where a phrase lives in the document
PhraseIdentifier: TypeAlias = tuple[int, str]

# Statement format as the LLM outputs it (plain strings, not yet block-mapped)
LlmStatement: TypeAlias = dict[str, bool | str | Sequence[str]]


class Statement(TypedDict):
    """A data processing statement extracted from a privacy policy."""
    action: Sequence[PhraseIdentifier]
    data: Sequence[PhraseIdentifier]
    processor: Sequence[PhraseIdentifier]
    recipient: Sequence[PhraseIdentifier]
    purpose: Sequence[PhraseIdentifier]
    context: Sequence[PhraseIdentifier]
    prohibition: bool


class DocumentBlockInfo(TypedDict):
    """A single atomic block (paragraph, heading, list item, etc.)."""
    element_indices: Sequence[int]
    text: str


class DocumentChunkBlockMapItem(TypedDict):
    """How a chunk maps to a block: block index and char range within chunk text."""
    index: int
    text_range: tuple[int, int]


class DocumentChunkInfo(TypedDict):
    """A chunk: a token-budget slice of the document with heading context."""
    block_map: Sequence[DocumentChunkBlockMapItem]
    text: str


class DocumentJson(TypedDict):
    """The preprocessed document as returned by preprocess_policy()."""
    blocks: Sequence[DocumentBlockInfo]
    chunks: Sequence[DocumentChunkInfo]


# Used by entity-normalization stage (not Stage 2); kept for completeness.
PhraseNormalizationResult: TypeAlias = dict  # phrase_id, referents, concepts
