import { describe, expect, it } from "vitest";
import { audioSummary, qualityChecked, qualityFacetGroups, qualityFilterLabel, qualityRows, qualityTitle, toggleQuality, videoSummary } from "./quality";

describe("audio quality presentation", () => {
  it("summarizes lossy and lossless sound without a misleading bit depth", () => {
    expect(audioSummary({ codec: "aac", format: "aac", class: "lossy", name: "AAC", label: "AAC 128", profile: "LC",
      bitrate: 128, sampleRate: 44100, channels: 2, layout: "stereo" })).toBe("AAC LC · 128 kb/s · 44,1 кГц · стерео");
    expect(audioSummary({ codec: "aac", format: "aac", class: "lossy", name: "HE-AAC", label: "HE-AAC 47", profile: "HE-AAC" }))
      .toBe("HE-AAC");
    expect(audioSummary({ codec: "flac", format: "flac", class: "hires", name: "FLAC", label: "FLAC 24/96",
      sampleRate: 96000, bitDepth: 24, channels: 6, layout: "5.1" })).toBe("FLAC · 96 кГц · 24 бит · 5.1");
    expect(videoSummary({ codec: "h264", name: "H.264", label: "H.264 1080p", profile: "High", width: 1920, height: 1080, fps: 29.97, bitrate: 2500 }))
      .toBe("H.264 High · 1920×1080 · 29,97 fps · 2500 kb/s");
  });

  it("explains a prepared copy by its original", () => {
    const original = { codec: "adpcm_ima_wav", format: "adpcm", class: "lossy" as const, name: "ADPCM", label: "ADPCM 176", bitrate: 176 };
    expect(qualityTitle({ ...original, sourceId: "s", prepared: true })).toBe("С потерями · ADPCM · 176 kb/s · оригинал, играет подготовленная копия");
    expect(qualityRows({ container: "FLAC", audio: { codec: "flac", format: "flac", class: "lossless", name: "FLAC", label: "FLAC 16/44.1" },
      origin: { container: "WAV", audio: original } }, 3 * 1024 * 1024)).toEqual([
      { label: "Копия", value: "FLAC" },
      { label: "Файл", value: "FLAC · 3 МБ" },
      { label: "Оригинал", value: "WAV · С потерями · ADPCM · 176 kb/s" },
    ]);
  });

  it("groups facet counts by class and keeps selected empty formats", () => {
    const groups = qualityFacetGroups({ lossy: 5, "lossy.aac": 4, "lossy.mp3": 1, hires: 1, "hires.flac": 1 }, ["lossless.alac"]);
    expect(groups.map(group => [group.value, group.count, group.formats.map(format => [format.label, format.count])])).toEqual([
      ["hires", 1, [["FLAC", 1]]],
      ["lossless", 0, [["ALAC", 0]]],
      ["lossy", 5, [["AAC", 4], ["MP3", 1]]],
    ]);
    expect(qualityFilterLabel("hires.flac")).toBe("Hi-Res · FLAC");
    expect(qualityFilterLabel("pcm")).toBe("WAV / PCM");
  });

  it("toggles a class, narrows it to the remaining formats and collapses a full set back", () => {
    const [lossy] = qualityFacetGroups({ lossy: 5, "lossy.aac": 4, "lossy.mp3": 1 }, []);
    let selected = toggleQuality([], "lossy", lossy!);
    expect(selected).toEqual(["lossy"]);
    expect(qualityChecked(selected, "lossy.mp3")).toBe(true);
    selected = toggleQuality(selected, "lossy.mp3", lossy!);
    expect(selected).toEqual(["lossy.aac"]);
    selected = toggleQuality(selected, "lossy.mp3", lossy!);
    expect(selected).toEqual(["lossy"]);
    expect(toggleQuality(selected, "lossy", lossy!)).toEqual([]);
  });
});

it("names one and two channels without a layout", () => {
  expect(audioSummary({ codec: "adpcm_ima_wav", format: "adpcm", class: "lossy", name: "ADPCM", label: "ADPCM", channels: 1, layout: "1 channels" }))
    .toBe("ADPCM · моно");
});
