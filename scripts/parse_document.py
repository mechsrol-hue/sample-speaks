#!/usr/bin/env python3
"""
Hybrid document parser for calibration certificates and IS standards.
Pipeline: OCR/pdfplumber → regex extraction → structured JSON output.
Local only — no cloud, no data leaves the machine.
"""
import sys
import os
import json
import re

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp'}


def extract_text(file_path):
    ext = os.path.splitext(file_path)[1].lower()
    if ext in IMAGE_EXTS:
        from paddleocr import PaddleOCR
        ocr = PaddleOCR(lang='en')
        result = ocr.predict(file_path)
        texts = []
        for item in result:
            if hasattr(item, 'rec_texts'):
                texts.extend(item.rec_texts)
            elif isinstance(item, dict) and 'rec_texts' in item:
                texts.extend(item['rec_texts'])
        return "\n".join(texts), "paddleocr"
    else:
        import pdfplumber
        pages = []
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text(layout=True)
                if not text:
                    text = page.extract_text()
                if text:
                    pages.append(text)
        if pages:
            return "\n\n".join(pages), "pdfplumber"
        from paddleocr import PaddleOCR
        ocr = PaddleOCR(lang='en')
        result = ocr.predict(file_path)
        texts = []
        for item in result:
            if hasattr(item, 'rec_texts'):
                texts.extend(item.rec_texts)
            elif isinstance(item, dict) and 'rec_texts' in item:
                texts.extend(item['rec_texts'])
        if texts:
            return "\n".join(texts), "paddleocr_fallback"
        return "", "none"


# ── Calibration Certificate Regex Patterns ──

DATE_PATTERN = r'(\d{1,2}[\s./-]\s*\d{1,2}[\s./-]\s*\d{2,4}|\d{1,2}\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s.,]*\d{2,4})'

CALIB_PATTERNS = {
    'certificate_number': [
        r'(?:Certificate|Cert|Cal\.?\s*Cert)[\s.:]*(?:No|Number|#)[\s.:]*([A-Z0-9/\-_.]+)',
        r'(?:ULR|ULR\s*No|Report\s*No)[\s.:]*([A-Z0-9/\-_.]+)',
        r'(?:Calibration\s*Certificate)[\s.:]*(?:No)?[\s.:]*([A-Z0-9/\-_.]+)',
    ],
    'date_of_calibration': [
        r'(?:Date\s*of\s*Calibration|Calibration\s*Date|Cal\.?\s*Date|Date\s*of\s*Cal)[\s.:]*' + DATE_PATTERN,
        r'(?:Calibrated\s*on)[\s.:]*' + DATE_PATTERN,
    ],
    'date_next_due': [
        r'(?:Due\s*Date|Next\s*Due|Valid\s*(?:Till|Until|Upto)|Next\s*Calibration\s*Due|Validity|Cal\.?\s*Due)[\s.:]*' + DATE_PATTERN,
        r'(?:Re[\s-]*calibration\s*(?:Due|Date))[\s.:]*' + DATE_PATTERN,
    ],
    'equipment_name': [
        r'(?:Name\s*of\s*(?:the\s*)?(?:Instrument|Equipment|Item|UUC)|Description\s*of\s*(?:Item|Equipment)|Instrument\s*(?:Name|Description)|UUC|Under\s*Calibration)[\s.:]*([^\n\r]{3,80})',
    ],
    'equipment_id': [
        r'(?:Identification\s*(?:No|Number)|ID[\s]*(?:No|Number)?|Sr\.?\s*No|Serial\s*(?:No|Number)|Asset\s*(?:No|ID|Code))[\s.:]*([A-Z0-9/\-_.]+)',
        r'(?:Lab\s*Code|Equipment\s*(?:No|Code|ID))[\s.:]*([A-Z0-9/\-_.]+)',
    ],
    'make': [
        r'(?:Make|Manufacturer|Brand)[\s.:]*([^\n\r]{2,60})',
    ],
    'model': [
        r'(?:Model(?:\s*No)?|Type)[\s.:]*([^\n\r]{2,60})',
    ],
    'range': [
        r'(?:Range|Measuring\s*Range|Capacity)[\s.:]*([^\n\r]{2,80})',
    ],
    'least_count': [
        r'(?:Least\s*Count|Resolution|LC|Graduation)[\s.:]*([^\n\r]{2,60})',
    ],
    'calibration_agency': [
        r'(?:Laboratory|Lab|Calibrated\s*(?:by|at)|Agency|NABL\s*(?:Lab|Accredited))[\s.:]*([^\n\r]{3,100})',
        r'(?:Name\s*of\s*(?:the\s*)?(?:Lab|Laboratory))[\s.:]*([^\n\r]{3,100})',
    ],
    'nabl_certificate': [
        r'(?:NABL|Accreditation)[\s.:]*(?:Certificate|Cert)?[\s.:]*(?:No|Number)?[\s.:]*([A-Z0-9/\-_.]+)',
    ],
    'reference_standard': [
        r'(?:Reference\s*Standard|Master\s*(?:Used|Instrument)|Std\.?\s*Used|Traceability)[\s.:]*([^\n\r]{3,120})',
    ],
    'temperature': [
        r'(?:Temperature|Temp|Ambient\s*Temp)[\s.:]*(\d+[\s.]*[°±]?\s*\d*\s*°?\s*C)',
    ],
    'humidity': [
        r'(?:Humidity|RH|R\.H\.|Relative\s*Humidity)[\s.:]*(\d+[\s.]*[%±]?\s*\d*\s*%?)',
    ],
}


