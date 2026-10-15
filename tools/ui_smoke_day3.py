"""Browser smoke of the supply workspace: sign in, open the Day 2 demo tender, create a
scenario, add a solar, a BESS and a biomass module, validate, save, screenshot.
CHROMIUM_PATH optional. Screenshots in /tmp/ui-day3-*.png."""

import os

from playwright.sync_api import sync_playwright

base = os.environ.get("BASE_URL", "http://127.0.0.1:8000")
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None)
    page = browser.new_page(viewport={"width": 1600, "height": 1100})
    page.goto(base + "/")
    page.wait_for_selector("form.login-card", timeout=30000)
    page.fill("input[type=email]", "bids@ergplan.test")
    page.fill("input[type=password]", os.environ.get("PASSWORD", "demo-pass-123"))
    page.click("button[type=submit]")
    page.wait_for_selector(".workspace-bar", timeout=30000)
    page.wait_for_timeout(1500)
    options = page.locator(".workspace-row select >> nth=1").locator("option").all_text_contents()
    demo = next((o for o in options if "Day 2 demo" in o), None)
    assert demo, options
    page.select_option(".workspace-row select >> nth=1", label=demo)
    page.wait_for_timeout(1000)
    page.fill("input[placeholder='New scenario name']", "Supply smoke")
    page.click("text=Create >> nth=1")
    page.wait_for_selector("text=Loaded \"Supply smoke\"", timeout=30000)
    page.click("text=Supply Modules")
    page.wait_for_selector(".supply", timeout=30000)
    for kind in ("Solar PV", "BESS", "Biomass"):
        page.click(f"button:has-text('+ {kind}')")
        page.wait_for_timeout(800)
    page.wait_for_selector(".iso-path", timeout=30000)
    page.click("button:has-text('Validate')")
    page.wait_for_timeout(1500)
    page.screenshot(path="/tmp/ui-day3-supply.png", full_page=False)
    print("modules:", page.locator(".module-card").count(), "loss rows:", page.locator(".loss-table tbody tr").count())
    page.click("button:has-text('Save as input version')")
    page.wait_for_selector("text=Saved as input version", timeout=30000)
    print(page.inner_text(".workspace-message"))
    page.click(".module-card >> nth=1")
    page.wait_for_timeout(600)
    page.screenshot(path="/tmp/ui-day3-bess.png", full_page=False)
    browser.close()
print("UI smoke day 3 ok")
