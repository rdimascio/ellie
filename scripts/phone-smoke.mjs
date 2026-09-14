import {
  phoneSmokeConfig,
  readPrivateTestJson,
  runPhoneSmoke,
} from "../apps/cli/src/phone-smoke.ts";
if (process.argv.length !== 4 || process.argv[2] !== "--config") {
  console.error("Use: node scripts/phone-smoke.mjs --config /absolute/private/test.json");
  process.exitCode = 1;
} else {
  try {
    const config = phoneSmokeConfig(await readPrivateTestJson(process.argv[3]));
    const report = await runPhoneSmoke(config, await readPrivateTestJson(config.invitationFile));
    console.log(JSON.stringify(report, null, 2));
    if (!report.loggedOut && report.pairAttempted)
      console.error(
        "Pairing may have created a temporary browser identity. Revoke it from the coordinator; logout was not confirmed.",
      );
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    console.error(
      "Phone test unavailable. Check private configuration, fresh invitation, connected unlocked iPhone, trusted certificate and Safari remote automation.",
    );
    process.exitCode = 1;
  }
}
