import type { Configuration } from "@mdcz/shared/config";
import type { RuntimeLogger } from "../../shared";
import type { BaseCodeSubtitleCache } from "./BaseCodeSubtitleCache";
import { SubtitleCatService } from "./SubtitleCatService";
import type { SubtitleCatNetworkClient } from "./subtitleCatHttp";
import type { DownloadedSubtitle } from "./types";

export interface SubtitleCatLookupOptions {
  configuration: Configuration;
  logger?: RuntimeLogger;
  networkClient: SubtitleCatNetworkClient;
  /** Already normalized to the base code by `parseFileInfo()`, so all `-C`/`-UC` variants share it. */
  number: string;
  signal?: AbortSignal;
  /** When supplied, every variant of one base code reuses a single search + download. */
  subtitleCache?: BaseCodeSubtitleCache;
}

/**
 * The single entry point both pipelines use for SubtitleCat, so the service options stay derived from
 * one place and the shared per-batch cache can be slotted in without touching the stage.
 */
export const fetchSubtitleCatSubtitleForNumber = async (
  options: SubtitleCatLookupOptions,
): Promise<DownloadedSubtitle | undefined> => {
  const load = async (): Promise<DownloadedSubtitle | undefined> =>
    await new SubtitleCatService({
      fallbackTraditional: options.configuration.download.subtitleCatFallbackTraditional,
      logger: options.logger,
      networkClient: options.networkClient,
    }).fetchBestSubtitle(options.number, { signal: options.signal });

  if (!options.subtitleCache) {
    return await load();
  }

  return await options.subtitleCache.resolve(options.number, load);
};
