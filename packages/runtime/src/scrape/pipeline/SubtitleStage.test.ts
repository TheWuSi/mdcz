import type { Configuration } from "@mdcz/shared/config";
import { configurationSchema, defaultConfiguration } from "@mdcz/shared/config";
import { describe, expect, it, vi } from "vitest";
import type { DownloadedSubtitle } from "../subtitles/types";
import { ScrapeContext } from "./ScrapeContext";
import { SubtitleStage } from "./SubtitleStage";
import type { FileScraperStageRuntime } from "./types";

const createConfiguration = (download: Partial<Configuration["download"]> = {}): Configuration =>
  configurationSchema.parse({
    ...defaultConfiguration,
    download: { ...defaultConfiguration.download, ...download },
  });

const SUBTITLE: DownloadedSubtitle = {
  language: "zh-CN",
  format: "srt",
  content: Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n你好\n"),
};

const createRuntime = (
  fetchSubtitleCatSubtitle?: FileScraperStageRuntime["fetchSubtitleCatSubtitle"],
): {
  logs: string[];
  runtime: FileScraperStageRuntime;
  warnings: string[];
} => {
  const logs: string[] = [];
  const warnings: string[] = [];
  const runtime = {
    fetchSubtitleCatSubtitle,
    logger: { warn: (message: string) => warnings.push(message) },
    signalService: { showLogText: (message: string) => logs.push(message) },
  } as unknown as FileScraperStageRuntime;

  return { logs, runtime, warnings };
};

const createContext = async (filePath: string, configuration: Configuration): Promise<ScrapeContext> => {
  const context = new ScrapeContext(filePath, { fileIndex: 1, totalFiles: 1 }, "batch", undefined, configuration);
  await context.resolveFileInfo();
  return context;
};

describe("SubtitleStage", () => {
  it("marks the file as externally subtitled without touching the native flag", async () => {
    const fetchSubtitleCatSubtitle = vi.fn(async () => SUBTITLE);
    const { logs, runtime } = createRuntime(fetchSubtitleCatSubtitle);
    const context = await createContext("/tmp/mdcz-subtitle-stage/ABC-111.mp4", createConfiguration());

    await new SubtitleStage(runtime).execute(context);

    expect(context.downloadedSubtitle).toBe(SUBTITLE);
    expect(context.fileInfo.isSubtitled).toBe(true);
    expect(context.fileInfo.subtitleTag).toBe("中文字幕");
    expect(context.fileInfo.subtitleOrigin).toBe("external");
    // The naming guard reads this flag, so a downloaded subtitle must never flip it on.
    expect(context.fileInfo.nativeSubtitled).toBe(false);
    expect(logs).toEqual(["[ABC-111] Downloaded zh-CN subtitle from SubtitleCat"]);
  });

  it("skips a natively subtitled source entirely", async () => {
    const fetchSubtitleCatSubtitle = vi.fn(async () => SUBTITLE);
    const { runtime } = createRuntime(fetchSubtitleCatSubtitle);
    const context = await createContext("/tmp/mdcz-subtitle-stage/ABC-111-C.mp4", createConfiguration());

    await new SubtitleStage(runtime).execute(context);

    expect(context.fileInfo.nativeSubtitled).toBe(true);
    expect(fetchSubtitleCatSubtitle).not.toHaveBeenCalled();
    expect(context.downloadedSubtitle).toBeUndefined();
  });

  it("makes no request when the feature is disabled", async () => {
    const fetchSubtitleCatSubtitle = vi.fn(async () => SUBTITLE);
    const { runtime } = createRuntime(fetchSubtitleCatSubtitle);
    const context = await createContext(
      "/tmp/mdcz-subtitle-stage/ABC-111.mp4",
      createConfiguration({ subtitleCat: false }),
    );

    await new SubtitleStage(runtime).execute(context);

    expect(fetchSubtitleCatSubtitle).not.toHaveBeenCalled();
  });

  it("leaves the file untouched and logs when nothing is found", async () => {
    const { logs, runtime } = createRuntime(async () => undefined);
    const context = await createContext("/tmp/mdcz-subtitle-stage/ABC-111.mp4", createConfiguration());

    await new SubtitleStage(runtime).execute(context);

    expect(context.downloadedSubtitle).toBeUndefined();
    expect(context.fileInfo.subtitleOrigin).toBeUndefined();
    expect(logs).toEqual(["[ABC-111] No SubtitleCat subtitle found"]);
  });

  it("warns instead of failing the scrape when the lookup throws", async () => {
    const { runtime, warnings } = createRuntime(async () => {
      throw new Error("subtitlecat is down");
    });
    const context = await createContext("/tmp/mdcz-subtitle-stage/ABC-111.mp4", createConfiguration());

    await expect(new SubtitleStage(runtime).execute(context)).resolves.toBeUndefined();

    expect(context.downloadedSubtitle).toBeUndefined();
    expect(warnings).toEqual(["SubtitleCat lookup failed for ABC-111: subtitlecat is down"]);
  });

  it("propagates an abort so the pipeline can stop", async () => {
    const controller = new AbortController();
    const { runtime, warnings } = createRuntime(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    const context = await createContext("/tmp/mdcz-subtitle-stage/ABC-111.mp4", createConfiguration());

    await expect(new SubtitleStage(runtime).execute(context, controller.signal)).rejects.toThrow(/Aborted/u);
    expect(warnings).toEqual([]);
  });

  it("does nothing when the host provides no SubtitleCat fetcher", async () => {
    const { logs, runtime, warnings } = createRuntime(undefined);
    const context = await createContext("/tmp/mdcz-subtitle-stage/ABC-111.mp4", createConfiguration());

    await new SubtitleStage(runtime).execute(context);

    expect(context.downloadedSubtitle).toBeUndefined();
    expect([...logs, ...warnings]).toEqual([]);
  });
});
