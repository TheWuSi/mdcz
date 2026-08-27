import { stat } from "node:fs/promises";
import path from "node:path";
import type { MediaRoot } from "@mdcz/media-store";
import { resolveRootRelativePath, toRootRelativePath } from "@mdcz/media-store";
import type { Configuration } from "@mdcz/shared/config";
import type { CrawlerData, DownloadedAssets, FileInfo, NfoLocalState, ScrapeResult } from "@mdcz/shared/types";
import { NetworkClient, type RuntimeDownloadNetworkClient } from "../network";
import { ActorImageService } from "./ActorImageService";
import type { RuntimeActorSourceProvider } from "./actorOutput";
import type { AggregationResult, ManualScrapeOptions } from "./aggregation";
import { DownloadManager, type ImageHostCooldownStore, MemoryImageHostCooldownStore } from "./download";
import { FileOrganizer, resolveMetadataOutputDir } from "./FileOrganizer";
import { FileScraper } from "./FileScraper";
import { NfoGenerator, nfoIgnoreFieldsToEnabledFields, reconcileExistingNfoFiles } from "./nfo";
import { applyPosterTagBadgesIfNeeded } from "./output/applyPosterTagBadges";
import { prepareCrawlerDataForMovieOutput } from "./output/prepareCrawlerDataForMovieOutput";
import { prepareImageAlternativesForDownload } from "./output/prepareImageAlternativesForDownload";
import { PosterWatermarkService } from "./PosterWatermarkService";
import {
  AggregateStage,
  AggregationCoordinator,
  CanonicalizeActorAliasesStage,
  DownloadStage,
  type FileScraperPipeline,
  type FileScraperStageRuntime,
  NfoStage,
  NumberExecutionGate,
  OrganizeStage,
  ParseStage,
  PlanStage,
  PrepareOutputStage,
  ProbeStage,
  type RuntimeScrapeSignalService,
  ScrapeContext,
  ScrapeSessionScope,
  type ScrapeStage,
  SubtitleStage,
  TranslateStage,
} from "./pipeline";
import { fetchSubtitleCatSubtitleForNumber } from "./subtitles";
import { TranslateService } from "./TranslateService";
import type { TranslationMappingStore } from "./translate/types";
import { isAbortError } from "./utils/abort";
import { pathExists } from "./utils/filesystem";
import { parseFileInfo } from "./utils/number";

