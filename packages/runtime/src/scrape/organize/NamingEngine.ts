import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { Configuration } from "@mdcz/shared/config";
import { Website } from "@mdcz/shared/enums";
import type { CrawlerData, FileInfo, NamingPreviewItem, NfoLocalState } from "@mdcz/shared/types";
import { classifyMovie, type MovieClassification } from "../utils/movieClassification";
import { buildSafeFileName, buildSafePath } from "../utils/path";
import { hasNativeChineseSubtitleTag, resolveFileInfoSubtitleTag } from "../utils/subtitles";

export interface NamingLayout {
  folderRelativePath: string;
  targetVideoFileName: string;
  nfoFileName: string;
}

interface ActorTemplateValue {
  actor: string;
  actorFallbackPrefix?: string;
}

const FC2_NUMBER_PATTERN = /^FC2(?:-?PPV)?-?\d+$/iu;

const isSellerFallback = (data: CrawlerData): boolean => {
  return FC2_NUMBER_PATTERN.test(data.number.trim());
};

const pickActorTemplateValue = (config: Configuration, actors: string[], data: CrawlerData): ActorTemplateValue => {
  const cleaned = actors.map((actor) => actor.trim()).filter((actor) => actor.length > 0);
  if (cleaned.length === 0) {
    const fallbackValue = data.studio?.trim();
    if (config.naming.actorFallbackToStudio && fallbackValue) {
      return {
        actor: fallbackValue,
        actorFallbackPrefix: isSellerFallback(data) ? "卖家：" : "片商：",
      };
    }
    return { actor: "Unknown" };
  }

  const max = Math.max(1, config.naming.actorNameMax);
  const selected = cleaned.slice(0, max);
  if (cleaned.length > max) {
    selected.push(config.naming.actorNameMore);
  }

  return { actor: selected.join(" ") };
};

const normalizeMarker = (value: string): string => value.trim();

type NamingMarkerKind = "subtitle" | "umr" | "leak" | "uncensored" | "censored";

interface NamingMarker {
  kind: NamingMarkerKind;
  value: string;
}

const appendMarker = (markers: NamingMarker[], kind: NamingMarkerKind, value: string): void => {
  const marker = normalizeMarker(value);
  if (!marker || markers.some((entry) => entry.value === marker)) {
    return;
  }
  markers.push({ kind, value: marker });
};

/** A marker short enough to read as part of one suffix, e.g. `-C`, `-U`, `-4K`. */
const SHORT_MARKER_PATTERN = /^([-_.])([A-Za-z0-9]{1,2})$/u;
/** Censorship markers merge in this order so `-U` + `-C` reads as the conventional `-UC`. */
const CENSORSHIP_MARKER_ORDER: readonly NamingMarkerKind[] = ["umr", "leak", "uncensored", "censored"];

/**
 * Collapses the Chinese-subtitle marker and the censorship markers into a single suffix when all of
 * them are short and share a delimiter: `-C` plus `-U` becomes `-UC`, not `-C-U`. Long markers — the
 * `-破解` / `-流出` defaults, or anything a user typed — are left exactly where they were, so existing
 * libraries keep their names.
 */
const mergeShortNamingMarkers = (markers: NamingMarker[]): NamingMarker[] => {
  const subtitleMarker = markers.find((marker) => marker.kind === "subtitle");
  const subtitleMatch = subtitleMarker?.value.match(SHORT_MARKER_PATTERN);
  if (!subtitleMatch) {
    return markers;
  }

  const delimiter = subtitleMatch[1];
  const mergeable = new Set(
    markers.filter((marker) => {
      if (marker.kind === "subtitle") {
        return false;
      }
      const match = marker.value.match(SHORT_MARKER_PATTERN);
      return match !== null && match[1] === delimiter;
    }),
  );
  if (mergeable.size === 0) {
    return markers;
  }

  const censorshipLetters = [...mergeable]
    .sort((left, right) => CENSORSHIP_MARKER_ORDER.indexOf(left.kind) - CENSORSHIP_MARKER_ORDER.indexOf(right.kind))
    .map((marker) => marker.value.slice(delimiter.length))
    .join("");

  return markers
    .filter((marker) => !mergeable.has(marker))
    .map((marker) =>
      marker === subtitleMarker
        ? { kind: "subtitle" as const, value: `${delimiter}${censorshipLetters}${subtitleMatch[2]}` }
        : marker,
    );
};

