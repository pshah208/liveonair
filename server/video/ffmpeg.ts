import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { MAX_FRAME_INTERVAL_SECONDS, MAX_VIDEO_FRAMES, type VideoFrame } from "../../shared/video.js";

/** Adapted from the PlayerIQ worker: ffprobe/ffmpeg run as argument arrays, never through a shell. */

export type RunCommand = (command: string, args: string[]) => Promise<string>;

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
}

export async function probeVideo(filePath: string, run: RunCommand = runCommand): Promise<ProbeResult> {
  const output = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath]);
  const metadata = JSON.parse(output) as { format?: { duration?: string }; streams?: { codec_type?: string; duration?: string; width?: number; height?: number; codec_name?: string }[] };
  const stream = metadata.streams?.find((candidate) => candidate.codec_type === "video");
  const durationSeconds = Number(metadata.format?.duration || stream?.duration || 0);
  if (!stream || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("The file does not contain a readable video stream.");
  }
  return { durationSeconds, width: Number(stream.width || 0), height: Number(stream.height || 0), codec: stream.codec_name || "unknown" };
}

/** Preserve the original 60-frame sampling for short clips, then grow at a three-second cadence. */
export function videoSampleInterval(durationSeconds: number): number {
  return Math.max(1, Math.min(durationSeconds / 60, MAX_FRAME_INTERVAL_SECONDS), durationSeconds / MAX_VIDEO_FRAMES);
}

/** Evenly spaced sample times, starting half an interval in so the first frame is not a black lead-in. */
export function sampleTimestamps(durationSeconds: number, intervalSeconds: number, maxFrames: number): number[] {
  const count = Math.max(1, Math.min(maxFrames, Math.floor(durationSeconds / intervalSeconds)));
  const step = durationSeconds / count;
  return Array.from({ length: count }, (_, index) => Number(Math.min(durationSeconds - 0.05, step * (index + 0.5)).toFixed(2)));
}

export function framePath(directory: string, index: number): string {
  return path.join(directory, `frame-${String(index).padStart(3, "0")}.jpg`);
}

export async function extractFrames(options: {
  inputPath: string;
  outputDirectory: string;
  timestamps: number[];
  maxWidth: number;
  run?: RunCommand;
  onFrame?: (done: number) => void;
}): Promise<VideoFrame[]> {
  const run = options.run ?? runCommand;
  await mkdir(options.outputDirectory, { recursive: true });
  const frames: VideoFrame[] = [];
  for (const [index, timestampSeconds] of options.timestamps.entries()) {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-ss", String(timestampSeconds),
      "-i", options.inputPath,
      "-frames:v", "1",
      "-vf", `scale='min(${Math.trunc(options.maxWidth)},iw)':-2`,
      "-q:v", "5",
      "-y", framePath(options.outputDirectory, index),
    ]);
    frames.push({ index, timestampSeconds });
    options.onFrame?.(index + 1);
  }
  return frames;
}

/** Crops the area around a clicked player (x, y in 0–1) from one frame, as the identity reference for the model. */
export async function extractReferenceCrop(options: {
  inputPath: string;
  outputPath: string;
  second: number;
  x: number;
  y: number;
  run?: RunCommand;
}): Promise<void> {
  const run = options.run ?? runCommand;
  const fx = Math.min(1, Math.max(0, options.x)).toFixed(4);
  const fy = Math.min(1, Math.max(0, options.y)).toFixed(4);
  // Expressions use the decoded (auto-rotated) frame size, so phone clips crop the right area.
  // A box is drawn round the clicked point first, so the model knows exactly which player is meant.
  const box = `drawbox=x=iw*${fx}-iw*0.035:y=ih*${fy}-ih*0.13:w=iw*0.07:h=ih*0.26:color=yellow@0.95:t=3`;
  const crop = `crop=trunc(iw*0.1)*2:trunc(min(ih\\,iw*0.32)/2)*2:max(0\\,min(iw*${fx}-ow/2\\,iw-ow)):max(0\\,min(ih*${fy}-oh/2\\,ih-oh))`;
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(Math.max(0, options.second)),
    "-i", options.inputPath,
    "-frames:v", "1",
    "-vf", `${box},${crop},scale=-2:'min(480,ih)'`,
    "-q:v", "4",
    "-y", options.outputPath,
  ]);
}

export function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new Error(`${command} could not start: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(0, 400)}`));
    });
  });
}
