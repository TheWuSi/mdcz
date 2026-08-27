import { describe, expect, it, vi } from "vitest";
import { SubtitleCatService } from "./SubtitleCatService";
import { SUBTITLE_CAT_PAGE_LIMIT } from "./subtitleCatHttp";

const BASE = "https://www.subtitlecat.com/";

const searchRow = (input: { href: string; title: string; downloads: number; downvoted?: boolean }): string => `
  <tr>
    <td><a href="${input.href}">${input.title}</a>${input.downvoted ? '<i class="fas fa-thumbs-down"></i>' : ""}</td>
    <td>Chinese</td><td>40 KB</td><td>${input.downloads}</td>
  </tr>`;

const searchPage = (rows: string[]): string =>
  `<html><body><table><tbody>${rows.join("")}</tbody></table></body></html>`;

const detailPage = (links: { "zh-CN"?: string; "zh-TW"?: string }): string =>
  `<html><body>${Object.entries(links)
    .map(([language, href]) => `<div><a id="download_${language}" href="${href}">Download</a></div>`)
    .join("")}</body></html>`;

const createNetworkClient = (pages: Record<string, string>, files: Record<string, string | Uint8Array> = {}) => {
  const requestedUrls: string[] = [];

  return {
    requestedUrls,
    getText: vi.fn(async (url: string) => {
      requestedUrls.push(url);
      const page = pages[url];
      if (page === undefined) {
        throw new Error(`HTTP 404 Not Found for ${url}`);
      }
      return page;
    }),
    getContent: vi.fn(async (url: string) => {
      requestedUrls.push(url);
      const file = files[url];
      if (file === undefined) {
        throw new Error(`HTTP 404 Not Found for ${url}`);
      }
      return typeof file === "string" ? new TextEncoder().encode(file) : file;
    }),
  };
};

const collectWarnings = () => {
  const warnings: string[] = [];
  return {
    warnings,
    logger: { debug: () => {}, error: () => {}, info: () => {}, warn: (message: string) => warnings.push(message) },
  };
};

describe("SubtitleCatService.search", () => {
  it("ranks title matches first, then simplified Chinese, then download count", async () => {
    const networkClient = createNetworkClient({
      [`${BASE}index.php?search=ABC-111`]: searchPage([
        searchRow({ href: "subs/1/unrelated.html", title: "Totally other movie", downloads: 9000 }),
        searchRow({ href: "subs/2/low.html", title: "ABC-111 low seed", downloads: 5 }),
        searchRow({ href: "subs/3/high.html", title: "ABC-111 popular", downloads: 800 }),
      ]),
      [`${BASE}subs/1/unrelated.html`]: detailPage({ "zh-CN": "/subs/1/unrelated.zh-CN.srt" }),
      [`${BASE}subs/2/low.html`]: detailPage({ "zh-CN": "/subs/2/low.zh-CN.srt" }),
      [`${BASE}subs/3/high.html`]: detailPage({ "zh-CN": "/subs/3/high.zh-CN.srt", "zh-TW": "/subs/3/high.zh-TW.srt" }),
    });

    const candidates = await new SubtitleCatService({ networkClient }).search("ABC-111");

    expect(candidates.map((candidate) => `${candidate.detailPath}:${candidate.language}`)).toEqual([
      "subs/3/high.html:zh-CN",
      "subs/2/low.html:zh-CN",
      "subs/3/high.html:zh-TW",
      "subs/1/unrelated.html:zh-CN",
    ]);
  });

  it("drops traditional Chinese when the fallback is disabled", async () => {
    const networkClient = createNetworkClient({
      [`${BASE}index.php?search=ABC-111`]: searchPage([
        searchRow({ href: "subs/1/tw-only.html", title: "ABC-111", downloads: 10 }),
      ]),
      [`${BASE}subs/1/tw-only.html`]: detailPage({ "zh-TW": "/subs/1/tw-only.zh-TW.srt" }),
    });

    expect(await new SubtitleCatService({ networkClient, fallbackTraditional: false }).search("ABC-111")).toEqual([]);
    expect(await new SubtitleCatService({ networkClient, fallbackTraditional: true }).search("ABC-111")).toHaveLength(
      1,
    );
  });

  it("skips a row whose detail page cannot be fetched instead of failing the search", async () => {
    const { logger, warnings } = collectWarnings();
    const networkClient = createNetworkClient({
      [`${BASE}index.php?search=ABC-111`]: searchPage([
        searchRow({ href: "subs/1/gone.html", title: "ABC-111 gone", downloads: 900 }),
        searchRow({ href: "subs/2/ok.html", title: "ABC-111 ok", downloads: 1 }),
      ]),
      [`${BASE}subs/2/ok.html`]: detailPage({ "zh-CN": "/subs/2/ok.zh-CN.srt" }),
    });

    const candidates = await new SubtitleCatService({ networkClient, logger }).search("ABC-111");

    expect(candidates.map((candidate) => candidate.detailPath)).toEqual(["subs/2/ok.html"]);
    expect(warnings.some((warning) => warning.includes("subs/1/gone.html"))).toBe(true);
  });

  it("makes no request for a blank number", async () => {
    const networkClient = createNetworkClient({});

    expect(await new SubtitleCatService({ networkClient }).search("   ")).toEqual([]);
    expect(networkClient.getText).not.toHaveBeenCalled();
  });

  it("refuses an oversized page", async () => {
    const networkClient = createNetworkClient({
      [`${BASE}index.php?search=ABC-111`]: "x".repeat(SUBTITLE_CAT_PAGE_LIMIT + 1),
    });

    await expect(new SubtitleCatService({ networkClient }).search("ABC-111")).rejects.toThrow(/exceeded/u);
  });
});

