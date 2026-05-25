import json
import os
from fpdf import FPDF

def sanitize(text):
    """Remove non-latin1 characters so fpdf does not crash."""
    if not text:
        return ''
    return str(text).encode('latin-1', errors='replace').decode('latin-1')

class ReportPDF(FPDF):
    def __init__(self, meta):
        super().__init__(orientation='L', format='A4')
        self.meta = meta
        self.set_auto_page_break(auto=True, margin=15)

    def header(self):
        # Metadata row


        # Metadata row
        self.set_font('Arial', '', 10)
        self.set_fill_color(245, 245, 245)
        self.set_text_color(0, 0, 0)
        meta = self.meta
        self.cell(70, 7, f"Sample Code: {meta.get('sampleCode', '')}", border=1, fill=True)
        self.cell(70, 7, f"Nominal Size: {meta.get('size', '')} mm", border=1, fill=True)
        self.cell(70, 7, f"Pipe Class: {meta.get('pipeClass', '')}", border=1, fill=True)
        self.cell(0,  7, f"Type: {meta.get('type', '')}", border=1, ln=1, fill=True)
        self.ln(3)

    def footer(self):
        self.set_y(-12)
        self.set_font('Arial', 'I', 8)
        self.set_text_color(100, 100, 100)
        self.cell(0, 10, f'Page {self.page_no()}', align='C')


def generate_report_pdf(payload_path: str, output_path: str) -> str:
    """
    Reads lims_payload.json and generates a formatted PDF test report.
    Returns the absolute path of the saved PDF.
    """
    with open(payload_path, encoding='utf-8') as f:
        data = json.load(f)

    meta = data.get('metadata', {})
    table_rows = data.get('table_rows', [])

    pdf = ReportPDF(meta)
    pdf.add_page()

    # ---- Column widths (landscape A4 = 297mm, margins ~20mm each side => ~257mm usable) ----
    col_w = [12, 35, 75, 80, 55]
    headers = ['#', 'Clause', 'Parameter', 'Specified Requirement', 'Observed Value']

    # Table header
    pdf.set_font('Arial', 'B', 9)
    pdf.set_fill_color(0, 51, 102)
    pdf.set_text_color(255, 255, 255)
    for i, h in enumerate(headers):
        pdf.cell(col_w[i], 9, h, border=1, align='C', fill=True)
    pdf.ln()

    # Table rows
    pdf.set_font('Arial', '', 8)
    pdf.set_text_color(0, 0, 0)
    row_colors = [(255, 255, 255), (240, 248, 255)]

    for idx, row in enumerate(table_rows):
        if len(row) < 5:
            continue

        obs_val    = str(row[4]).strip() if len(row) > 4 else ''
        clause_val = str(row[1]).strip() if len(row) > 1 else ''
        param_name = str(row[2]).strip() if len(row) > 2 else ''
        spec_val   = str(row[3]).strip() if len(row) > 3 else ''

        r, g, b = row_colors[idx % 2]
        pdf.set_fill_color(r, g, b)

        cells = [
            sanitize(str(idx + 1)),
            sanitize(clause_val),
            sanitize(param_name),
            sanitize(spec_val),
            sanitize(obs_val if obs_val else '(Pending)'),
        ]

        # Calculate max lines any cell in this row will take
        line_height = 6
        max_lines = 1
        for i, (w, text) in enumerate(zip(col_w, cells)):
            text_width = pdf.get_string_width(text)
            lines = max(1, int(text_width / (w - 2)) + 1)
            lines += text.count('\n')
            if lines > max_lines:
                max_lines = lines
                
        row_height = max_lines * line_height

        # Check if we need a page break before drawing the row
        if pdf.get_y() + row_height > pdf.page_break_trigger:
            pdf.add_page()
            
        start_x = pdf.get_x()
        start_y = pdf.get_y()

        for i, (w, text) in enumerate(zip(col_w, cells)):
            x = pdf.get_x()
            y = pdf.get_y()
            # Draw the empty cell with full height border and background
            pdf.rect(x, y, w, row_height, 'DF')
            # Draw the text inside
            pdf.multi_cell(w, line_height, text, border=0, align='L', fill=False)
            # Reset X, Y to next column
            pdf.set_xy(x + w, start_y)

        pdf.ln(row_height)

    pdf.output(output_path)
    return os.path.abspath(output_path)


if __name__ == "__main__":
    payload_path = os.path.join(os.path.dirname(__file__), 'lims_payload.json')
    sample_code = "REPORT"
    try:
        with open(payload_path, encoding='utf-8') as f:
            d = json.load(f)
            sample_code = d.get('metadata', {}).get('sampleCode', 'REPORT')
    except Exception:
        pass

    output = os.path.join(os.path.dirname(__file__), f'Report_{sample_code}.pdf')
    saved = generate_report_pdf(payload_path, output)
    print(f"[SUCCESS] PDF generated successfully: {saved}")