const formatPartSuffix = (fileInfo: FileInfo, config: Configuration): string => {
  if (!fileInfo.part) {
    return "";
  }

  if (config.naming.partStyle === "RAW") {
    return fileInfo.part.suffix;
  }

  return `-${config.naming.partStyle}${fileInfo.part.number}`;
};

const buildNamingMarkers = (
  fileInfo: FileInfo,
  config: Configuration,
  classification: MovieClassification,
): string[] => {
  const markers: NamingMarker[] = [];
  // Only a filename-native marker may reach the output name; sidecar or downloaded
  // subtitles must never append `-C` to a number that did not carry one.
  if (hasNativeChineseSubtitleTag(fileInfo)) {
    appendMarker(markers, "subtitle", config.naming.cnwordStyle);
  }

  if (classification.umr) {
    appendMarker(markers, "umr", config.naming.umrStyle);
  }

  if (classification.leak) {
    appendMarker(markers, "leak", config.naming.leakStyle);
  }

  if (classification.uncensored) {
    appendMarker(markers, "uncensored", config.naming.uncensoredStyle);
  } else {
    appendMarker(markers, "censored", config.naming.censoredStyle);
  }

  return mergeShortNamingMarkers(markers).map((marker) => marker.value);
};

const buildNumberWithNamingMarkers = (number: string, markers: string[]): string => {
  const baseNumber = number.trim();
  if (!baseNumber) {
    return number;
  }

  return `${baseNumber}${markers.join("")}`;
};

const formatReleaseDateByRule = (releaseDate: string | undefined, rule: string): string | undefined => {
  if (!releaseDate) {
    return undefined;
  }

  const normalized = releaseDate.trim();
  if (!normalized) {
    return undefined;
  }

  const match = normalized.match(/^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/u);
  if (!match) {
    return normalized;
  }

  const year = match[1];
  const month = match[2].padStart(2, "0");
  const day = match[3].padStart(2, "0");
  const template = rule.trim() || "YYYY-MM-DD";

  return template.replaceAll("YYYY", year).replaceAll("MM", month).replaceAll("DD", day);
};

const extractReleaseYear = (releaseDate: string | undefined): string | undefined => {
  const match = releaseDate?.trim().match(/^(\d{4})/u);
  return match?.[1];
};

const formatRuntimeMinutes = (durationSeconds: number | undefined): string | undefined => {
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return undefined;
  }

  return String(Math.max(1, Math.round(durationSeconds / 60)));
};

const getNumberLetters = (number: string): string | undefined => {
  const normalized = number.trim();
  if (!normalized) {
    return undefined;
  }

  const upper = normalized.toUpperCase();
  for (const prefix of ["FC2", "MYWIFE", "KIN8", "S2M", "T28", "TH101", "XXX-AV"]) {
    if (upper.startsWith(prefix)) {
      return prefix;
    }
  }

  const match = normalized.match(/(\d*[A-Za-z]+)\d*/u);
  return match?.[1]?.toUpperCase();
};

const getNumberFirstLetter = (number: string): string | undefined => {
  const first = number.trim().charAt(0).toUpperCase();
  if (!first) {
    return undefined;
  }

  return /[0-9A-Z]/u.test(first) ? first : "#";
};

/**
 * The top-level library folder the source file came from — `movies` for
 * `<mediaPath>/movies/Inception (2010)/Inception (2010).mkv`.
 *
 * Only the first segment, never the whole relative directory: it answers "which library is this"
 * so a template like `{originPath}/{number}` keeps movies, tv and anime apart under one output root,
 * without replicating the source tree. Returns undefined when the media directory is unset or the
 * file sits outside it, which drops the segment from the rendered path instead of failing the file.
 */
const resolveOriginPathSegment = (filePath: string, mediaPath: string): string | undefined => {
  const configuredMediaRoot = mediaPath.trim();
  if (!configuredMediaRoot || !isAbsolute(configuredMediaRoot) || !isAbsolute(filePath)) {
    return undefined;
  }

  const relativeDir = relative(resolve(configuredMediaRoot), resolve(dirname(filePath)));
  if (!relativeDir || relativeDir === ".." || relativeDir.startsWith(`..${sep}`) || isAbsolute(relativeDir)) {
    return undefined;
  }

  return relativeDir.split(/[\\/]/u)[0] || undefined;
};

