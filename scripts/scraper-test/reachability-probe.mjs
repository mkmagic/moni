// Bank reachability probe: "from THIS machine, which banks can we reach, up to
// the login form?" Credential-free. It never types, clicks submit, or calls
// scraper.scrape()/login()/fillInputs — there are no credentials in this file.
//
//   node scripts/scraper-test/reachability-probe.mjs [--only discount,leumi] [--out results.json]
//
// Env: MONI_CHROME_PATH = Chrome/Chromium binary (unset -> puppeteer's bundled).
// Run it on the candidate server and on a control machine at the same time and
// compare. See .claude/skills/israeli-scraper/SKILL.md §2b.
import { hostname } from "node:os";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";
import { CompanyTypes, createScraper } from "israeli-bank-scrapers";

const NAV_TIMEOUT_MS = 45_000;
const READY_TIMEOUT_MS = 20_000;
const RETRY_WAIT_MS = 30_000;

// Closures we have READ in node_modules/israeli-bank-scrapers/lib/scrapers/*.js
// and confirmed only wait for / navigate to a login page (no typing, no submit):
//   discount, yahav, behatsdaa, mizrahi, max, visaCal: waitForSelector only.
//   leumi: page.goto(hb2.bankleumi.co.il/authenticate/logon) + waits.
// Anything else with a checkReadiness is NOT run.
const SAFE_READINESS = new Set([
  "discount",
  "yahav",
  "behatsdaa",
  "mizrahi",
  "leumi",
  "max",
  "visaCal",
]);
// preAction closures that only click to reveal the login tab / iframe (no
// typing): max (closes popup, opens personal-area login tab) and visaCal
// (opens the login popup and its iframe's password tab, returns the frame).
// Other preActions (beinleumi family: a 1s sleep) are unnecessary and skipped.
const SAFE_PREACTION = new Set(["max", "visaCal"]);

// Scrapers with no getLoginOptions (they log in via fetch inside the page or
// via a private API). Navigate to the host taken from the source; no form check.
const API_HOSTS = {
  isracard: "https://digital.isracard.co.il/personalarea/Login", // BASE_URL + the path base-isracard-amex.js navigates to
  amex: "https://he.americanexpress.co.il/personalarea/Login", // BASE_URL + same path
  oneZero: "https://identity.tfd-bank.com/v1/", // one-zero.js IDENTITY_SERVER_URL
};

const NETWORK_RE =
  /ERR_(CONNECTION_(TIMED_OUT|REFUSED|RESET|CLOSED|FAILED)|TIMED_OUT|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_CHANGED|EMPTY_RESPONSE|TUNNEL_CONNECTION_FAILED)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|Navigation timeout|fetch failed|timed? ?out/i;
const CHALLENGE_RE =
  /(captcha|perfdrive|hcaptcha|cloudflare|just a moment|attention required|access denied|request rejected|checking your browser|verify you are (a )?human)/i;

/** Returns the matched challenge keyword (lowercased), or null. */
export function findChallengeKeyword(obs) {
  const hay = `${obs.title ?? ""}\n${obs.url ?? ""}\n${obs.body ?? ""}`;
  const m = CHALLENGE_RE.exec(hay);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Pure classification of one probe attempt.
 * observation: { mode: "browser"|"api", error?: string|null, status?: number|null,
 *                formFound?: boolean, title?: string, url?: string, body?: string }
 * Returns exactly one of: OK | NETWORK_BLOCK | HTTP_<status> | CHALLENGE | NO_FORM | ERROR.
 * Precedence: transport error > form found (OK) > challenge keyword > HTTP>=400 >
 * (api mode: any <400 response is OK) > NO_FORM. A 403 "Access Denied" page is
 * reported as CHALLENGE (more informative than HTTP_403); a login form that is
 * actually present wins over incidental captcha words on the page.
 */
export function classify(obs) {
  const status = obs.status ?? null;
  if (obs.error) {
    return NETWORK_RE.test(obs.error) ? "NETWORK_BLOCK" : "ERROR";
  }
  if (obs.formFound && (status === null || status < 400)) return "OK";
  if (findChallengeKeyword(obs)) return "CHALLENGE";
  if (status !== null && status >= 400) return `HTTP_${status}`;
  if (obs.mode === "api" && status !== null) return "OK";
  return "NO_FORM";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))]);
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
};
const shortMsg = (e) => String(e?.cause?.code ?? e?.message ?? e).split("\n")[0].slice(0, 120);

