// scoring.js
// Turn the list of findings into a letter grade. This is deterministic on
// purpose: the grade is computed from the facts, never invented by the model,
// so the same site always scores the same way.

const WEIGHT = { urgent: 34, serious: 16, watch: 5, minor: 0, good: 0 };

export function scoreReport(findings) {
  const tally = { urgent: 0, serious: 0, watch: 0, minor: 0, good: 0 };
  let penalty = 0;
  for (const f of findings) {
    if (tally[f.severity] === undefined) continue;
    tally[f.severity]++;
    // Notes from the browsing agent are the model's judgment, so they are shown but never move the grade.
    if (f.source === "agent" || String(f.id || "").startsWith("agent-")) continue;
    penalty += WEIGHT[f.severity] || 0;
  }

  let score = Math.max(0, 100 - penalty);

  // Caps: a site leaking data or with a down page can't earn a top grade,
  // no matter how few other issues it has.
  if (tally.urgent >= 1) score = Math.min(score, 68); // no better than C
  if (tally.urgent >= 2) score = Math.min(score, 55); // no better than D+
  if (tally.serious >= 1 && tally.urgent === 0) score = Math.min(score, 84); // no better than B

  const { letter, label } = toGrade(score, tally);
  return { grade: letter, gradeLabel: label, score, ringPercent: Math.round(score), tally };
}

function toGrade(score, tally) {
  if (tally.urgent === 0 && tally.serious === 0 && tally.watch === 0)
    return { letter: "A", label: "Looking great" };
  if (score >= 90) return { letter: "A", label: "Looking great" };
  if (score >= 80) return { letter: "B", label: "In good shape" };
  if (score >= 66) return { letter: "C", label: "Needs care" };
  if (score >= 50) return { letter: "D", label: "Needs work" };
  return { letter: "F", label: "Needs urgent help" };
}
