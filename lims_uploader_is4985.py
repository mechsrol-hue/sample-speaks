import sys
import os
import io
import time
import json
import argparse
from generate_report_pdf import generate_report_pdf
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.action_chains import ActionChains
from selenium.common.exceptions import TimeoutException, NoSuchElementException, StaleElementReferenceException

# Force UTF-8 stdout to avoid Windows cp1252 crash
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import pyautogui
pyautogui.FAILSAFE = False

def prevent_screen_off():
    try:
        pyautogui.move(100, 0)
        time.sleep(0.5)
        pyautogui.move(-100, 0)
        time.sleep(0.25)
    except Exception as e:
        pass

def log(level, msg):
    print(f"[{level}] {msg}", flush=True)

def wait_el(driver, by, val, timeout=15, cond="presence"):
    try:
        if cond == "click":
            return WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((by, val)))
        if cond == "visible":
            return WebDriverWait(driver, timeout).until(EC.visibility_of_element_located((by, val)))
        return WebDriverWait(driver, timeout).until(EC.presence_of_element_located((by, val)))
    except TimeoutException:
        return None


def safe_click(driver, el, desc=""):
    try:
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
        time.sleep(0.3)
        el.click()
        log("INFO", f"Clicked: {desc}")
        return True
    except Exception:
        try:
            driver.execute_script("arguments[0].click();", el)
            log("INFO", f"JS-clicked: {desc}")
            return True
        except Exception as e:
            log("WARN", f"Could not click {desc}: {e}")
            return False


def fill_field(driver, el, value):
    """Reliably fill a field: clear, send_keys, fallback to JS."""
    try:
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
        el.clear()
        el.send_keys(str(value))
        return True
    except Exception:
        try:
            driver.execute_script("""
                var n = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
                n.call(arguments[0], arguments[1]);
                arguments[0].dispatchEvent(new Event('input',{bubbles:true}));
                arguments[0].dispatchEvent(new Event('change',{bubbles:true}));
            """, el, str(value))
            return True
        except Exception as e:
            log("WARN", f"fill_field failed: {e}")
            return False


def get_all_fillable_inputs(driver):
    """
    Get all visible, enabled, non-hidden input/textarea fields on the current page
    in their DOM order — same top-to-bottom order as the LIMS parameter rows.
    Excludes: search boxes, hidden, readonly, checkboxes, radios, file, submit, button.
    """
    script = """
        var inputs = Array.from(document.querySelectorAll(
            'input:not([type=hidden]):not([type=checkbox]):not([type=radio])' +
            ':not([type=file]):not([type=submit]):not([type=button])' +
            ':not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])'
        ));
        // Filter to visible only, and exclude any obvious search boxes
        return inputs.filter(function(el) {
            var rect = el.getBoundingClientRect();
            var isVisible = (rect.width > 0 && rect.height > 0 &&
                             window.getComputedStyle(el).display !== 'none' &&
                             window.getComputedStyle(el).visibility !== 'hidden');
            
            var isSearch = (el.type === 'search') || 
                           (el.placeholder && el.placeholder.toLowerCase().includes('search')) ||
                           (el.id && el.id.toLowerCase().includes('search')) ||
                           (el.className && typeof el.className === 'string' && el.className.toLowerCase().includes('search'));
                           
            return isVisible && !isSearch;
        });
    """
    return driver.execute_script(script)