const formatDefinition = (fileInfo: FileInfo): string | undefined => {
  const resolution = fileInfo.resolution?.trim();
  return resolution || undefined;
};

const formatFourKLabel = (definition: string | undefined): string | undefined => {
  if (!definition) {
    return undefined;
  }

  const normalized = definition.toUpperCase();
  if (["8K", "4320P", "UHD8"].includes(normalized)) {
    return "8K";
  }

  if (["4K", "2160P", "UHD"].includes(normalized)) {
    return "4K";
  }

  return undefined;
};

const formatCensorshipType = (classification: MovieClassification): string => {
  if (classification.umr) {
    return "无码破解";
  }

  if (classification.leak) {
    return "无码流出";
  }

  return classification.uncensored ? "无码" : "有码";
};

const toTemplateValue = (value: string | number | undefined): string | number | undefined => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const truncateSegment = (value: string, maxLength: number): string => {
  const limit = Math.max(1, Math.trunc(maxLength));
  if (value.length <= limit) {
    return value;
  }
  return value.slice(0, limit).trim();
};

const truncatePathSegments = (value: string, maxLength: number): string => {
  return value
    .split(/[\\/]+/u)
    .map((segment) => truncateSegment(segment, maxLength))
    .filter((segment) => segment.length > 0)
    .join("/");
};

const previewFileInfo = (number: string, overrides?: Partial<FileInfo>): FileInfo => ({
  filePath: `/preview/${number}.mp4`,
  fileName: number,
  extension: ".mp4",
  number,
  isSubtitled: false,
  resolution: "1080P",
  ...overrides,
});

const previewData = (number: string, overrides?: Partial<CrawlerData>): CrawlerData => ({
  title: "Sample Original Title",
  title_zh: "示例中文标题",
  number,
  actors: ["演员A"],
  genres: [],
  studio: "示例制片",
  director: "示例导演",
  publisher: "示例发行",
  series: "示例系列",
  plot: "Sample plot",
  plot_zh: "示例简介",
  release_date: "2024-01-15",
  durationSeconds: 7260,
  rating: 4.5,
  scene_images: [],
  website: Website.DMM,
  ...overrides,
});

const NAMING_PREVIEW_SAMPLES: Array<{
  label: string;
  fileInfo: FileInfo;
  data: CrawlerData;
  localState?: NfoLocalState;
}> = [
  {
    label: "普通",
    fileInfo: previewFileInfo("ABC-123"),
    data: previewData("ABC-123"),
  },
  {
    label: "中文字幕",
    fileInfo: previewFileInfo("ABC-456", {
      isSubtitled: true,
      subtitleTag: "中文字幕",
      nativeSubtitled: true,
      subtitleOrigin: "embedded",
      resolution: "2160P",
    }),
    data: previewData("ABC-456", { title_zh: "中文字幕示例", actors: ["演员B"], studio: "Studio X" }),
  },
  {
    label: "无码破解中字",
    fileInfo: previewFileInfo("ABC-789", {
      isSubtitled: true,
      subtitleTag: "中文字幕",
      nativeSubtitled: true,
      subtitleOrigin: "embedded",
      isUncensored: true,
      filenameUncensoredChoice: "umr",
    }),
    data: previewData("ABC-789", { title_zh: "无码破解中字示例", actors: ["演员C"], studio: "Studio Y" }),
  },
  {
    label: "多演员",
    fileInfo: previewFileInfo("DEF-012"),
    data: previewData("DEF-012", {
      title_zh: "多演员作品",
      actors: ["演员E", "演员F", "演员G", "演员H"],
      studio: "Studio W",
    }),
  },
  {
    label: "演员为空",
    fileInfo: previewFileInfo("FC2-123456"),
    data: previewData("FC2-123456", {
      actors: [],
      studio: "示例卖家",
      publisher: "示例卖家",
      website: Website.FC2,
    }),
  },
];

/**
 * Re-homes the preview sample under the configured media directory so `{originPath}` renders a
 * plausible library folder instead of nothing. The rest of the sample is already illustrative data.
 */
const PREVIEW_ORIGIN_FOLDER = "movies";

const previewSampleFileInfo = (fileInfo: FileInfo, config: Configuration): FileInfo => {
  const mediaRoot = config.paths.mediaPath.trim();
  if (!mediaRoot || !isAbsolute(mediaRoot)) {
    return fileInfo;
  }

  return {
    ...fileInfo,
    filePath: join(mediaRoot, PREVIEW_ORIGIN_FOLDER, `${fileInfo.fileName}${fileInfo.extension}`),
  };
};

