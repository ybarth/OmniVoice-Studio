from fastapi import APIRouter, File, HTTPException, UploadFile

from services.document_extract import MAX_DOCUMENT_BYTES, extract_document_text

router = APIRouter(prefix="/documents", tags=["Documents"])


@router.post("/extract")
async def extract_document(file: UploadFile = File(...)):
    filename = file.filename or "document"
    data = await file.read()
    if len(data) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="Document is too large. Upload a file under 25 MB.")
    kind, text = extract_document_text(filename, data)
    return {
        "filename": filename,
        "kind": kind,
        "text": text,
        "char_count": len(text),
    }
