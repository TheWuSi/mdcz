import type { LibraryEntryDto } from "@mdcz/shared/serverDtos";
import { describe, expect, it } from "vitest";
import { resolveLibraryThumbnailRef } from "./libraryAssets";

const createEntry = (overrides: Partial<LibraryEntryDto> = {}): LibraryEntryDto => ({
  actors: [],
  assets: [],
  available: null,
  crawlerData: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  directory: "Actor A/ABC-123",
  fileName: "ABC-123.strm",
  fileRefs: [],
  hiddenFromRecentAt: null,
  id: "entry-1",
  lastKnownPath: null,
  lastRefreshedAt: null,
  mediaIdentity: "ABC-123",
  modifiedAt: null,
  number: "ABC-123",
  relativePath: "ABC-123.mp4",
  rootDisplayName: "Media",
  rootId: "media-root",
  scrapeOutputId: null,
  size: 0,
  taskId: null,
  thumbnailPath: null,
  title: null,
  ...overrides,
});

describe("library thumbnail asset references", () => {
  it("uses the matched poster asset root in separated mode", () => {
    const entry = createEntry({
      thumbnailPath: "Actor A/ABC-123/poster.jpg",
      assets: [
        {
          id: "poster-1",
          kind: "poster",
          uri: "Actor A/ABC-123/poster.jpg",
          rootId: "metadata-root",
          relativePath: "Actor A/ABC-123/poster.jpg",
        },
      ],
    });

    expect(resolveLibraryThumbnailRef(entry)).toEqual({
      path: "Actor A/ABC-123/poster.jpg",
      rootId: "metadata-root",
    });
  });

  it("falls back to the media root for legacy entries without asset root metadata", () => {
    const entry = createEntry({ thumbnailPath: "ABC-123/poster.jpg" });

    expect(resolveLibraryThumbnailRef(entry)).toEqual({
      path: "ABC-123/poster.jpg",
      rootId: "media-root",
    });
  });
});
