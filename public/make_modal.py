import re

with open("index.html", "r") as f:
    content = f.read()

# 1. Replace onclick in global-upload-btn
content = content.replace("onclick=\"document.getElementById('excel-file').click()\"", "onclick=\"openModal('upload-center-modal')\"")

# 2. Extract the interior of admin-upload-content
start_marker = '<div id="admin-upload-content" style="display:none; padding: 25px; border-top: 1px solid var(--glass-border);">'
start_idx = content.find(start_marker)

if start_idx != -1:
    end_idx = content.find('</div>\n        </div>', start_idx) # End of admin-upload-section
    if end_idx != -1:
        interior_html = content[start_idx + len(start_marker) : end_idx]
        
        # Remove the old section from the pendancy tab
        section_start_marker = "<!-- Merged Upload Center Section (Visible to Admins Only) -->"
        section_start_idx = content.rfind(section_start_marker, 0, start_idx)
        
        new_content = content[:section_start_idx] + content[end_idx + len('</div>\n        </div>'):]
        
        # Create the Modal
        modal_html = f"""
<!-- Upload Center Modal -->
<div id="upload-center-modal" class="modal">
    <div class="modal-content" style="max-width: 900px; background: #ffffff;">
        <span class="close-modal" onclick="closeModal('upload-center-modal')">&times;</span>
        <div style="display:flex; align-items:center; gap:10px; margin-bottom: 20px; border-bottom: 1px solid #e2e8f0; padding-bottom: 15px;">
            <span style="font-size:1.8rem;">📤</span>
            <div>
                <h2 style="margin:0; font-size:1.5rem; color:#1e293b; font-weight: 700;">Upload Engine & Audit</h2>
                <p style="margin:4px 0 0; color:var(--text-muted); font-size:0.95rem;">Manage your master data, reconcile duplicates, and audit history.</p>
            </div>
        </div>
        <div style="padding: 10px 0;">
{interior_html}
        </div>
    </div>
</div>
"""
        # Insert before </body>
        body_close_idx = new_content.rfind("</body>")
        final_content = new_content[:body_close_idx] + modal_html + new_content[body_close_idx:]
        
        with open("index.html", "w") as f:
            f.write(final_content)
        print("Successfully created Upload Center Modal.")
    else:
        print("Could not find end of admin-upload-content.")
else:
    print("Could not find admin-upload-content.")
