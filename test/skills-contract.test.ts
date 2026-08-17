import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const commandDocuments = [
  { path: "README.md", entrypoint: "node .\\dist\\cli.js" },
  {
    path: "skills/youtube-research/SKILL.md",
    entrypoint: "rtk node .\\dist\\cli.js --json",
  },
  {
    path: "skills/youtube-authorized-media/SKILL.md",
    entrypoint: "rtk node .\\dist\\cli.js --json",
  },
  {
    path: "skills/youtube-local-media/SKILL.md",
    entrypoint: "rtk node .\\dist\\cli.js --json",
  },
  {
    path: "skills/youtube-channel-operations/SKILL.md",
    entrypoint: "rtk node .\\dist\\cli.js --json",
  },
  {
    path: "skills/youtube-research/references/command-contract.md",
    entrypoint: "rtk node .\\dist\\cli.js --json",
  },
  {
    path: "skills/youtube-authorized-media/references/authorized-media-contract.md",
    entrypoint: "rtk node .\\dist\\cli.js --json",
  },
  {
    path: "skills/youtube-local-media/references/local-media-contract.md",
    entrypoint: "rtk node .\\dist\\cli.js --json",
  },
  {
    path: "skills/youtube-channel-operations/references/operations-boundary.md",
    entrypoint: "rtk node .\\dist\\cli.js --json",
  },
];

describe("machine-readable command documentation", () => {
  it.each(commandDocuments)(
    "uses the direct CLI entrypoint in $path",
    ({ path, entrypoint }) => {
      const document = readFileSync(resolve(process.cwd(), path), "utf8");

      expect(document).not.toContain("npm run start --");
      expect(document).not.toContain("`ytops --json");
      expect(document).toContain(entrypoint);
    },
  );
});