interface MountedRootScrapeLogger {
  debug?(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const toRuntimeLogger = (logger: MountedRootScrapeLogger) => ({
  debug: (message: string) => logger.debug?.(message),
  info: (message: string) => logger.info(message),
  warn: (message: string) => logger.warn(message),
  error: (message: string) => logger.error(message),
});

export interface MountedRootScrapeRuntimeConfig {
  runtimePaths: {
    dataDir: string;
  };
  get(): Promise<Configuration>;
}

export interface MountedRootScrapeAggregationService {
  aggregate(
    number: string,
    configuration: Configuration,
    signal?: AbortSignal,
    manualScrape?: ManualScrapeOptions,
  ): Promise<AggregationResult | null>;
  getFailureSummary?(number: string): string | undefined;
}

export interface MountedRootScrapeRuntimeItemInput {
  root: MediaRoot;
  relativePath: string;
  scrapeSessionId?: string;
  manualScrape?: NonNullable<Parameters<FileScraper["scrapeFile"]>[3]>["manualScrape"];
  localState?: NfoLocalState;
  progress: { fileIndex: number; totalFiles: number };
  onEvent?: (type: string, message: string) => Promise<void> | void;
  onProgress?: (progress: { value: number; current: number; total: number }) => Promise<void> | void;
  onStage?: (stage: "search" | "download" | "parse" | "organize", message: string) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface MountedRootScrapeRuntimeItemSuccess {
  status: "success";
  result: ScrapeResult;
  crawlerData: CrawlerData;
  nfoPath: string | null;
  outputRelativePath: string;
  size: number;
  modifiedAt: Date | null;
}

export interface MountedRootScrapeRuntimeItemFailure {
  status: "failed" | "skipped";
  result: ScrapeResult;
  error: string;
}

export type MountedRootScrapeRuntimeItemResult =
  | MountedRootScrapeRuntimeItemSuccess
  | MountedRootScrapeRuntimeItemFailure;

class MountedRootScrapeSignalService implements RuntimeScrapeSignalService {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly emit: (type: string, message: string) => Promise<void> | void,
    private readonly emitProgress: (progress: {
      value: number;
      current: number;
      total: number;
    }) => Promise<void> | void,
    private readonly emitStage: (
      stage: "search" | "download" | "parse" | "organize",
      message: string,
    ) => Promise<void> | void,
  ) {}

  showFailedInfo(_input: { fileInfo: FileInfo; error: string }): void {}

  showLogText(message: string): void {
    this.track(this.emit("log", message));
  }

  showScrapeInfo(input: {
    fileInfo: FileInfo;
    site: CrawlerData["website"];
    step: "search" | "download" | "parse" | "organize";
  }): void {
    this.track(this.emitStage(input.step, `${input.fileInfo.fileName}${input.fileInfo.extension}: ${input.site}`));
  }

  showScrapeResult(_result: ScrapeResult): void {}

  setProgress(value: number, current: number, total: number): void {
    this.track(this.emitProgress({ value, current, total }));
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private track(result: Promise<void> | void): void {
    if (!result) {
      return;
    }

    this.pending.add(result);
    result.then(
      () => this.pending.delete(result),
      () => this.pending.delete(result),
    );
  }
}

class MountedRootFileScraperPipeline implements FileScraperPipeline {
  private readonly nfoGenerator = new NfoGenerator();
  private readonly networkClient: RuntimeDownloadNetworkClient;
  private readonly fileOrganizer: FileOrganizer;
  private readonly translateService: TranslateService;
  private readonly downloadManager: DownloadManager;
  private readonly actorImageService: ActorImageService;
  private readonly posterWatermarkService: PosterWatermarkService;
  private readonly aggregationCoordinator: AggregationCoordinator;
  private readonly numberExecutionGate: NumberExecutionGate;
  private readonly runtimeLogger: ReturnType<typeof toRuntimeLogger>;

  readonly stages: readonly ScrapeStage[];

  constructor(
    private readonly root: MediaRoot,
    private readonly config: MountedRootScrapeRuntimeConfig,
    private readonly aggregationService: MountedRootScrapeAggregationService,
    private readonly signalService: RuntimeScrapeSignalService,
    private readonly logger: MountedRootScrapeLogger,
    networkClient?: RuntimeDownloadNetworkClient,
    private readonly localState?: NfoLocalState,
    mappingStore?: TranslationMappingStore,
    imageHostCooldownStore: ImageHostCooldownStore = new MemoryImageHostCooldownStore(),
    private readonly actorSourceProvider?: RuntimeActorSourceProvider,
    private readonly sessionScope?: ScrapeSessionScope,
  ) {
    this.networkClient = networkClient ?? new NetworkClient();
    const runtimeLogger = toRuntimeLogger(this.logger);
    this.runtimeLogger = runtimeLogger;
    this.fileOrganizer = new FileOrganizer(runtimeLogger);
    this.translateService = new TranslateService(this.networkClient, { logger: runtimeLogger, mappingStore });
    this.downloadManager = new DownloadManager(this.networkClient, {
      assetCache: sessionScope?.assetCache,
      imageHostCooldownStore,
      logger: runtimeLogger,
    });
    this.actorImageService = new ActorImageService({
      cacheRoot: path.join(this.config.runtimePaths.dataDir, "actor-image-cache"),
      logger: runtimeLogger,
      networkClient: this.networkClient,
    });
    this.posterWatermarkService = new PosterWatermarkService({ dataDir: this.config.runtimePaths.dataDir });
    // One pipeline is built per file here, so without a session scope every cache would be single-use.
    this.aggregationCoordinator =
      sessionScope?.aggregationCoordinator ?? new AggregationCoordinator(this.aggregationService);
    this.numberExecutionGate = sessionScope?.numberExecutionGate ?? new NumberExecutionGate();
    this.stages = this.createStages();
  }

  async createContext(
    filePath: string,
    progress: { fileIndex: number; totalFiles: number } = { fileIndex: 1, totalFiles: 1 },
    options: Parameters<FileScraperPipeline["createContext"]>[2] = {},
  ): Promise<ScrapeContext> {
    const configuration = await this.getConfiguration();
    return new ScrapeContext(filePath, progress, "batch", options.manualScrape, configuration, options.scrapeSessionId);
  }

  setProgress(progress: { fileIndex: number; totalFiles: number }, stepPercent: number): void {
    const normalizedPercent = Math.max(0, Math.min(100, stepPercent));
    const fileIndex = Math.max(1, progress.fileIndex);
    const totalFiles = Math.max(1, progress.totalFiles);
    const globalValue = (fileIndex - 1 + normalizedPercent / 100) / totalFiles;
    const value = Math.max(0, Math.min(100, Math.round(globalValue * 100)));
    this.signalService.setProgress(value, fileIndex, totalFiles);
  }

  async runExclusiveByNumber<T>(number: string, operation: () => Promise<T>): Promise<T> {
    return await this.numberExecutionGate.runExclusive(number, operation);
  }

  async handleAbort(context: ScrapeContext): Promise<ScrapeResult> {
    this.logger.info(`Scrape aborted for ${context.fileInfo.filePath}`);
    this.setProgress(context.progress, 100);
    const skippedResult: ScrapeResult = {
      fileId: context.fileId,
      fileInfo: context.fileInfo,
      status: "skipped",
      error: "Operation aborted",
    };
    this.signalService.showScrapeResult(skippedResult);
    return skippedResult;
  }

  async handleError(context: ScrapeContext, error: unknown): Promise<ScrapeResult> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Scrape failed for ${context.fileInfo.filePath}: ${message}`);
    this.setProgress(context.progress, 100);

    try {
      context.fileInfo = await this.moveToFailedFolder(context.fileInfo, await this.getConfiguration());
    } catch (moveError) {
      const moveMessage = moveError instanceof Error ? moveError.message : String(moveError);
      this.logger.warn(`Failed to move file to failed folder: ${moveMessage}`);
    }

    const failedResult: ScrapeResult = {
      fileId: context.fileId,
      fileInfo: context.fileInfo,
      status: "failed",
      error: message,
    };
    this.signalService.showScrapeResult(failedResult);
    this.signalService.showFailedInfo({ fileInfo: context.fileInfo, error: message });
    return failedResult;
  }

  private createStageRuntime(): FileScraperStageRuntime {
    return {
      actorImageService: this.actorImageService,
      actorSourceProvider: this.actorSourceProvider,
      fileOrganizer: this.fileOrganizer,
      logger: this.logger,
      nfoGenerator: this.nfoGenerator,
      signalService: this.signalService,
      getConfiguration: async () => await this.getConfiguration(),
      aggregateMetadata: async (fileInfo, configuration, signal, manualScrape) =>
        await this.aggregationCoordinator.aggregate(fileInfo, configuration, signal, manualScrape),
      getAggregationFailureMessage: (fileInfo) => this.aggregationService.getFailureSummary?.(fileInfo.number),
      handleFailedFileMove: async (fileInfo, configuration) => await this.moveToFailedFolder(fileInfo, configuration),
      loadExistingNfoLocalState: async () => this.localState,
      setProgress: (progress, stepPercent) => {
        this.setProgress(progress, stepPercent);
      },
      translateCrawlerData: async (crawlerData, configuration, signal) => {
        try {
          return await this.translateService.translateCrawlerData(crawlerData, configuration, signal);
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          this.logger.warn(
            `Translation failed for ${crawlerData.number}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return crawlerData;
        }
      },
      probeVideoMetadata: async () => undefined,
      prepareOutputCrawlerData: async (context, signal) => {
        const prepared = await prepareCrawlerDataForMovieOutput(
          this.actorImageService,
          context.requireConfiguration(),
          context.requireCrawlerData(),
          {
            enabled: true,
            movieDir: resolveMetadataOutputDir(context.requirePlan()),
            sourceVideoPath: context.fileInfo.filePath,
            actorSourceProvider: this.actorSourceProvider,
            signal,
          },
        );
        return {
          data: prepared.data,
          actorPhotoPaths: prepared.actorPhotoPaths,
        };
      },
      fetchSubtitleCatSubtitle: async (context, signal) =>
        await fetchSubtitleCatSubtitleForNumber({
          configuration: context.requireConfiguration(),
          logger: this.runtimeLogger,
          networkClient: this.networkClient,
          number: context.fileInfo.number,
          signal,
          subtitleCache: this.sessionScope?.subtitleCache,
        }),
      downloadCrawlerAssets: async (context, signal) => await this.downloadCrawlerAssets(context, signal),
      writePreparedNfo: async (context) => await this.writePreparedNfo(context),
      organizePreparedVideo: async (context) =>
        await this.fileOrganizer.organizeVideo(context.fileInfo, context.requirePlan(), context.requireConfiguration()),
    };
  }

  private createStages(): readonly ScrapeStage[] {
    const runtime = this.createStageRuntime();
    return [
      new ParseStage(),
      new ProbeStage(runtime),
      new AggregateStage(runtime),
      new TranslateStage(runtime),
      new CanonicalizeActorAliasesStage(),
      new PlanStage(runtime),
      new SubtitleStage(runtime),
      new PrepareOutputStage(runtime),
      new DownloadStage(runtime),
      new NfoStage(runtime),
      new OrganizeStage(runtime),
    ];
  }

  private async getConfiguration(): Promise<Configuration> {
    const configuration = await this.config.get();
    return {
      ...configuration,
      paths: {
        ...configuration.paths,
        mediaPath: this.root.hostPath,
      },
    };
  }

  private async moveToFailedFolder(fileInfo: FileInfo, config: Configuration): Promise<FileInfo> {
    if (config.behavior.fileMode === "separated") {
      return fileInfo;
    }
    if (!config.behavior.failedFileMove || !(await pathExists(fileInfo.filePath))) {
      return fileInfo;
    }
    try {
      const movedPath = await this.fileOrganizer.moveToFailedFolder(fileInfo, config);
      const movedFileInfo = parseFileInfo(movedPath);
      return {
        ...fileInfo,
        ...movedFileInfo,
        filePath: movedPath,
        isSubtitled: fileInfo.isSubtitled || movedFileInfo.isSubtitled,
        subtitleTag: fileInfo.subtitleTag ?? movedFileInfo.subtitleTag,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to move file to failed folder: ${message}`);
      return fileInfo;
    }
  }

  private async downloadCrawlerAssets(
    context: ScrapeContext,
    signal?: AbortSignal,
  ): Promise<{ assets: DownloadedAssets; crawlerData?: CrawlerData }> {
    this.signalService.showLogText(`[${context.fileInfo.number}] Downloading resources...`);
    const aggregationResult = context.requireAggregationResult();
    const crawlerData = context.requireCrawlerData();
    const preparedImageAlternatives = prepareImageAlternativesForDownload(
      crawlerData,
      aggregationResult.imageAlternatives,
      aggregationResult.sources,
    );
    let resolvedSceneImageUrls: string[] | undefined;
    const downloadedAssets = await this.downloadManager.downloadAll(
      resolveMetadataOutputDir(context.requirePlan()),
      crawlerData,
      context.requireConfiguration(),
      preparedImageAlternatives,
      {
        onResolvedSceneImageUrls: (urls) => {
          resolvedSceneImageUrls = urls;
        },
        onSceneProgress: (downloaded, total) => {
          this.signalService.showLogText(`[${context.fileInfo.number}] Scene images: ${downloaded}/${total}`);
        },
        signal,
      },
      {
        movieBaseName: path.basename(context.requirePlan().nfoPath, ".nfo"),
      },
    );

    const resolvedCrawlerData =
      resolvedSceneImageUrls === undefined ? crawlerData : { ...crawlerData, scene_images: resolvedSceneImageUrls };
    const assets = await applyPosterTagBadgesIfNeeded({
      assets: downloadedAssets,
      config: context.requireConfiguration(),
      crawlerData: resolvedCrawlerData,
      dataDir: this.config.runtimePaths.dataDir,
      fileInfo: context.fileInfo,
      localState: context.existingNfoLocalState,
      logger: this.logger,
      signal,
      signalService: this.signalService,
      watermarkService: this.posterWatermarkService,
    });

    return { assets, crawlerData: resolvedCrawlerData };
  }

  private async writePreparedNfo(context: ScrapeContext): Promise<string | undefined> {
    const configuration = context.requireConfiguration();
    if (!(configuration.download.generateNfo && context.plan)) {
      return undefined;
    }
    const assets = context.assets ?? { downloaded: [], sceneImages: [] };
    if (configuration.download.keepNfo) {
      const existingNfoPath = await reconcileExistingNfoFiles(
        context.plan.nfoPath,
        configuration.download.nfoNaming,
        pathExists,
      );
      if (existingNfoPath) {
        return existingNfoPath;
      }
    }
    return await this.nfoGenerator.writeNfo(context.plan.nfoPath, context.requireCrawlerData(), {
      assets,
      fileInfo: context.fileInfo,
      localState: context.existingNfoLocalState,
      nfoNaming: configuration.download.nfoNaming,
      enabledFields: nfoIgnoreFieldsToEnabledFields(configuration.download.nfoIgnoreFields),
      nfoTitleTemplate: configuration.naming.nfoTitleTemplate,
      sources: context.requireAggregationResult().sources,
      videoMeta: context.videoMeta,
    });
  }
}

interface SessionScopeEntry {
  scope: ScrapeSessionScope;
  /** Files of this session currently inside `scrape()`. */
  activeCount: number;
  /** Wall clock of the moment `activeCount` last hit zero. */
  idleSince?: number;
  /** `releaseSession()` has been called; the last file out disposes the scope. */
  retired: boolean;
}

/**
 * Backstop for tasks that never reach `releaseSession()` (crash, hard stop, dropped connection).
 * Only applies once every file the task submitted has finished — see `#evictIdleScopes()`.
 */
const SESSION_SCOPE_IDLE_TTL_MS = 30 * 60 * 1000;

export class MountedRootScrapeRuntime {
  /**
   * Ref-counted scopes keyed by scrape session id, so every file of one task shares its metadata,
   * artwork and subtitle caches. Deliberately per task and never process-wide: `AggregationCoordinator`
   * keeps successful results for the scope's whole lifetime, so a longer-lived scope would hand
   * hours-old metadata to a re-scrape.
   */
  readonly #scopes = new Map<string, SessionScopeEntry>();

  constructor(
    private readonly config: MountedRootScrapeRuntimeConfig,
    private readonly aggregationService: MountedRootScrapeAggregationService,
    private readonly logger: MountedRootScrapeLogger = console,
    private readonly networkClient?: RuntimeDownloadNetworkClient,
    private readonly mappingStore?: TranslationMappingStore,
    private readonly imageHostCooldownStore?: ImageHostCooldownStore,
    private readonly actorSourceProvider?: RuntimeActorSourceProvider,
  ) {}

  /**
   * Records the files a task submitted, so the scope's same-number grouping comes from the task list
   * instead of from whichever files the worker pool happens to run together. Call it before executing
   * the task; `releaseSession()` still does the teardown.
   */
  beginSession(
    scrapeSessionId: string | undefined,
    absoluteFilePaths: readonly string[],
    escapeStrings: readonly string[] = [],
  ): void {
    if (!scrapeSessionId) {
      return;
    }

    const entry: SessionScopeEntry = this.#scopes.get(scrapeSessionId) ?? {
      activeCount: 0,
      retired: false,
      scope: new ScrapeSessionScope(this.aggregationService),
    };
    entry.scope.groups.seed(absoluteFilePaths, escapeStrings);
    this.#scopes.set(scrapeSessionId, entry);
  }

  async scrape(input: MountedRootScrapeRuntimeItemInput): Promise<MountedRootScrapeRuntimeItemResult> {
    const signalService = new MountedRootScrapeSignalService(
      (type, message) => {
        console.info(message);
        return input.onEvent?.(type, message);
      },
      (progress) => input.onProgress?.(progress),
      (stage, message) => input.onStage?.(stage, message),
    );
    const session = this.#acquireSessionScope(input.scrapeSessionId);
    try {
      const scraper = new FileScraper(
        new MountedRootFileScraperPipeline(
          input.root,
          this.config,
          this.aggregationService,
          signalService,
          this.logger,
          this.networkClient,
          input.localState,
          this.mappingStore,
          this.imageHostCooldownStore,
          this.actorSourceProvider,
          session.scope,
        ),
      );
      const absolutePath = resolveRootRelativePath(input.root, input.relativePath);
      const result = await scraper.scrapeFile(absolutePath, input.progress, input.signal, {
        manualScrape: input.manualScrape,
        scrapeSessionId: input.scrapeSessionId,
      });

      if (result.status !== "success" || !result.crawlerData) {
        return {
          status: result.status === "skipped" ? "skipped" : "failed",
          result,
          error: result.error ?? "刮削失败",
        };
      }

      const outputVideoPath = result.fileInfo.filePath;
      const sourceVideoPath = resolveRootRelativePath(input.root, input.relativePath);
      let outputRelativePath: string;
      let statsPath = outputVideoPath;
      try {
        outputRelativePath = toRootRelativePath(input.root, outputVideoPath);
      } catch {
        // Separated mode writes the playable STRM under the metadata root while
        // the untouched source media remains the library entry on the media root.
        outputRelativePath = toRootRelativePath(input.root, sourceVideoPath);
        statsPath = sourceVideoPath;
      }
      const stats = await stat(statsPath).catch(() => null);
      return {
        status: "success",
        result,
        crawlerData: result.crawlerData,
        nfoPath: result.nfoPath ?? null,
        outputRelativePath,
        size: stats?.size ?? 0,
        modifiedAt: stats?.mtime ?? null,
      };
    } finally {
      await signalService.flush();
      session.scope.groups.complete(resolveRootRelativePath(input.root, input.relativePath));
      await session.release();
    }
  }

  /**
   * Drops the caches a finished task built up. Call this from the task runner's `finally` so the
   * stop / pause / failure paths release too. Idempotent, and safe to call while files are still
   * in flight — the last one out does the actual teardown.
   */
  async releaseSession(scrapeSessionId: string | undefined): Promise<void> {
    if (!scrapeSessionId) {
      return;
    }

    const entry = this.#scopes.get(scrapeSessionId);
    if (!entry) {
      return;
    }

    entry.retired = true;
    if (entry.activeCount > 0) {
      return;
    }
    await this.#disposeScopeEntry(scrapeSessionId, entry);
  }

  /** Sessions without an id get a private scope: one file, nothing to share. */
  #acquireSessionScope(scrapeSessionId?: string): { scope: ScrapeSessionScope; release: () => Promise<void> } {
    if (!scrapeSessionId) {
      const scope = new ScrapeSessionScope(this.aggregationService);
      return { scope, release: async () => await scope.dispose() };
    }

    this.#evictIdleScopes();
    const entry: SessionScopeEntry = this.#scopes.get(scrapeSessionId) ?? {
      activeCount: 0,
      retired: false,
      scope: new ScrapeSessionScope(this.aggregationService),
    };
    entry.activeCount += 1;
    entry.idleSince = undefined;
    this.#scopes.set(scrapeSessionId, entry);
    return { scope: entry.scope, release: async () => await this.#releaseScopeEntry(scrapeSessionId, entry) };
  }

  async #releaseScopeEntry(scrapeSessionId: string, entry: SessionScopeEntry): Promise<void> {
    entry.activeCount = Math.max(0, entry.activeCount - 1);
    if (entry.activeCount > 0) {
      return;
    }

    entry.idleSince = Date.now();
    if (entry.retired) {
      // `releaseSession()` ran while this file was still going; disposing earlier would have pulled
      // the cached asset files out from under it.
      await this.#disposeScopeEntry(scrapeSessionId, entry);
    }
  }

  async #disposeScopeEntry(scrapeSessionId: string, entry: SessionScopeEntry): Promise<void> {
    if (this.#scopes.get(scrapeSessionId) === entry) {
      this.#scopes.delete(scrapeSessionId);
    }
    try {
      await entry.scope.dispose();
    } catch (error) {
      this.logger.warn(`Failed to dispose scrape session scope ${scrapeSessionId}: ${String(error)}`);
    }
  }

  /**
   * Reaps scopes whose task died without releasing. Runs on acquire, so it costs nothing when idle.
   * A scope with files still to come is never reaped, however long the gap between them: dropping it
   * mid-task would make the surviving variants of a base code re-aggregate and re-download.
   */
  #evictIdleScopes(): void {
    const now = Date.now();
    for (const [scrapeSessionId, entry] of [...this.#scopes]) {
      const idleFor = entry.idleSince === undefined ? 0 : now - entry.idleSince;
      if (entry.activeCount === 0 && !entry.scope.groups.hasPending() && idleFor > SESSION_SCOPE_IDLE_TTL_MS) {
        void this.#disposeScopeEntry(scrapeSessionId, entry);
      }
    }
  }
}
