"""Browser smoke of the built workspace served by the platform app: sign in, create a
tender and scenario, save inputs, sign out. Screenshots in /tmp/ui-*.png."""
import os
from playwright.sync_api import sync_playwright

base = "http://127.0.0.1:8000"
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None)
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.goto(base + "/")
    page.wait_for_selector("form.login-card", timeout=30000)
    page.screenshot(path="/tmp/ui-login.png")
    page.fill("input[type=email]", "bids@ergplan.test")
    page.fill("input[type=password]", "demo-pass-123")
    page.click("button[type=submit]")
    page.wait_for_selector(".workspace-bar", timeout=30000)
    page.wait_for_selector(".sidebar", timeout=30000)
    page.fill("input[placeholder='New tender name']", "UI smoke tender")
    page.click("text=Create >> nth=0")
    page.wait_for_timeout(1000)
    page.fill("input[placeholder='New scenario name']", "UI smoke scenario")
    page.click("text=Create >> nth=1")
    page.wait_for_selector("text=Loaded \"UI smoke scenario\"", timeout=30000)
    page.click("text=Save inputs")
    page.wait_for_selector("text=Saved version 2", timeout=30000)
    page.screenshot(path="/tmp/ui-workspace.png")
    text = page.inner_text(".workspace-message")
    print("workspace message:", text)
    page.click("text=Sign out")
    page.wait_for_selector("form.login-card", timeout=30000)
    browser.close()
print("UI smoke ok")
