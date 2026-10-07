// Unit tests for the pure verdict function of the credential-free bank
// reachability probe (scripts/scraper-test/reachability-probe.mjs).
import { describe, expect, it } from "vitest";
import { classify, findChallengeKeyword } from "../../scripts/scraper-test/reachability-probe.mjs";

const base = { mode: "browser", status: 200, formFound: false, title: "", url: "", body: "" };

describe("reachability probe classify", () => {
  it("OK when the login form selector was found", () => {
    expect(classify({ ...base, formFound: true })).toBe("OK");
  });

  it("OK wins over incidental captcha words when the form is present", () => {
    expect(classify({ ...base, formFound: true, body: "protected by hCaptcha" })).toBe("OK");
  });

  it.each([
    "net::ERR_CONNECTION_TIMED_OUT at https://start.telebank.co.il/",
    "net::ERR_CONNECTION_REFUSED",
    "net::ERR_CONNECTION_RESET",
    "net::ERR_NAME_NOT_RESOLVED",
    "Navigation timeout of 45000 ms exceeded",
    "ETIMEDOUT",
    "ECONNREFUSED",
  ])("NETWORK_BLOCK for transport failure: %s", (error) => {
    expect(classify({ ...base, status: null, error })).toBe("NETWORK_BLOCK");
  });

  it("ERROR for an unrecognised failure", () => {
    expect(classify({ ...base, status: null, error: "Protocol error: boom" })).toBe("ERROR");
  });

  it("HTTP_<status> for a >= 400 main response", () => {
    expect(classify({ ...base, status: 503 })).toBe("HTTP_503");
    expect(classify({ ...base, status: 404 })).toBe("HTTP_404");
  });

  it.each([
    ["body", { body: "Access Denied - you don't have permission" }, "access denied"],
    ["title", { title: "Just a moment..." }, "just a moment"],
    ["url", { url: "https://validate.perfdrive.com/x" }, "perfdrive"],
    ["body", { body: "Request Rejected" }, "request rejected"],
  ])("CHALLENGE from %s", (_where, patch, keyword) => {
    expect(classify({ ...base, ...patch })).toBe("CHALLENGE");
    expect(findChallengeKeyword({ ...base, ...patch })).toBe(keyword);
  });

  it("a 403 block page is CHALLENGE, not HTTP_403", () => {
    expect(classify({ ...base, status: 403, body: "Access Denied" })).toBe("CHALLENGE");
  });

  it("NO_FORM when the page loaded but nothing matched", () => {
    expect(classify({ ...base, body: "welcome" })).toBe("NO_FORM");
  });

  it("api mode: any non-error response below 400 is OK", () => {
    expect(classify({ ...base, mode: "api", status: 200 })).toBe("OK");
    expect(classify({ ...base, mode: "api", status: 302 })).toBe("OK");
    expect(classify({ ...base, mode: "api", status: 404 })).toBe("HTTP_404");
  });
});
