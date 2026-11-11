#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(`edit-library-video: ${message}`);
  process.exit(2);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with status ${result.status}`);
}

function finiteNumber(value, label, { positive = false, nonnegative = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a finite number`);
  if (positive && value <= 0) fail(`${label} must be greater than zero`);
  if (nonnegative && value < 0) fail(`${label} must not be negative`);
  return value;
}

function shellListPath(path) {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

if (process.argv.length !== 3) {
  fail("usage: node scripts/edit-library-video.mjs EDIT.json");
}

const decisionPath = resolve(process.argv[2]);
let decision;
try {
  decision = JSON.parse(readFileSync(decisionPath, "utf8"));
} catch (error) {
  fail(`could not read ${decisionPath}: ${error.message}`);
}

const baseDir = dirname(decisionPath);
const pathFromDecision = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty path`);
  return resolve(baseDir, value);
};
const raw = pathFromDecision(decision.raw, "raw");
const output = pathFromDecision(decision.output, "output");
if (!existsSync(raw)) fail(`raw video does not exist: ${raw}`);
if (existsSync(output)) fail(`output already exists: ${output}`);
if (raw === output) fail("raw and output paths must differ");
if (!Array.isArray(decision.segments) || decision.segments.length === 0) fail("segments must be a non-empty array");

let cropFilter = "";
if (decision.crop !== undefined) {
  const { x, y, width, height } = decision.crop ?? {};
  finiteNumber(x, "crop.x", { nonnegative: true });
  finiteNumber(y, "crop.y", { nonnegative: true });
  finiteNumber(width, "crop.width", { positive: true });
  finiteNumber(height, "crop.height", { positive: true });
  for (const [name, value] of Object.entries({ x, y, width, height })) {
    if (!Number.isInteger(value)) fail(`crop.${name} must be an integer physical pixel value`);
  }
  cropFilter = `crop=${width}:${height}:${x}:${y}`;
}

const segments = decision.segments.map((segment, index) => {
  if (!segment || typeof segment !== "object") fail(`segments[${index}] must be an object`);
  const start = finiteNumber(segment.start, `segments[${index}].start`, { nonnegative: true });
  const end = finiteNumber(segment.end, `segments[${index}].end`, { positive: true });
  if (end <= start) fail(`segments[${index}].end must be after start`);
  const sourceDuration = end - start;
  const duration = segment.duration === undefined
    ? sourceDuration
    : finiteNumber(segment.duration, `segments[${index}].duration`, { positive: true });
  if (duration > sourceDuration + 0.000_001) fail(`segments[${index}].duration cannot lengthen footage`);
  const shortened = duration < sourceDuration - 0.000_001;
  const caption = segment.caption ?? "";
  if (typeof caption !== "string") fail(`segments[${index}].caption must be a string`);
  if (shortened && !caption.includes("Waiting shortened")) {
    fail(`segments[${index}] shortens time and its caption must include “Waiting shortened”`);
  }
  return { start, end, sourceDuration, duration, caption, speed: duration / sourceDuration };
});

mkdirSync(dirname(output), { recursive: true });
const workDir = `${output}.parts`;
if (existsSync(workDir)) fail(`temporary work directory already exists: ${workDir}`);
mkdirSync(workDir, { recursive: true });

try {
  const partPaths = [];
  segments.forEach((segment, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    const captionPath = join(workDir, `caption-${suffix}.png`);
    const partPath = join(workDir, `part-${suffix}.mp4`);
    run("swift", [join(scriptDir, "library-video-caption.swift"), captionPath, segment.caption]);

    const transform = [
      ...(cropFilter ? [cropFilter] : []),
      "scale=1920:950:force_original_aspect_ratio=decrease",
      "pad=1920:950:(ow-iw)/2:(oh-ih)/2:color=black",
      segment.speed === 1
        ? "setpts=PTS-STARTPTS"
        : `setpts=${segment.speed.toFixed(9)}*(PTS-STARTPTS)`,
      "fps=30",
      "pad=1920:1080:0:0:color=black",
    ].join(",");
    const filters = `[0:v]${transform}[picture];[picture][1:v]overlay=0:950:shortest=1[out]`;
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "warning", "-nostdin",
      "-ss", String(segment.start), "-t", String(segment.sourceDuration), "-i", raw,
      "-loop", "1", "-i", captionPath,
      "-filter_complex", filters,
      "-map", "[out]", "-an", "-t", String(segment.duration),
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart",
      partPath,
    ]);
    partPaths.push(partPath);
  });

  const concatPath = join(workDir, "concat.txt");
  writeFileSync(concatPath, `${partPaths.map((path) => `file ${shellListPath(path)}`).join("\n")}\n`);
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "warning", "-nostdin",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-map", "0:v:0", "-an", "-c", "copy", "-movflags", "+faststart", output,
  ]);
  rmSync(workDir, { recursive: true, force: true });
  console.log(JSON.stringify({ output, segments: segments.length }, null, 2));
} catch (error) {
  console.error(`edit-library-video: retained partial work at ${workDir}`);
  throw error;
}
