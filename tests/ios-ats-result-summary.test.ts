import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedATSResult } from "../scripts/ios-ats-result-summary.mjs";

const names = [
  "NativeGoogleHTTPSIntegrationTests/testLateGmailBodyCannotPublishAfterCancelCredentialChangeOrRevocation()",
  "NativeGoogleHTTPSIntegrationTests/testLifeAccountGrantIsIndependentOfNativeEnrollment()",
  "NativeGoogleHTTPSIntegrationTests/testPinnedNativeLifeQuestionUsesSeparateGrantAndDurableReadOnlyStatus()",
  "NativeGoogleHTTPSIntegrationTests/testPinnedClientsReadSelectedCalendarAndExplicitGmailBodies()",
];

function result() {
  return {
    summary: {
      result: "Passed",
      totalTestCount: 5,
      passedTests: 5,
      failedTests: 0,
      skippedTests: 0,
    },
    tests: {
      testNodes: [
        {
          children: [
            ...names.map((nodeIdentifier) => ({
              nodeType: "Test Case",
              nodeIdentifier,
              result: "Passed",
            })),
            { nodeType: "Test Case", nodeIdentifier: "OtherTests/testOther()", result: "Passed" },
          ],
        },
      ],
    },
  };
}

test("ATS result retains only passing counts and exact Google case names", () => {
  const { summary, tests } = result();
  assert.deepEqual(verifiedATSResult(summary, tests), {
    xcresultOutcome: "Passed",
    counts: { total: 5, passed: 5, failed: 0, skipped: 0 },
    googleCases: names,
  });
});

test("ATS result rejects zero, skipped, failed, missing, duplicated, and inconsistent cases", () => {
  const variants = [
    () => {
      const value = result();
      value.summary.totalTestCount = 0;
      return value;
    },
    () => {
      const value = result();
      value.summary.skippedTests = 1;
      return value;
    },
    () => {
      const value = result();
      value.summary.failedTests = 1;
      return value;
    },
    () => {
      const value = result();
      value.tests.testNodes[0]!.children[0]!.result = "Skipped";
      return value;
    },
    () => {
      const value = result();
      value.tests.testNodes[0]!.children[0]!.nodeIdentifier = "OtherTests/testOther()";
      return value;
    },
    () => {
      const value = result();
      value.tests.testNodes[0]!.children[4]!.nodeIdentifier = names[0]!;
      return value;
    },
    () => {
      const value = result();
      value.tests.testNodes[0]!.children.splice(3, 1);
      return value;
    },
  ];
  for (const variant of variants) {
    const { summary, tests } = variant();
    assert.throws(() => verifiedATSResult(summary, tests));
  }
});