function parseArgs(argv) {
  const out = { only: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") out.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (argv[i] === "--out") out.out = argv[++i] ?? null;
  }
  return out;
}

/** Build the per-bank plan from the library itself. Launches nothing. */
function buildTargets(only) {
  const targets = [];
  for (const companyId of Object.values(CompanyTypes)) {
    if (only && !only.includes(companyId)) continue;
    const scraper = createScraper({ companyId, startDate: new Date() });
    // Some getLoginOptions touch this.page while building (visaCal registers a
    // passive waitForRequest listener). A stub keeps derivation side-effect free.
    scraper.page = { waitForRequest: () => new Promise(() => {}) };
    let opts = null;
    try {
      opts = scraper.getLoginOptions({});
    } catch {
      opts = null;
    }
    if (opts && opts.loginUrl) {
      targets.push({
        companyId,
        mode: "browser",
        scraper,
        loginUrl: opts.loginUrl,
        selector: opts.fields?.[0]?.selector ?? null,
        waitUntil: opts.waitUntil, // recorded only; probe always uses domcontentloaded
        checkReadiness: opts.checkReadiness,
        preAction: opts.preAction,
      });
    } else {
      targets.push({ companyId, mode: "api", loginUrl: API_HOSTS[companyId] ?? scraper.baseUrl ?? null });
    }
  }
  return targets;
}

async function findFormSelector(page, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const frame of page.frames()) {
      try {
        if (await frame.$(selector)) return true;
      } catch {
        // frame navigating/detached; try again next tick
      }
    }
    await sleep(500);
  } while (Date.now() < deadline);
  return false;
}

// Headless Chrome announces itself as "HeadlessChrome"; Cal and Behatsdaa reject
// that UA outright from any IP, which would mask the network differences this
// probe exists to compare. Present the ordinary Chrome UA instead (same version).
async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent((await browser.userAgent()).replace("HeadlessChrome", "Chrome"));
  // Match the library's BaseScraperWithBrowser default viewport. Puppeteer's own
  // 800x600 default flips Cal into its mobile layout, hiding #ccLoginDesktopBtn.
  await page.setViewport({ width: 1024, height: 768 });
  return page;
}

async function probeBrowser(browser, t) {
  const page = await newPage(browser);
  let lastStatus = null;
  page.on("response", (res) => {
    const req = res.request();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) lastStatus = res.status();
  });
  const obs = { mode: "browser", error: null, status: null, formFound: false, title: "", url: "", body: "" };
  try {
    page.setDefaultTimeout(READY_TIMEOUT_MS);
    const res = await page.goto(t.loginUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    obs.status = res ? res.status() : lastStatus;
    // The library's closures read this.page lazily.
    t.scraper.page = page;
    if (t.checkReadiness && SAFE_READINESS.has(t.companyId)) {
      try {
        await withTimeout(t.checkReadiness(), READY_TIMEOUT_MS, "checkReadiness");
      } catch (e) {
        if (NETWORK_RE.test(String(e?.message)) && /net::/.test(String(e?.message))) obs.error = shortMsg(e);
      }
    }
    if (!obs.error && t.preAction && SAFE_PREACTION.has(t.companyId)) {
      try {
        await withTimeout(t.preAction(), READY_TIMEOUT_MS, "preAction"); // frames are searched below
      } catch {
        // fall through: selector check below decides
      }
    }
    if (lastStatus !== null) obs.status = lastStatus;
    if (!obs.error && t.selector) obs.formFound = await findFormSelector(page, t.selector, READY_TIMEOUT_MS);
    obs.url = page.url();
    obs.title = await page.title().catch(() => "");
    obs.body = await page
      .evaluate(() => (document.body ? document.body.innerText.slice(0, 5000) : ""))
      .catch(() => "");
  } catch (e) {
    obs.error = shortMsg(e);
    obs.url = page.url();
  } finally {
    await page.close().catch(() => {});
  }
  return obs;
}

