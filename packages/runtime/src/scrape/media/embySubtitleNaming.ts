import { extname, join, parse, resolve } from "node:path";
import { detectSubtitleTagFromSidecarSuffix, normalizeSubtitleText } from "../utils/subtitles";
import { buildSubtitleSidecarTargetPath, type SubtitleSidecarMatch } from "./subtitleSidecars";

/**
 * EMBY sidecar subtitles are named `[Video].[Language].[SourceTag].[Ext]`. The source tag
 * keeps a locally supplied subtitle distinguishable from one fetched by SubtitleCat, so both
 * can live side by side as primary/secondary tracks.
 */
export const EMBY_SUBTITLE_SOURCE_TAGS = {
  local: "src",
  subtitleCat: "subcat",
} as const;

export type EmbySubtitleSourceTag = (typeof EMBY_SUBTITLE_SOURCE_TAGS)[keyof typeof EMBY_SUBTITLE_SOURCE_TAGS];
export type EmbySubtitleLanguage = "zh-CN" | "zh-TW";

const SIMPLIFIED_TOKENS = new Set(["zh-cn", "zhcn", "zh-hans", "zhhans", "chs", "sc", "gb", "gbk"]);
const TRADITIONAL_TOKENS = new Set(["zh-tw", "zhtw", "zh-hk", "zh-hant", "zhhant", "cht", "tc", "big5"]);
const TRADITIONAL_TEXT_HINTS = ["繁中", "繁體", "繁体", "正體", "正体"] as const;
/** Suffixes carrying multipart or EMBY flag semantics must keep their original text. */
const RESERVED_SUFFIX_PATTERN =
  /(?:^|[-_.\s])(?:cd|part|ep|disc|disk)[-_\s]?\d{1,2}(?:$|[-_.\s])|(?:^|[-_.\s])(?:forced|sdh|default|cc)(?:$|[-_.\s])/iu;

const splitSuffixTokens = (suffix: string): string[] =>
  normalizeSubtitleText(suffix)
    .toLowerCase()
    .split(/[-_.\s()[\]{}【】（）]+/u)
    .filter((token) => token.length > 0);

/**
 * Rejoins adjacent tokens so `zh-CN` survives the same split that isolates `chs`.
 */
const buildSuffixTokenCandidates = (suffix: string): string[] => {
  const tokens = splitSuffixTokens(suffix);
  const candidates = [...tokens];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    candidates.push(`${tokens[index]}-${tokens[index + 1]}`);
  }
  return candidates;
};

export const buildEmbySubtitleTargetPath = (
  targetVideoPath: string,
  options: {
    language: EmbySubtitleLanguage;
    sourceTag: string;
    extension: string;
  },
): string => {
  const targetVideo = parse(targetVideoPath);
  const extension = options.extension.startsWith(".") ? options.extension : `.${options.extension}`;
  return join(targetVideo.dir, `${targetVideo.name}.${options.language}.${options.sourceTag}${extension}`);
};

/**
 * Resolves the EMBY language token for a local sidecar, or `undefined` when the sidecar is not
 * recognizably Chinese (English tracks, unlabeled subtitles, multipart/forced variants). Callers
 * must leave those names untouched rather than guess a language.
 */
export const resolveSidecarEmbyLanguage = (sidecar: SubtitleSidecarMatch): EmbySubtitleLanguage | undefined => {
  const suffix = sidecar.suffix;
  if (!suffix.trim() || RESERVED_SUFFIX_PATTERN.test(suffix)) {
    return undefined;
  }

  const normalized = normalizeSubtitleText(suffix);
  const candidates = buildSuffixTokenCandidates(suffix);
  if (
    candidates.some((token) => TRADITIONAL_TOKENS.has(token)) ||
    TRADITIONAL_TEXT_HINTS.some((hint) => normalized.includes(hint))
  ) {
    return "zh-TW";
  }

  if (candidates.some((token) => SIMPLIFIED_TOKENS.has(token))) {
    return "zh-CN";
  }

  // Falls back to the shared detector for generic markers such as `.zh`, `.cn` or `.中字`.
  return detectSubtitleTagFromSidecarSuffix(suffix) === "中文字幕" ? "zh-CN" : undefined;
};

/**
 * Maps every sidecar to its final on-disk path, in the same order it was given. Chinese sidecars
 * are normalized to the EMBY layout; everything else keeps its original suffix.
 *
 * Both the collision planner and the mover call this so they agree on the exact names. Two
 * sidecars can normalize onto one name (`.chs.srt` plus `.zh.srt`); the extras get `src2`,
 * `src3`, … Names already matching their own EMBY target are reserved first, so re-running a
 * scrape over organized output is a no-op instead of shuffling tags.
 */
export const buildSubtitleSidecarEmbyTargetPaths = (
  sidecars: readonly SubtitleSidecarMatch[],
  targetVideoPath: string,
): string[] => {
  const targets = new Array<string | undefined>(sidecars.length);
  const taken = new Set<string>();
  const languages = sidecars.map((sidecar) => resolveSidecarEmbyLanguage(sidecar));

  const buildCandidate = (language: EmbySubtitleLanguage, extension: string, attempt: number): string =>
    buildEmbySubtitleTargetPath(targetVideoPath, {
      language,
      sourceTag: attempt === 0 ? EMBY_SUBTITLE_SOURCE_TAGS.local : `${EMBY_SUBTITLE_SOURCE_TAGS.local}${attempt + 1}`,
      extension,
    });

  sidecars.forEach((sidecar, index) => {
    const language = languages[index];
    if (!language) {
      const legacyTarget = buildSubtitleSidecarTargetPath(sidecar, targetVideoPath);
      targets[index] = legacyTarget;
      taken.add(legacyTarget);
      return;
    }

    // Reserve stable names first: a sidecar already sitting at its own EMBY target keeps it.
    const preferred = buildCandidate(language, extname(sidecar.path), 0);
    if (resolve(sidecar.path) === resolve(preferred)) {
      targets[index] = preferred;
      taken.add(preferred);
    }
  });

  sidecars.forEach((sidecar, index) => {
    if (targets[index]) {
      return;
    }

    const language = languages[index];
    if (!language) {
      return;
    }

    const extension = extname(sidecar.path);
    for (let attempt = 0; ; attempt += 1) {
      const candidate = buildCandidate(language, extension, attempt);
      if (!taken.has(candidate)) {
        targets[index] = candidate;
        taken.add(candidate);
        return;
      }
    }
  });

  return targets.map((target, index) => target ?? buildSubtitleSidecarTargetPath(sidecars[index], targetVideoPath));
};