def parse_calibration_cert(text):
    result = {}
    confidence = {}

    for field, patterns in CALIB_PATTERNS.items():
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                value = match.group(1).strip().rstrip(':').strip()
                if len(value) > 1:
                    result[field] = value
                    confidence[field] = 1.0
                    break
        if field not in result:
            result[field] = ""
            confidence[field] = 0.0

    return result, confidence


# ── IS Standard Regex Patterns ──

IS_NUMBER_PATTERNS = [
    r'IS\s*[:\s]*(\d{3,5})\s*(?:[:(]\s*(?:Part\s*\d+\s*[:/]?\s*(?:Sec(?:tion)?\s*\d+)?)?\s*[):]?\s*)?(?:\d{4})?',
    r'Indian\s*Standard\s*.*?IS\s*(\d{3,5})',
]

def parse_is_standard(text):
    result = {
        'is_number': '',
        'title': '',
        'test_parameters': [],
        'tables': [],
    }
    confidence = {}

    for pattern in IS_NUMBER_PATTERNS:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            full = match.group(0).strip()
            result['is_number'] = full
            confidence['is_number'] = 1.0
            break
    if not result['is_number']:
        confidence['is_number'] = 0.0

    title_match = re.search(
        r'(?:Indian\s+Standard)\s*\n+\s*(.+?)(?:\n|$)',
        text, re.IGNORECASE
    )
    if title_match:
        result['title'] = title_match.group(1).strip()
        confidence['title'] = 0.9

    clause_pattern = r'(\d+(?:\.\d+)*)\s+([A-Z][^\n]{5,120})'
    clauses = re.findall(clause_pattern, text)

    spec_patterns = [
        r'(?:shall\s+(?:not\s+)?(?:be|exceed|have))\s+(?:(?:less|more|greater)\s+than\s+)?(\d+[\d.]*)\s*(%|mm|°C|MPa|kg|g|N|kN|m|cm|μm)',
        r'(?:minimum|min|max|maximum)[\s.:]*(\d+[\d.]*)\s*(%|mm|°C|MPa|kg|g|N|kN|m|cm|μm)',
        r'(\d+[\d.]*)\s*(?:to|–|-)\s*(\d+[\d.]*)\s*(%|mm|°C|MPa|kg|g|N|kN|m|cm|μm)',
    ]

    params = []
    for clause_num, clause_text in clauses:
        for sp in spec_patterns:
            spec_match = re.search(sp, clause_text, re.IGNORECASE)
            if spec_match:
                groups = spec_match.groups()
                param = {
                    'clause': clause_num,
                    'param': clause_text.strip()[:100],
                    'spec_val': spec_match.group(0).strip(),
                    'type': 'Quantitative' if any(g and g.replace('.', '').isdigit() for g in groups) else 'Qualitative',
                    'expected': '',
                    'min': '',
                    'max': '',
                }
                if 'minimum' in clause_text.lower() or 'min' in clause_text.lower():
                    param['min'] = groups[0]
                elif 'maximum' in clause_text.lower() or 'max' in clause_text.lower():
                    param['max'] = groups[0]
                elif len(groups) >= 3 and groups[1]:
                    param['min'] = groups[0]
                    param['max'] = groups[1]

                params.append(param)
                break

    for clause_num, clause_text in clauses:
        already = any(p['clause'] == clause_num for p in params)
        if not already:
            qual_keywords = ['satisfactory', 'shall be', 'conform', 'free from', 'clean', 'smooth', 'colour', 'color', 'marking', 'visual']
            is_qual = any(kw in clause_text.lower() for kw in qual_keywords)
            if is_qual:
                params.append({
                    'clause': clause_num,
                    'param': clause_text.strip()[:100],
                    'spec_val': f'As in Cl {clause_num}',
                    'type': 'Qualitative',
                    'expected': 'Satisfactory',
                    'min': '',
                    'max': '',
                })

    result['test_parameters'] = params
    confidence['test_parameters'] = 0.6 if params else 0.0

    return result, confidence


