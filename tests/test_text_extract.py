from privacy_research_dataset.text_extract import (
    extract_main_text_with_method,
    _readability_extract,
    _pandoc_extract,
)


def test_extracts_main_policy_content():
    html = """
    <html>
      <head><title>Privacy Policy</title></head>
      <body>
        <nav>Home | About | Contact | Sign In</nav>
        <main>
          <h1>Privacy Policy</h1>
          <p>Last updated: January 2024</p>
          <h2>Information We Collect</h2>
          <p>We collect personal information that you provide to us directly,
             such as your name, email address, and phone number.</p>
          <h2>How We Use Your Information</h2>
          <p>We use the information we collect to provide, maintain,
             and improve our services.</p>
        </main>
        <footer>© 2024 Example Corp | Terms | Privacy</footer>
      </body>
    </html>
    """

    text, method = extract_main_text_with_method(
        html, source_url="https://example.com/privacy"
    )

    assert method in ("trafilatura", "readability", "pandoc", "fallback")
    assert text is not None
    assert "Information We Collect" in text
    assert "personal information" in text


def test_returns_none_for_empty_input():
    text, method = extract_main_text_with_method(None)
    assert text is None
    assert method is None


def test_returns_none_for_blank_html():
    text, method = extract_main_text_with_method("")
    assert text is None
    assert method is None


def test_fallback_used_when_trafilatura_yields_nothing(monkeypatch):
    """When trafilatura returns None the readability/bs4 fallback kicks in."""
    import privacy_research_dataset.text_extract as te

    monkeypatch.setattr(te, "trafilatura", None)

    html = "<html><body><p>We collect your name and email for privacy purposes.</p></body></html>"
    text, method = extract_main_text_with_method(html)

    assert method in ("readability", "pandoc", "fallback")
    assert text is not None
    assert "privacy" in text.lower()


def test_readability_extract_returns_main_content():
    html = """
    <html>
      <head><title>Privacy Policy</title></head>
      <body>
        <nav><a href="/">Home</a> | <a href="/about">About</a></nav>
        <article>
          <h1>Privacy Policy</h1>
          <p>We are committed to protecting your personal data and privacy rights.</p>
          <h2>Data We Collect</h2>
          <p>We collect information you provide when you register or use our services.</p>
        </article>
        <footer>© 2024 Corp</footer>
      </body>
    </html>
    """
    text = _readability_extract(html)
    if text is None:
        import pytest
        pytest.skip("readability-lxml not installed")
    assert "privacy" in text.lower() or "personal data" in text.lower()


def test_pandoc_extract_returns_text():
    html = """
    <html>
      <body>
        <h1>Privacy Policy</h1>
        <p>We collect your name and email address to provide our services.</p>
      </body>
    </html>
    """
    text = _pandoc_extract(html)
    if text is None:
        import pytest
        pytest.skip("pypandoc/pandoc not installed")
    assert "Privacy Policy" in text
    assert "email address" in text


def test_chunk_policy_text_passthrough():
    """Short text is returned as a single chunk."""
    from privacy_research_dataset.crawler import _chunk_policy_text

    text = "## Section\n\nSome content here.\n"
    chunks = _chunk_policy_text(text, max_chars=10_000)
    assert chunks == [text]


def test_chunk_policy_text_splits_at_headings():
    """Long text is split at heading boundaries with breadcrumb context."""
    from privacy_research_dataset.crawler import _chunk_policy_text

    # Build a doc longer than 200 chars with two H2 sections
    section_a = "## Section A\n\n" + ("A" * 120) + "\n"
    section_b = "## Section B\n\n" + ("B" * 120) + "\n"
    text = section_a + section_b

    chunks = _chunk_policy_text(text, max_chars=150)
    assert len(chunks) >= 2
    # Second chunk must carry the Section B heading for context
    assert "## Section B" in chunks[-1]
