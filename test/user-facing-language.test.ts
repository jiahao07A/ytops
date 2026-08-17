import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const skillNames = [
  "youtube-research",
  "youtube-authorized-media",
  "youtube-local-media",
  "youtube-channel-operations",
];

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function firstMatch(source: string, expression: RegExp): string {
  const match = source.match(expression);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("面向用户的元数据语言", () => {
  it("uses Simplified Chinese for the package description", () => {
    const packageJson = JSON.parse(readWorkspaceFile("package.json")) as { description: string };

    expect(packageJson.description).toMatch(/[\u4e00-\u9fff]/);
  });

  it.each(skillNames)("uses Simplified Chinese for %s metadata", (skillName) => {
    const skill = readWorkspaceFile(`skills/${skillName}/SKILL.md`);
    const interfaceMetadata = readWorkspaceFile(`skills/${skillName}/agents/openai.yaml`);
    const description = firstMatch(skill, /^description: (.+)$/m);
    const shortDescription = firstMatch(interfaceMetadata, /^  short_description: "(.+)"$/m);

    expect(description).toMatch(/[\u4e00-\u9fff]/);
    expect(shortDescription).toMatch(/[\u4e00-\u9fff]/);
  });
});
