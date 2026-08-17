import { describe, expect, it } from "vitest";
import { UserInputError } from "../src/lib/errors.js";
import {
  buildDownloadArguments,
  normalizeQuality,
  summarizeVideo,
} from "../src/lib/yt-dlp.js";

describe("yt-dlp command construction", () => {
  it("forces the safe configuration boundary for video downloads", () => {
    const args = buildDownloadArguments(
      "video",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "D:\\authorized-output",
      "1080p",
    );

    expect(args).toContain("--ignore-config");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--merge-output-format");
    expect(args).toContain("mp4");
    expect(args).toContain("bv*[height<=1080]+ba/b[height<=1080]/b");
  });

  it("uses yt-dlp audio extraction rather than a custom downloader", () => {
    const args = buildDownloadArguments(
      "audio",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "D:\\authorized-output",
      "best",
    );

    expect(args).toContain("--extract-audio");
    expect(args).toContain("--audio-format");
    expect(args).toContain("m4a");
  });

  it("rejects malformed quality and unsafe URL inputs before spawning yt-dlp", () => {
    expect(() => normalizeQuality("unlimited")).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "file:///local/video",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://localhost/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://youtube.com.example/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://www.youtube.com/redirect?q=http%3A%2F%2F127.0.0.1%3A8080",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://user@www.youtube.com/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://[::1]/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
  });

  it("accepts supported HTTPS single-video YouTube URL forms", () => {
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://youtu.be/dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).not.toThrow();
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).not.toThrow();
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://www.youtube.com/shorts/dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).not.toThrow();
  });
});

describe("video summaries", () => {
  it("maps the stable subset of yt-dlp metadata", () => {
    expect(
      summarizeVideo({
        id: "abc123",
        title: "Example",
        webpage_url: "https://www.youtube.com/watch?v=abc123",
        channel: "Example channel",
        duration: 42,
        view_count: 1000,
        upload_date: "20260816",
        thumbnail: "https://img.example/thumbnail.jpg",
      }),
    ).toEqual({
      id: "abc123",
      title: "Example",
      url: "https://www.youtube.com/watch?v=abc123",
      channel: "Example channel",
      durationSeconds: 42,
      viewCount: 1000,
      uploadDate: "20260816",
      thumbnail: "https://img.example/thumbnail.jpg",
    });
  });
});
