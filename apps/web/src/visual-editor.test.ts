import { expect, it } from "vitest";
import type { SourceDto } from "@hibiki/contracts";

it("offers the real streams of an owned original that needs conversion", async () => {
  const { donorVideoFiles, offeredStreams } = await import("./visual-editor-model");
  const original: SourceDto = {id:"mkv", provider:"local", status:"unavailable", reason:"unsupported_codec", mime:"video/x-matroska",
    videoStreams:[{index:0,codec:"h264"},{index:2,codec:"vp9"}]};
  expect(donorVideoFiles([original,{...original,id:"missing",reason:"missing_file"},{...original,id:"shared",shared:true}]).map(s=>s.id)).toEqual(["mkv"]);
  expect(offeredStreams("Выберите videoStreamIndex: 0 (h264), 2 (vp9)")).toEqual(original.videoStreams);
  expect(offeredStreams("Запись удалена")).toEqual([]);
});
