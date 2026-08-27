import { Website } from "@mdcz/shared/enums";
import { POSTER_TAG_BADGE_TYPE_OPTIONS } from "@mdcz/shared/posterBadges";
import type { CrawlerData, FileInfo, NfoLocalState } from "@mdcz/shared/types";
import { describe, expect, it } from "vitest";
import { resolvePosterBadgeDefinitions } from "./posterBadges";
import { parseFileInfo } from "./utils/number";

const createCrawlerData = (overrides: Partial<CrawlerData> = {}): CrawlerData => ({
  title: "Sample",
  number: "ABC-123",
  actors: [],
  genres: [],
  scene_images: [],
  website: Website.DMM,
  ...overrides,
});

const createFileInfo = (overrides: Partial<FileInfo> = {}): FileInfo => ({
  filePath: "/tmp/ABC-123.mp4",
  fileName: "ABC-123.mp4",
  extension: ".mp4",
  number: "ABC-123",
  isSubtitled: false,
  ...overrides,
});

const badgeIds = (data: CrawlerData, fileInfo?: FileInfo, localState?: NfoLocalState): string[] =>
  resolvePosterBadgeDefinitions(data, fileInfo, localState, POSTER_TAG_BADGE_TYPE_OPTIONS).map(
    (definition) => definition.id,
  );

describe("resolvePosterBadgeDefinitions", () => {
  it("resolves subtitle, censored, and 4K badges in stable definition order", () => {
    expect(
      badgeIds(
        createCrawlerData(),
        createFileInfo({ isSubtitled: true, subtitleTag: "中文字幕", resolution: " 2160p " }),
      ),
    ).toEqual(["subtitle", "censored", "fourK"]);
  });

  it("resolves local uncensored choices without also classifying the movie as censored", () => {
    expect(badgeIds(createCrawlerData(), createFileInfo(), { uncensoredChoice: "umr" })).toEqual(["umr"]);
    expect(badgeIds(createCrawlerData(), createFileInfo(), { uncensoredChoice: "leak" })).toEqual(["leak"]);
    expect(badgeIds(createCrawlerData(), createFileInfo(), { uncensoredChoice: "uncensored" })).toEqual(["uncensored"]);
  });

  it("resolves metadata classifications and supported display resolutions", () => {
    expect(badgeIds(createCrawlerData({ genres: ["流出"] }), createFileInfo({ resolution: "1080P" }))).toEqual([
      "leak",
      "fullHd",
    ]);
    expect(badgeIds(createCrawlerData({ number: "FC2-12345" }), createFileInfo({ resolution: "8k" }))).toEqual([
      "uncensored",
      "eightK",
    ]);
    expect(badgeIds(createCrawlerData(), createFileInfo({ resolution: "4K" }))).toEqual(["censored", "fourK"]);
  });

  it("badges a `-UC` source as UMR plus embedded subtitles", () => {
    // The three same-number variants have to end up visually distinct, which is the whole point of
    // keeping `-UC` out of the plain `-C` bucket.
    expect(
      resolvePosterBadgeDefinitions(
        createCrawlerData(),
        parseFileInfo("/tmp/ABC-123-UC.mp4"),
        undefined,
        POSTER_TAG_BADGE_TYPE_OPTIONS,
      ),
    ).toEqual([
      expect.objectContaining({ id: "subtitle", label: "内嵌中字" }),
      expect.objectContaining({ id: "umr", label: "破解" }),
    ]);
    expect(badgeIds(createCrawlerData(), parseFileInfo("/tmp/ABC-123-C.mp4"))).toEqual(["subtitle", "censored"]);
    expect(badgeIds(createCrawlerData(), parseFileInfo("/tmp/ABC-123.mp4"))).toEqual(["censored"]);
  });

  it("uses local tags without file information and honors the enabled type filter", () => {
    const data = createCrawlerData();
    const localState = { tags: ["中字", "破解"] };

    expect(resolvePosterBadgeDefinitions(data, undefined, localState, ["subtitle", "uncensored"])).toEqual([
      expect.objectContaining({ id: "subtitle", label: "外挂中字" }),
    ]);
    expect(resolvePosterBadgeDefinitions(data, undefined, undefined, [])).toEqual([]);
  });

  it("labels the subtitle badge by variant and prefers the matching variant images", () => {
    const embedded = resolvePosterBadgeDefinitions(
      createCrawlerData(),
      createFileInfo({ isSubtitled: true, subtitleTag: "中文字幕", nativeSubtitled: true, subtitleOrigin: "embedded" }),
      undefined,
      ["subtitle"],
    );
    const external = resolvePosterBadgeDefinitions(
      createCrawlerData(),
      createFileInfo({
        isSubtitled: true,
        subtitleTag: "中文字幕",
        nativeSubtitled: false,
        subtitleOrigin: "external",
      }),
      undefined,
      ["subtitle"],
    );

    expect(embedded).toEqual([
      expect.objectContaining({
        id: "subtitle",
        label: "内嵌中字",
        // Two-image mode first, then the single-image compatibility names.
        imageBasenames: ["sub_embedded", "subtitle_embedded", "内嵌中字", "sub", "subtitle", "中字"],
      }),
    ]);
    expect(external).toEqual([
      expect.objectContaining({
        id: "subtitle",
        label: "外挂中字",
        imageBasenames: ["sub_external", "subtitle_external", "外挂中字", "sub", "subtitle", "中字"],
      }),
    ]);
  });

  it("derives the subtitle variant from the native marker when no origin was recorded", () => {
    // `-C` sources that never reached `resolveFileInfoWithSubtitles()` only carry `nativeSubtitled`.
    expect(
      resolvePosterBadgeDefinitions(
        createCrawlerData(),
        createFileInfo({ isSubtitled: true, subtitleTag: "中文字幕", nativeSubtitled: true }),
        undefined,
        ["subtitle"],
      ),
    ).toEqual([expect.objectContaining({ label: "内嵌中字" })]);
    expect(
      resolvePosterBadgeDefinitions(
        createCrawlerData(),
        createFileInfo({ isSubtitled: true, subtitleTag: "中文字幕" }),
        undefined,
        ["subtitle"],
      ),
    ).toEqual([expect.objectContaining({ label: "外挂中字" })]);
  });

  it("leaves other badge labels and image lookups untouched", () => {
    const [leak] = resolvePosterBadgeDefinitions(createCrawlerData({ genres: ["流出"] }), createFileInfo(), undefined, [
      "leak",
    ]);

    expect(leak).toMatchObject({ id: "leak", label: "流出" });
    expect(leak).not.toHaveProperty("imageBasenames");
  });
});
