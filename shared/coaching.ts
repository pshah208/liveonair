export interface CoachingClip {
  id: string;
  inSeconds: number;
  outSeconds: number;
  title: string;
  tag: string;
  playerTags: string[];
  notes: string;
}

export interface SourceFingerprint {
  name: string;
  size: number;
  lastModified: number;
}

export const MAX_COACHING_CLIPS = 200;
const MAX_JSON_BYTES = 1024 * 1024;
const CLIP_FIELDS = ["id", "inSeconds", "outSeconds", "title", "tag", "playerTags", "notes"];

export function coachingStorageKey(source: SourceFingerprint): string {
  if (
    typeof source.name !== "string" ||
    !Number.isSafeInteger(source.size) || source.size < 0 ||
    !Number.isSafeInteger(source.lastModified)
  ) {
    throw new Error("Invalid coaching source fingerprint.");
  }
  return `matchlens:coaching:${JSON.stringify([source.name, source.size, source.lastModified])}`;
}

export function validClipRange(inSeconds: number, outSeconds: number, duration: number): boolean {
  return Number.isFinite(duration) && duration > 0 &&
    Number.isFinite(inSeconds) && Number.isFinite(outSeconds) &&
    inSeconds >= 0 && outSeconds > inSeconds && outSeconds <= duration;
}

function recordWithFields(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  ) {
    throw new Error(`${label} has an invalid shape; expected fields: ${fields.join(", ")}.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, maxLength: number, label: string, required = false): string {
  if (typeof value !== "string" || value.length > maxLength || (required && !value.trim())) {
    throw new Error(`${label} must be ${required ? "a nonempty" : "a"} string of at most ${maxLength} characters.`);
  }
  return value;
}

function validateClips(value: unknown, duration: number): CoachingClip[] {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Coaching duration must be finite and positive.");
  }
  if (!Array.isArray(value)) {
    throw new Error("Coaching clips must be an array.");
  }
  if (value.length > MAX_COACHING_CLIPS) {
    throw new Error(`Coaching clips must contain at most ${MAX_COACHING_CLIPS} entries.`);
  }
  const ids = new Set<string>();
  const clips: CoachingClip[] = [];
  for (const [index, entry] of value.entries()) {
    const label = `Coaching clip ${index + 1}`;
    const clip = recordWithFields(entry, CLIP_FIELDS, label);
    const id = text(clip.id, 100, `${label} id`, true);
    if (ids.has(id)) {
      throw new Error(`${label} has a duplicate id.`);
    }
    ids.add(id);
    const { inSeconds, outSeconds } = clip;
    if (
      typeof inSeconds !== "number" || typeof outSeconds !== "number" ||
      !validClipRange(inSeconds, outSeconds, duration)
    ) {
      throw new Error(`${label} range must be finite and satisfy 0 <= inSeconds < outSeconds <= duration.`);
    }
    const title = text(clip.title, 120, `${label} title`, true);
    const tag = text(clip.tag, 60, `${label} tag`);
    const notes = text(clip.notes, 2000, `${label} notes`);
    if (!Array.isArray(clip.playerTags) || clip.playerTags.length > 20) {
      throw new Error(`${label} playerTags must be an array of at most 20 strings.`);
    }
    const playerTags: string[] = [];
    for (const playerTag of clip.playerTags) {
      playerTags.push(text(playerTag, 60, `${label} playerTags entry`));
    }
    clips.push({ id, inSeconds, outSeconds, title, tag, playerTags, notes });
  }
  return clips;
}

function validateJsonBudget(json: string): void {
  // UTF-16 length is a cheap lower bound before measuring the UTF-8 payload.
  if (json.length > MAX_JSON_BYTES || new TextEncoder().encode(json).byteLength > MAX_JSON_BYTES) {
    throw new Error("Coaching JSON exceeds the 1 MB (1048576 byte) limit.");
  }
}

export function parseCoachingClips(json: string | null, duration: number): CoachingClip[] {
  if (json === null) return [];
  if (typeof json !== "string") {
    throw new Error("Coaching JSON must be a string or null.");
  }
  validateJsonBudget(json);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Coaching JSON is corrupt or invalid.");
  }
  const envelope = recordWithFields(value, ["version", "clips"], "Coaching envelope");
  if (envelope.version !== 1) {
    throw new Error("Unsupported coaching envelope version; expected version 1.");
  }
  return validateClips(envelope.clips, duration);
}

export function serializeCoachingClips(clips: CoachingClip[], duration: number): string {
  const json = JSON.stringify({ version: 1, clips: validateClips(clips, duration) });
  validateJsonBudget(json);
  return json;
}
