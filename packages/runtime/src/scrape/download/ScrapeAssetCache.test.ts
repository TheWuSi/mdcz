import { readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type CachedScrapeAsset, ScrapeAssetCache } from "./ScrapeAssetCache";

const asset = (path: string, overrides: Partial<CachedScrapeAsset> = {}): CachedScrapeAsset => ({
  path,
  width: 800,
  height: 1_200,
  format: "jpeg",
  ...overrides,
});

/** Stands in for the real copy: records the path the cache allocated and writes the bytes there. */
const copyInto = (recorder: string[]) => async (targetPath: string) => {
  recorder.push(targetPath);
  await writeFile(targetPath, "poster-bytes", "utf8");
  return targetPath;
};

const pathExists = async (filePath: string): Promise<boolean> =>
  await stat(filePath).then(
    () => true,
    () => false,
  );

describe("ScrapeAssetCache", () => {
  it("memoizes an in-flight request so siblings await it instead of downloading again", async () => {
    const cache = new ScrapeAssetCache();
    expect(cache.get("https://cdn.test/poster.jpg")).toBeUndefined();

    const request = Promise.resolve(asset("/tmp/poster.jpg"));
    cache.track("https://cdn.test/poster.jpg", request);

    // Surrounding whitespace must not open a second entry for the same URL.
    await expect(cache.get("  https://cdn.test/poster.jpg  ")).resolves.toMatchObject({ path: "/tmp/poster.jpg" });
    await cache.dispose();
  });

  it("forgets a failed request so the next task may retry it", async () => {
    const cache = new ScrapeAssetCache();
    const failed = Promise.resolve(null);
    cache.track("https://cdn.test/poster.jpg", failed);
    await failed;

    expect(cache.get("https://cdn.test/poster.jpg")).toBeUndefined();

    const rejected = Promise.reject(new Error("boom"));
    cache.track("https://cdn.test/fanart.jpg", rejected);
    await rejected.catch(() => undefined);

    expect(cache.get("https://cdn.test/fanart.jpg")).toBeUndefined();
    await cache.dispose();
  });

  it("keeps the copied bytes under a session directory named after the image format", async () => {
    const cache = new ScrapeAssetCache();
    const allocated: string[] = [];

    const jpeg = await cache.put("https://cdn.test/poster.jpg", asset("/tmp/poster.jpg"), copyInto(allocated));
    const png = await cache.put(
      "https://cdn.test/fanart.png",
      asset("/tmp/fanart.png", { format: "png", width: 1_920, height: 1_080 }),
      copyInto(allocated),
    );
    const unknownFormat = await cache.put(
      "https://cdn.test/thumb",
      asset("/tmp/thumb", { format: undefined }),
      copyInto(allocated),
    );

    expect(jpeg).toMatchObject({ width: 800, height: 1_200, format: "jpeg" });
    expect(png).toMatchObject({ width: 1_920, height: 1_080, format: "png" });
    // Every asset gets its own file, so one task cropping its copy cannot disturb another's.
    expect(new Set(allocated).size).toBe(3);
    expect(jpeg?.path).toMatch(/[/\\]mdcz-asset-[^/\\]+[/\\]asset-1\.jpg$/u);
    expect(png?.path).toMatch(/asset-2\.png$/u);
    expect(unknownFormat?.path).toMatch(/asset-3\.img$/u);
    await expect(readFile(jpeg?.path ?? "", "utf8")).resolves.toBe("poster-bytes");

    await cache.dispose();
    // The directory is per session on purpose: a later re-scrape must see live artwork.
    await expect(pathExists(jpeg?.path ?? "")).resolves.toBe(false);
  });

  it("reports a failed copy as a cache miss instead of a broken entry", async () => {
    const cache = new ScrapeAssetCache();
    const cached = await cache.put("https://cdn.test/poster.jpg", asset("/tmp/poster.jpg"), async () => null);

    expect(cached).toBeNull();
    expect(cache.get("https://cdn.test/poster.jpg")).toBeUndefined();
    await cache.dispose();
  });

  it("degrades to plain uncached downloads once disposed", async () => {
    const cache = new ScrapeAssetCache();
    await cache.dispose();

    const allocated: string[] = [];
    await expect(cache.put("https://cdn.test/poster.jpg", asset("/tmp/poster.jpg"), copyInto(allocated))).resolves.toBe(
      null,
    );
    cache.track("https://cdn.test/poster.jpg", Promise.resolve(asset("/tmp/poster.jpg")));

    expect(allocated).toEqual([]);
    expect(cache.get("https://cdn.test/poster.jpg")).toBeUndefined();
    // A second dispose must stay harmless: session teardown can race with a straggling file.
    await expect(cache.dispose()).resolves.toBeUndefined();
  });
});