def detect_document_type(text):
    text_lower = text.lower()
    calib_keywords = ['calibration certificate', 'certificate of calibration', 'nabl', 'uuc',
                      'date of calibration', 'calibrated on', 'next due', 'reference standard',
                      'traceability', 'measurement result', 'uncertainty']
    is_keywords = ['indian standard', 'bureau of indian standards', 'bis', 'is ',
                   'scope', 'clause', 'table ', 'shall be', 'shall not', 'conforming to']

    calib_score = sum(1 for kw in calib_keywords if kw in text_lower)
    is_score = sum(1 for kw in is_keywords if kw in text_lower)

    if calib_score > is_score and calib_score >= 2:
        return 'calibration_certificate'
    elif is_score > calib_score and is_score >= 2:
        return 'is_standard'
    elif calib_score > 0:
        return 'calibration_certificate'
    elif is_score > 0:
        return 'is_standard'
    return 'unknown'


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No file path provided"}))
        sys.exit(1)

    file_path = sys.argv[1]
    doc_type_override = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        text, method = extract_text(file_path)
        if not text:
            print(json.dumps({"success": False, "error": "Could not extract text from document"}))
            sys.exit(1)

        doc_type = doc_type_override or detect_document_type(text)

        if doc_type == 'calibration_certificate':
            parsed, confidence = parse_calibration_cert(text)
            print(json.dumps({
                "success": True,
                "doc_type": "calibration_certificate",
                "extraction_method": method,
                "parsed": parsed,
                "confidence": confidence,
                "raw_text": text[:5000],
                "needs_llm": any(v == 0.0 for v in confidence.values()),
            }))
        elif doc_type == 'is_standard':
            parsed, confidence = parse_is_standard(text)
            print(json.dumps({
                "success": True,
                "doc_type": "is_standard",
                "extraction_method": method,
                "parsed": parsed,
                "confidence": confidence,
                "raw_text": text[:5000],
                "needs_llm": confidence.get('test_parameters', 0) < 0.8,
            }))
        else:
            print(json.dumps({
                "success": True,
                "doc_type": "unknown",
                "extraction_method": method,
                "parsed": {},
                "confidence": {},
                "raw_text": text[:5000],
                "needs_llm": True,
            }))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
