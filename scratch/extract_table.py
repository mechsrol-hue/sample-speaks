import pdfplumber
import sys

pdf_path = "Testing Charges/Testing charges BIS 09.2.2026/From IS 2797 to IS 4990 9.2.2026.pdf"

try:
    with pdfplumber.open(pdf_path) as pdf:
        found_pages = []
        # Search for IS 4985 in the first 100 pages as a quick heuristic
        for i, page in enumerate(pdf.pages):
            text = page.extract_text()
            if text and "IS 4985" in text:
                found_pages.append(i)
        
        print(f"Found 'IS 4985' on pages: {found_pages}")
        
        if not found_pages:
            sys.exit(0)
            
        # Extract table from the first matching page
        first_page = pdf.pages[found_pages[0]]
        tables = first_page.extract_tables()
        print(f"Number of tables found on page {found_pages[0]}: {len(tables)}")
        
        if tables:
            for row in tables[0][:10]: # Print first 10 rows
                print(row)
except Exception as e:
    print(f"Error: {e}")
