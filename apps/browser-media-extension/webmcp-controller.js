(() => {
  const controllerName = "__ellieWebMCPControllerV1";
  if (Object.hasOwn(globalThis, controllerName)) return;
  const maximumTools = 16;
  const maximumResultBytes = 16_384;
  const snapshots = new Map();
  const executions = new Map();
  const cancelledExecutions = new Set();

  const annotations = (tool) => ({
    readOnlyHint: tool?.annotations?.readOnlyHint === true,
    untrustedContentHint: tool?.annotations?.untrustedContentHint === true,
    consequentialHint: tool?.annotations?.consequentialHint === true,
  });
  const metadata = (tool) => ({
    name: typeof tool?.name === "string" ? tool.name.slice(0, 100) : "",
    description: typeof tool?.description === "string" ? tool.description.slice(0, 300) : "",
    inputSchema: tool?.inputSchema,
    annotations: annotations(tool),
  });
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  };
  const exact = (left, right) =>
    JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  const bounded = (value) => {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || new TextEncoder().encode(encoded).length > maximumResultBytes)
      throw new Error("result_too_large");
    return JSON.parse(encoded);
  };

  const controller = Object.freeze({
    async list(reviewed) {
      const context = document.modelContext;
      if (!context || typeof context.getTools !== "function") throw new Error("webmcp_unavailable");
      const tools = await context.getTools();
      if (!Array.isArray(tools) || tools.length > maximumTools) throw new Error("invalid_tools");
      const accepted = [];
      snapshots.clear();
      for (const tool of tools) {
        const value = metadata(tool);
        const policy = reviewed.find(
          (candidate) =>
            candidate.name === value.name &&
            exact(candidate.inputSchema, value.inputSchema) &&
            exact(candidate.annotations, value.annotations),
        );
        if (!policy) continue;
        const handle = crypto.randomUUID();
        snapshots.set(handle, { tool, metadata: value });
        accepted.push({ handle, ...value });
      }
      return accepted;
    },
    async execute(handle, expected, args, executionId) {
      const controller = new AbortController();
      executions.set(executionId, controller);
      try {
        if (cancelledExecutions.delete(executionId)) controller.abort();
        const saved = snapshots.get(handle);
        if (!saved || !exact(saved.metadata, expected)) throw new Error("stale_tool");
        const context = document.modelContext;
        if (
          !context ||
          typeof context.getTools !== "function" ||
          typeof context.executeTool !== "function"
        )
          throw new Error("webmcp_unavailable");
        const tools = await context.getTools();
        if (!Array.isArray(tools)) throw new Error("invalid_tools");
        const matching = tools.filter((tool) => exact(metadata(tool), expected));
        if (matching.length !== 1) throw new Error("stale_tool");
        const current = matching[0];
        controller.signal.throwIfAborted();
        const result = await context.executeTool(current, args, { signal: controller.signal });
        if (result === null) return { navigation: true };
        return { navigation: false, value: bounded(result) };
      } finally {
        executions.delete(executionId);
      }
    },
    cancel(executionId) {
      const controller = executions.get(executionId);
      if (controller) controller.abort();
      else {
        if (cancelledExecutions.size >= 64) {
          const oldest = cancelledExecutions.values().next().value;
          if (oldest !== undefined) cancelledExecutions.delete(oldest);
        }
        cancelledExecutions.add(executionId);
      }
      return true;
    },
  });
  Object.defineProperty(globalThis, controllerName, {
    value: controller,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
