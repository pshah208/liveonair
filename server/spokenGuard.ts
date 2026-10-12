import type { MatchFixture } from "../shared/types.js";

/**
 * Guards for free-form prose the model writes from approved facts. The model may rephrase, but every
 * number it writes must appear in the facts it was given, and it may only name players those facts name.
 */

function digitRuns(value: string): string[] {
  return value.match(/\d+/gu) ?? [];
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function unsupportedNumbers(output: string, sourceText: string): string[] {
  const allowed = new Set(digitRuns(sourceText).map((run) => String(Number(run))));
  return digitRuns(output).filter((run) => !allowed.has(String(Number(run))));
}

function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^\\p{L}])${escaped}($|[^\\p{L}])`, "u").test(haystack);
}

/** Roster players mentioned in the output (by full name or surname) that the source never mentions. */
export function unsupportedPlayers(output: string, sourceText: string, fixture: MatchFixture | undefined): string[] {
  if (!fixture) return [];
  const text = normalize(output);
  const source = normalize(sourceText);
  const players = [...fixture.home.players, ...fixture.away.players];
  const sourcePlayers = players.filter((player) => containsWord(source, normalize(player.name)));
  const allowedTokens = new Set(sourcePlayers.flatMap((player) => normalize(player.name).split(/\s+/u)));
  return players
    .filter((player) => !sourcePlayers.includes(player))
    .filter((player) => {
      const full = normalize(player.name);
      if (containsWord(text, full)) return true;
      const surname = full.split(/\s+/u).at(-1) ?? "";
      return surname.length >= 4 && !allowedTokens.has(surname) && containsWord(text, surname);
    })
    .map((player) => player.name);
}

export function groundingProblems(output: string, sourceText: string, fixture: MatchFixture | undefined): string[] {
  const problems: string[] = [];
  const numbers = unsupportedNumbers(output, sourceText);
  if (numbers.length > 0) problems.push(`unsupported numbers: ${[...new Set(numbers)].slice(0, 5).join(", ")}`);
  const players = unsupportedPlayers(output, sourceText, fixture);
  if (players.length > 0) problems.push(`unsupported players: ${players.slice(0, 5).join(", ")}`);
  return problems;
}
