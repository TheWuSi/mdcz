import { type CheerioAPI, load } from "cheerio";
import type { EmbySubtitleLanguage } from "../media";
import { SubtitleCatProviderError } from "./errors";

/** Cheerio does not re-export its node type, so derive the selection type from the API itself. */
type CheerioSelection = ReturnType<CheerioAPI>;

/**
 * A single-star selector is enough: Font Awesome renders `<i class="fas fa-thumbs-down">`, so matching
 * `.fa-thumbs-down` also covers `.fas.fa-thumbs-down` and the `far`/`fa` weight variants.
 */
const THUMBS_DOWN_SELECTOR = ".fa-thumbs-down";
const DETAIL_PATH_PREFIXES = ["subs/", "/subs/"] as const;
const MAX_SEARCH_ROWS = 12;
/** Detail pages list one language per block; `download_<language>` is the anchor id Go keys on. */
const DETAIL_LANGUAGES: readonly EmbySubtitleLanguage[] = ["zh-CN", "zh-TW"];

export interface SubtitleCatSearchRow {
  title: string;
  detailPath: string;
  size: string;
  downloads: number;
}

export type SubtitleCatDetailLinks = Partial<Record<EmbySubtitleLanguage, string>>;

/** Ports Go's `nodeText`: all descendant text, whitespace collapsed to single spaces. */
const nodeText = (node: CheerioSelection): string => node.text().split(/\s+/u).filter(Boolean).join(" ");

/** Ports Go's `leadingInt`: parse the first whitespace-delimited field, ignoring thousands separators. */
const leadingInt = (value: string): number => {
  const [field] = value.trim().split(/\s+/u);
  if (!field) {
    return 0;
  }

  const parsed = Number.parseInt(field.replaceAll(",", ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const hasThumbsDown = (node: CheerioSelection): boolean => node.find(THUMBS_DOWN_SELECTOR).length > 0;

const parseHtml = (html: string, what: string): CheerioAPI => {
  try {
    return load(html);
  } catch (error) {
    throw new SubtitleCatProviderError(`failed to parse ${what}: ${error instanceof Error ? error.message : error}`);
  }
};

/**
 * Ports Go's `parseSubtitleCatSearch`, plus the thumbs-down filter the reference lacks: a row flagged
 * with a downvote icon is skipped outright so the next candidate takes its place.
 */
export const parseSubtitleCatSearchRows = (html: string): SubtitleCatSearchRow[] => {
  const $ = parseHtml(html, "search page");
  const rows: SubtitleCatSearchRow[] = [];

  $("tr").each((_index, element) => {
    if (rows.length >= MAX_SEARCH_ROWS) {
      return false;
    }

    const row = $(element);
    const cells = row.children("td");
    if (cells.length < 4) {
      return undefined;
    }

    if (hasThumbsDown(row)) {
      return undefined;
    }

    const link = cells.eq(0).find("a").first();
    const detailPath = (link.attr("href") ?? "").trim();
    if (!DETAIL_PATH_PREFIXES.some((prefix) => detailPath.startsWith(prefix))) {
      return undefined;
    }

    rows.push({
      title: nodeText(link),
      detailPath,
      size: nodeText(cells.eq(2)),
      downloads: leadingInt(nodeText(cells.eq(3))),
    });
    return undefined;
  });

  return rows;
};

/**
 * Ports Go's `parseSubtitleCatDetail`, again skipping downvoted blocks. Returned in `zh-CN`, `zh-TW`
 * order so simplified Chinese always wins when both are offered.
 */
export const parseSubtitleCatDetailLinks = (html: string): SubtitleCatDetailLinks => {
  const $ = parseHtml(html, "detail page");
  const links: SubtitleCatDetailLinks = {};

  for (const language of DETAIL_LANGUAGES) {
    const anchor = $(`a#download_${language}`).first();
    if (anchor.length === 0) {
      continue;
    }

    const href = (anchor.attr("href") ?? "").trim();
    if (!href) {
      continue;
    }

    // The icon sits beside the link rather than inside it, so widen to the enclosing block.
    const block = anchor.closest("div, li, tr, p");
    if (hasThumbsDown(block.length > 0 ? block : anchor)) {
      continue;
    }

    links[language] = href;
  }

  return links;
};

/** The languages a detail page actually offers, in preference order. */
export const listSubtitleCatDetailLanguages = (links: SubtitleCatDetailLinks): EmbySubtitleLanguage[] =>
  DETAIL_LANGUAGES.filter((language) => Boolean(links[language]));
