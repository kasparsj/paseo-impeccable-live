import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolveContainedDirectory(root: string, relative: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const requested = relative.trim() || ".";
  if (path.isAbsolute(requested)) throw new Error("App path must be relative to the selected workspace.");
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(canonicalRoot, requested));
  } catch {
    throw new Error("The app path does not exist.");
  }
  if (!isWithin(canonicalRoot, resolved)) throw new Error("The app path escapes the selected workspace.");
  if (!(await stat(resolved)).isDirectory()) throw new Error("The app path is not a directory.");
  return resolved;
}

export function validateLocalUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Preview URL must be a valid local HTTP URL.");
  }
  if (parsed.protocol !== "http:" || !LOCAL_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error("Preview URL must use http://localhost, http://127.0.0.1, or http://[::1].");
  }
  return parsed.toString();
}
