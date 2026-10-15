"""Browser smoke of the assistant and DPR tabs: sign in, open the Day 4 demo tender, ask the
assistant to list scenarios (recorded mode), screenshot; open the post-award DPR tab and
screenshot the generated workspace. Screenshots in /tmp/ui-day6-*.png."""

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
    demo = next((o for o in options if "Day 4 demo" in o), None)
    assert demo, options
    page.select_option(".workspace-row select >> nth=1", label=demo)
    page.wait_for_timeout(1000)
    page.click("text=Assistant & Voice")
    page.wait_for_selector(".assistant", timeout=30000)
    page.fill(".assistant .composer-row input", "list scenarios")
    page.press(".assistant .composer-row input", "Enter")
    page.wait_for_selector(".assistant .msg.assistant", timeout=30000)
    page.wait_for_timeout(800)
    print("assistant:", page.locator(".assistant .msg.assistant").last.inner_text()[:160].replace("\n", " "))
    page.fill(".assistant .composer-row input", "create a scenario called UI smoke case")
    page.press(".assistant .composer-row input", "Enter")
    page.wait_for_selector(".assistant .proposal", timeout=30000)
    print("proposal:", page.locator(".assistant .proposal").first.inner_text()[:140].replace("\n", " "))
    page.screenshot(path="/tmp/ui-day6-assistant.png", full_page=False)
    page.click(".assistant .proposal button:has-text('Reject')")
    page.wait_for_timeout(800)
    page.click("text=Post-award DPR")
    page.wait_for_selector(".dpr", timeout=30000)
    page.wait_for_timeout(2500)
    print("dpr chips:", " | ".join(page.locator(".dpr .req-head .chip").all_text_contents()))
    print("dpr sections:", page.locator(".dpr .dpr-section").count())
    page.screenshot(path="/tmp/ui-day6-dpr.png", full_page=False)
    browser.close()
print("UI smoke day 6 ok")
