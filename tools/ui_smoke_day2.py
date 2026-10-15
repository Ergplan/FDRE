"""Browser smoke of the tender intelligence screen served by the platform app: sign in,
open the tender created by tools/demo_day2.sh, walk the requirements, summary, amendments,
tasks and timeline views. Screenshots in /tmp/ui-day2-*.png. CHROMIUM_PATH optional."""

import os

from playwright.sync_api import sync_playwright

base = os.environ.get("BASE_URL", "http://127.0.0.1:8000")
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None)
    page = browser.new_page(viewport={"width": 1500, "height": 1000})
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
    page.wait_for_selector(".tender-intel", timeout=30000)
    page.wait_for_selector(".req-table tbody tr", timeout=30000)
    rows = page.locator(".req-table tbody tr").count()
    print("requirement rows:", rows)
    page.screenshot(path="/tmp/ui-day2-requirements.png", full_page=False)
    for view in ("summary", "documents", "amendments", "tasks", "timeline"):
        page.click(f".subnav >> text={view}")
        page.wait_for_timeout(800)
        page.screenshot(path=f"/tmp/ui-day2-{view}.png", full_page=False)
    print("amendment rows:", page.locator(".impact table tbody tr").count())
    print("timeline rows:", page.locator(".timeline li").count())
    browser.close()
print("UI smoke day 2 ok")
