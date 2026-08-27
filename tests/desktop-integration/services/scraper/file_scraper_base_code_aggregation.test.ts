import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configurationSchema, defaultConfiguration } from "@main/services/config";
import { PersistentCooldownStore } from "@main/services/cooldown/PersistentCooldownStore";
import { SignalService } from "@main/services/SignalService";
import { DownloadManager } from "@main/services/scraper/DownloadManager";
import { createFileScraper } from "@main/services/scraper/FileScraper";
import type { NfoGenerator } from "@main/services/scraper/NfoGenerator";
import * as scraperOutput from "@main/services/scraper/output";
import type { NetworkClient } from "@mdcz/runtime/network";
import type {
  AggregationService,
  FileOrganizer,
  OrganizePlan,
  PosterBadgeDefinition,
  TranslateService,
} from "@mdcz/runtime/scrape";
import { PosterWatermarkService, ScrapeSessionScope } from "@mdcz/runtime/scrape";
import * as imageUtils from "@mdcz/runtime/scrape/utils/image";
import { Website } from "@mdcz/shared/enums";
import type { CrawlerData, FileInfo } from "@mdcz/shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockConfigManager } from "../../../helpers/scraper";

const SUBTITLE_CAT_BASE = "https://www.subtitlecat.com/";
const SEARCH_URL = `${SUBTITLE_CAT_BASE}index.php?search=ABC-111`;
const DETAIL_URL = `${SUBTITLE_CAT_BASE}subs/1/abc-111.html`;
const SUBTITLE_URL = `${SUBTITLE_CAT_BASE}subs/1/abc-111.zh-CN.srt`;
const POSTER_URL = "https://images.test/abc-111/poster.jpg";
const THUMB_URL = "https://images.test/abc-111/thumb.jpg";
const SUBTITLE_BODY = "1\n00:00:01,000 --> 00:00:02,000\n你好\n";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dirPath = await mkdtemp(join(tmpdir(), "mdcz-base-code-aggregation-"));
  tempDirs.push(dirPath);
  return dirPath;
};

const config = configurationSchema.parse({
  ...defaultConfiguration,
  download: {
    ...defaultConfiguration.download,
    downloadFanart: false,
    downloadSceneImages: false,
    downloadTrailer: false,
    generateNfo: false,
    keepPoster: false,
    keepThumb: false,
    subtitleCat: true,
    tagBadges: true,
    // Narrowed so the assertions read the subtitle variant and the censorship kind without
    // resolution badges in the way.
    tagBadgeTypes: ["subtitle", "umr"],
  },
});

const crawlerData: CrawlerData = {
  title: "Sample Title",
  number: "ABC-111",
  actors: [],
  genres: [],
  scene_images: [],
  poster_url: POSTER_URL,
  thumb_url: THUMB_URL,
  website: Website.DMM,
};

const createAggregationResult = () => ({
  data: crawlerData,
  sources: {},
  imageAlternatives: { thumb_url: [], poster_url: [], fanart_url: [], scene_images: [] },
  stats: {
    totalSites: 1,
    successCount: 1,
    failedCount: 0,
    skippedCount: 0,
    siteResults: [],
    rejectedSites: [],
    totalElapsedMs: 1,
  },
});

const searchPage = `<html><body><table><tbody>
  <tr><td><a href="subs/1/abc-111.html">ABC-111 Chinese</a></td><td>Chinese</td><td>40 KB</td><td>820</td></tr>
</tbody></table></body></html>`;
const detailPage = `<html><body><div><a id="download_zh-CN" href="/subs/1/abc-111.zh-CN.srt">Download</a></div></body></html>`;

class FakeNetworkClient {
  readonly download = vi.fn(async (url: string, outputPath: string) => {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `downloaded:${url}`, "utf8");
    return outputPath;
  });

  readonly probe = vi.fn(async (url: string) => ({ ok: true, status: 200, contentLength: 1_024, resolvedUrl: url }));

  readonly getText = vi.fn(async (url: string) => {
    const pages: Record<string, string> = { [SEARCH_URL]: searchPage, [DETAIL_URL]: detailPage };
    const page = pages[url];
    if (page === undefined) {
      throw new Error(`HTTP 404 Not Found for ${url}`);
    }
    return page;
  });

  readonly getContent = vi.fn(async (url: string) => {
    if (url !== SUBTITLE_URL) {
      throw new Error(`HTTP 404 Not Found for ${url}`);
    }
    return new TextEncoder().encode(SUBTITLE_BODY);
  });
}

const planFor = (root: string, movieBase: string): OrganizePlan => {
  const outputDir = join(root, "output", movieBase);
  return {
    outputDir,
    targetVideoPath: join(outputDir, `${movieBase}.mp4`),
    nfoPath: join(outputDir, `${movieBase}.nfo`),
  };
};