describe("SubtitleCatService.fetchBestSubtitle", () => {
  it("returns the first candidate that downloads cleanly", async () => {
    const networkClient = createNetworkClient(
      {
        [`${BASE}index.php?search=ABC-111`]: searchPage([
          searchRow({ href: "subs/1/first.html", title: "ABC-111 first", downloads: 900 }),
          searchRow({ href: "subs/2/second.html", title: "ABC-111 second", downloads: 10 }),
        ]),
        [`${BASE}subs/1/first.html`]: detailPage({ "zh-CN": "/subs/1/first.zh-CN.srt" }),
        [`${BASE}subs/2/second.html`]: detailPage({ "zh-CN": "/subs/2/second.zh-CN.ass" }),
      },
      { [`${BASE}subs/2/second.zh-CN.ass`]: "[Script Info]" },
    );
    const { logger, warnings } = collectWarnings();

    const subtitle = await new SubtitleCatService({ networkClient, logger }).fetchBestSubtitle("ABC-111");

    expect(subtitle).toEqual({ language: "zh-CN", format: "ass", content: Buffer.from("[Script Info]") });
    expect(warnings.some((warning) => warning.includes("first"))).toBe(true);
  });

  it("rejects an HTML error page served as a subtitle and falls through", async () => {
    const networkClient = createNetworkClient(
      {
        [`${BASE}index.php?search=ABC-111`]: searchPage([
          searchRow({ href: "subs/1/html.html", title: "ABC-111 html", downloads: 900 }),
          searchRow({ href: "subs/2/real.html", title: "ABC-111 real", downloads: 10 }),
        ]),
        [`${BASE}subs/1/html.html`]: detailPage({ "zh-CN": "/subs/1/html.zh-CN.srt" }),
        [`${BASE}subs/2/real.html`]: detailPage({ "zh-CN": "/subs/2/real.zh-CN.srt" }),
      },
      {
        [`${BASE}subs/1/html.zh-CN.srt`]: "<!DOCTYPE html>\n<html><body>Not found</body></html>",
        [`${BASE}subs/2/real.zh-CN.srt`]: "1\n00:00:01,000 --> 00:00:02,000\n你好\n",
      },
    );
    const { logger, warnings } = collectWarnings();

    const subtitle = await new SubtitleCatService({ networkClient, logger }).fetchBestSubtitle("ABC-111");

    expect(subtitle?.content.toString("utf8")).toContain("你好");
    expect(warnings.some((warning) => warning.includes("HTML"))).toBe(true);
  });

  it("resolves to undefined instead of throwing when nothing works", async () => {
    const { logger, warnings } = collectWarnings();
    const networkClient = createNetworkClient({});

    expect(await new SubtitleCatService({ networkClient, logger }).fetchBestSubtitle("ABC-111")).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("search failed"))).toBe(true);
  });

  it("fetches each detail page once even when it yields two languages", async () => {
    const networkClient = createNetworkClient(
      {
        [`${BASE}index.php?search=ABC-111`]: searchPage([
          searchRow({ href: "subs/1/both.html", title: "ABC-111", downloads: 5 }),
        ]),
        [`${BASE}subs/1/both.html`]: detailPage({ "zh-CN": "/subs/1/a.zh-CN.srt", "zh-TW": "/subs/1/a.zh-TW.srt" }),
      },
      { [`${BASE}subs/1/a.zh-CN.srt`]: "1\n00:00:01,000 --> 00:00:02,000\nhi\n" },
    );

    await new SubtitleCatService({ networkClient }).fetchBestSubtitle("ABC-111");

    expect(networkClient.requestedUrls.filter((url) => url === `${BASE}subs/1/both.html`)).toHaveLength(1);
  });
});
