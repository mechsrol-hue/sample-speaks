import re

with open("index.html", "r") as f:
    lines = f.readlines()

start_idx = -1
end_idx = -1
for i, line in enumerate(lines):
    if "<!-- Merged Upload Center Section (Visible to Admins Only) -->" in line:
        start_idx = i
    if "<!-- End tab-dashboard -->" in line:
        # admin-upload-section ends a few lines before this
        end_idx = i - 3 # Because 564 is the closing div, 565 empty, 566 div, 567 end tab-dashboard
        break

if start_idx != -1 and end_idx != -1:
    section = lines[start_idx:end_idx+1]
    del lines[start_idx:end_idx+1]
    
    insert_idx = -1
    for i, line in enumerate(lines):
        if '<div id="tab-pendancy" class="tab-content active">' in line:
            insert_idx = i + 1
            break
            
    if insert_idx != -1:
        lines = lines[:insert_idx] + section + lines[insert_idx:]
        with open("index.html", "w") as f:
            f.writelines(lines)
        print("Success! Moved section.")
    else:
        print("Could not find tab-pendancy")
else:
    print("Could not find bounds", start_idx, end_idx)
