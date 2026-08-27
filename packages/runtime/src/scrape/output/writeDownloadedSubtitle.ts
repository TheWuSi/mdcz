import { writeFile } from "node:fs/promises";
import { toErrorMessage } from "@mdcz/shared/error";
import { buildEmbySubtitleTargetPath, EMBY_SUBTITLE_SOURCE_TAGS } from "../media";
import type { RuntimeScrapeSignalService } from "../pipeline/types";
import type { DownloadedSubtitle } from "../subtitles/types";
import { ensureParentDirectory } from "../utils/filesystem";

/**
 * Drops a SubtitleCat subtitle next to the final playable entry, so both normal mode (the moved
 * video) and separated mode (the metadata-directory `.strm`) land the sidecar in the right place
 * without ever writing back into the source directory.
 *
 * Never throws: the video is already organized by the time this runs, so a subtitle write failure
 * must not turn a successful scrape into a failed one.
 */
export const writeDownloadedSubtitleIfNeeded = async (input: {
  logger: { warn(message: string): void };
  numberLabel?: string;
  outputVideoPath: string;
  signalService?: Pick<RuntimeScrapeSignalService, "showLogText">;
  subtitle?: DownloadedSubtitle;
}): Promise<string | undefined> => {
  if (!input.subtitle) {
    return undefined;
  }

  const targetPath = buildEmbySubtitleTargetPath(input.outputVideoPath, {
    language: input.subtitle.language,
    sourceTag: EMBY_SUBTITLE_SOURCE_TAGS.subtitleCat,
    extension: input.subtitle.format,
  });

  try {
    await ensureParentDirectory(targetPath);
    // Overwriting is intentional: the `subcat` tag identifies one source, so re-scraping the same
    // number simply refreshes its own file instead of piling up numbered duplicates.
    await writeFile(targetPath, input.subtitle.content);
  } catch (error) {
    input.logger.warn(`Failed to write downloaded subtitle to ${targetPath}: ${toErrorMessage(error)}`);
    return undefined;
  }

  input.signalService?.showLogText(
    input.numberLabel ? `[${input.numberLabel}] Saved subtitle to ${targetPath}` : `Saved subtitle to ${targetPath}`,
  );
  return targetPath;
};
