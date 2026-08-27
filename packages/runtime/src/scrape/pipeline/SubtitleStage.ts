import { toErrorMessage } from "@mdcz/shared/error";
import type { DownloadedSubtitle } from "../subtitles/types";
import { isAbortError, throwIfAborted } from "../utils/abort";
import type { ScrapeContext } from "./ScrapeContext";
import type { FileScraperStageRuntime, ScrapeStage } from "./types";

/**
 * Looks up a Chinese subtitle on SubtitleCat.
 *
 * Runs after `PlanStage` on purpose: the output paths are already fixed by then, so a subtitle found
 * here can never influence the directory or file name — a number that did not natively carry `-C`
 * keeps its bare form. It still runs before `DownloadStage`, because the poster badge is rendered
 * inside `downloadCrawlerAssets` and needs to know a subtitle exists.
 */
export class SubtitleStage implements ScrapeStage {
  constructor(private readonly runtime: FileScraperStageRuntime) {}

  async execute(context: ScrapeContext, signal?: AbortSignal): Promise<void> {
    const fetchSubtitle = this.runtime.fetchSubtitleCatSubtitle;
    if (!fetchSubtitle || !context.requireConfiguration().download.subtitleCat) {
      return;
    }

    // A natively `-C` labelled source already carries burned-in Chinese subtitles: per the decision
    // matrix it is neither searched nor downloaded.
    if (context.fileInfo.nativeSubtitled === true || !context.fileInfo.number.trim()) {
      return;
    }

    throwIfAborted(signal);
    const number = context.fileInfo.number;

    let subtitle: DownloadedSubtitle | undefined;
    try {
      subtitle = await fetchSubtitle(context, signal);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      // The scrape itself is unaffected by a missing subtitle, so this never fails the file.
      this.runtime.logger.warn(`SubtitleCat lookup failed for ${number}: ${toErrorMessage(error)}`);
      return;
    }

    if (!subtitle) {
      this.runtime.signalService.showLogText(`[${number}] No SubtitleCat subtitle found`);
      return;
    }

    context.downloadedSubtitle = subtitle;
    // `nativeSubtitled` deliberately stays false: this marks the file as subtitled for the NFO tags
    // and the poster badge, while `NamingEngine` keeps refusing to append `-C`.
    context.fileInfo = {
      ...context.fileInfo,
      isSubtitled: true,
      subtitleTag: "中文字幕",
      subtitleOrigin: "external",
    };
    this.runtime.signalService.showLogText(`[${number}] Downloaded ${subtitle.language} subtitle from SubtitleCat`);
  }
}
