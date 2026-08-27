import { extname } from "node:path";
import { noopRuntimeLogger, type RuntimeLogger } from "../../shared";
import { isAbortError, throwIfAborted } from "../utils/abort";
import { SubtitleCatProviderError } from "./errors";
import {
  fetchLimitedContent,
  fetchLimitedText,
  SUBTITLE_CAT_FILE_LIMIT,
  SUBTITLE_CAT_PAGE_LIMIT,
  type SubtitleCatNetworkClient,
} from "./subtitleCatHttp";
import {
  listSubtitleCatDetailLanguages,
  parseSubtitleCatDetailLinks,
  parseSubtitleCatSearchRows,
  type SubtitleCatDetailLinks,
} from "./subtitleCatParser";
import { buildSubtitleCatSearchUrl, resolveSubtitleCatUrl, SUBTITLE_CAT_BASE_URL } from "./subtitleCatUrl";
import type { DownloadedSubtitle, SubtitleCatCandidate } from "./types";

const HTML_BODY_PREFIXES = ["<!doctype html", "<html"] as const;
const HTML_SNIFF_BYTES = 256;
const DEFAULT_FORMAT = "srt";

export interface SubtitleCatServiceOptions {
  networkClient: SubtitleCatNetworkClient;
  baseUrl?: string;
  logger?: RuntimeLogger;
  /** When false, a detail page offering only traditional Chinese is skipped. */
  fallbackTraditional?: boolean;
  timeoutMs?: number;
}

export interface SubtitleCatRequestOptions {
  signal?: AbortSignal;
}

/** Detail pages are fetched once per call and reused by both ranking and download. */
type DetailLinkCache = Map<string, SubtitleCatDetailLinks>;

const looksLikeHtml = (content: Buffer): boolean => {
  const head = content.subarray(0, HTML_SNIFF_BYTES).toString("utf8").trim().toLowerCase();
  return HTML_BODY_PREFIXES.some((prefix) => head.startsWith(prefix));
};

/**
 * Scrapes subtitlecat.com for a Chinese subtitle, porting `refer/subtitlecat.go`.
 *
 * Ranking follows the reference: rows whose title names the number first, then simplified before
 * traditional Chinese, then download count descending. Downvoted rows never make the list at all.
 */
export class SubtitleCatService {
  private readonly base: URL;

  private readonly logger: RuntimeLogger;

  constructor(private readonly options: SubtitleCatServiceOptions) {
    this.base = new URL(options.baseUrl ?? SUBTITLE_CAT_BASE_URL);
    this.logger = options.logger ?? noopRuntimeLogger;
  }

  async search(number: string, options: SubtitleCatRequestOptions = {}): Promise<SubtitleCatCandidate[]> {
    return this.searchWithCache(number, new Map(), options.signal);
  }

  async download(
    candidate: SubtitleCatCandidate,
    options: SubtitleCatRequestOptions = {},
  ): Promise<DownloadedSubtitle> {
    return this.downloadWithCache(candidate, new Map(), options.signal);
  }

  /**
   * Walks the ranked candidates and returns the first one that downloads cleanly. A candidate that
   * fails to parse or download is logged and skipped, so one bad entry never sinks the whole lookup.
   */
  async fetchBestSubtitle(
    number: string,
    options: SubtitleCatRequestOptions = {},
  ): Promise<DownloadedSubtitle | undefined> {
    const detailCache: DetailLinkCache = new Map();
    let candidates: SubtitleCatCandidate[];

    try {
      candidates = await this.searchWithCache(number, detailCache, options.signal);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      this.logger.warn(`SubtitleCat search failed for ${number}: ${this.describe(error)}`);
      return undefined;
    }

    for (const candidate of candidates) {
      throwIfAborted(options.signal);
      try {
        return await this.downloadWithCache(candidate, detailCache, options.signal);
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        this.logger.warn(
          `SubtitleCat candidate "${candidate.title}" (${candidate.language}) failed for ${number}: ${this.describe(error)}`,
        );
      }
    }

    return undefined;
  }

