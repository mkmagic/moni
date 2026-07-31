import { describe, expect, it } from "vitest";
import { redactSecrets } from "@/lib/redact-secrets";

describe("redactSecrets", () => {
  it("replaces every non-empty secret", () => {
    const message = 'id: "national-id", cardSuffix: "1234", password: "pw"';

    expect(redactSecrets(message, ["national-id", "1234", "pw"])).toBe(
      'id: "[redacted]", cardSuffix: "[redacted]", password: "[redacted]"',
    );
  });

  it("replaces longer secrets before secrets they contain", () => {
    expect(redactSecrets("request body contains abc123", ["abc", "abc123"])).toBe(
      "request body contains [redacted]",
    );
  });

  it("replaces JSON-escaped secrets", () => {
    expect(redactSecrets('{"password":"p\\\"w"}', ['p"w'])).toBe('{"password":"[redacted]"}');
  });

  it("ignores empty secrets", () => {
    expect(redactSecrets("unchanged", [""])).toBe("unchanged");
  });
});
