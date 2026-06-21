#!/usr/bin/env python3
import sys
import os
import json

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp'}

def extract_with_pdfplumber(pdf_path):
    import pdfplumber
    extracted_text = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text(layout=True)
            if not text:
                text = page.extract_text()
            if text:
                extracted_text.append(text)
    return extracted_text

def extract_with_ocr(file_path):
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(lang='en')
    result = ocr.predict(file_path)
    texts = []
    for item in result:
        if hasattr(item, 'rec_texts'):
            texts.extend(item.rec_texts)
        elif isinstance(item, dict) and 'rec_texts' in item:
            texts.extend(item['rec_texts'])
    return texts

def extract_text(file_path):
    ext = os.path.splitext(file_path)[1].lower()

    try:
        if ext in IMAGE_EXTS:
            lines = extract_with_ocr(file_path)
            if not lines:
                print(json.dumps({"success": False, "error": "OCR could not extract text from image."}))
                sys.exit(1)
            full_text = "\n".join(lines)
            print(json.dumps({"success": True, "text": full_text, "method": "paddleocr"}))
            return

        extracted_text = extract_with_pdfplumber(file_path)

        if not extracted_text:
            lines = extract_with_ocr(file_path)
            if lines:
                full_text = "\n".join(lines)
                print(json.dumps({"success": True, "text": full_text, "method": "paddleocr_fallback"}))
                return
            print(json.dumps({"success": False, "error": "No text found. PDF may be image-only and OCR also failed."}))
            sys.exit(1)

        full_text = "\n\n".join(extracted_text)
        print(json.dumps({"success": True, "text": full_text, "method": "pdfplumber"}))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No file path provided"}))
        sys.exit(1)
    extract_text(sys.argv[1])
