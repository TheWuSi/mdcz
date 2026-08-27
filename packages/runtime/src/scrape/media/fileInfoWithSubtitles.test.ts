import { describe, expect, it } from "vitest";
import { parseFileInfo } from "../utils/number";
import { resolveFileInfoWithSubtitles } from "./fileInfoWithSubtitles";
import type { SubtitleSidecarMatch } from "./subtitleSidecars";

const chineseSidecar = (path: string, suffix: string): SubtitleSidecarMatch => ({
  path,
  suffix,
  subtitleTag: "中文字幕",
});

describe("resolveFileInfoWithSubtitles", () => {
  it("marks a sidecar-only Chinese subtitle as external without claiming it is native", async () => {
    const { fileInfo } = await resolveFileInfoWithSubtitles("/input/ABC-111.mp4", {
      parsedFileInfo: parseFileInfo("/input/ABC-111.mp4"),
      subtitleSidecars: [chineseSidecar("/input/ABC-111.chs.srt", ".chs")],
    });

    expect(fileInfo).toMatchObject({
      number: "ABC-111",
      isSubtitled: true,
      subtitleTag: "中文字幕",
      nativeSubtitled: false,
      subtitleOrigin: "external",
    });
  });

  it("keeps a filename-native marker classified as embedded even when sidecars exist", async () => {
    const { fileInfo } = await resolveFileInfoWithSubtitles("/input/ABC-111-C.mp4", {
      parsedFileInfo: parseFileInfo("/input/ABC-111-C.mp4"),
      subtitleSidecars: [chineseSidecar("/input/ABC-111-C.zh-CN.srt", ".zh-CN")],
    });

    expect(fileInfo).toMatchObject({
      number: "ABC-111",
      nativeSubtitled: true,
      subtitleOrigin: "embedded",
    });
  });

  it("leaves origin unset when no subtitle exists at all", async () => {
    const { fileInfo } = await resolveFileInfoWithSubtitles("/input/ABC-111.mp4", {
      parsedFileInfo: parseFileInfo("/input/ABC-111.mp4"),
      subtitleSidecars: [],
    });

    expect(fileInfo.isSubtitled).toBe(false);
    expect(fileInfo.subtitleTag).toBeUndefined();
    expect(fileInfo.nativeSubtitled).toBe(false);
    expect(fileInfo.subtitleOrigin).toBeUndefined();
  });
});
