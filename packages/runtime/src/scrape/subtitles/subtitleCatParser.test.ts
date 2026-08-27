import { describe, expect, it } from "vitest";
import {
  listSubtitleCatDetailLanguages,
  parseSubtitleCatDetailLinks,
  parseSubtitleCatSearchRows,
} from "./subtitleCatParser";

const searchRow = (input: {
  href: string;
  title: string;
  size: string;
  downloads: string;
  downvoted?: boolean;
}): string => `
  <tr>
    <td>
      <a href="${input.href}">${input.title}</a>
      ${input.downvoted ? '<i class="fas fa-thumbs-down"></i>' : '<i class="fas fa-thumbs-up"></i>'}
    </td>
    <td>Chinese</td>
    <td>${input.size}</td>
    <td>${input.downloads}</td>
  </tr>`;

const searchPage = (rows: string[]): string => `
  <html><body><table class="table">
    <thead><tr><th>Name</th><th>Language</th><th>Size</th><th>Downloads</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table></body></html>`;

describe("parseSubtitleCatSearchRows", () => {
  it("reads title, detail path, size and download count from each row", () => {
    const html = searchPage([
      searchRow({
        href: "subs/1001/abc-111.html",
        title: "ABC-111  Chinese\n subtitle",
        size: "42 KB",
        downloads: "1,204 downloads",
      }),
      searchRow({ href: "/subs/1002/abc-111-alt.html", title: "Another ABC-111", size: "8 KB", downloads: "12" }),
    ]);

    expect(parseSubtitleCatSearchRows(html)).toEqual([
      { title: "ABC-111 Chinese subtitle", detailPath: "subs/1001/abc-111.html", size: "42 KB", downloads: 1204 },
      { title: "Another ABC-111", detailPath: "/subs/1002/abc-111-alt.html", size: "8 KB", downloads: 12 },
    ]);
  });

  it("skips downvoted rows so the next candidate takes their place", () => {
    const html = searchPage([
      searchRow({ href: "subs/1001/bad.html", title: "Bad rip", size: "1 KB", downloads: "9999", downvoted: true }),
      searchRow({ href: "subs/1002/good.html", title: "Good rip", size: "40 KB", downloads: "10" }),
    ]);

    expect(parseSubtitleCatSearchRows(html).map((row) => row.detailPath)).toEqual(["subs/1002/good.html"]);
  });

  it("ignores header rows and links that are not subtitle detail pages", () => {
    const html = searchPage([
      searchRow({ href: "https://ads.example/promo", title: "Sponsored", size: "0", downloads: "0" }),
      searchRow({ href: "index.php?search=other", title: "Related search", size: "0", downloads: "0" }),
    ]);

    expect(parseSubtitleCatSearchRows(html)).toEqual([]);
  });

  it("caps the row list at 12 entries", () => {
    const rows = Array.from({ length: 20 }, (_value, index) =>
      searchRow({ href: `subs/${index}/abc-111.html`, title: `ABC-111 #${index}`, size: "1 KB", downloads: "1" }),
    );

    expect(parseSubtitleCatSearchRows(searchPage(rows))).toHaveLength(12);
  });
});

describe("parseSubtitleCatDetailLinks", () => {
  const detailPage = (input: { simplified?: string; traditional?: string; downvoted?: "zh-CN" | "zh-TW" }): string => `
    <html><body>
      ${
        input.simplified
          ? `<div class="sub-single">
               ${input.downvoted === "zh-CN" ? '<span><i class="fas fa-thumbs-down"></i></span>' : ""}
               <a id="download_zh-CN" href="${input.simplified}">Download</a>
             </div>`
          : ""
      }
      ${
        input.traditional
          ? `<div class="sub-single">
               ${input.downvoted === "zh-TW" ? '<span><i class="fa fa-thumbs-down"></i></span>' : ""}
               <a id="download_zh-TW" href="${input.traditional}">Download</a>
             </div>`
          : ""
      }
    </body></html>`;

  it("extracts both Chinese variants and orders simplified first", () => {
    const links = parseSubtitleCatDetailLinks(
      detailPage({ simplified: "/subs/1/a.zh-CN.srt", traditional: "/subs/1/a.zh-TW.srt" }),
    );

    expect(links).toEqual({ "zh-CN": "/subs/1/a.zh-CN.srt", "zh-TW": "/subs/1/a.zh-TW.srt" });
    expect(listSubtitleCatDetailLanguages(links)).toEqual(["zh-CN", "zh-TW"]);
  });

  it("drops a language whose block is downvoted", () => {
    const links = parseSubtitleCatDetailLinks(
      detailPage({ simplified: "/subs/1/a.zh-CN.srt", traditional: "/subs/1/a.zh-TW.srt", downvoted: "zh-CN" }),
    );

    expect(listSubtitleCatDetailLanguages(links)).toEqual(["zh-TW"]);
  });

  it("returns nothing when the page offers no Chinese download", () => {
    expect(listSubtitleCatDetailLanguages(parseSubtitleCatDetailLinks("<html><body>no subs</body></html>"))).toEqual(
      [],
    );
  });
});
