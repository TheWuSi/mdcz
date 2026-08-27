import { describe, expect, it } from "vitest";
import {
  buildEmbySubtitleTargetPath,
  buildSubtitleSidecarEmbyTargetPaths,
  EMBY_SUBTITLE_SOURCE_TAGS,
  resolveSidecarEmbyLanguage,
} from "./embySubtitleNaming";
import type { SubtitleSidecarMatch } from "./subtitleSidecars";

const sidecar = (path: string, suffix: string, chinese = true): SubtitleSidecarMatch => ({
  path,
  suffix,
  subtitleTag: chinese ? "中文字幕" : "字幕",
});

describe("buildEmbySubtitleTargetPath", () => {
  it("renders the [Video].[Language].[SourceTag].[Ext] layout", () => {
    expect(
      buildEmbySubtitleTargetPath("/out/ABC-111/ABC-111.mp4", {
        language: "zh-CN",
        sourceTag: EMBY_SUBTITLE_SOURCE_TAGS.subtitleCat,
        extension: "srt",
      }),
    ).toBe("/out/ABC-111/ABC-111.zh-CN.subcat.srt");

    expect(
      buildEmbySubtitleTargetPath("/out/ABC-111/ABC-111.strm", {
        language: "zh-TW",
        sourceTag: EMBY_SUBTITLE_SOURCE_TAGS.local,
        extension: ".ass",
      }),
    ).toBe("/out/ABC-111/ABC-111.zh-TW.src.ass");
  });
});

describe("resolveSidecarEmbyLanguage", () => {
  it("maps simplified markers to zh-CN", () => {
    for (const suffix of [".chs", ".zh-CN", ".zh_cn", ".sc", ".zh", ".cn", ".中字", "-简中"]) {
      expect(resolveSidecarEmbyLanguage(sidecar(`/in/ABC-111${suffix}.srt`, suffix))).toBe("zh-CN");
    }
  });

  it("maps traditional markers to zh-TW", () => {
    for (const suffix of [".cht", ".zh-TW", ".tc", ".big5", ".繁中"]) {
      expect(resolveSidecarEmbyLanguage(sidecar(`/in/ABC-111${suffix}.srt`, suffix, false))).toBe("zh-TW");
    }
  });

  it("leaves non-Chinese, unlabeled, multipart and flagged sidecars alone", () => {
    for (const suffix of ["", ".eng", ".en", ".jp", ".cd1.chs", ".chs.forced", ".part2", ".sdh"]) {
      expect(resolveSidecarEmbyLanguage(sidecar(`/in/ABC-111${suffix}.srt`, suffix, false))).toBeUndefined();
    }
  });
});

describe("buildSubtitleSidecarEmbyTargetPaths", () => {
  it("normalizes Chinese sidecars and keeps everything else on its original suffix", () => {
    const sidecars = [
      sidecar("/in/ABC-111.chs.srt", ".chs"),
      sidecar("/in/ABC-111.eng.srt", ".eng", false),
      sidecar("/in/ABC-111.cht.ass", ".cht", false),
    ];

    expect(buildSubtitleSidecarEmbyTargetPaths(sidecars, "/out/ABC-111/ABC-111.mp4")).toEqual([
      "/out/ABC-111/ABC-111.zh-CN.src.srt",
      "/out/ABC-111/ABC-111.eng.srt",
      "/out/ABC-111/ABC-111.zh-TW.src.ass",
    ]);
  });

  it("disambiguates two sidecars that normalize onto the same name", () => {
    const sidecars = [sidecar("/in/ABC-111.chs.srt", ".chs"), sidecar("/in/ABC-111.zh.srt", ".zh")];

    expect(buildSubtitleSidecarEmbyTargetPaths(sidecars, "/out/ABC-111/ABC-111.mp4")).toEqual([
      "/out/ABC-111/ABC-111.zh-CN.src.srt",
      "/out/ABC-111/ABC-111.zh-CN.src2.srt",
    ]);
  });

  it("is idempotent for already-organized output regardless of directory order", () => {
    // Re-scraping in place must not shuffle `src` onto a different file.
    const sidecars = [
      sidecar("/out/ABC-111/ABC-111.chs.srt", ".chs"),
      sidecar("/out/ABC-111/ABC-111.zh-CN.src.srt", ".zh-CN.src"),
    ];

    expect(buildSubtitleSidecarEmbyTargetPaths(sidecars, "/out/ABC-111/ABC-111.mp4")).toEqual([
      "/out/ABC-111/ABC-111.zh-CN.src2.srt",
      "/out/ABC-111/ABC-111.zh-CN.src.srt",
    ]);
  });

  it("keeps a distinct target for each part of a multipart release", () => {
    const cd1 = [sidecar("/in/ABC-111-CD1.chs.srt", ".chs")];
    const cd2 = [sidecar("/in/ABC-111-CD2.chs.srt", ".chs")];

    expect(buildSubtitleSidecarEmbyTargetPaths(cd1, "/out/ABC-111/ABC-111-CD1.mp4")).toEqual([
      "/out/ABC-111/ABC-111-CD1.zh-CN.src.srt",
    ]);
    expect(buildSubtitleSidecarEmbyTargetPaths(cd2, "/out/ABC-111/ABC-111-CD2.mp4")).toEqual([
      "/out/ABC-111/ABC-111-CD2.zh-CN.src.srt",
    ]);
  });
});
