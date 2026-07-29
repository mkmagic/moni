// src/lib/transport.ts and the HTTPS-only gate built on it — Moni's HTTPS-only
// gate and the app→Postgres TLS guard (issue #16, threat-model §8). All pure
// functions, so exercised directly rather than through a running server.
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { assertDatabaseTls, isLoopbackHost, isTransportAcceptable } from "@/lib/transport";
import { proxy } from "@/proxy";

describe("isLoopbackHost", () => {
  it("recognizes loopback names with and without a port", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("localhost:3000")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:3000")).toBe(true);
    expect(isLoopbackHost("[::1]:3000")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("rejects everything else, including a missing Host", () => {
    expect(isLoopbackHost("moni.example.ts.net")).toBe(false);
    expect(isLoopbackHost("192.168.1.20:3000")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });

  it("is not fooled by a hostname that merely contains a loopback name", () => {
    // The whole point of the exemption is that the request never left the box.
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
    expect(isLoopbackHost("notlocalhost")).toBe(false);
  });
});

describe("isTransportAcceptable", () => {
  it("accepts a proxied HTTPS request", () => {
    expect(isTransportAcceptable("moni.example.ts.net", "https")).toBe(true);
  });

  it("fails closed when the proxy header is missing", () => {
    // Missing is a rejection, not a maybe — this is the case where the app is
    // exposed directly instead of through Caddy.
    expect(isTransportAcceptable("moni.example.ts.net", null)).toBe(false);
  });

  it("rejects an explicitly plaintext hop", () => {
    expect(isTransportAcceptable("moni.example.ts.net", "http")).toBe(false);
  });

  it("reads the client-facing hop from a chained proxy list", () => {
    expect(isTransportAcceptable("moni.example.ts.net", "https, http")).toBe(true);
    expect(isTransportAcceptable("moni.example.ts.net", "http, https")).toBe(false);
  });

  it("tolerates casing and padding", () => {
    expect(isTransportAcceptable("moni.example.ts.net", "  HTTPS  ")).toBe(true);
  });

  it("exempts loopback so `npm run dev` works without a proxy", () => {
    expect(isTransportAcceptable("localhost:3000", null)).toBe(true);
  });
});

describe("proxy", () => {
  const request = (host: string, forwardedProto?: string) =>
    new NextRequest("https://moni.example.ts.net/dashboard", {
      headers: forwardedProto ? { host, "x-forwarded-proto": forwardedProto } : { host },
    });

  it("passes a proxied HTTPS request through", () => {
    const res = proxy(request("moni.example.ts.net", "https"));
    expect(res.status).toBe(200);
  });

  it("rejects a plaintext request rather than redirecting it", () => {
    // A 3xx here would mean the cookie had already crossed the wire.
    const res = proxy(request("moni.example.ts.net", "http"));
    expect(res.status).toBe(400);
  });

  it("rejects when no proxy header is present at all", () => {
    const res = proxy(request("moni.example.ts.net"));
    expect(res.status).toBe(400);
  });

  it("lets loopback dev requests through", () => {
    const res = proxy(request("localhost:3000"));
    expect(res.status).toBe(200);
  });
});

describe("assertDatabaseTls", () => {
  it("allows a loopback database with no sslmode at all", () => {
    expect(() => assertDatabaseTls("postgresql://moni_app:pw@localhost:5432/moni")).not.toThrow();
    expect(() =>
      assertDatabaseTls("postgresql://moni_app:pw@127.0.0.1:5432/moni?sslmode=disable"),
    ).not.toThrow();
  });

  it("allows a remote database with sslmode=verify-full", () => {
    expect(() =>
      assertDatabaseTls("postgresql://moni_app:pw@db.example.com:5432/moni?sslmode=verify-full"),
    ).not.toThrow();
  });

  it("refuses a remote database with no sslmode", () => {
    expect(() => assertDatabaseTls("postgresql://moni_app:pw@db.example.com:5432/moni")).toThrow(
      /verify-full/,
    );
  });

  it("refuses sslmode=require, which encrypts without verifying identity", () => {
    expect(() =>
      assertDatabaseTls("postgresql://moni_app:pw@db.example.com:5432/moni?sslmode=require"),
    ).toThrow(/verify-full/);
  });

  it("never puts the connection string in the error message", () => {
    // The URL carries the database password; this error is destined for logs.
    let message = "";
    try {
      assertDatabaseTls("postgresql://moni_app:hunter2@db.example.com:5432/moni");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("moni_app");
  });

  it("defers to the driver for an absent or malformed URL", () => {
    expect(() => assertDatabaseTls(undefined)).not.toThrow();
    expect(() => assertDatabaseTls("not-a-url")).not.toThrow();
  });
});
