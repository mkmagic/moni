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

### Puppeteer Troubleshooting (Linux server — verified on Ubuntu 24.04, 2026-07-31)

**`npx puppeteer browsers install chrome` does not reliably work here.** It and `npm ci` both
exit non-zero **with no error message**, leaving a version directory containing an *empty*
`chrome-linux64/`. The failure only surfaces later, as the badly misleading
`Could not find Chrome (ver. X)` — which reads like "it was never downloaded" when in fact the
download succeeded and the *extraction* is what failed. Don't trust the exit code; check for the
binary. Fetch and unpack it yourself:

```bash
VER=148.0.7778.97   # must match puppeteer's expected build: node -p "require('puppeteer').executablePath()"
cd ~/.cache/puppeteer/chrome && rm -rf "linux-$VER"
curl -sSL -o c.zip "https://storage.googleapis.com/chrome-for-testing-public/$VER/linux64/chrome-linux64.zip"
mkdir -p "linux-$VER" && unzip -q c.zip -d "linux-$VER/" && chmod -R +x "linux-$VER/chrome-linux64/" && rm c.zip
"linux-$VER/chrome-linux64/chrome" --version
```

**Runtime libraries** the Chrome download does *not* include (Ubuntu 24.04 names — note the
`t64` suffixes, the pre-24.04 names in most "Chrome in Docker" recipes will not resolve):

```
libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 libxcomposite1
libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2
libatspi2.0-0t64 fonts-liberation
```

**Chrome's sandbox is blocked by AppArmor on Ubuntu 24.04+.** The default
`kernel.apparmor_restrict_unprivileged_userns=1` makes Chrome die with
`FATAL … zygote_host_impl_linux.cc: No usable sandbox!` — *even as a non-root user*, so the usual
"don't run as root" advice does not fix it. Two ways out, and they are **not** equivalent:

```bash
sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # preferred: keeps Chrome's sandbox
```

versus passing `--no-sandbox`, which **disables** it. The scraper stack is untrusted by design
(`threat-model.md` §2 lists a compromised dependency as hostile, and it runs with plaintext Tier-0
in memory), so `--no-sandbox` on a real host silently deletes a boundary that
`security-design-principles.md` §20 is separately trying to build. Acceptable on a throwaway probe
box; not on anything that holds real credentials.

Also pass `--disable-dev-shm-usage`: Docker defaults `/dev/shm` to 64 MB and Chrome dies mid-page
with renderer crashes rather than a clean error. `scrape-worker.mts` passes **no** launch `args`
today (`scrape-worker.mts:77`), so this is still an open gap for deployment.

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
   `a[title="דלג לחשבון"]` selector. The patch broadens it to the shared prefix
   (`leumi.js:31`), which **is** correct — see the warning immediately below.

> [!WARNING]
> **Fix 2 does not currently work, and this section previously claimed it did.**
> Observed 2026-07-31 (#54) with the patch verifiably applied: a wrong Leumi password still hangs
> ~60s and still dies on `a[title="דלג לחשבון"]` — the exact symptom the patch exists to remove.
> A failure screenshot confirms Leumi *did* render
> `אחד או יותר מפרטי ההזדהות שהוקלדו שגויים`, and the patched constant *is* a prefix of it. So the
> string is right and the break is **downstream of the patch**.
>
> Most likely cause, **unconfirmed**: the `InvalidPassword` detector never reads that text from the
> page directly. It reads it via `pageEvalAll(page, 'svg#Capa_1', …)` and then walks
> `parentElement.children[1].innerText` (`leumi.js:43`) — a DOM-shape assumption about the error
> *icon* that the patch never touched. If Leumi renamed or restructured that icon, `errorMessage`
> is `undefined`, `undefined?.startsWith(...)` is falsy, and `InvalidPassword` can never match no
> matter how correct the string is. A DOM probe attempting to confirm this failed to reproduce the
> error state, so treat it as a lead, not a finding.
>
> **Practical consequence:** do not use `INVALID_PASSWORD` as your signal that a Leumi login was
> reached. A ~60s hang ending in the `דלג לחשבון` selector error is currently indistinguishable
> from a genuine block. Read a failure screenshot instead (see §2b).

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

### `errorMessage` contains the credential. Never persist or print it raw.

`israeli-bank-scrapers` embeds **the failing request's POST body** in `errorMessage`. Verified
2026-07-31 (#54) — a failed Isracard login produced:

```
fetchPostWithinPage parse error: Unexpected end of JSON input,
url: https://digital.isracard.co.il/services/ProxyRequestHandler.ashx?reqName=ValidateIdData,
data: {"id":"<NATIONAL ID>","cardSuffix":"<CARD DIGITS>","countryCode":"212",...}
```

For `isracard`/`amex`, `id` and `card6Digits` are **two of the three `loginFields`** — i.e. this is
Tier-0 credential material, not merely Tier-1. Anything that stores, logs, prints or ships
`errorMessage` unfiltered is leaking it.

Scrub every supplied credential value out of the string before it goes anywhere:

```ts
function redact(text: string, credentials: Record<string, string>): string {
  let out = text;
  for (const [field, value] of Object.entries(credentials)) {
    if (String(value ?? "").length < 3) continue; // below 3 chars, matches innocent substrings
    out = out.split(String(value)).join(`[REDACTED:${field}]`);
  }
  return out;
}
```

Redact **before** the value reaches a classifier, a log line, or a DB write — not just before the
final write — because intermediate error paths tend to echo the message to stdout on the way.

A **failure screenshot leaks too**: the login form is captured with the identifier typed into it.
Passwords render masked; national IDs, usernames and card digits do not. Treat any
`storeFailureScreenShotPath` output as Tier-1 and shred it after reading.

## 3. Example Scripts

In the `scripts/` directory of this skill, you will find template `.mjs` scripts to test basic connectivity:

- **`leumi.mjs`**: Basic scraper for Bank Leumi.
- **`isracard.mjs`**: Scraper for Isracard, pulling exactly the last month of transactions.

### Running the Scripts

> [!CAUTION]
> These templates hold credentials as inline literals, which **contradicts the rule the rest of
> this project follows**. `scripts/scrape-test.ts` states it directly: *"Credentials come from
> stdin, NEVER argv — argv is visible in `ps` output and shell history."* An inline literal is
> worse than argv: it is a Tier-0 secret sitting in a file, one `git add -A` from being committed.
> Read from stdin instead, and keep the shell out of it too (`unset HISTFILE`, `read -rs`).

1. Pipe credentials in on stdin rather than editing them into the file (`username`/`password` for
   banks, or `id`/`card6Digits`/`password` for credit cards).
2. Run the script using Node.js:
   ```bash
   node leumi.mjs
   ```
3. On success, the script outputs the list of `txns` containing `date`, `description`,
   `chargedAmount`, `status`, etc., so you can verify the transaction fields.

**Do not read `INVALID_PASSWORD` as "the login page was reached" for Leumi** — see the warning in
§2 — and do not read `GENERIC` as "blocked". Both were observed in #54 on runs that had loaded the
real login page perfectly well; one was the provider rejecting a malformed national ID, the other
was a server-side credential rejection. **The screenshot is the evidence; the error type is not.**

**A successful scrape that returns zero transactions is a failure, not a pass.** Count the rows —
`accounts.reduce((n, a) => n + a.txns.length, 0)` — and treat `0` as a failure until you have
confirmed from a known-good environment that the account genuinely has no activity in the window.
Trusting `success: true` or the exit code hides exactly the failure mode anti-automation produces.