def determine_unit(param_name, spec_val):
    spec_val_str = str(spec_val).lower()
    param_lower = str(param_name).lower()
    if "mm" in spec_val_str or "mm" in param_lower:
        return "mm"
    if "°c" in spec_val_str or "degree" in spec_val_str:
        return "°C"
    if "%" in spec_val_str or "percent" in spec_val_str:
        return "%"
    if "density" in param_lower:
        return "g/cc"
    return ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True, help="Path to the JSON payload file")
    parser.add_argument("--mode", choices=["auto", "single", "row_by_row"], default="auto", help="Upload mode")
    parser.add_argument("--preview", action="store_true", help="Generate PDF, open it for preview, and exit without uploading.")
    args = parser.parse_args()

    # 1. Load payload
    if args.payload == '-':
        data = json.load(sys.stdin)
    else:
        if not os.path.exists(args.payload):
            log("ERROR", f"Payload file not found: {args.payload}")
            sys.exit(1)
        with open(args.payload, encoding="utf-8") as f:
            data = json.load(f)

    lims_user   = data.get("lims_user", "").strip()
    lims_pass   = data.get("lims_pass", "").strip()
    meta        = data.get("metadata", {})
    table_rows  = data.get("table_rows", [])
    sample_code = meta.get("sampleCode", "").strip()
    pipe_size   = meta.get("size", "")
    pipe_class  = meta.get("pipeClass", "")

    log("INFO", f"Sample: {sample_code} | Size: {pipe_size}mm | Class: {pipe_class}")
    log("INFO", f"Total parameters queued: {len(table_rows)}")

    # Determine mode
    upload_mode = args.mode
    is_no = str(meta.get("isNo", "")).lower()
    if upload_mode == "auto":
        if "4985" in is_no:
            upload_mode = "single"
            log("INFO", "Auto-detected IS 4985: Running in Single-PDF Mode (will exit after uploading PDF to first pending clause)")
        else:
            upload_mode = "row_by_row"
            log("INFO", "Auto-detected non-IS 4985 standard: Running in Row-by-Row Mode")
    else:
        log("INFO", f"Using user-specified mode: {upload_mode}")

    if upload_mode == "single" and not args.preview:
        missing_values = []
        for row in table_rows:
            if len(row) > 4:
                obs = str(row[4]).strip()
                param_name = str(row[2]).strip()
                # Skip validation for purely descriptive rows (no parameter name)
                if param_name and not obs:
                    missing_values.append(param_name)
        if missing_values:
            log("WARN", f"Validation Warning: Missing values in payload for parameters: {missing_values}. Proceeding anyway...")
            # sys.exit(1)

    # Build ordered list of (observed_value, is_qualitative) to fill in sequence
    fill_queue = []
    for row in table_rows:
        if len(row) < 5:
            continue
        obs = str(row[4]).strip()
        qual = str(row[5]).strip().lower() if len(row) > 5 else "qualitative"
        fill_queue.append((obs, "qualitative" in qual))

    if not lims_user or not lims_pass:
        log("ERROR", "LIMS credentials missing in payload.")
        sys.exit(1)

    # Generate PDF Report from payload
    pdf_path = None
    try:
        pdf_output = os.path.join(os.path.dirname(os.path.abspath(args.payload)), f'Report_{sample_code}.pdf')
        pdf_path = generate_report_pdf(args.payload, pdf_output)
        log("SUCCESS", f"PDF report generated: {pdf_path}")
    except Exception as e:
        log("WARN", f"PDF generation failed: {e}. Will skip PDF upload for first clause.")
        pdf_path = None

    if args.preview and pdf_path:
        log("SUCCESS", "Preview PDF generated successfully. Exiting without uploading.")
        sys.exit(0)

    # 2. Launch Chrome (Robust fallback chain)
    log("INFO", "Launching Chrome...")
    driver = None
    try:
        from selenium.webdriver.chrome.options import Options as ChromeOptions
        opts = ChromeOptions()
        opts.add_experimental_option("detach", True)
        opts.add_experimental_option("excludeSwitches", ["enable-logging"])
        driver = webdriver.Chrome(options=opts)
        driver.maximize_window()
        log("SUCCESS", "Launched Google Chrome successfully!")
    except Exception as e:
        log("WARN", f"Chrome with options failed: {e}. Trying simple Chrome without options...")
        try:
            driver = webdriver.Chrome()
            driver.maximize_window()
            log("SUCCESS", "Launched simple Chrome successfully!")
        except Exception as e2:
            log("ERROR", f"Chrome also failed: {e2}. Trying Edge as fallback...")
            try:
                driver = webdriver.Edge()
                driver.maximize_window()
                log("SUCCESS", "Launched Microsoft Edge successfully!")
            except Exception as e3:
                log("ERROR", f"Edge also failed: {e3}")
                sys.exit(1)

    # 3. Navigate to login
    driver.get("https://lims.bis.gov.in/accounts/login/?next=/dashboard/")
    time.sleep(2)

    # 4. Fill username & password — try multiple strategies
    log("INFO", "Filling login credentials...")
    username_el = None
    for xp in ["//input[@name='username']",
                "//label[contains(.,'User Name')]/following-sibling::input",
                "//input[@type='text'][contains(@class,'form-control')]"]:
        username_el = wait_el(driver, By.XPATH, xp, timeout=5, cond="visible")
        if username_el:
            break

    password_el = None
    for xp in ["//input[@name='password']",
                "//input[@type='password']"]:
        password_el = wait_el(driver, By.XPATH, xp, timeout=3, cond="visible")
        if password_el:
            break

    if username_el and password_el:
        filled_creds = False
        try:
            ActionChains(driver).click(username_el).send_keys(lims_user).perform()
            time.sleep(0.2)
            ActionChains(driver).click(password_el).send_keys(lims_pass).perform()
            filled_creds = True
            log("INFO", f"Credentials filled for: {lims_user}")
        except Exception:
            pass

        if not filled_creds:
            try:
                username_el.clear()
                username_el.send_keys(lims_user)
                password_el.clear()
                password_el.send_keys(lims_pass)
                filled_creds = True
                log("INFO", f"Credentials filled (send_keys) for: {lims_user}")
            except Exception as e:
                log("WARN", f"Credential fill failed: {e} — fill manually")
    else:
        log("WARN", "Login fields not found — please fill manually")

    # 5. Click captcha field so cursor is ready
    time.sleep(0.4)
    try:
        cap = driver.find_element(By.ID, "id_captcha_1")
        cap.click()
        log("AUTOMATION_WAITING_FOR_CAPTCHA", "Captcha focused — type captcha and click LOGIN")
    except Exception:
        log("AUTOMATION_WAITING_FOR_LOGIN", "Please type captcha and click LOGIN")

    # 6. Wait for login redirect (checks every 1.5s, no fixed delay)
    log("INFO", "Watching for login redirect...")
    ok_paths = ["/dashboard/", "/to_dos/", "/lab_details/", "/admin/", "/home/"]
    logged_in = False
    deadline  = time.time() + 300

    while time.time() < deadline:
        pyautogui.moveRel(1, 0, duration=0.05)
        pyautogui.moveRel(-1, 0, duration=0.05)
        try:
            cur = driver.current_url
            if any(p in cur for p in ok_paths) and "login" not in cur:
                log("SUCCESS", f"Logged in! URL: {cur}")
                logged_in = True
                break
        except Exception:
            pass
        time.sleep(1.5)

    if not logged_in:
        log("ERROR", "Login timed out")
        driver.quit()
        sys.exit(1)

    time.sleep(2)

    # 7. Navigate to Pending Samples directly using exact URL
    log("INFO", "Navigating directly to Pending Samples...")
    try:
        base_url = driver.current_url.split("/", 3)[0] + "//" + driver.current_url.split("/", 3)[2]
        driver.get(base_url + "/sample/ta_sample_pending_list")
        time.sleep(3)
        log("SUCCESS", "Navigated to Pending Samples list.")
    except Exception as e:
        log("WARN", f"Direct navigation failed: {e}. Please navigate manually.")
        time.sleep(8)

    # 8. Filter by Sample Code (using exact LIMS custom filter mechanism)
    log("INFO", f"Opening filter panel for sample: {sample_code}")
    
    try:
        # 1. Click main Filter button
        filter_btn = None
        for xp in [
            "//button[@class='btn btn-filter ml-3']",
            "//button[contains(@class,'btn-filter')]",
            "//button[contains(.,'Filter')]"
        ]:
            filter_btn = wait_el(driver, By.XPATH, xp, timeout=10, cond="click")
            if filter_btn:
                log("INFO", f"Found Filter button using: {xp}")
                break
                
        if filter_btn:
            safe_click(driver, filter_btn, "Filter Dropdown Button")
            time.sleep(1.5)
        else:
            log("WARN", "Could not find Filter dropdown button.")

        # 2. Type Sample Code
        log("INFO", "Typing sample code...")
        s_input = None
        for xp in [
            "//input[@id='id_samplepart__encoded_sample_code__icontains']",
            "//input[contains(@id,'sample_code')]",
            "//input[contains(@name,'sample_code')]"
        ]:
            s_input = wait_el(driver, By.XPATH, xp, timeout=5, cond="visible")
            if s_input:
                log("INFO", f"Found sample code input box using: {xp}")
                break
                
        if s_input:
            s_input.clear()
            s_input.send_keys(sample_code)
            time.sleep(0.5)
        else:
            log("WARN", "Sample code input box not found in filter panel.")

        # 3. Click Apply Filter
        log("INFO", "Clicking Apply Filter button...")
        apply_btn = None
        for xp in [
            "//button[@class='btn btn-primary filterprimary']",
            "//button[contains(@class,'filterprimary')]",
            "//button[contains(.,'Apply')]"
        ]:
            apply_btn = wait_el(driver, By.XPATH, xp, timeout=5, cond="click")
            if apply_btn:
                log("INFO", f"Found Apply Filter button using: {xp}")
                break
                
        if apply_btn:
            safe_click(driver, apply_btn, "Apply Filter")
            log("SUCCESS", "Apply Filter clicked. Waiting 20 seconds for table to reload...")
            time.sleep(20)
        else:
            log("WARN", "Apply Filter button not found.")
            
    except Exception as e:
        log("WARN", f"Error during filtering: {e}. Please filter manually.")
        time.sleep(10)

    # 9. Click "Generate" on the sample row
    log("INFO", "Looking for 'Generate' button on the sample row...")
    generate_clicked = False
    
    # Wait dynamically for the table to reload and show the sample code row
    try:
        sample_row_xpath = f"//tr[td[1][contains(translate(text(),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '{sample_code.upper()}')]]"
        sample_row = wait_el(driver, By.XPATH, sample_row_xpath, timeout=15, cond="visible")
        if sample_row:
            log("SUCCESS", "Table loaded and sample row found!")
    except Exception as e:
        log("WARN", f"Did not detect sample row dynamically: {e}. Proceeding anyway...")

    for by, sel in [
        (By.LINK_TEXT, "Generate"),
        (By.XPATH, f"//tr[td[1][contains(translate(text(),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '{sample_code.upper()}')]]//a[normalize-space(text())='Generate']"),
        (By.XPATH, f"//tr[td[1][contains(translate(text(),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '{sample_code.upper()}')]]//button[normalize-space(text())='Generate']"),
        (By.XPATH, f"//tr[contains(., '{sample_code}')]//a[contains(., 'Generate')]"),
        (By.PARTIAL_LINK_TEXT, "Generate")
    ]:
        gen_el = wait_el(driver, by, sel, timeout=5, cond="click")
        if gen_el:
            log("INFO", f"Found Generate button using selector: {sel}")
            safe_click(driver, gen_el, "Generate")
            generate_clicked = True
            time.sleep(5)
            log("SUCCESS", "Clicked Generate — Test Parameters list loading...")
            break

    if not generate_clicked:
        log("WARN", "Generate button not found — please click 'Generate' manually, waiting 15s")
        time.sleep(15)

    # 10. Loop through Test Parameters Table (Exactly like srl_tr1.py)
    log("INFO", "Starting one-by-one parameter filling loop...")
    
    # Wait for the dataTable rows to appear (AJAX)
    log("INFO", "Waiting for parameter table rows to load...")
    table_loaded = wait_el(driver, By.XPATH, "//table[@id='dataTable']/tbody/tr", timeout=30, cond="presence")
    if table_loaded:
        log("SUCCESS", "Parameter table rows detected! Waiting 5s for full render...")
        time.sleep(5)
    else:
        log("WARN", "Parameter table rows not detected within 30s. Attempting to proceed anyway...")
    
    fill_count = 0
    skip_count = 0
    pdf_uploaded = False  # Track if PDF has been uploaded to first valid clause

    for i, row_data in enumerate(table_rows):
        if len(row_data) < 5:
            continue
            
        obs_val = str(row_data[4]).strip()
        is_qual = "qualitative" in str(row_data[5]).strip().lower() if len(row_data) > 5 else True
        min_val = str(row_data[6]).strip() if len(row_data) > 6 else ""
        max_val = str(row_data[7]).strip() if len(row_data) > 7 else ""
        param_name = str(row_data[2]).strip()
        clause_val = str(row_data[1]).strip()
        
        # HTML tables are 1-indexed, so row `i` in our UI maps to `tr[i+1]`
        fallback_index = i + 1
        tr_index = fallback_index

        # Dynamic row lookup
        try:
            web_rows = driver.find_elements(By.XPATH, "//table[@id='dataTable']/tbody/tr")
            matched_idx = None
            
            # 1. Exact case-insensitive match
            for w_idx, w_row in enumerate(web_rows, start=1):
                try:
                    w_clause = w_row.find_element(By.XPATH, "./td[2]").text.strip()
                    w_param = w_row.find_element(By.XPATH, "./td[3]").text.strip()
                    if w_clause.lower() == clause_val.lower() and w_param.lower() == param_name.lower():
                        matched_idx = w_idx
                        log("INFO", f"    -> Exact match found for '{param_name}' at Row {w_idx}")
                        break
                except Exception:
                    continue
                    
            # 2. Clean alphanumeric partial match
            if not matched_idx:
                def clean_str(s):
                    return "".join(c for c in s.lower() if c.isalnum())
                clean_clause = clean_str(clause_val)
                clean_param = clean_str(param_name)
                
                for w_idx, w_row in enumerate(web_rows, start=1):
                    try:
                        w_clause = clean_str(w_row.find_element(By.XPATH, "./td[2]").text)
                        w_param = clean_str(w_row.find_element(By.XPATH, "./td[3]").text)
                        
                        if ((clean_clause in w_clause or w_clause in clean_clause) and 
                            (clean_param in w_param or w_param in clean_param)):
                            matched_idx = w_idx
                            log("INFO", f"    -> Partial clean match found for '{param_name}' at Row {w_idx}")
                            break
                    except Exception:
                        continue
                        
            if matched_idx:
                tr_index = matched_idx
            else:
                log("INFO", f"    -> No match found for '{param_name}' (Clause {clause_val}). Falling back to index {fallback_index}")
        except Exception as e:
            log("WARN", f"Error in dynamic row lookup: {e}")

        # ONLY skip if observed value is completely empty or None (allow "not done" or "na" to proceed)
        if not obs_val or obs_val == "":
            log("INFO", f"Row {tr_index} [{param_name[:30]}]: skipping (empty value)")
            skip_count += 1
            continue
            
        log("INFO", f"Row {tr_index} [{param_name[:30]}]: processing value '{obs_val}'...")
        
        # Make sure the table is present before processing the row
        wait_el(driver, By.XPATH, "//table[@id='dataTable']", timeout=15, cond="presence")
        prevent_screen_off()

        # 1. Read row status to check if it's "Pending" (status is in td[8])
        tr_status = "Pending"
        try:
            status_path = f"//table[@id='dataTable']/tbody/tr[{tr_index}]/td[8]"
            status_el = driver.find_element(By.XPATH, status_path)
            tr_status = status_el.text.strip()
            log("INFO", f"  -> Row {tr_index} status is: '{tr_status}'")
        except Exception as e:
            log("WARN", f"  -> Could not read status for Row {tr_index}: {e}")

        # Skip rows that are already approved/submitted or have NA requested
        skip_keywords = ["approved", "not applicable requested", "not applicable", "submitted"]
        if tr_status and tr_status.lower().strip() not in ["-", "", "pending"]:
            if any(kw in tr_status.lower() for kw in skip_keywords):
                log("INFO", f"  -> Row {tr_index} already processed/NA (status: '{tr_status}'). Skipping.")
                skip_count += 1
                continue

        # 2. Check if the value is Not Applicable (NA)
        if obs_val.lower() in ["na", "not applicable"]:
            log("INFO", f"  -> Clicking Not Applicable for Row {tr_index}")
            na_path = f"//table[@id='dataTable']/tbody/tr[{tr_index}]//td[last()]//button[contains(translate(text(),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'NOT APPLICABLE')]"
            na_btn = wait_el(driver, By.XPATH, na_path, timeout=5, cond="click")
            if na_btn:
                safe_click(driver, na_btn, "Not Applicable")
                yes_btn = wait_el(driver, By.XPATH, "//button[contains(translate(text(),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'YES')]", timeout=5, cond="click")
                if yes_btn: 
                    safe_click(driver, yes_btn, "Yes Confirm")
                    try:
                        WebDriverWait(driver, 60).until(EC.staleness_of(yes_btn))
                    except: pass
                    time.sleep(15)
                    try:
                        wait_el(driver, By.XPATH, "//table[@id='dataTable']/tbody/tr", timeout=30, cond="presence")
                    except Exception: pass
                fill_count += 1
            else:
                log("WARN", "  -> Not Applicable button not found.")
            continue

        # 3. Handle Start -> Submit button sequence
        # Find Start or Submit button on this row
        btn_path = f"//table[@id='dataTable']/tbody/tr[{tr_index}]//td[last()]//button"
        row_btns = driver.find_elements(By.XPATH, btn_path)

        start_btn = None
        submit_btn = None
        for b in row_btns:
            btn_text = b.text.strip().lower()
            if btn_text == "start":
                start_btn = b
                break
            elif btn_text == "submit":
                submit_btn = b
                break

        # Also check via onclick attribute (more robust)
        if not start_btn and not submit_btn:
            for b in row_btns:
                onclick = b.get_attribute("onclick") or ""
                if "startTest" in onclick:
                    start_btn = b
                    break
                elif "submitTR" in onclick:
                    submit_btn = b
                    break

        form_opened = False
        if start_btn:
            log("INFO", f"  -> Clicking 'Start' for Row {tr_index}")
            # Extract clause and sample IDs from onclick to call submitTR directly after reload
            onclick_attr = start_btn.get_attribute("onclick") or ""
            driver.execute_script("arguments[0].click();", start_btn)

            # startTest() calls location.reload() — wait for page to reload
            log("INFO", f"  -> Waiting for page reload after Start...")
            try:
                WebDriverWait(driver, 20).until(EC.staleness_of(start_btn))
            except Exception:
                pass
            time.sleep(5)
            # Wait for the table to reappear
            wait_el(driver, By.XPATH, "//table[@id='dataTable']/tbody/tr", timeout=20, cond="presence")
            time.sleep(2)

            # Now re-find the Submit button on the same row (page reloaded, elements are new)
            try:
                submit_btn_xpath = f"//table[@id='dataTable']/tbody/tr[{tr_index}]//td[last()]//button[normalize-space(text())='Submit' or contains(@onclick,'submitTR')]"
                submit_btn_new = WebDriverWait(driver, 15).until(
                    EC.element_to_be_clickable((By.XPATH, submit_btn_xpath))
                )
                log("INFO", f"  -> Clicking 'Submit' after Start reload for Row {tr_index}")
                driver.execute_script("arguments[0].click();", submit_btn_new)
                time.sleep(3)
                form_el = wait_el(driver, By.ID, "TestReportForm", timeout=20, cond="presence")
                if form_el:
                    form_opened = True
            except Exception as e:
                log("WARN", f"  -> Failed to find/click Submit after page reload for Row {tr_index}: {e}")

        elif submit_btn:
            log("INFO", f"  -> Clicking 'Submit' for Row {tr_index}")
            driver.execute_script("arguments[0].click();", submit_btn)
            time.sleep(3)
            form_el = wait_el(driver, By.ID, "TestReportForm", timeout=20, cond="presence")
            if form_el:
                form_opened = True
                
        if not form_opened:
            log("WARN", f"  -> TestReportForm did not load in time for Row {tr_index}. Skipping.")
            skip_count += 1
            continue
            
        time.sleep(1) # Give form a moment to initialize JS

        # === PDF UPLOAD: happens on the FIRST clause that actually opens the form ===
        is_first_clause = form_opened and not pdf_uploaded
        
        # 4. Fill modal TestReportForm
        try:
            if is_qual:
                # Qualitative
                qual_radio = wait_el(driver, By.XPATH, '//input[@id="Qualitative" and @type="radio"]', timeout=3)
                if qual_radio: 
                    driver.execute_script("arguments[0].click();", qual_radio)

                # For first clause: override text with standard PDF reference message
                fill_text = "Kindly check the attached document" if is_first_clause else obs_val
                
                res_area = driver.find_element(By.XPATH, '//textarea[@id="id_result"]')
                res_area.clear()
                res_area.send_keys(fill_text)
            else:
                # Quantitative
                quant_radio = wait_el(driver, By.XPATH, '//input[@id="Quantitative" and @type="radio"]', timeout=3)
                if quant_radio: 
                    driver.execute_script("arguments[0].click();", quant_radio)
                
                if max_val and min_val:
                    opt = wait_el(driver, By.XPATH, '//input[@id="value_range" and @type="radio"]', timeout=2)
                    if opt: driver.execute_script("arguments[0].click();", opt)
                    driver.find_element(By.ID, 'id_range_minimum').clear()
                    driver.find_element(By.ID, 'id_range_minimum').send_keys(min_val)
                    driver.find_element(By.ID, 'id_range_maximum').clear()
                    driver.find_element(By.ID, 'id_range_maximum').send_keys(max_val)
                elif max_val:
                    opt = wait_el(driver, By.XPATH, '//input[@id="value_max" and @type="radio"]', timeout=2)
                    if opt: driver.execute_script("arguments[0].click();", opt)
                    driver.find_element(By.ID, 'id_range_maximum').clear()
                    driver.find_element(By.ID, 'id_range_maximum').send_keys(max_val)
                elif min_val:
                    opt = wait_el(driver, By.XPATH, '//input[@id="value_min" and @type="radio"]', timeout=2)
                    if opt: driver.execute_script("arguments[0].click();", opt)
                    driver.find_element(By.ID, 'id_range_minimum').clear()
                    driver.find_element(By.ID, 'id_range_minimum').send_keys(min_val)
                
                # Fill the unit
                try:
                    range_unit = driver.find_element(By.ID, 'id_range_unit')
                    unit_val = determine_unit(param_name, row_data[3])
                    if unit_val:
                        range_unit.clear()
                        range_unit.send_keys(unit_val)
                        log("INFO", f"  -> Filled range unit: {unit_val}")
                except Exception as e:
                    log("DEBUG", f"Could not fill range unit: {e}")

                # Fill the result range
                try:
                    res_range = driver.find_element(By.ID, 'id_resultrange')
                    res_range.clear()
                    res_range.send_keys(obs_val)
                except Exception as e:
                    log("DEBUG", f"Could not fill resultrange: {e}")

            # 5. Conformity (default to conforms, but support marking as not conforming if failed)
            conformity_val = "P"
            if obs_val.lower() in ["fail", "failed", "not conforms", "not conforming"]:
                conformity_val = "F"
            elif obs_val.lower() in ["na", "not applicable"]:
                conformity_val = "NA"
                
            try:
                if conformity_val == "P":
                    opt_conforms = driver.find_element(By.ID, "id_confirms")
                    driver.execute_script("arguments[0].click();", opt_conforms)
                elif conformity_val == "F":
                    opt_not_conforms = driver.find_element(By.ID, "id_not_confirms")
                    driver.execute_script("arguments[0].click();", opt_not_conforms)
                else:
                    opt_na = driver.find_element(By.ID, "id_not_applicable")
                    driver.execute_script("arguments[0].click();", opt_na)
                log("INFO", f"  -> Set conformity: {conformity_val}")
            except Exception as e:
                log("WARN", f"  -> Conformity selection failed: {e}")
            
            # === FIRST VALID CLAUSE: scroll down and attach the generated PDF ===
            if is_first_clause and pdf_path and os.path.exists(pdf_path):
                log("INFO", f"  -> First clause: attaching PDF via id_attachments...")
                try:
                    # Scroll down to reveal attachment field
                    driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
                    time.sleep(1.5)

                    # id_attachments is a VISIBLE file input — confirmed from HTML inspection
                    attach_file_input = None
                    for xp in [
                        '//*[@id="id_attachments"]',
                        '//form[@id="TestReportForm"]//input[@type="file"]',
                        '//div[@id="Viewselection"]//input[@type="file"]',
                        '//input[@type="file"]'
                    ]:
                        try:
                            attach_file_input = driver.find_element(By.XPATH, xp)
                            if attach_file_input:
                                log("INFO", f"  -> Found file input using: {xp}")
                                break
                        except Exception:
                            continue

                    if attach_file_input:
                        # Ensure visibility (some portals hide the input)
                        driver.execute_script("""
                            arguments[0].style.display = 'block';
                            arguments[0].style.visibility = 'visible';
                            arguments[0].style.opacity = '1';
                        """, attach_file_input)
                        time.sleep(0.3)
                        attach_file_input.send_keys(pdf_path)
                        log("SUCCESS", f"  -> PDF attached successfully: {pdf_path}")
                        pdf_uploaded = True
                        time.sleep(2)
                    else:
                        log("WARN", "  -> id_attachments input not found. Proceeding without attachment.")

                except Exception as attach_err:
                    log("WARN", f"  -> PDF attachment failed: {attach_err}. Proceeding without attachment.")

            # Click modal Submit button — confirmed selector: onclick="testreportSubmit();"
            modal_submit_btn = None
            for xp in [
                '//button[@onclick="testreportSubmit();"]',
                '//div[@class="modal-footer"]//button[contains(@class,"btn-primary")]',
                '//button[contains(translate(text(),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"SUBMIT") and contains(@class,"btn-primary")]'
            ]:
                try:
                    modal_submit_btn = driver.find_element(By.XPATH, xp)
                    if modal_submit_btn:
                        log("INFO", f"  -> Found modal Submit button via: {xp}")
                        break
                except Exception:
                    continue

            if modal_submit_btn:
                driver.execute_script("arguments[0].click();", modal_submit_btn)
            else:
                log("WARN", "  -> Modal Submit button not found — trying JS testreportSubmit() directly")
                driver.execute_script("testreportSubmit();")

            
            log("SUCCESS", f"  -> Submitted Row {tr_index}!")
            fill_count += 1
            
            # Wait for page reload/modal closing
            try:
                WebDriverWait(driver, 60).until(EC.staleness_of(modal_submit_btn))
            except:
                pass
            time.sleep(15)
            
            if upload_mode == "single" and pdf_uploaded:
                log("INFO", "Single-PDF Mode: Successfully uploaded PDF to first clause. Marking remaining clauses as Not Applicable...")
                try:
                    # Find and click "Select All" checkbox
                    select_all = WebDriverWait(driver, 10).until(EC.element_to_be_clickable((By.XPATH, "//table[@id='dataTable']//thead//input[@type='checkbox']")))
                    driver.execute_script("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'}); arguments[0].click();", select_all)
                    time.sleep(1.5)
                    
                    # Click "Mark Not Applicable" button
                    mark_na_btn = WebDriverWait(driver, 5).until(EC.element_to_be_clickable((By.ID, "IdNotAppModel")))
                    driver.execute_script("arguments[0].click();", mark_na_btn)
                    time.sleep(2)
                    
                    # Click Confirm in Modal
                    confirm_btn = WebDriverWait(driver, 5).until(EC.element_to_be_clickable((By.CSS_SELECTOR, ".bulknotApplicableConfirmBtn")))
                    driver.execute_script("arguments[0].click();", confirm_btn)
                    
                    log("SUCCESS", "Successfully marked remaining clauses as Not Applicable.")
                    time.sleep(15) # Wait for page reload
                    
                    # Track sample in submitted.js
                    # Track sample via Supabase instead of submitted.js
                    try:
                        import urllib.request
                        # We send a small POST to our own Node.js server which handles Supabase, 
                        # or we just write a special log that Node.js reads.
                        # Since we are running in a subprocess, printing a specific SUCCESS log is safest.
                        print(f"[[SUBMITTED_SAMPLE]]:{sample_code}", flush=True)
                        log("INFO", f"Sample {sample_code} successfully tracked via stdout for Node.js")
                    except Exception as track_err:
                        log("WARN", f"Failed to track sample: {track_err}")

                except Exception as ex:
                    log("ERROR", f"Failed to mark remaining clauses as NA: {ex}")
                
                log("SUCCESS", "Single-PDF Mode process fully complete. Exiting.")
                break            
        except Exception as e:
            log("ERROR", f"  -> Error filling form for Row {tr_index}: {e}")
            skip_count += 1
            # Try to close modal if it's still open to prevent getting stuck
            try:
                close_btn = driver.find_element(By.XPATH, '//button[@class="close" or contains(text(),"Close")]')
                driver.execute_script("arguments[0].click();", close_btn)
                time.sleep(2)
            except:
                pass

    log("SUCCESS", f"LIMS Automation Complete! Filled: {fill_count}, Skipped: {skip_count}")
    log("INFO", "Keeping browser open 20s for review...")
    time.sleep(20)

    try:
        driver.quit()
    except Exception:
        pass
    log("SUCCESS", "Session closed.")

if __name__ == "__main__":
    main()
