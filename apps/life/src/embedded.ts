import { createLifeApplication, type LifeApplicationOptions } from "./main.ts";

// Coordinator lifecycle owners retain this cold handle before starting any jobs.
export { createLifeApplication } from "./main.ts";

/** Start Life inside the coordinator. The caller owns authenticated HTTP admission and shutdown. */
export async function createEmbeddedLifeApplication(options: Omit<LifeApplicationOptions, "port">) {
  const application = await createLifeApplication(options);
  await application.prepareEmbedded();
  return {
    handle: application.handle,
    close: () => application.close(),
  };
}
