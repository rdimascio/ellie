(() => {
  if (globalThis.__ellieMediaController) return;

  const origin = "https://www.disneyplus.com";
  const entityPath =
    /^\/browse\/entity-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const actionId = (value) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  const exact = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join();
  const seen = new Set();
  const cancelled = new Set();
  const session = crypto.randomUUID();
  let snapshot;
  let mutation;
  const remember = (set, value) => {
    set.add(value);
    if (set.size > 256) set.delete(set.values().next().value);
  };
  const active = (command, expectedUrl, deadline) => {
    if (cancelled.has(command.actionId)) throw new Error("cancelled");
    if (location.href !== expectedUrl) throw new Error("page_changed");
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("command_timeout");
  };
  const page = () => {
    const url = new URL(location.href);
    if (url.origin !== origin || url.username || url.password) throw new Error("unsupported_page");
    if (url.search || url.hash) return "unsupported";
    if (url.pathname === "/identity/login") return "login";
    if (!entityPath.test(url.pathname)) return "unsupported";
    if (document.querySelector("[aria-modal='true'], [role='dialog'], input[type='password']"))
      return "unsupported";
    return "browse";
  };
  const site = () => ({
    provider: "disneyplus",
    page: page(),
    playback: "unavailable",
  });
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (
      rect.width <= 2 ||
      rect.height <= 2 ||
      rect.bottom <= 0 ||
      rect.top >= innerHeight ||
      rect.right <= 0 ||
      rect.left >= innerWidth
    )
      return false;
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
        return false;
      const parent = node.parentElement;
      if (parent) {
        const bounds = parent.getBoundingClientRect();
        const parentStyle = getComputedStyle(parent);
        if (
          ["hidden", "auto", "scroll"].includes(parentStyle.overflowX) &&
          (rect.right <= bounds.left || rect.left >= bounds.right)
        )
          return false;
        if (
          ["hidden", "auto", "scroll"].includes(parentStyle.overflowY) &&
          (rect.bottom <= bounds.top || rect.top >= bounds.bottom)
        )
          return false;
      }
    }
    const x = Math.min(innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 8)));
    const y = Math.min(innerHeight - 1, Math.max(0, rect.top + Math.min(rect.height / 2, 8)));
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && element.contains(hit));
  };
  const title = (anchor) => {
    for (const value of [
      anchor.getAttribute("aria-label"),
      anchor.getAttribute("title"),
      anchor.textContent,
    ]) {
      const candidate = value?.replace(/\s+/g, " ").trim();
      if (
        candidate &&
        !/[\p{C}]/u.test(candidate) &&
        new TextEncoder().encode(candidate).length <= 200
      )
        return candidate;
    }
    return null;
  };
  const eligible = (anchor) => {
    if (anchor.hasAttribute("download")) return false;
    const target = anchor.getAttribute("target");
    if (target && target.toLowerCase() !== "_self") return false;
    for (let node = anchor; node; node = node.parentElement) {
      if (
        node.hasAttribute("inert") ||
        node.hasAttribute("disabled") ||
        node.getAttribute("aria-disabled")?.trim().toLowerCase() === "true" ||
        node.getAttribute("aria-hidden")?.trim().toLowerCase() === "true"
      )
        return false;
    }
    const url = new URL(anchor.href, location.href);
    return (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href.length <= 2048 &&
      entityPath.test(url.pathname)
    );
  };
  const observed = () => {
    const anchors = document.querySelectorAll("a[href]");
    if (anchors.length > 500) throw new Error("ambiguous_candidates");
    const entries = [];
    const counts = new Map();
    for (const anchor of anchors) {
      if (!visible(anchor) || !eligible(anchor)) continue;
      const label = title(anchor);
      if (!label) continue;
      const entry = {
        id: crypto.randomUUID(),
        title: label,
        anchor,
        href: anchor.href,
      };
      entries.push(entry);
      counts.set(entry.href, (counts.get(entry.href) || 0) + 1);
    }
    return entries.filter((entry) => counts.get(entry.href) === 1);
  };
  const rowLabel = (row, index) => {
    for (const value of [row.getAttribute("aria-label"), row.getAttribute("title")]) {
      const label = value?.replace(/\s+/g, " ").trim();
      if (label && !/[\p{C}]/u.test(label) && new TextEncoder().encode(label).length <= 100)
        return label;
    }
    return `Row ${index + 1}`;
  };
  const rowGeometry = (row) => {
    const style = getComputedStyle(row);
    const left = row.scrollLeft;
    const width = row.scrollWidth;
    const viewport = row.clientWidth;
    const maximum = width - viewport;
    if (
      ![left, width, viewport].every(Number.isFinite) ||
      style.direction !== "ltr" ||
      !["auto", "scroll"].includes(style.overflowX) ||
      viewport <= 0 ||
      width <= viewport + 2 ||
      left < -1 ||
      left > maximum + 1
    )
      return null;
    const bounds = row.getBoundingClientRect();
    if (bounds.width <= 2 || bounds.height <= 2 || bounds.bottom <= 0 || bounds.top >= innerHeight)
      return null;
    for (let node = row; node; node = node.parentElement) {
      if (
        node.hasAttribute("inert") ||
        node.hasAttribute("disabled") ||
        node.getAttribute("aria-disabled")?.trim().toLowerCase() === "true" ||
        node.getAttribute("aria-hidden")?.trim().toLowerCase() === "true"
      )
        return null;
      const current = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (
        current.position === "fixed" &&
        node !== row &&
        rect.width >= innerWidth / 2 &&
        rect.height >= innerHeight / 2
      )
        return null;
    }
    return {
      row,
      left,
      width,
      viewport,
      directions: [...(left > 1 ? ["left"] : []), ...(left < maximum - 1 ? ["right"] : [])],
    };
  };
  const observedRows = (entries) => {
    const candidates = new Map();
    for (const entry of entries) {
      let row = entry.anchor.parentElement;
      while (row && row !== document.body && !rowGeometry(row)) row = row.parentElement;
      if (!row || row === document.body) continue;
      const list = candidates.get(row) || [];
      list.push(entry);
      candidates.set(row, list);
    }
    if (candidates.size > 8) throw new Error("ambiguous_rows");
    return [...candidates].map(([row, members], index) => ({
      id: crypto.randomUUID(),
      label: rowLabel(row, index),
      ...rowGeometry(row),
      members: members.map(({ href, anchor, title }) => ({
        href,
        anchor,
        title,
      })),
    }));
  };
  const viewportScroll = () => {
    const root = document.scrollingElement;
    if (!root || innerWidth < 1 || innerHeight < 1) return { state: "scroll_unavailable" };
    const rootOverflow = getComputedStyle(root).overflowY;
    const bodyOverflow = document.body && getComputedStyle(document.body).overflowY;
    if ([rootOverflow, bodyOverflow].some((value) => value === "hidden" || value === "clip"))
      return { state: "scroll_unavailable" };
    const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    if (!hit) return { state: "scroll_unavailable" };
    for (let node = hit; node && node !== root; node = node.parentElement) {
      if (node.hasAttribute("inert") || node.getAttribute("aria-disabled") === "true")
        return { state: "scroll_unavailable" };
      const style = getComputedStyle(node);
      if (
        node !== document.body &&
        ["auto", "scroll"].includes(style.overflowY) &&
        node.scrollHeight > node.clientHeight + 2
      )
        return { state: "scroll_ambiguous" };
      const bounds = node.getBoundingClientRect();
      if (
        style.position === "fixed" &&
        bounds.width >= innerWidth / 2 &&
        bounds.height >= innerHeight / 2
      )
        return { state: "scroll_unavailable" };
    }
    const top = root.scrollTop;
    const height = root.scrollHeight;
    const viewport = root.clientHeight;
    const maximum = height - viewport;
    if (
      ![top, height, viewport].every(Number.isFinite) ||
      viewport <= 0 ||
      height <= viewport + 2 ||
      top < -1 ||
      top > maximum + 1
    )
      return { state: "scroll_unavailable" };
    const directions = [...(top > 1 ? ["up"] : []), ...(top < maximum - 1 ? ["down"] : [])];
    return { state: "available", root, top, height, viewport, directions };
  };
  const valid = (command) => {
    if (!command || !actionId(command.actionId)) return false;
    if (command.type === "observe" || command.type === "inspect")
      return exact(command, ["type", "actionId"]);
    if (command.type === "cancel")
      return (
        exact(command, ["type", "actionId", "targetActionId"]) && actionId(command.targetActionId)
      );
    if (command.type === "open")
      return (
        exact(command, ["type", "actionId", "snapshotId", "candidateId"]) &&
        actionId(command.snapshotId) &&
        actionId(command.candidateId)
      );
    if (command.type === "scrollViewport")
      return (
        exact(command, ["type", "actionId", "direction", "snapshotId"]) &&
        ["up", "down"].includes(command.direction) &&
        actionId(command.snapshotId)
      );
    if (command.type === "scrollSelectedRow")
      return (
        exact(command, ["type", "actionId", "snapshotId", "rowId", "direction"]) &&
        actionId(command.snapshotId) &&
        actionId(command.rowId) &&
        ["left", "right"].includes(command.direction)
      );
    return false;
  };

  async function dispatch(command, expectedUrl, deadline) {
    if (location.origin !== origin) throw new Error("unsupported_page");
    if (location.href !== expectedUrl) throw new Error("page_changed");
    if (!valid(command)) throw new Error("invalid_command");
    if (seen.has(command.actionId)) throw new Error("duplicate_action");
    remember(seen, command.actionId);
    if (command.type === "cancel") {
      remember(cancelled, command.targetActionId);
      return { outcome: "cancelled" };
    }
    try {
      active(command, expectedUrl, deadline);
    } catch (error) {
      if (command.type !== "observe" && command.type !== "inspect") snapshot = undefined;
      throw error;
    }
    if (command.type === "observe") return site();
    if (command.type === "inspect") {
      const observation = site();
      const entries = observation.page === "browse" ? observed() : [];
      const rows = observation.page === "browse" ? observedRows(entries) : [];
      const scroll = observation.page === "browse" ? viewportScroll() : undefined;
      const snapshotId = crypto.randomUUID();
      snapshot = {
        session,
        url: location.href,
        created: Date.now(),
        entries: entries.length <= 40 ? entries : [],
        rows,
        scroll,
        id: snapshotId,
      };
      return {
        snapshotId,
        candidates: snapshot.entries.map(({ id, title: label }) => ({
          id,
          title: label,
        })),
        playback: { available: false },
        site: {
          ...observation,
          ...(observation.page === "browse"
            ? {
                verticalScrollDirections: scroll?.directions || [],
                rows: rows.map(({ id, label, directions }) => ({
                  id,
                  label,
                  directions,
                })),
              }
            : {}),
        },
      };
    }
    if (mutation) throw new Error("busy");
    mutation = command.actionId;
    try {
      if (page() !== "browse") throw new Error("unsupported_page");
      if (
        !snapshot ||
        snapshot.id !== command.snapshotId ||
        snapshot.session !== session ||
        snapshot.url !== location.href ||
        Date.now() - snapshot.created >= 30_000
      )
        throw new Error("stale_snapshot");
      if (command.type === "scrollViewport") {
        const current = viewportScroll();
        if (snapshot.scroll?.state !== "available" || current.state !== "available")
          throw new Error(
            current.state === "scroll_ambiguous" ? "scroll_ambiguous" : "scroll_unavailable",
          );
        if (
          current.root !== snapshot.scroll.root ||
          current.top !== snapshot.scroll.top ||
          current.height !== snapshot.scroll.height ||
          current.viewport !== snapshot.scroll.viewport ||
          !snapshot.scroll.directions.includes(command.direction) ||
          !current.directions.includes(command.direction)
        )
          throw new Error("stale_snapshot");
        active(command, expectedUrl, deadline);
        current.root.scrollBy({
          top: (command.direction === "down" ? 1 : -1) * Math.max(1, current.viewport - 80),
          behavior: "instant",
        });
        return {
          outcome: current.root.scrollTop === current.top ? "scroll_unverified" : "scrolled",
        };
      }
      if (command.type === "scrollSelectedRow") {
        const row = snapshot.rows.find((candidate) => candidate.id === command.rowId);
        if (!row || !row.directions.includes(command.direction)) throw new Error("stale_row");
        const entries = observed();
        const currentRows = observedRows(entries);
        const current = currentRows.find((candidate) => candidate.row === row.row);
        if (
          !current ||
          current.label !== row.label ||
          current.left !== row.left ||
          current.width !== row.width ||
          current.viewport !== row.viewport ||
          !current.directions.includes(command.direction) ||
          current.members.length !== row.members.length ||
          current.members.some(
            (member, index) =>
              member.anchor !== row.members[index].anchor ||
              member.href !== row.members[index].href ||
              member.title !== row.members[index].title,
          )
        )
          throw new Error("stale_row");
        active(command, expectedUrl, deadline);
        current.row.scrollBy({
          left: (command.direction === "right" ? 1 : -1) * Math.max(1, current.viewport - 80),
          behavior: "instant",
        });
        return {
          outcome: current.row.scrollLeft === current.left ? "scroll_unverified" : "scrolled",
        };
      }
      const entry = snapshot.entries.find((candidate) => candidate.id === command.candidateId);
      if (!entry) throw new Error("stale_candidate");
      const current = observed().filter((candidate) => candidate.href === entry.href);
      if (
        current.length !== 1 ||
        current[0].anchor !== entry.anchor ||
        current[0].title !== entry.title ||
        !entry.anchor.isConnected
      )
        throw new Error("stale_candidate");
      active(command, expectedUrl, deadline);
      const before = location.href;
      entry.anchor.click();
      for (let index = 0; index < 20; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (cancelled.has(command.actionId)) throw new Error("cancelled");
        if (Date.now() >= deadline) throw new Error("command_timeout");
        if (location.href !== before) {
          if (location.href !== entry.href) throw new Error("page_changed");
          return { outcome: "navigation_observed" };
        }
      }
      throw new Error("navigation_not_observed");
    } finally {
      mutation = undefined;
      snapshot = undefined;
    }
  }

  globalThis.__ellieMediaController = { dispatch };
})();
