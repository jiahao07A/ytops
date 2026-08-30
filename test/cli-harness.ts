// CLI spawn 测试共用的进程包装：spawn 构建产物并以文本返回结果。
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    [resolve(process.cwd(), "dist", "cli.js"), ...args],
    { encoding: "utf8" },
  );
}
