import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { VideoFrame } from "../../shared/video.js";

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