/** Mirrors what `NamingEngine` produces for these markers, so each variant gets its own directory. */
const movieBaseFor = (fileInfo: FileInfo): string => {
  if (fileInfo.filenameUncensoredChoice === "umr") {
    return fileInfo.nativeSubtitled ? "ABC-111-UC" : "ABC-111-U";
  }
  return fileInfo.nativeSubtitled ? "ABC-111-C" : "ABC-111";
};

const labelForPosterPath = (posterPath: string): string => {
  if (posterPath.includes("ABC-111-UC")) return "-UC";
  return posterPath.includes("ABC-111-C") ? "-C" : "plain";
};

const pathExists = async (filePath: string): Promise<boolean> =>
  await stat(filePath).then(
    () => true,
    () => false,
  );

const callsFor = (mock: { mock: { calls: unknown[][] } }, url: string): number =>
  mock.mock.calls.filter(([requested]) => requested === url).length;

describe("same base code aggregation", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0, tempDirs.length).map((dirPath) => rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("downloads metadata, poster and subtitle once for ABC-111, ABC-111-C and ABC-111-UC, then badges each poster copy", async () => {
    const root = await createTempDir();
    mockConfigManager(config);
    vi.spyOn(scraperOutput, "probeVideoMetadataOrWarn").mockResolvedValue({
      durationSeconds: 120,
      width: 1_920,
      height: 1_080,
      bitrate: 1_000_000,
    });
    vi.spyOn(imageUtils, "validateImage").mockResolvedValue({ valid: true, width: 800, height: 1_200 });
    const appliedBadges: Array<{ posterPath: string; labels: string[] }> = [];
    vi.spyOn(PosterWatermarkService.prototype, "applyTagBadges").mockImplementation(
      async (posterPath: string, badges: readonly PosterBadgeDefinition[]) => {
        appliedBadges.push({ posterPath, labels: badges.map((badge) => badge.label) });
      },
    );

    const networkClient = new FakeNetworkClient() as unknown as NetworkClient;
    const aggregate = vi.fn().mockResolvedValue(createAggregationResult());
    const aggregationService = { aggregate } as unknown as AggregationService;
    const sessionScope = new ScrapeSessionScope(aggregationService);
    const downloadManager = new DownloadManager(networkClient, {
      assetCache: sessionScope.assetCache,
      imageHostCooldownStore: new PersistentCooldownStore({
        filePath: join(root, "image-host-cooldowns.json"),
        loggerName: "BaseCodeAggregationTestStore",
      }),
    });
    const fileOrganizer = {
      plan: vi.fn((fileInfo: FileInfo) => planFor(root, movieBaseFor(fileInfo))),
      ensureOutputReady: vi.fn(async (plan: OrganizePlan) => plan),
      organizeVideo: vi.fn(async (_fileInfo: FileInfo, plan: OrganizePlan) => plan.targetVideoPath),
    } as unknown as FileOrganizer;

    const createScraper = () =>
      createFileScraper({
        aggregationService,
        translateService: {
          translateCrawlerData: vi.fn(async (data: CrawlerData) => data),
        } as unknown as TranslateService,
        nfoGenerator: { writeNfo: vi.fn() } as unknown as NfoGenerator,
        downloadManager,
        fileOrganizer,
        signalService: new SignalService(null),
        networkClient,
        sessionScope,
      });

    const videoPaths = [join(root, "ABC-111.mp4"), join(root, "ABC-111-C.mp4"), join(root, "ABC-111-UC.mp4")];
    await Promise.all(videoPaths.map(async (videoPath) => await writeFile(videoPath, "video")));
    sessionScope.groups.seed(videoPaths);

    // Run all three variants concurrently: the per-number gate has to serialize them for the caches to hit.
    const results = await Promise.all(
      videoPaths.map(async (videoPath, index) => {
        try {
          return await createScraper().scrapeFile(videoPath, { fileIndex: index + 1, totalFiles: videoPaths.length });
        } finally {
          sessionScope.groups.complete(videoPath);
        }
      }),
    );

    expect(results.map((result) => result.status)).toEqual(["success", "success", "success"]);
    expect(sessionScope.groups.hasPending()).toBe(false);
    // All three variants normalize to one base code, so metadata, artwork and the subtitle are fetched once.
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(callsFor(networkClient.download as never, POSTER_URL)).toBe(1);
    expect(callsFor(networkClient.download as never, THUMB_URL)).toBe(1);
    expect(callsFor((networkClient as unknown as FakeNetworkClient).getText, SEARCH_URL)).toBe(1);
    expect(callsFor((networkClient as unknown as FakeNetworkClient).getContent, SUBTITLE_URL)).toBe(1);

    // Each task still keeps a private poster copy, which is what lets the badges differ.
    const posterPaths = [
      join(root, "output", "ABC-111", "poster.jpg"),
      join(root, "output", "ABC-111-C", "poster.jpg"),
      join(root, "output", "ABC-111-UC", "poster.jpg"),
    ];
    for (const posterPath of posterPaths) {
      await expect(readFile(posterPath, "utf8")).resolves.toBe(`downloaded:${POSTER_URL}`);
    }
    expect(appliedBadges.map((entry) => entry.posterPath).sort()).toEqual([...posterPaths].sort());
    // `-UC` is UMR with burned-in subtitles, so it must not look like the plain `-C` next door.
    expect(
      appliedBadges.map((entry) => `${labelForPosterPath(entry.posterPath)}:${entry.labels.join()}`).sort(),
    ).toEqual(["-C:内嵌中字", "-UC:内嵌中字,破解", "plain:外挂中字"].sort());

    // The `-C` and `-UC` sources already carry burned-in subtitles, so only the plain variant writes
    // a sidecar.
    await expect(pathExists(join(root, "output", "ABC-111", "ABC-111.zh-CN.subcat.srt"))).resolves.toBe(true);
    await expect(readFile(join(root, "output", "ABC-111", "ABC-111.zh-CN.subcat.srt"), "utf8")).resolves.toBe(
      SUBTITLE_BODY,
    );
    await expect(pathExists(join(root, "output", "ABC-111-C", "ABC-111-C.zh-CN.subcat.srt"))).resolves.toBe(false);
    await expect(pathExists(join(root, "output", "ABC-111-UC", "ABC-111-UC.zh-CN.subcat.srt"))).resolves.toBe(false);

    await sessionScope.dispose();
  });

  it("keeps caches private to a scope so a later session refetches everything", async () => {
    const root = await createTempDir();
    mockConfigManager(config);
    vi.spyOn(scraperOutput, "probeVideoMetadataOrWarn").mockResolvedValue({
      durationSeconds: 120,
      width: 1_920,
      height: 1_080,
    });
    vi.spyOn(imageUtils, "validateImage").mockResolvedValue({ valid: true, width: 800, height: 1_200 });
    vi.spyOn(PosterWatermarkService.prototype, "applyTagBadges").mockResolvedValue(undefined);

    const networkClient = new FakeNetworkClient() as unknown as NetworkClient;
    const aggregate = vi.fn().mockResolvedValue(createAggregationResult());
    const aggregationService = { aggregate } as unknown as AggregationService;
    const cooldownStore = new PersistentCooldownStore({
      filePath: join(root, "image-host-cooldowns.json"),
      loggerName: "BaseCodeAggregationTestStore",
    });
    const videoPath = join(root, "ABC-111.mp4");
    await writeFile(videoPath, "video");

    const scrapeOnce = async (attempt: number): Promise<void> => {
      const sessionScope = new ScrapeSessionScope(aggregationService);
      const plan = planFor(join(root, `attempt-${attempt}`), "ABC-111");
      const scraper = createFileScraper({
        aggregationService,
        translateService: {
          translateCrawlerData: vi.fn(async (data: CrawlerData) => data),
        } as unknown as TranslateService,
        nfoGenerator: { writeNfo: vi.fn() } as unknown as NfoGenerator,
        downloadManager: new DownloadManager(networkClient, {
          assetCache: sessionScope.assetCache,
          imageHostCooldownStore: cooldownStore,
        }),
        fileOrganizer: {
          plan: vi.fn(() => plan),
          ensureOutputReady: vi.fn(async () => plan),
          organizeVideo: vi.fn(async () => plan.targetVideoPath),
        } as unknown as FileOrganizer,
        signalService: new SignalService(null),
        networkClient,
        sessionScope,
      });

      const result = await scraper.scrapeFile(videoPath, { fileIndex: 1, totalFiles: 1 });
      expect(result.status).toBe("success");
      const cachedPosterPath = join(dirname(plan.nfoPath), "poster.jpg");
      await expect(pathExists(cachedPosterPath)).resolves.toBe(true);
      await sessionScope.dispose();
    };

    await scrapeOnce(1);
    await scrapeOnce(2);

    // A re-scrape must see live metadata and live artwork, never the previous session's copies.
    expect(aggregate).toHaveBeenCalledTimes(2);
    expect(callsFor(networkClient.download as never, POSTER_URL)).toBe(2);
    expect(callsFor((networkClient as unknown as FakeNetworkClient).getText, SEARCH_URL)).toBe(2);
  });
});