export class NamingEngine {
  buildLayout(fileInfo: FileInfo, data: CrawlerData, config: Configuration, localState?: NfoLocalState): NamingLayout {
    const title = data.title_zh?.trim() || data.title;
    const originaltitle = data.original_title?.trim() || data.title.trim();
    const actorTemplateValue = pickActorTemplateValue(config, data.actors ?? [], data);
    const classification = classifyMovie(fileInfo, data, localState);
    const markers = buildNamingMarkers(fileInfo, config, classification);
    const styledNumber = buildNumberWithNamingMarkers(data.number, markers);
    const partSuffix = formatPartSuffix(fileInfo, config);
    const formattedReleaseDate = formatReleaseDateByRule(data.release_date, config.naming.releaseRule);
    const rawActors = (data.actors ?? []).map((actor) => actor.trim()).filter((actor) => actor.length > 0);
    const firstActor = rawActors[0] ?? actorTemplateValue.actor;
    const allActors = rawActors.length > 0 ? rawActors.join(" ") : actorTemplateValue.actor;
    const outline = data.plot_zh?.trim() || data.plot?.trim();
    const definition = formatDefinition(fileInfo);
    const fourK = formatFourKLabel(definition);
    const nativeChineseSubtitle = hasNativeChineseSubtitleTag(fileInfo);
    const cnword = nativeChineseSubtitle ? config.naming.cnwordStyle : undefined;
    const sourceFileName = fileInfo.fileName.trim() || parse(fileInfo.filePath).name;
    const censorshipType = formatCensorshipType(classification);
    const templateData = {
      title,
      originaltitle,
      number: styledNumber,
      rawNumber: data.number,
      actor: actorTemplateValue.actor,
      actorFallbackPrefix: actorTemplateValue.actorFallbackPrefix,
      date: formattedReleaseDate,
      release: formattedReleaseDate,
      year: extractReleaseYear(data.release_date),
      runtime: formatRuntimeMinutes(data.durationSeconds),
      director: data.director,
      series: data.series,
      studio: data.studio,
      publisher: data.publisher,
      outline,
      plot: outline,
      firstActor,
      allActors,
      letters: getNumberLetters(data.number),
      firstLetter: getNumberFirstLetter(data.number),
      filename: sourceFileName,
      originPath: resolveOriginPathSegment(fileInfo.filePath, config.paths.mediaPath),
      definition,
      resolution: definition,
      "4K": fourK,
      cnword,
      subtitle: nativeChineseSubtitle ? resolveFileInfoSubtitleTag(fileInfo) : undefined,
      censorshipType,
      score: toTemplateValue(data.rating),
      rating: toTemplateValue(data.rating),
      website: data.website,
    };

    const sourceVideo = parse(fileInfo.filePath);
    const folderRelativePath = truncatePathSegments(
      buildSafePath(config.naming.folderTemplate, templateData),
      config.naming.folderNameMax,
    );
    const fileBaseName = truncateSegment(
      buildSafeFileName(config.naming.fileTemplate, templateData) || styledNumber,
      config.naming.fileNameMax,
    );
    const nfoBaseName = fileInfo.part ? fileBaseName : parse(sourceVideo.base).name;
    const shouldRenameOutput = config.behavior.fileMode === "separated" || config.behavior.successFileRename;
    const targetExtension = config.behavior.fileMode === "separated" ? ".strm" : fileInfo.extension;
    const targetVideoFileName = shouldRenameOutput
      ? `${fileBaseName}${partSuffix}${targetExtension}`
      : sourceVideo.base;
    const nfoFileName = `${shouldRenameOutput ? fileBaseName : nfoBaseName}.nfo`;

    return {
      folderRelativePath,
      targetVideoFileName,
      nfoFileName,
    };
  }

  buildPreview(config: Configuration): NamingPreviewItem[] {
    return NAMING_PREVIEW_SAMPLES.map((sample) => {
      const layout = this.buildLayout(
        previewSampleFileInfo(sample.fileInfo, config),
        sample.data,
        config,
        sample.localState,
      );
      return {
        label: sample.label,
        folder:
          config.behavior.fileMode === "separated" || config.behavior.successFileMove
            ? layout.folderRelativePath || "当前目录"
            : "当前目录",
        file: layout.targetVideoFileName,
      };
    });
  }
}
