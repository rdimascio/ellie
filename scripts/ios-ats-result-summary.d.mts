export declare function verifiedATSResult(
  summary: unknown,
  tests: unknown,
): {
  xcresultOutcome: "Passed";
  counts: { total: number; passed: number; failed: number; skipped: number };
  googleCases: string[];
  householdCases: string[];
  quietCases: string[];
};
