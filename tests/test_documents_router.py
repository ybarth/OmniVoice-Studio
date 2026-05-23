import io
import zipfile

import pytest


def make_docx(text: str) -> bytes:
    body = ''.join(f'<w:p><w:r><w:t>{part}</w:t></w:r></w:p>' for part in text.split('\n'))
    xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:body>{body}</w:body></w:document>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("[Content_Types].xml", "")
        zf.writestr("word/document.xml", xml)
    return buffer.getvalue()


def test_documents_extract_text_plain_rtf_docx_and_pdf():
    from services.document_extract import extract_document_text

    cases = [
        ("notes.txt", b"Hello text file", "Hello text file"),
        ("notes.md", b"# Title\n\nMarkdown body", "Markdown body"),
        ("notes.rtf", br"{\rtf1\ansi Hello \b bold\b0\par Next line}", "Hello bold\nNext line"),
        ("brief.docx", make_docx("Docx title\nDocx body"), "Docx body"),
        (
            "sample.pdf",
            b"%PDF-1.4\n1 0 obj<<>>stream\nBT (PDF body text) Tj ET\nendstream\nendobj\n%%EOF",
            "PDF body text",
        ),
    ]

    for filename, content, expected in cases:
        kind, text = extract_document_text(filename, content)
        assert kind
        assert expected in text


def test_documents_extract_rejects_unsupported_files():
    from fastapi import HTTPException
    from services.document_extract import extract_document_text

    with pytest.raises(HTTPException) as exc:
        extract_document_text("voice.wav", b"not a document")

    assert exc.value.status_code == 400
    assert "Unsupported document type" in exc.value.detail
