---
name: israeli-scraper
description: Guidelines on installing, updating, and using the israeli-bank-scrapers library in the Moni project.
---

# Israeli Bank Scrapers Skill

This document explains how to set up, troubleshoot, and use the `israeli-bank-scrapers` library for retrieving financial transactions for the Moni project.

## 1. Installation

Navigate to your dependencies directory and install the package:
```bash
npm init -y
npm install israeli-bank-scrapers --save
```

### Puppeteer Troubleshooting (macOS / arm64)
The `israeli-bank-scrapers` library uses Puppeteer, which downloads a Chrome binary. Sometimes this installation fails silently or throws `Failed to launch the browser process: no such file`.

To fix this, either force Puppeteer to install Chrome:
```bash
npx puppeteer browsers install chrome
```
**Or** pass your system's native Chrome path in the scraper options:
```javascript
executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

## 2. Version Verification and Updates

To ensure you have the correct/latest version:
```bash
npm ls israeli-bank-scrapers
```

To update the package to the latest version:
```bash
npm install israeli-bank-scrapers@latest --save
```

**This package is PATCHED.** `patches/israeli-bank-scrapers+6.9.0.patch` is applied by
`patch-package` via the root `postinstall` (verified to run even though npm gates *dependency*
postinstall scripts). Upgrading the package will orphan the patch — re-check whether both fixes are
still needed, and regenerate with `npx patch-package israeli-bank-scrapers`. Both are upstream bugs
worth reporting (`npx patch-package israeli-bank-scrapers --create-issue` drafts the issue):

1. **Leumi `getLoginOptions` waited on `load` for `https://www.leumi.co.il/he`, which never fires.**
   Leumi added hCaptcha + `captcha.perfdrive.com` (F5/Shape) assets to their public homepage; they
   abort and the `load` event never arrives, so the *first* navigation times out at 30s before
   login is even attempted. `checkReadiness` immediately navigates away to
   `hb2.../authenticate/logon` anyway, so the page only needs to have parsed →
   `waitUntil: 'domcontentloaded'`. **This is not captcha evasion** — the captcha is on a page the
   scraper discards; it's a wait-condition bug the third-party script exposed.
2. **`INVALID_PASSWORD_MSG` was stale.** Leumi reworded it to
   `אחד או יותר מפרטי ההזדהות שהוקלדו שגויים` (was `…שמסרת שגויים. ניתן לנסות שוב`). The exact-string
   match never fired, so a wrong password hung the full 60s and then failed on the unrelated
   `a[title="דלג לחשבון"]` selector. Now matches the shared prefix.

## 2b. Debugging a failing scrape

**`timeout` is the wrong knob.** Despite its doc comment ("Maximum navigation time in
milliseconds"), `ScraperOptions.timeout` is passed to `puppeteer.launch()` and only bounds *browser
startup*. The option that reaches `page.setDefaultTimeout()` — and therefore governs `page.goto` —
is **`defaultTimeout`** (base-scraper-with-browser.js:95 vs :136). Setting `timeout` changes
nothing and the error still says 30000. `scrape-worker.mts` sets `defaultTimeout: 60_000`.

`navigationRetryCount` does **not** help a timeout: it only retries on a non-ok HTTP status, and a
timeout throws out of `page.goto` before that check.

Turn on the library's own step logging and a failure snapshot:
```bash
DEBUG='israeli-bank-scrapers:*' MONI_SCRAPE_FAILURE_SCREENSHOT=/tmp/fail.png npm run scrape:test -- …
```
The debug stream names the step (`navigate to login url` → `execute 'checkReadiness' interceptor` →
`fill login components` → `click on login submit button` → `handle login results SUCCESS`), which
the error message never does. **Read the screenshot** — a wrong password shows the bank's own red
error on the page, which is far faster than inferring it.

Ignore the `ERR_ABORTED` flood for `cache.bankleumi.co.il/adrum/...` and `gate-keeper` — those are
AppDynamics monitoring assets cancelled during navigation, not the failure.

**Isolate bank-changed-their-UI from we-broke-something with a credential-free probe.** Drive
Puppeteer at the same URL with the same waits and assert the selectors exist — no credentials, no
lockout risk, repeatable. That is what proved Leumi's login page was fine (2.2s, all selectors
present) and moved the search to the homepage navigation. Do this *before* retrying with real
credentials: repeated failed logins can lock a real bank account.

Note `getLoginOptions().loginUrl` for Leumi is the marketing homepage `www.leumi.co.il/he`, NOT the
login page — probing the obvious URL tests the wrong thing.

## 3. Example Scripts

In the `scripts/` directory of this skill, you will find template `.mjs` scripts to test basic connectivity:

- **`leumi.mjs`**: Basic scraper for Bank Leumi.
- **`isracard.mjs`**: Scraper for Isracard, pulling exactly the last month of transactions.

### Running the Scripts
1. Provide the actual credentials in the script (`username`/`password` for banks, or `id`/`card6Digits`/`password` for credit cards).
2. Run the script using Node.js:
   ```bash
   node leumi.mjs
   ```
3. Look out for the `GENERIC` or `INVALID_PASSWORD` error if the credentials are not filled out correctly.
4. On success, the script will output the list of `txns` containing `date`, `description`, `chargedAmount`, `status`, etc., to allow you to verify the transaction fields.