// API-mode: no login form to look for, so a single browser navigation to the
// host and classification on network/status only. A browser (not Node fetch) is
// used because these hosts sit behind bot filters that 403 a bare Node client,
// which would say nothing about reachability.
async function probeApi(browser, t) {
  const page = await newPage(browser);
  const obs = { mode: "api", error: null, status: null, formFound: false, title: "", url: t.loginUrl ?? "", body: "" };
  try {
    const res = await page.goto(t.loginUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    obs.status = res ? res.status() : null;
    obs.url = page.url();
    obs.title = await page.title().catch(() => "");
    obs.body = await page
      .evaluate(() => (document.body ? document.body.innerText.slice(0, 5000) : ""))
      .catch(() => "");
  } catch (e) {
    obs.error = shortMsg(e);
  } finally {
    await page.close().catch(() => {});
  }
  return obs;
}

async function probeOne(browser, t) {
  const start = Date.now();
  let attempts = 0;
  let obs;
  let verdict;
  for (;;) {
    attempts++;
    obs = t.mode === "browser" ? await probeBrowser(browser, t) : await probeApi(browser, t);
    verdict = classify(obs);
    if (verdict === "OK" || attempts >= 2) break;
    await sleep(RETRY_WAIT_MS);
  }
  return {
    company: t.companyId,
    mode: t.mode,
    loginHost: hostOf(t.loginUrl),
    verdict,
    attempts,
    elapsedMs: Date.now() - start,
    finalHost: hostOf(obs.url),
    httpStatus: obs.status,
    ...(verdict === "CHALLENGE" ? { challengeKeyword: findChallengeKeyword(obs) } : {}),
    ...(verdict === "ERROR" || verdict === "NETWORK_BLOCK" ? { error: obs.error } : {}),
  };
}

async function publicIp() {
  try {
    const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(10_000) });
    return (await res.text()).trim();
  } catch (e) {
    return `unknown (${shortMsg(e)})`;
  }
}

function printTable(rows) {
  const cols = ["company", "mode", "loginHost", "verdict", "attempts", "elapsedMs", "finalHost", "httpStatus"];
  const cell = (r, c) => String(r[c] ?? "-");
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r, c).length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join("  ");
  console.log(line(cols));
  for (const r of rows) console.log(line(cols.map((c) => cell(r, c))));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = buildTargets(args.only);
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.MONI_CHROME_PATH,
    args: ["--disable-dev-shm-usage"],
  });
  try {
    const meta = {
      egressIp: await publicIp(),
      hostname: hostname(),
      timestamp: new Date().toISOString(),
      chromeVersion: await browser.version(),
    };
    console.log(`egress ${meta.egressIp} | host ${meta.hostname} | ${meta.chromeVersion} | ${meta.timestamp}`);

    const results = [];
    for (let i = 0; i < targets.length; i++) {
      results.push(await probeOne(browser, targets[i]));
      if (i < targets.length - 1) await sleep(3000 + Math.random() * 5000);
    }
    results.sort((a, b) => a.company.localeCompare(b.company));
    printTable(results);
    if (args.out) {
      writeFileSync(args.out, JSON.stringify({ ...meta, results }, null, 2) + "\n");
      console.log(`wrote ${args.out}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
