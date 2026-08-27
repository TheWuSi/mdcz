import type { Configuration } from "@mdcz/shared/config";
import { configurationSchema, defaultConfiguration } from "@mdcz/shared/config";
import { describe, expect, it, vi } from "vitest";
import { BaseCodeSubtitleCache } from "./BaseCodeSubtitleCache";
import { fetchSubtitleCatSubtitleForNumber } from "./subtitleCatLookup";

const BASE = "https://www.subtitlecat.com/";

const PAGES: Record<string, string> = {
  [`${BASE}index.php?search=ABC-111`]: `<html><body><table><tbody><tr>
      <td><a href="subs/1/abc-111.html">ABC-111</a></td><td>Chinese</td><td>40 KB</td><td>7</td>
    </tr></tbody></table></body></html>`,
  [`${BASE}subs/1/abc-111.html`]: `<html><body>
      <div><a id="download_zh-TW" href="/subs/1/abc-111.zh-TW.srt">Download</a></div>
    </body></html>`,
};

const FILES: Record<string, string> = {
  [`${BASE}subs/1/abc-111.zh-TW.srt`]: "1\n00:00:01,000 --> 00:00:02,000\n你好\n",
};

const createNetworkClient = () => ({
  getText: vi.fn(async (url: string) => {
    const page = PAGES[url];
    if (page === undefined) {
      throw new Error(`HTTP 404 Not Found for ${url}`);
    }
    return page;
  }),
  getContent: vi.fn(async (url: string) => {
    const file = FILES[url];
    if (file === undefined) {
      throw new Error(`HTTP 404 Not Found for ${url}`);
    }
    return new TextEncoder().encode(file);
  }),
});

const createConfiguration = (download: Partial<Configuration["download"]> = {}): Configuration =>
  configurationSchema.parse({
    ...defaultConfiguration,
    download: { ...defaultConfiguration.download, ...download },
  });

describe("fetchSubtitleCatSubtitleForNumber", () => {
  it("honours the traditional Chinese fallback switch", async () => {
    const networkClient = createNetworkClient();

    expect(
      await fetchSubtitleCatSubtitleForNumber({
        configuration: createConfiguration({ subtitleCatFallbackTraditional: false }),
        networkClient,
        number: "ABC-111",
      }),
    ).toBeUndefined();

    expect(
      await fetchSubtitleCatSubtitleForNumber({
        configuration: createConfiguration({ subtitleCatFallbackTraditional: true }),
        networkClient,
        number: "ABC-111",
      }),
    ).toMatchObject({ language: "zh-TW", format: "srt" });
  });

  it("searches once for every variant of the same base code", async () => {
    const networkClient = createNetworkClient();
    const subtitleCache = new BaseCodeSubtitleCache();
    const lookup = async () =>
      await fetchSubtitleCatSubtitleForNumber({
        configuration: createConfiguration(),
        networkClient,
        // `parseFileInfo()` normalizes `ABC-111-C` and `ABC-111-cd2` to this same base code.
        number: "ABC-111",
        subtitleCache,
      });

    const [first, second] = await Promise.all([lookup(), lookup()]);

    expect(first).toBe(second);
    expect(networkClient.getContent).toHaveBeenCalledTimes(1);
    expect(networkClient.getText.mock.calls.filter(([url]) => url === `${BASE}index.php?search=ABC-111`)).toHaveLength(
      1,
    );
  });
});