  private async searchWithCache(
    number: string,
    detailCache: DetailLinkCache,
    signal?: AbortSignal,
  ): Promise<SubtitleCatCandidate[]> {
    const trimmedNumber = number.trim();
    if (!trimmedNumber) {
      return [];
    }

    const searchUrl = buildSubtitleCatSearchUrl(this.base, trimmedNumber);
    const html = await fetchLimitedText(this.options.networkClient, searchUrl, {
      base: this.base,
      maxBytes: SUBTITLE_CAT_PAGE_LIMIT,
      signal,
      timeout: this.options.timeoutMs,
    });

    const candidates: SubtitleCatCandidate[] = [];
    for (const row of parseSubtitleCatSearchRows(html)) {
      throwIfAborted(signal);

      let links: SubtitleCatDetailLinks;
      try {
        links = await this.loadDetailLinks(row.detailPath, detailCache, signal);
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        this.logger.warn(`SubtitleCat detail page ${row.detailPath} failed: ${this.describe(error)}`);
        continue;
      }

      for (const language of listSubtitleCatDetailLanguages(links)) {
        if (language === "zh-TW" && this.options.fallbackTraditional === false) {
          continue;
        }
        candidates.push({ ...row, language });
      }
    }

    return this.rankCandidates(candidates, trimmedNumber);
  }

  /** Ports the reference's `sort.SliceStable` comparator, which keeps the page order as a tiebreak. */
  private rankCandidates(candidates: SubtitleCatCandidate[], number: string): SubtitleCatCandidate[] {
    const upperNumber = number.toUpperCase();
    const namesNumber = (candidate: SubtitleCatCandidate): boolean =>
      candidate.title.toUpperCase().includes(upperNumber);

    return candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((left, right) => {
        const leftNames = namesNumber(left.candidate);
        const rightNames = namesNumber(right.candidate);
        if (leftNames !== rightNames) {
          return leftNames ? -1 : 1;
        }

        if (left.candidate.language !== right.candidate.language) {
          return left.candidate.language === "zh-CN" ? -1 : 1;
        }

        if (left.candidate.downloads !== right.candidate.downloads) {
          return right.candidate.downloads - left.candidate.downloads;
        }

        return left.index - right.index;
      })
      .map((entry) => entry.candidate);
  }

  private async downloadWithCache(
    candidate: SubtitleCatCandidate,
    detailCache: DetailLinkCache,
    signal?: AbortSignal,
  ): Promise<DownloadedSubtitle> {
    const links = await this.loadDetailLinks(candidate.detailPath, detailCache, signal);
    const href = links[candidate.language];
    if (!href) {
      throw new SubtitleCatProviderError(`language ${candidate.language} is unavailable on ${candidate.detailPath}`);
    }

    const detailUrl = resolveSubtitleCatUrl(this.base, candidate.detailPath);
    const downloadUrl = resolveSubtitleCatUrl(this.base, href);
    const content = await fetchLimitedContent(this.options.networkClient, downloadUrl, {
      base: this.base,
      maxBytes: SUBTITLE_CAT_FILE_LIMIT,
      referer: detailUrl.toString(),
      signal,
      timeout: this.options.timeoutMs,
    });

    // An error page served with a 200 would otherwise be written out as a subtitle file.
    if (content.byteLength === 0 || looksLikeHtml(content)) {
      throw new SubtitleCatProviderError(`download returned HTML instead of a subtitle: ${downloadUrl.pathname}`);
    }

    return {
      language: candidate.language,
      format: extname(downloadUrl.pathname).replace(/^\./u, "").toLowerCase() || DEFAULT_FORMAT,
      content,
    };
  }

  private async loadDetailLinks(
    detailPath: string,
    detailCache: DetailLinkCache,
    signal?: AbortSignal,
  ): Promise<SubtitleCatDetailLinks> {
    const cached = detailCache.get(detailPath);
    if (cached) {
      return cached;
    }

    const detailUrl = resolveSubtitleCatUrl(this.base, detailPath);
    const html = await fetchLimitedText(this.options.networkClient, detailUrl, {
      base: this.base,
      maxBytes: SUBTITLE_CAT_PAGE_LIMIT,
      referer: this.base.toString(),
      signal,
      timeout: this.options.timeoutMs,
    });

    const links = parseSubtitleCatDetailLinks(html);
    detailCache.set(detailPath, links);
    return links;
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
