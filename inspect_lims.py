import sys
import io
import time
import os
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

SAMPLE_CODE = "26MD61F86N"
OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))

def save_html(driver, filename, label):
    path = os.path.join(OUTPUT_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        f.write(driver.page_source)
    print(f"[SAVED] {label} -> {filename}", flush=True)

def wait_el(driver, by, val, timeout=15):
    try:
        return WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((by, val)))
    except:
        return None

def main():
    print("[STEP 1] Launching Chrome...", flush=True)
    opts = Options()
    opts.add_experimental_option("detach", True)
    opts.add_experimental_option("excludeSwitches", ["enable-logging"])
    driver = webdriver.Chrome(options=opts)
    driver.maximize_window()

    # -------------------------------------------------------
    # STEP 1: Login
    # -------------------------------------------------------
    driver.get("https://lims.bis.gov.in/accounts/login/?next=/dashboard/")
    print("[STEP 1] Waiting 90s for you to LOG IN...", flush=True)
    deadline = time.time() + 90
    while time.time() < deadline:
        if "login" not in driver.current_url:
            print("[STEP 1] Login detected!", flush=True)
            break
        time.sleep(2)
    save_html(driver, "page_01_dashboard.html", "Dashboard after login")
    time.sleep(3)

    # -------------------------------------------------------
    # STEP 2: Navigate to Pending Samples
    # -------------------------------------------------------
    try:
        base = driver.current_url.split("/", 3)[0] + "//" + driver.current_url.split("/", 3)[2]
        driver.get(base + "/sample/ta_sample_pending_list")
        time.sleep(4)
        save_html(driver, "page_02_pending_list.html", "Pending Samples list")
        print("[STEP 2] Pending Samples page captured.", flush=True)
    except Exception as e:
        print(f"[WARN] Could not navigate to pending list: {e}", flush=True)

    # -------------------------------------------------------
    # STEP 3: Filter by sample code and click Generate
    # -------------------------------------------------------
    try:
        # Click Filter button
        for xp in ["//button[contains(@class,'btn-filter')]", "//button[contains(.,'Filter')]"]:
            fb = wait_el(driver, By.XPATH, xp, timeout=8)
            if fb:
                driver.execute_script("arguments[0].click();", fb)
                print("[STEP 3] Clicked Filter button.", flush=True)
                time.sleep(2)
                break

        # Type sample code
        for xp in ["//input[@id='id_samplepart__encoded_sample_code__icontains']",
                   "//input[contains(@id,'sample_code')]"]:
            si = wait_el(driver, By.XPATH, xp, timeout=5)
            if si:
                si.clear(); si.send_keys(SAMPLE_CODE)
                print(f"[STEP 3] Typed sample code: {SAMPLE_CODE}", flush=True)
                time.sleep(1)
                break

        # Click Apply
        for xp in ["//button[contains(@class,'filterprimary')]", "//button[contains(.,'Apply')]"]:
            ab = wait_el(driver, By.XPATH, xp, timeout=5)
            if ab:
                driver.execute_script("arguments[0].click();", ab)
                print("[STEP 3] Clicked Apply filter.", flush=True)
                time.sleep(20)
                break

        save_html(driver, "page_03_filtered_list.html", "Filtered sample list")
        print("[STEP 3] Filtered list captured.", flush=True)
    except Exception as e:
        print(f"[WARN] Filter step failed: {e}", flush=True)

    # -------------------------------------------------------
    # STEP 4: Click Generate button on the sample row
    # -------------------------------------------------------
    generate_clicked = False
    try:
        for by, sel in [
            (By.LINK_TEXT, "Generate"),
            (By.XPATH, f"//tr[contains(., '{SAMPLE_CODE}')]//a[contains(., 'Generate')]"),
            (By.PARTIAL_LINK_TEXT, "Generate"),
        ]:
            g = wait_el(driver, by, sel, timeout=10)
            if g:
                driver.execute_script("arguments[0].click();", g)
                generate_clicked = True
                print("[STEP 4] Clicked Generate!", flush=True)
                time.sleep(6)
                break

        if not generate_clicked:
            print("[WARN] Could not find Generate button automatically.", flush=True)

        save_html(driver, "page_04_parameters_table.html", "Test Parameters table")
        print("[STEP 4] Parameters table captured.", flush=True)
    except Exception as e:
        print(f"[WARN] Generate step failed: {e}", flush=True)

    # -------------------------------------------------------
    # STEP 5: Click Start on the FIRST row
    # -------------------------------------------------------
    try:
        first_start = wait_el(driver, By.XPATH,
            "//table[@id='dataTable']/tbody/tr[1]//button[normalize-space(text())='Start']",
            timeout=15)
        if first_start:
            driver.execute_script("arguments[0].click();", first_start)
            print("[STEP 5] Clicked Start on first row.", flush=True)
            time.sleep(8)
            save_html(driver, "page_05_after_start.html", "Page after clicking Start")
        else:
            print("[WARN] Start button not found on first row.", flush=True)
    except Exception as e:
        print(f"[WARN] Start click failed: {e}", flush=True)

    # -------------------------------------------------------
    # STEP 6: Click Submit on the first row
    # -------------------------------------------------------
    try:
        first_submit = wait_el(driver, By.XPATH,
            "//table[@id='dataTable']/tbody/tr[1]//button[normalize-space(text())='Submit']",
            timeout=15)
        if first_submit:
            driver.execute_script("arguments[0].click();", first_submit)
            print("[STEP 6] Clicked Submit on first row - modal should open.", flush=True)
            time.sleep(4)
            save_html(driver, "page_06_modal_open.html", "TestReportForm modal open")
        else:
            print("[WARN] Submit button not found on first row.", flush=True)
    except Exception as e:
        print(f"[WARN] Submit click failed: {e}", flush=True)

    # -------------------------------------------------------
    # STEP 7: Scroll down inside the modal and capture again
    # -------------------------------------------------------
    try:
        driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(2)
        save_html(driver, "page_07_modal_scrolled.html", "Modal after scroll (attach area visible)")
        print("[STEP 7] Scrolled modal and captured HTML.", flush=True)
    except Exception as e:
        print(f"[WARN] Scroll step failed: {e}", flush=True)

    print("\n[DONE] All pages captured. Chrome stays open for your review.", flush=True)
    print("Files saved in:", OUTPUT_DIR, flush=True)

if __name__ == "__main__":
    main()
