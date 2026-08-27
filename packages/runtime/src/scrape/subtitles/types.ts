import type { EmbySubtitleLanguage } from "../media";

export interface SubtitleCatCandidate {
  /** Row title as shown on the search page, used to prefer rows naming the number. */
  title: string;
  /** Site-relative detail page path, e.g. `subs/1234567/abc-111.html`. */
  detailPath: string;
  language: EmbySubtitleLanguage;
  /** Human readable size string from the search table; informational only. */
  size: string;
  downloads: number;
}

export interface DownloadedSubtitle {
  language: EmbySubtitleLanguage;
  /** Lowercased extension without the leading dot, e.g. `srt`, `ass`, `vtt`. */
  format: string;
  content: Buffer;
}
