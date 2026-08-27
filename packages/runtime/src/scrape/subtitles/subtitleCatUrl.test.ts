import { describe, expect, it } from "vitest";
import {
  buildSubtitleCatSearchUrl,
  isUnsafeSubtitleCatHost,
  resolveSubtitleCatUrl,
  SUBTITLE_CAT_BASE_URL,
} from "./subtitleCatUrl";

describe("resolveSubtitleCatUrl", () => {
  it("resolves site-relative hrefs against the provider base", () => {
    expect(resolveSubtitleCatUrl(SUBTITLE_CAT_BASE_URL, "subs/1234/abc-111.html").toString()).toBe(
      "https://www.subtitlecat.com/subs/1234/abc-111.html",
    );
    expect(resolveSubtitleCatUrl(SUBTITLE_CAT_BASE_URL, "/subs/1234/abc-111.html").toString()).toBe(
      "https://www.subtitlecat.com/subs/1234/abc-111.html",
    );
  });

  it("rejects references that would leave the provider origin", () => {
    for (const reference of [
      "",
      "   ",
      "http://www.subtitlecat.com/subs/1.html",
      "https://evil.example/subs/1.html",
      "//evil.example/subs/1.html",
      "subs\\1.html",
      "javascript:alert(1)",
    ]) {
      expect(() => resolveSubtitleCatUrl(SUBTITLE_CAT_BASE_URL, reference)).toThrow(/Unsafe SubtitleCat URL/u);
    }
  });

  it("rejects path traversal, including percent-encoded segments", () => {
    for (const reference of ["../etc/passwd", "subs/../../etc/passwd", "subs/%2e%2e/secret", "subs/./x.html"]) {
      expect(() => resolveSubtitleCatUrl(SUBTITLE_CAT_BASE_URL, reference)).toThrow(/Unsafe SubtitleCat URL/u);
    }
  });

  it("rejects a base pointing at a private address", () => {
    expect(() => resolveSubtitleCatUrl("http://127.0.0.1/", "subs/1.html")).toThrow(/private address/u);
    expect(() => resolveSubtitleCatUrl("http://192.168.1.10/", "subs/1.html")).toThrow(/private address/u);
  });

  it("percent-encodes the search term", () => {
    expect(buildSubtitleCatSearchUrl(SUBTITLE_CAT_BASE_URL, "  ABC-111  ").toString()).toBe(
      "https://www.subtitlecat.com/index.php?search=ABC-111",
    );
    expect(buildSubtitleCatSearchUrl(SUBTITLE_CAT_BASE_URL, "ABC 111&x=1").searchParams.get("search")).toBe(
      "ABC 111&x=1",
    );
  });
});

describe("isUnsafeSubtitleCatHost", () => {
  it("flags loopback, private, link-local and multicast literals", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "0.0.0.0",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.169.254",
      "224.0.0.1",
      "::1",
      "::",
      "[::1]",
      "fe80::1",
      "fc00::1",
      "ff02::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isUnsafeSubtitleCatHost(host), host).toBe(true);
    }
  });

  it("allows public hosts", () => {
    for (const host of ["www.subtitlecat.com", "8.8.8.8", "172.32.0.1", "2001:db8::1"]) {
      expect(isUnsafeSubtitleCatHost(host), host).toBe(false);
    }
  });
});
