// 数据模块共享的本机文件与 JSON 原语：0600 原子写、schema 校验读取与
// 官方响应解析。各数据模块不得再各自复制这些实现；错误类型由调用方
// 通过错误工厂提供，保持各模块自己的错误语义。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { z } from "zod";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFsCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function saveJsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export interface LoadJsonFileErrors {
  corrupt: () => Error;
  unreadable: () => Error;
}

export async function loadValidatedJsonFile<T>(
  path: string,
  fallback: T,
  schema: z.ZodType<T>,
  errors: LoadJsonFileErrors,
): Promise<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isFsCode(error, "ENOENT")) {
      return fallback;
    }
    throw errors.unreadable();
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw errors.corrupt();
  }
  return validated.data;
}
