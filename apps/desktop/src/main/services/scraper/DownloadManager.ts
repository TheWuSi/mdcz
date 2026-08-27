import {
  createImageHostCooldownStore,
  type PersistentCooldownStore,
} from "@main/services/cooldown/PersistentCooldownStore";
import { loggerService } from "@main/services/LoggerService";
import type { NetworkClient } from "@mdcz/runtime/network";
import {
  DownloadManager as RuntimeDownloadManager,
  type DownloadManagerOptions as RuntimeDownloadManagerOptions,
  type ScrapeAssetCache,
} from "@mdcz/runtime/scrape";

export type { DownloadCallbacks } from "@mdcz/runtime/scrape";

interface DownloadManagerOptions {
  imageHostCooldownStore?: PersistentCooldownStore;
  /** Shared across one scrape session so base-code variants download each image URL only once. */
  assetCache?: ScrapeAssetCache;
}

const createRuntimeOptions = (options: DownloadManagerOptions): RuntimeDownloadManagerOptions => ({
  assetCache: options.assetCache,
  imageHostCooldownStore: options.imageHostCooldownStore ?? createImageHostCooldownStore(),
  logger: loggerService.getLogger("DownloadManager"),
});

export class DownloadManager extends RuntimeDownloadManager {
  constructor(networkClient: NetworkClient, options: DownloadManagerOptions = {}) {
    super(networkClient, createRuntimeOptions(options));
  }
}
