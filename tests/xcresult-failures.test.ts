import test from "node:test";
import assert from "node:assert/strict";
import { annotation, failureReport } from "../scripts/xcresult-failures.mjs";

test("failure report names each failed test case with its assertion messages", () => {
  const tree = {
    testNodes: [
      {
        nodeType: "Test Plan",
        name: "EllieIOSATS",
        children: [
          {
            nodeType: "Test Suite",
            name: "HouseholdChoresHTTPSIntegrationTests",
            children: [
              {
                nodeType: "Test Case",
                nodeIdentifier:
                  "HouseholdChoresHTTPSIntegrationTests/testTwoEnrolledClientsUsePinnedProductionChoresWithNoWriteReplay()",
                result: "Failed",
                children: [
                  {
                    nodeType: "Failure Message",
                    name: "HouseholdChoresHTTPSIntegrationTests.swift:75: Timed out waiting for stale conflict.",
                  },
                  {
                    nodeType: "Failure Message",
                    name: "HouseholdChoresHTTPSIntegrationTests.swift:104: XCTAssertNil failed",
                  },
                ],
              },
              {
                nodeType: "Test Case",
                nodeIdentifier: "HouseholdChoresHTTPSIntegrationTests/testPasses()",
                result: "Passed",
              },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(failureReport(tree), [
    {
      test: "HouseholdChoresHTTPSIntegrationTests/testTwoEnrolledClientsUsePinnedProductionChoresWithNoWriteReplay()",
      message:
        "HouseholdChoresHTTPSIntegrationTests.swift:75: Timed out waiting for stale conflict.",
    },
    {
      test: "HouseholdChoresHTTPSIntegrationTests/testTwoEnrolledClientsUsePinnedProductionChoresWithNoWriteReplay()",
      message: "HouseholdChoresHTTPSIntegrationTests.swift:104: XCTAssertNil failed",
    },
  ]);
});

test("annotations escape workflow command syntax in test names and messages", () => {
  assert.equal(
    annotation({ test: "Suite/test(a:b, c)", message: "50% done\nline two\r::warning::x" }),
    "::error title=Suite/test(a%3Ab%2C c)::50%25 done%0Aline two%0D::warning::x",
  );
});

test("failure report tolerates malformed and empty result trees", () => {
  assert.deepEqual(failureReport(undefined), []);
  assert.deepEqual(failureReport({ testNodes: [null, 7, { children: "bad" }] }), []);
  assert.deepEqual(
    failureReport({ testNodes: [{ nodeType: "Failure Message", name: "x".repeat(5_000) }] }),
    [{ test: "(unknown test)", message: "x".repeat(4_000) }],
  );
});
