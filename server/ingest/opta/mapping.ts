/**
 * One config table for the synthetic Opta-style feed.
 * Community type and qualifier ids are unverified against the gated Stats Perform specification.
 * Ids in the 9000 range are synthetic extensions. They are not Opta identifiers.
 */
export const OPTA_STYLE_LABEL = "Opta-style format, synthetic data" as const;

export const OPTA_MAPPING = {
  label: OPTA_STYLE_LABEL,
  verifiedAgainstOfficialSpec: false,
  types: {
    pass: { typeId: 1, origin: "community", canonical: "pass" },
    tackle: { typeId: 7, origin: "community", canonical: "tackle" },
    save: { typeId: 10, origin: "community", canonical: "save" },
    shotMiss: { typeId: 13, origin: "community", canonical: "shot", outcome: "miss" },
    shotBlocked: { typeId: 14, origin: "community", canonical: "shot", outcome: "blocked" },
    shotSaved: { typeId: 15, origin: "community", canonical: "shot", outcome: "saved" },
    goal: { typeId: 16, origin: "community", canonical: "goal" },
    card: { typeId: 17, origin: "community", canonical: "card" },
    subOff: { typeId: 18, origin: "community", canonical: "substitution", role: "off" },
    subOn: { typeId: 19, origin: "community", canonical: "substitution", role: "on" },
    deleted: { typeId: 43, origin: "community", canonical: "deleted" },
    pressure: { typeId: 9101, origin: "synthetic-extension", canonical: "pressure" },
    corner: { typeId: 9102, origin: "synthetic-extension", canonical: "corner" },
    foul: { typeId: 9103, origin: "synthetic-extension", canonical: "foul" },
    kickoff: { typeId: 9104, origin: "synthetic-extension", canonical: "kickoff" },
    halftime: { typeId: 9105, origin: "synthetic-extension", canonical: "halftime" },
    fulltime: { typeId: 9106, origin: "synthetic-extension", canonical: "fulltime" },
  },
  qualifiers: {
    passEndX: { qualifierId: 140, origin: "community", meaning: "pass end x, 0-100" },
    passEndY: { qualifierId: 141, origin: "community", meaning: "pass end y, 0-100" },
    relatedEvent: { qualifierId: 55, origin: "community", meaning: "related event id" },
    yellowCard: { qualifierId: 31, origin: "community", meaning: "yellow card" },
    secondYellow: { qualifierId: 32, origin: "community", meaning: "second yellow, sent off" },
    redCard: { qualifierId: 33, origin: "community", meaning: "straight red card" },
    syntheticPressure: {
      qualifierId: 9100,
      origin: "synthetic-extension",
      value: "synthetic-extension:pressure",
      meaning: "Pressure has no public Opta equivalent. This qualifier marks a synthetic extension.",
    },
    syntheticOutcome: { qualifierId: 9113, origin: "synthetic-extension", meaning: "canonical outcome, synthetic extension" },
    syntheticXg: { qualifierId: 9110, origin: "synthetic-extension", meaning: "illustrative xG, synthetic extension" },
    syntheticFlightMs: { qualifierId: 9111, origin: "synthetic-extension", meaning: "ball flight milliseconds, synthetic extension" },
    syntheticSpeedKmh: { qualifierId: 9112, origin: "synthetic-extension", meaning: "shot speed km/h, synthetic extension" },
    syntheticRevision: { qualifierId: 9114, origin: "synthetic-extension", meaning: "event revision when not 1, synthetic extension" },
  },
  teams: { home: 1, away: 2 },
} as const;
