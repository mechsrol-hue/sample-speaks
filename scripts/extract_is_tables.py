#!/usr/bin/env python3
"""
Smart IS standard extractor.
Pass 1: pdfplumber extracts text from all pages (free, instant).
Pass 2: Detects image-based table pages (text-sparse but content-heavy).
Pass 3: Renders ONLY those pages to base64 PNG for vision LLM.
No OCR on tables — vision reads them directly.
"""
import sys
import os
import json
import base64
import re

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

TABLE_KEYWORDS = re.compile(
    r'table\s*\d|dimensions|thickness|tolerance|specification|requirements|'
    r'sampling|properties|sl\s*\.?\s*no|nominal|diameter|class\s*\d',
    re.IGNORECASE
)


def classify_page(page_num, text, page_obj):
    """Classify a page: 'text', 'text_table', 'image_table' (needs vision), or 'skip'."""
    text_stripped = (text or "").strip()
    text_len = len(text_stripped)
    has_table_hint = bool(TABLE_KEYWORDS.search(text_stripped))

    # pdfplumber got a real text-based table with 3+ rows
    raw_tables = page_obj.extract_tables()
    real_tables = [t for t in (raw_tables or []) if t and len(t) >= 3]
    if real_tables:
        return 'text_table'

    # Detect rotated/garbled text: lots of characters but very few words per line
    # e.g. "sepiP" "dezicitsalpnU" — reversed text from 90° rotation
    lines = [l for l in text_stripped.split('\n') if len(l.strip()) > 2]
    words = [w for w in text_stripped.split() if len(w) > 2]
    avg_words_per_line = len(words) / max(len(lines), 1)
    has_reversed = any(
        w[::-1].lower() in ('table', 'pipes', 'dimensions', 'diameter', 'thickness', 'class', 'nominal')
        for w in words[:50]
    )

    # Rotated table page: many single-word lines or reversed words
    if (avg_words_per_line < 3.0 and len(lines) > 20) or has_reversed:
        return 'image_table'

    # Page has table keywords but pdfplumber couldn't extract the table
    if has_table_hint and text_len < 500:
        return 'image_table'

    # Nearly empty page
    if text_len < 50 and page_num > 1:
        return 'skip'

    return 'text'


def render_page_to_base64(page_obj, resolution=200):
    """Render a pdfplumber page to base64 PNG."""
    img = page_obj.to_image(resolution=resolution)
    import io
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode('utf-8')


def extract_full(file_path):
    ext = os.path.splitext(file_path)[1].lower()

    if ext in {'.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp'}:
        with open(file_path, 'rb') as f:
            img_b64 = base64.b64encode(f.read()).decode('utf-8')
        return {
            "text": "",
            "pages": [],
            "tables": [],
            "image_table_pages": [{"page": 1, "image_base64": img_b64}],
            "method": "image_direct",
            "page_count": 1
        }

    import pdfplumber

    all_page_texts = []
    text_tables = []
    pages_data = []
    image_table_pages = []

    with pdfplumber.open(file_path) as pdf:
        for i, page in enumerate(pdf.pages):
            page_num = i + 1
            text = page.extract_text(layout=True)
            if not text:
                text = page.extract_text()

            page_type = classify_page(page_num, text, page)

            pages_data.append({
                "page": page_num,
                "text": text or "",
                "type": page_type
            })
            if text:
                all_page_texts.append(text)

            if page_type == 'text_table':
                raw_tables = page.extract_tables()
                for table_idx, table in enumerate(raw_tables or []):
                    if not table:
                        continue
                    cleaned = [
                        [str(cell).strip() if cell is not None else "" for cell in row]
                        for row in table
                        if any(c is not None and str(c).strip() for c in row)
                    ]
                    if len(cleaned) < 2:
                        continue
                    text_tables.append({
                        "page": page_num,
                        "table_index": table_idx,
                        "headers": cleaned[0],
                        "rows": cleaned[1:],
                        "row_count": len(cleaned) - 1,
                        "col_count": len(cleaned[0])
                    })

            elif page_type == 'image_table':
                try:
                    img_b64 = render_page_to_base64(page, resolution=250)
                    image_table_pages.append({
                        "page": page_num,
                        "image_base64": img_b64,
                        "hint": text or ""
                    })
                except Exception as e:
                    sys.stderr.write(f"Could not render page {page_num}: {e}\n")

    page_type_summary = {}
    for p in pages_data:
        t = p["type"]
        page_type_summary[t] = page_type_summary.get(t, 0) + 1

    return {
        "success": True,
        "text": "\n\n".join(all_page_texts),
        "pages": [{"page": p["page"], "text": p["text"]} for p in pages_data],
        "tables": text_tables,
        "image_table_pages": image_table_pages,
        "page_types": page_type_summary,
        "method": "smart_extract",
        "page_count": len(pages_data)
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No file path provided"}))
        sys.exit(1)

    try:
        result = extract_full(sys.argv[1])
        # Don't dump image_base64 to stdout by default — too large
        # Instead, save images to temp files and return paths
        image_pages_info = []
        for itp in result.get("image_table_pages", []):
            img_data = base64.b64decode(itp["image_base64"])
            img_path = os.path.join(
                os.path.dirname(sys.argv[1]) or '.',
                f"_table_page_{itp['page']}.png"
            )
            with open(img_path, 'wb') as f:
                f.write(img_data)
            image_pages_info.append({
                "page": itp["page"],
                "image_path": img_path,
                "hint": itp.get("hint", "")
            })

        output = {
            "success": True,
            "text": result["text"],
            "pages": result["pages"],
            "tables": result["tables"],
            "image_table_pages": image_pages_info,
            "page_types": result.get("page_types", {}),
            "method": result["method"],
            "page_count": result["page_count"]
        }
        print(json.dumps(output))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
