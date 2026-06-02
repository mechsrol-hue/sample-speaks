import fitz # PyMuPDF
import sys
doc = fitz.open("Testing Charges/Testing charges BIS 09.2.2026/From IS 2797 to IS 4990 9.2.2026.pdf")
found = False
for i in range(len(doc)):
    text = doc[i].get_text("text")
    if "IS 4985" in text:
        print(f"--- PAGE {i} ---")
        print(text[:1000]) # just print the top part to see structure
        found = True
        break
if not found:
    print("IS 4985 not found in this doc.")
