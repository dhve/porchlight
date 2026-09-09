export function reportFixture() {
  return {
    id: "report1234", target: "fixture.example", url: "https://fixture.example/",
    scannedAt: "2026-08-01T12:00:00.000Z", grade: "?", gradeLabel: "Not rated", score: null,
    ringPercent: 0, tally: { serious: 1, urgent: 0, watch: 0, minor: 0, good: 0 },
    summary: "The page check was incomplete.", userId: "owner12345", email: "private@example.test",
    by: { id: "owner12345", name: "Private Person" }, ip: "192.0.2.20",
    privateNotes: ["Private review context"],
    assessment: { status: "incomplete", reason: "A planned check timed out." },
    coverage: [{ check: "links", status: "inconclusive", reason: "Timed out" }],
    engine: { version: "fixture-v2", browser: { viewport: { width: 390, height: 844 }, measurements: { name: "phone", ip: "203.0.113.8" } } },
    findings: [{ id: "links-broken", title: "A link was unavailable", severity: "serious",
      source: { detector: "links", version: "fixture-v2" },
      evidence: { note: "Measured on a public page.", pages: ["https://fixture.example/about?q=public"],
        measurements: { name: "download", status: 404, ip: "203.0.113.8" },
        items: [{ url: "https://fixture.example/missing", kind: "link", status: 404 }] },
      disputed: { wrong: 2, right: 0, notes: [{ text: "Private old feedback", by: "Private Person" }] },
      privateNotes: ["Private finding context"],
    }],
    passes: ["HTTPS loaded."], contact: { emails: ["public@fixture.example"], pages: ["https://fixture.example/contact"] },
    agent: { notes: [{ title: "A public browsing observation", measurements: { name: "menu", width: 390 } }] },
    attestation: { v: 2, signature: "synthetic-signature", payload: { v: 2, reportDigest: "synthetic-digest", metadata: { name: "public measurement" } } },
  };
}

export function assertNoPrivateIdentity(assert, value) {
  const json = JSON.stringify(value);
  for (const secret of ["owner12345", "other12345", "Private Person", "private@example.test", "Private review context", "Private finding context", "Private old feedback", "192.0.2.20"]) {
    assert.equal(json.includes(secret), false, `Public response included fixture private data: ${secret}`);
  }
}
