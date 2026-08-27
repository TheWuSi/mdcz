import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaRoot } from "@mdcz/media-store";
import { configurationSchema, defaultConfiguration } from "@mdcz/shared/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MountedRootScrapeRuntime } from "./mountedRootScrapeRuntime";
import { ScrapeSessionScope } from "./pipeline";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dirPath = await mkdtemp(join(tmpdir(), "mdcz-mounted-scope-"));
  tempDirs.push(dirPath);
  return dirPath;
};

const createRoot = (hostPath: string): MediaRoot => ({
  id: "root-1",
  displayName: "Root",
  hostPath,
  rootType: "mounted-filesystem",
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

/** Enough of a runtime to exercise the session scope lifecycle; the scrape itself is expected to fail. */
const createRuntime = async () => {
  const dataDir = await createTempDir();
  const root = createRoot(await createTempDir());
  const aggregate = vi.fn().mockResolvedValue(null);
  const configuration = configurationSchema.parse({
    ...defaultConfiguration,
    download: { ...defaultConfiguration.download, subtitleCat: false },
  });
  const runtime = new MountedRootScrapeRuntime(
    { runtimePaths: { dataDir }, get: async () => configuration },
    {
      aggregate,
    },
  );

  const scrape = async (scrapeSessionId?: string, relativePath = "ABC-111.mp4") =>
    await runtime.scrape({
      root,
      relativePath,
      progress: { fileIndex: 1, totalFiles: 1 },
      ...(scrapeSessionId ? { scrapeSessionId } : {}),
    });

  return { aggregate, root, runtime, scrape };
};

describe("MountedRootScrapeRuntime session scopes", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0, tempDirs.length).map((dirPath) => rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("keeps one scope alive for a session until it is released", async () => {
    const dispose = vi.spyOn(ScrapeSessionScope.prototype, "dispose");
    const { runtime, scrape } = await createRuntime();

    await scrape("task-1");
    await scrape("task-1");
    // Every file of a task shares the caches, so nothing may be torn down between files.
    expect(dispose).not.toHaveBeenCalled();

    await runtime.releaseSession("task-1");
    expect(dispose).toHaveBeenCalledTimes(1);

    // Releasing twice, or releasing a task that never ran, has to stay harmless.
    await runtime.releaseSession("task-1");
    await runtime.releaseSession("task-2");
    await runtime.releaseSession(undefined);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("gives each session its own scope so a later task never reads cached metadata", async () => {
    const dispose = vi.spyOn(ScrapeSessionScope.prototype, "dispose");
    const { runtime, scrape } = await createRuntime();

    await scrape("task-1");
    await scrape("task-2");
    await runtime.releaseSession("task-1");
    await runtime.releaseSession("task-2");

    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("disposes the throwaway scope of a call without a session id", async () => {
    const dispose = vi.spyOn(ScrapeSessionScope.prototype, "dispose");
    const { scrape } = await createRuntime();

    await scrape();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not reap a scope whose task still has submitted files to run", async () => {
    const dispose = vi.spyOn(ScrapeSessionScope.prototype, "dispose");
    const { root, runtime, scrape } = await createRuntime();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const submitted = ["ABC-111.mp4", "ABC-111-C.mp4", "ABC-111-UC.mp4"];
    runtime.beginSession(
      "task-1",
      submitted.map((relativePath) => join(root.hostPath, relativePath)),
    );

    await scrape("task-1", submitted[0]);
    // The idle timer must not fire between files: it is a backstop for dead tasks, not a pause
    // budget. `#evictIdleScopes()` runs on every acquire, so this second acquire exercises it.
    now += 31 * 60 * 1000;
    await scrape("task-1", submitted[1]);
    expect(dispose).not.toHaveBeenCalled();

    // Once the last submitted file is done the backstop is free to reap it again.
    await scrape("task-1", submitted[2]);
    now += 31 * 60 * 1000;
    await scrape("task-2");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
