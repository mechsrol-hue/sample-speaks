#!/usr/bin/env python3
"""
Render specific pages of a PDF at high DPI.
Phase 2 of the IS extraction pipeline uses this to get
crisp renders for the Gemini + Qwen vision readers.

Usage:
  python3 render_pages.py <pdf_path> <page_nums_csv> [dpi]
  page_nums_csv: comma-separated, 1-indexed (e.g. "5,6,7")
  dpi: default 300 (use 200 for faster preview, 400 for maximum clarity)

Output: JSON { success, pages: [{ page, image_base64, width, height, dpi }] }
"""
import sys
import os
import json
import base64
import io

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"


def render_pages(pdf_path, page_numbers, dpi=300):
    import pdfplumber
    results = []
    with pdfplumber.open(pdf_path) as pdf:
        total = len(pdf.pages)
        for page_num in page_numbers:
            if page_num < 1 or page_num > total:
                results.append({
                    'page': page_num,
                    'error': f'Page {page_num} out of range (PDF has {total} pages)',
                    'image_base64': None,
                })
                continue
            page = pdf.pages[page_num - 1]
            try:
                img = page.to_image(resolution=dpi)
                buf = io.BytesIO()
                img.save(buf, format='PNG')
                b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
                results.append({
                    'page': page_num,
                    'image_base64': b64,
                    'width': round(page.width),
                    'height': round(page.height),
                    'dpi': dpi,
                })
                sys.stderr.write(f"Rendered page {page_num} at {dpi} DPI ({len(b64)//1024}KB)\n")
            except Exception as e:
                results.append({
                    'page': page_num,
                    'error': str(e),
                    'image_base64': None,
                })
    return results


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({'success': False, 'error': 'Usage: render_pages.py <pdf> <pages_csv> [dpi]'}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    raw_pages = sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 300

    if not os.path.exists(pdf_path):
        print(json.dumps({'success': False, 'error': f'File not found: {pdf_path}'}))
        sys.exit(1)

    pages = [int(p.strip()) for p in raw_pages.split(',') if p.strip().isdigit()]
    if not pages:
        print(json.dumps({'success': False, 'error': 'No valid page numbers provided'}))
        sys.exit(1)

    rendered = render_pages(pdf_path, pages, dpi)
    print(json.dumps({'success': True, 'pages': rendered}))
