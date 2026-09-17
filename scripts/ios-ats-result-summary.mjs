const googleCases = [
  "NativeGoogleHTTPSIntegrationTests/testLateGmailBodyCannotPublishAfterCancelCredentialChangeOrRevocation()",
  "NativeGoogleHTTPSIntegrationTests/testLifeAccountGrantIsIndependentOfNativeEnrollment()",
  "NativeGoogleHTTPSIntegrationTests/testPinnedClientsReadSelectedCalendarAndExplicitGmailBodies()",
];

export function verifiedATSResult(summary, tests) {
  const counts = {
    total: summary?.totalTestCount,
    passed: summary?.passedTests,
    failed: summary?.failedTests,
    skipped: summary?.skippedTests,
  };
  if (
    !Number.isSafeInteger(counts.total) ||
    counts.total <= 0 ||
    !Number.isSafeInteger(counts.passed) ||
    counts.passed !== counts.total ||
    counts.failed !== 0 ||
    counts.skipped !== 0 ||
    summary.result !== "Passed"
  ) {
    throw new Error("ATS xcresult has zero, failed, skipped, or inconsistent tests.");
  }
  if (!Array.isArray(tests?.testNodes))
    throw new Error("ATS xcresult test inventory is unavailable.");
  const cases = [];
  const pending = [...tests.testNodes];
  let visited = 0;
  while (pending.length) {
    if (++visited > 10_000) throw new Error("ATS xcresult test inventory exceeds its bound.");
    const node = pending.pop();
    if (!node || typeof node !== "object")
      throw new Error("ATS xcresult test inventory is malformed.");
    if (node.nodeType === "Test Case") cases.push(node);
    if (node.children !== undefined) {
      if (!Array.isArray(node.children))
        throw new Error("ATS xcresult test inventory is malformed.");
      pending.push(...node.children);
    }
  }
  if (cases.length !== counts.total || cases.some((test) => test.result !== "Passed"))
    throw new Error("ATS xcresult test inventory disagrees with the summary.");
  for (const name of googleCases) {
    if (cases.filter((test) => test.nodeIdentifier === name).length !== 1)
      throw new Error("An expected Google HTTPS test did not pass exactly once.");
  }
  return { xcresultOutcome: "Passed", counts, googleCases };
}
