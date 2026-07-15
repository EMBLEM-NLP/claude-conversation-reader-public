---
description: "Use when working with Playwright browser automation, page interactions, selectors, or cookie extraction in the Claude.ai auth flow."
applyTo: "src/auth/**"
---

# Playwright Auth Conventions

- Always use `page.waitForURL()` or `page.waitForSelector()` before interacting — never raw timeouts
- Use `page.context().cookies()` to capture all cookies after auth completes
- Launch with `{ headless: false }` by default for login (user must interact); accept `--headless` flag for CI
- Close browser context in a `finally` block to prevent zombie processes
- Use `page.waitForLoadState('networkidle')` after redirect chains complete
- Log auth progress steps without logging actual cookie or credential values
- Claude.ai login requires human interaction (email + verification code or Google SSO) — the browser MUST be visible
