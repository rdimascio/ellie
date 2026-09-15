import { main } from "../packages/improvement-queue/src/cli.ts";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
