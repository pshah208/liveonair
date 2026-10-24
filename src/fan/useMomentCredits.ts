import { useEffect, useState } from "react";
import type { FanMomentCredit } from "../../shared/fan.js";
import { requestJson } from "../api.js";

type CreditsResponse = { matchId: string | null; moments: FanMomentCredit[] };

/**
 * Read-only credits for producer-approved moments (which desk agents wrote and checked them), from
 * GET /api/fan/moments. Refetched when the set of public moments changes. Falls back to an empty map on error,
 * so cards show the generic credit line.
 */
export function useMomentCredits(matchId: string | undefined, signature: string): ReadonlyMap<string, FanMomentCredit> {
  const [credits, setCredits] = useState<ReadonlyMap<string, FanMomentCredit>>(() => new Map());
  useEffect(() => {
    if (!matchId || !signature) { setCredits(new Map()); return; }
    let cancelled = false;
    requestJson<CreditsResponse>("/api/fan/moments")
      .then((body) => {
        if (cancelled || !body || (body.matchId && body.matchId !== matchId)) return;
        setCredits(new Map(body.moments.map((credit) => [credit.id, credit])));
      })
      .catch(() => { /* keep the generic credit line */ });
    return () => { cancelled = true; };
  }, [matchId, signature]);
  return credits;
}
