(() => {
  if (globalThis.__ellieMediaController) return;
  const allowedOrigins = new Set(["https://www.netflix.com", "https://www.youtube.com"]);
  const youtubeOrigins = new Set(["https://www.youtube.com"]);
  const netflixOrigins = new Set(["https://www.netflix.com"]);
  const snapshots = new Map();
  const cancelled = new Set();
  const seen = new Set();
  let mutation;
  const session = crypto.randomUUID();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const uuid = (value) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  const exact = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join();
  const remember = (set, value) => {
    set.add(value);
    if (set.size > 256) set.delete(set.values().next().value);
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    let node = element;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)
        return false;
      const parent = node.parentElement;
      if (parent) {
        const p = parent.getBoundingClientRect();
        const ps = getComputedStyle(parent);
        // In HTML, body overflow is propagated to the viewport when the root
        // overflow is visible. The body's own box can be zero-height even as
        // its children render in the viewport (for example, YouTube results).
        // Keep clipping checks for every other ancestor and for a body whose
        // overflow has not been propagated.
        const rootStyle = parent === document.body && getComputedStyle(document.documentElement);
        const viewportBodyOverflow =
          rootStyle && rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible";
        if (
          !viewportBodyOverflow &&
          (ps.overflowX === "hidden" || ps.overflowX === "auto" || ps.overflowX === "scroll") &&
          (rect.right <= p.left || rect.left >= p.right)
        )
          return false;
        if (
          !viewportBodyOverflow &&
          (ps.overflowY === "hidden" || ps.overflowY === "auto" || ps.overflowY === "scroll") &&
          (rect.bottom <= p.top || rect.top >= p.bottom)
        )
          return false;
      }
      node = parent;
    }
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + Math.min(rect.width / 2, 8)));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + Math.min(rect.height / 2, 8)));
    const hit = document.elementFromPoint(x, y);
    return (
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth &&
      Boolean(hit && (element.contains(hit) || hit.contains(element)))
    );
  };
  const titleFor = (anchor) => {
    for (const value of [
      anchor.getAttribute("aria-label"),
      anchor.getAttribute("title"),
      anchor.textContent,
    ]) {
      const title = value?.replace(/\s+/g, " ").trim();
      if (title && title.length <= 200) return title;
    }
    return null;
  };
  const supportedAnchor = (anchor) => {
    if (anchor.hasAttribute("download")) return false;
    const target = anchor.getAttribute("target");
    if (target && target.toLowerCase() !== "_self") return false;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin) return false;
    return youtubeOrigins.has(location.origin)
      ? url.pathname === "/watch" || url.pathname.startsWith("/shorts/")
      : netflixOrigins.has(location.origin) &&
          !url.username &&
          !url.password &&
          /^\/(?:watch|title)\/[0-9]{1,20}$/.test(url.pathname) &&
          !url.hash &&
          url.href.length <= 2048;
  };
  const scrollableRowFor = (anchor) => {
    let row = anchor.parentElement;
    while (row && row !== document.body) {
      if (
        row.scrollWidth > row.clientWidth + 2 &&
        ["auto", "scroll"].includes(getComputedStyle(row).overflowX)
      )
        return row;
      row = row.parentElement;
    }
    return null;
  };
  // Scan the current eligible DOM, not the capped title list in a prior read.
  // More than 500 anchors cannot establish a unique row within this budget.
  const uniqueVisibleRow = () => {
    const anchors = document.querySelectorAll("a[href]");
    if (anchors.length > 500) return undefined;
    let selected;
    for (const anchor of anchors) {
      if (!visible(anchor) || !supportedAnchor(anchor)) continue;
      const row = scrollableRowFor(anchor);
      if (!row) continue;
      if (selected && selected !== row) return undefined;
      selected = row;
    }
    return selected;
  };
  const observedRowLabel = (row, index) => {
    const previous = row.previousElementSibling;
    const heading =
      row.getAttribute("aria-label") ||
      (previous?.matches("h1,h2,h3,[role='heading']") ? previous.textContent : null);
    const text = heading?.replace(/\s+/g, " ").trim();
    const prefix = `Row ${index + 1}`;
    const candidate = text ? `${prefix}: ${text}` : prefix;
    return !/[\p{C}]/u.test(candidate) && new TextEncoder().encode(candidate).length <= 100
      ? candidate
      : prefix;
  };
  // The complete visible eligible row set must fit the cap. A partial scan
  // cannot establish which row a person selected.
  const observedRows = () => {
    const anchors = document.querySelectorAll("a[href]");
    if (anchors.length > 500) return undefined;
    const rows = new Map();
    for (const anchor of anchors) {
      if (!visible(anchor) || !supportedAnchor(anchor) || !titleFor(anchor)) continue;
      const row = scrollableRowFor(anchor);
      if (!row || rows.has(row)) continue;
      rows.set(row, anchor);
      if (rows.size > 8) return undefined;
    }
    return [...rows].map(([row, anchor], index) => ({
      row,
      anchor,
      href: anchor.href,
      title: titleFor(anchor),
      label: observedRowLabel(row, index),
    }));
  };
  const observedSearchControl = () => {
    const inputs = document.querySelectorAll("input");
    if (inputs.length > 128) return undefined;
    let selected;
    for (const input of inputs) {
      if (
        (input.type !== "search" && input.getAttribute("role") !== "searchbox") ||
        !visible(input) ||
        input.disabled ||
        input.readOnly ||
        input.closest("[role='dialog'],[aria-modal='true']")
      )
        continue;
      if (selected) return undefined;
      const labelledBy = input.getAttribute("aria-labelledby");
      const referenced =
        labelledBy && /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(labelledBy)
          ? document.getElementById(labelledBy)?.textContent
          : null;
      const label =
        input.getAttribute("aria-label") ||
        referenced ||
        (input.labels?.length === 1 ? input.labels[0].textContent : null);
      const name = label?.replace(/\s+/g, " ").trim();
      if (!name || /[\p{C}]/u.test(name) || new TextEncoder().encode(name).length > 100)
        return undefined;
      selected = {
        input,
        label: name,
        type: input.type,
        role: input.getAttribute("role"),
        value: input.value,
      };
    }
    return selected &&
      ["search", "search netflix", "search titles", "search titles, people, genres"].includes(
        selected.label.toLowerCase(),
      )
      ? selected
      : undefined;
  };
  const observedYoutubeSearchControl = () => {
    if (!youtubeOrigins.has(location.origin)) return undefined;
    const site = siteObservation();
    if (site.page !== "home" && site.page !== "results") return undefined;
    const url = new URL(location.href);
    if (
      url.hash ||
      (site.page === "home" && url.search) ||
      (site.page === "results" &&
        (url.searchParams.size !== 1 || url.searchParams.getAll("search_query").length !== 1))
    )
      return undefined;
    if (
      document.querySelector("input[type='password']") ||
      [...document.querySelectorAll("[role='dialog'],[aria-modal='true']")].some(visible)
    )
      return undefined;
    const inputs = document.querySelectorAll("input");
    const buttons = document.querySelectorAll("button");
    if (inputs.length > 128 || buttons.length > 256) return undefined;
    const uncovered = (element) => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && element.contains(hit));
    };
    const searchFields = [...inputs].filter(
      (input) =>
        (input.name === "search_query" ||
          input.type === "search" ||
          input.getAttribute("role") === "searchbox") &&
        uncovered(input),
    );
    if (searchFields.length !== 1) return undefined;
    const fields = [...inputs].filter((input) => {
      const form = input.closest("form");
      const action = form && new URL(form.action, location.href);
      return (
        input.type === "text" &&
        input.name === "search_query" &&
        input.getAttribute("role") === "combobox" &&
        input.getAttribute("placeholder") === "Search" &&
        !input.disabled &&
        !input.readOnly &&
        !input.closest("[inert],[aria-disabled='true']") &&
        form?.method.toLowerCase() === "get" &&
        action?.origin === location.origin &&
        action.pathname === "/results" &&
        !action.search &&
        !action.hash &&
        uncovered(input)
      );
    });
    if (fields.length !== 1 || fields[0] !== searchFields[0]) return undefined;
    const input = fields[0];
    const container = input.closest("form")?.parentElement?.parentElement;
    if (!container) return undefined;
    const controls = [...buttons].filter(
      (button) =>
        button.getAttribute("aria-label") === "Search" &&
        !button.disabled &&
        !button.closest("[inert],[aria-disabled='true']") &&
        uncovered(button),
    );
    return controls.length === 1 && controls[0].parentElement === container
      ? {
          input,
          button: controls[0],
          container,
          value: input.value,
          id: crypto.randomUUID(),
          label: "Search",
        }
      : undefined;
  };
  const schema = (c) => {
    if (!c || !uuid(c.actionId)) return false;
    if (c.type === "inspect" || c.type === "observe" || c.type === "play" || c.type === "pause")
      return exact(c, ["type", "actionId"]);
    if (c.type === "cancel")
      return exact(c, ["type", "actionId", "targetActionId"]) && uuid(c.targetActionId);
    if (c.type === "scrollViewport")
      return exact(c, ["type", "actionId", "direction"]) && ["up", "down"].includes(c.direction);
    if (c.type === "seek")
      return (
        exact(c, ["type", "actionId", "offsetSeconds"]) &&
        [-30, -10, 10, 30].includes(c.offsetSeconds)
      );
    if (c.type === "open")
      return (
        exact(c, ["type", "actionId", "snapshotId", "candidateId"]) &&
        uuid(c.snapshotId) &&
        uuid(c.candidateId)
      );
    if (c.type === "scrollSelectedRow")
      return (
        exact(c, ["type", "actionId", "snapshotId", "rowId", "direction"]) &&
        uuid(c.snapshotId) &&
        uuid(c.rowId) &&
        ["left", "right"].includes(c.direction)
      );
    if (c.type === "searchObserved")
      return (
        exact(c, ["type", "actionId", "snapshotId", "controlId", "query"]) &&
        uuid(c.snapshotId) &&
        uuid(c.controlId) &&
        typeof c.query === "string" &&
        c.query.length > 0 &&
        c.query === c.query.trim() &&
        c.query.length <= 200 &&
        new TextEncoder().encode(c.query).length <= 512 &&
        !/[\p{C}]/u.test(c.query)
      );
    return (
      c.type === "scrollRow" &&
      exact(c, ["type", "actionId", "snapshotId", "candidateId", "direction"]) &&
      uuid(c.snapshotId) &&
      uuid(c.candidateId) &&
      ["left", "right"].includes(c.direction)
    );
  };
  const active = (c, expectedUrl, deadline) => {
    if (cancelled.has(c.actionId)) throw new Error("cancelled");
    if (location.href !== expectedUrl) throw new Error("page_changed");
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("command_timeout");
  };
  const findVideo = () => {
    const all = [...document.querySelectorAll("video")];
    if (all.length > 16) throw new Error("ambiguous_video");
    const values = all.filter(visible);
    if (values.length !== 1) throw new Error(values.length ? "ambiguous_video" : "video_not_found");
    return values[0];
  };
  const siteObservation = () => {
    if (!youtubeOrigins.has(location.origin) && !netflixOrigins.has(location.origin))
      throw new Error("unsupported_page");
    const url = new URL(location.href);
    const youtube = youtubeOrigins.has(location.origin);
    if (!youtube && (url.username || url.password))
      return { provider: "netflix", page: "unsupported", playback: "unavailable" };
    const netflixQuery =
      url.pathname === "/search" && url.searchParams.getAll("q").length === 1
        ? url.searchParams.get("q")
        : null;
    const netflixResults =
      netflixQuery &&
      url.searchParams.size === 1 &&
      !url.hash &&
      netflixQuery === netflixQuery.trim() &&
      netflixQuery.length <= 200 &&
      new TextEncoder().encode(netflixQuery).length <= 512 &&
      !/[\p{C}]/u.test(netflixQuery);
    const page = !youtube
      ? /^\/login(?:\/|$)/.test(url.pathname)
        ? "login"
        : netflixResults
          ? "results"
          : url.pathname === "/browse" ||
              /^\/browse\/genre\/[0-9]{1,20}$/.test(url.pathname) ||
              (url.pathname === "/search" && !url.search) ||
              /^\/title\/[0-9]{1,20}$/.test(url.pathname)
            ? "browse"
            : /^\/watch\/[0-9]{1,20}$/.test(url.pathname)
              ? "watch"
              : "unsupported"
      : url.pathname === "/"
        ? "home"
        : url.pathname === "/results" &&
            url.searchParams.getAll("search_query").length === 1 &&
            Boolean(url.searchParams.get("search_query")?.trim())
          ? "results"
          : url.pathname === "/watch" &&
              url.searchParams.getAll("v").length === 1 &&
              /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") ?? "")
            ? "watch"
            : url.pathname === "/signin"
              ? "login"
              : "unsupported";
    const provider = youtube ? "youtube" : "netflix";
    if (
      !youtube &&
      (page === "browse" || page === "results") &&
      document.querySelector("[aria-modal='true'], [role='dialog'], input[type='password']")
    )
      return { provider, page: "unsupported", playback: "unavailable" };
    if (page !== "watch") return { provider, page, playback: "unavailable" };
    const videos = [...document.querySelectorAll("video")];
    if (videos.length > 16) return { provider, page, playback: "ambiguous" };
    const rendered = videos.filter((video) => {
      const rect = video.getBoundingClientRect();
      if (
        rect.width <= 2 ||
        rect.height <= 2 ||
        rect.bottom <= 0 ||
        rect.top >= innerHeight ||
        rect.right <= 0 ||
        rect.left >= innerWidth
      )
        return false;
      for (let node = video; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        )
          return false;
      }
      return true;
    });
    if (rendered.length > 1) return { provider, page, playback: "ambiguous" };
    if (rendered.length === 0) return { provider, page, playback: "unavailable" };
    // A visible video can be an advertisement. Never identify it as the selected title.
    const dialogs = document.querySelectorAll("[aria-modal='true'], [role='dialog']");
    if (
      document.querySelector(".html5-video-player.ad-showing") ||
      dialogs.length > 32 ||
      [...dialogs].some(visible)
    )
      return { provider, page, playback: "ambiguous" };
    const video = rendered[0];
    if (video.error || video.readyState < 2) return { provider, page, playback: "unavailable" };
    const playback = video.paused || video.ended ? "paused" : "playing";
    const time = video.currentTime;
    return {
      provider,
      page,
      playback,
      ...(Number.isFinite(time) && time >= 0 && time <= 86_400
        ? { currentTimeSeconds: Math.round(time * 10) / 10 }
        : {}),
    };
  };
  async function dispatch(command, expectedUrl, deadline) {
    if (!allowedOrigins.has(location.origin)) throw new Error("unsupported_page");
    if (location.href !== expectedUrl) throw new Error("page_changed");
    if (!schema(command)) throw new Error("invalid_command");
    if (command.type === "cancel") {
      if (seen.has(command.actionId)) throw new Error("duplicate_action");
      remember(seen, command.actionId);
      remember(cancelled, command.targetActionId);
      return { outcome: "cancelled" };
    }
    if (seen.has(command.actionId)) throw new Error("duplicate_action");
    remember(seen, command.actionId);
    active(command, expectedUrl, deadline);
    if (netflixOrigins.has(location.origin) && command.type !== "inspect") {
      const site = siteObservation();
      if (site.page === "login" || site.page === "unsupported") throw new Error("unsupported_page");
      if (
        (command.type === "open" || command.type === "searchObserved") &&
        site.page !== "browse" &&
        site.page !== "results"
      )
        throw new Error("unsupported_page");
      if (command.type === "scrollRow" && site.page !== "browse")
        throw new Error("unsupported_page");
      if (
        (command.type === "play" || command.type === "pause") &&
        (site.page !== "watch" ||
          site.playback !== (command.type === "play" ? "paused" : "playing"))
      )
        throw new Error("playback_unknown");
    }
    const mutates = command.type !== "inspect" && command.type !== "observe";
    if (mutates && mutation) throw new Error("busy");
    if (mutates) mutation = command.actionId;
    try {
      if (command.type === "observe") {
        active(command, expectedUrl, deadline);
        return siteObservation();
      }
      if (command.type === "inspect") {
        const site = siteObservation();
        const snapshotId = crypto.randomUUID();
        const entries = [];
        const anchors = document.querySelectorAll("a[href]");
        for (
          let index = 0;
          index < Math.min(anchors.length, 500) && entries.length < 40;
          index += 1
        ) {
          const anchor = anchors[index];
          if (
            site.page === "login" ||
            site.page === "unsupported" ||
            !visible(anchor) ||
            !supportedAnchor(anchor)
          )
            continue;
          const title = titleFor(anchor);
          if (title) entries.push({ id: crypto.randomUUID(), title, anchor, href: anchor.href });
        }
        if (netflixOrigins.has(location.origin)) {
          const counts = new Map();
          for (const entry of entries) counts.set(entry.href, (counts.get(entry.href) || 0) + 1);
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            if (counts.get(entries[index].href) !== 1) entries.splice(index, 1);
          }
        }
        snapshots.clear();
        const currentRows =
          netflixOrigins.has(location.origin) && site.page === "browse"
            ? observedRows()
            : undefined;
        const rows = currentRows?.map((entry) => ({ ...entry, id: crypto.randomUUID() })) || [];
        const currentSearch =
          netflixOrigins.has(location.origin) && (site.page === "browse" || site.page === "results")
            ? observedSearchControl()
            : youtubeOrigins.has(location.origin)
              ? observedYoutubeSearchControl()
              : undefined;
        const searchControl = currentSearch
          ? { ...currentSearch, id: crypto.randomUUID() }
          : undefined;
        const uniqueRow = site.page === "browse" ? uniqueVisibleRow() : undefined;
        const rowCandidateId = uniqueRow
          ? entries.find((entry) => scrollableRowFor(entry.anchor) === uniqueRow)?.id
          : undefined;
        snapshots.set(snapshotId, {
          session,
          url: location.href,
          created: Date.now(),
          entries,
          rowCandidateId,
          rows,
          searchControl,
        });
        const allVideos = [...document.querySelectorAll("video")];
        const videos = allVideos.length <= 16 ? allVideos.filter(visible) : [];
        const playback =
          videos.length === 1
            ? {
                available: true,
                paused: videos[0].paused,
                currentTime: Math.max(0, Math.round(videos[0].currentTime * 10) / 10),
                seekable: videos[0].seekable.length > 0,
              }
            : { available: false };
        return {
          snapshotId,
          candidates: entries.map(({ id, title }) => ({ id, title })),
          playback,
          ...(youtubeOrigins.has(location.origin) && searchControl
            ? { searchControl: { id: searchControl.id, label: searchControl.label } }
            : {}),
          site:
            netflixOrigins.has(location.origin) &&
            (site.page === "browse" || site.page === "results")
              ? {
                  ...site,
                  ...(site.page === "browse"
                    ? {
                        horizontalScrollAvailable: Boolean(rowCandidateId),
                        rows: rows.map(({ id, label }) => ({ id, label })),
                      }
                    : {}),
                  ...(searchControl
                    ? { searchControl: { id: searchControl.id, label: searchControl.label } }
                    : {}),
                }
              : youtubeOrigins.has(location.origin) &&
                  (site.page === "home" || site.page === "results") &&
                  searchControl
                ? { ...site, searchControl: { id: searchControl.id, label: searchControl.label } }
                : site,
          ...(rowCandidateId ? { rowCandidateId } : {}),
        };
      }
      if (command.type === "scrollViewport") {
        active(command, expectedUrl, deadline);
        const before = scrollY;
        scrollBy({
          top: (command.direction === "down" ? 1 : -1) * Math.max(1, innerHeight - 80),
          behavior: "instant",
        });
        await wait(80);
        active(command, expectedUrl, deadline);
        if (scrollY === before) throw new Error("scroll_unavailable");
        return { outcome: "scrolled" };
      }
      if (command.type === "scrollSelectedRow") {
        if (!netflixOrigins.has(location.origin)) throw new Error("row_scroll_unavailable");
        const snapshot = snapshots.get(command.snapshotId);
        if (
          !snapshot ||
          snapshot.session !== session ||
          snapshot.url !== location.href ||
          Date.now() - snapshot.created >= 30_000
        )
          throw new Error("stale_snapshot");
        const chosen = snapshot.rows?.find((entry) => entry.id === command.rowId);
        const currentRows = observedRows();
        const current = currentRows?.find((entry) => entry.row === chosen?.row);
        if (
          !chosen ||
          !chosen.anchor.isConnected ||
          !current ||
          current.anchor !== chosen.anchor ||
          current.href !== chosen.href ||
          current.title !== chosen.title ||
          current.label !== chosen.label ||
          currentRows.length !== snapshot.rows.length
        )
          throw new Error("row_scroll_unavailable");
        active(command, expectedUrl, deadline);
        const before = chosen.row.scrollLeft;
        chosen.row.scrollBy({
          left: (command.direction === "left" ? -1 : 1) * chosen.row.clientWidth * 0.8,
          behavior: "instant",
        });
        await wait(80);
        active(command, expectedUrl, deadline);
        if (chosen.row.scrollLeft === before) throw new Error("row_scroll_unavailable");
        return { outcome: "scrolled" };
      }
      if (command.type === "searchObserved") {
        if (!netflixOrigins.has(location.origin) && !youtubeOrigins.has(location.origin))
          throw new Error("search_unavailable");
        const snapshot = snapshots.get(command.snapshotId);
        if (
          !snapshot ||
          snapshot.session !== session ||
          snapshot.url !== location.href ||
          Date.now() - snapshot.created >= 30_000
        )
          throw new Error("stale_snapshot");
        const chosen = snapshot.searchControl;
        const youtube = youtubeOrigins.has(location.origin);
        const current = youtube ? observedYoutubeSearchControl() : observedSearchControl();
        if (
          !chosen ||
          chosen.id !== command.controlId ||
          !chosen.input.isConnected ||
          !current ||
          current.input !== chosen.input ||
          current.label !== chosen.label ||
          current.type !== chosen.type ||
          current.role !== chosen.role ||
          current.value !== chosen.value ||
          (youtube && (current.button !== chosen.button || current.container !== chosen.container))
        )
          throw new Error("search_unavailable");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter) throw new Error("search_unavailable");
        const event = new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: command.query,
        });
        active(command, expectedUrl, deadline);
        snapshots.delete(command.snapshotId);
        setter.call(chosen.input, command.query);
        chosen.input.dispatchEvent(event);
        if (youtube) {
          const expectedOrigin = new URL(expectedUrl).origin;
          active(command, expectedUrl, deadline);
          const ready = observedYoutubeSearchControl();
          if (
            !ready ||
            ready.input !== chosen.input ||
            ready.button !== chosen.button ||
            ready.container !== chosen.container ||
            ready.value !== command.query
          )
            throw new Error("search_unavailable");
          chosen.button.click();
          for (let index = 0; index < 20; index += 1) {
            await wait(50);
            if (cancelled.has(command.actionId)) throw new Error("cancelled");
            if (Date.now() >= deadline) throw new Error("command_timeout");
            const url = new URL(location.href);
            if (url.href === expectedUrl) continue;
            if (
              url.origin !== expectedOrigin ||
              url.pathname !== "/results" ||
              url.hash ||
              url.searchParams.size !== 1 ||
              url.searchParams.getAll("search_query").length !== 1 ||
              url.searchParams.get("search_query") !== command.query
            )
              throw new Error("page_changed");
            return { outcome: "navigation_observed" };
          }
          throw new Error("navigation_not_observed");
        }
        return { outcome: "search_dispatched" };
      }
      if (command.type === "scrollRow" || command.type === "open") {
        const snapshot = snapshots.get(command.snapshotId);
        if (
          !snapshot ||
          snapshot.session !== session ||
          snapshot.url !== location.href ||
          Date.now() - snapshot.created >= 30_000
        )
          throw new Error("stale_snapshot");
        const entry = snapshot.entries.find((item) => item.id === command.candidateId);
        if (
          !entry ||
          !entry.anchor.isConnected ||
          !visible(entry.anchor) ||
          entry.anchor.href !== entry.href ||
          titleFor(entry.anchor) !== entry.title ||
          !supportedAnchor(entry.anchor)
        )
          throw new Error("stale_candidate");
        active(command, expectedUrl, deadline);
        if (command.type === "open") {
          const before = location.href;
          active(command, expectedUrl, deadline);
          entry.anchor.click();
          for (let i = 0; i < 20; i += 1) {
            await wait(50);
            if (cancelled.has(command.actionId)) throw new Error("cancelled");
            if (Date.now() >= deadline) throw new Error("command_timeout");
            if (location.href !== before) return { outcome: "navigation_observed" };
          }
          throw new Error("navigation_not_observed");
        }
        const row = scrollableRowFor(entry.anchor);
        if (!row) throw new Error("row_scroll_unavailable");
        if (netflixOrigins.has(location.origin)) {
          if (snapshot.rowCandidateId !== entry.id || uniqueVisibleRow() !== row)
            throw new Error("row_scroll_unavailable");
        }
        active(command, expectedUrl, deadline);
        const before = row.scrollLeft;
        row.scrollBy({
          left: (command.direction === "left" ? -1 : 1) * row.clientWidth * 0.8,
          behavior: "instant",
        });
        await wait(80);
        active(command, expectedUrl, deadline);
        if (row.scrollLeft === before) throw new Error("row_scroll_unavailable");
        return { outcome: "scrolled" };
      }
      if (command.type === "play") {
        const video = findVideo();
        const before = video.currentTime;
        active(command, expectedUrl, deadline);
        const playResult = Promise.resolve(video.play()).then(
          () => "started",
          () => "failed",
        );
        const started = await Promise.race([
          playResult,
          wait(Math.max(0, Math.min(750, deadline - Date.now()))).then(() => "timeout"),
        ]);
        active(command, expectedUrl, deadline);
        if (started !== "started") throw new Error("playback_unknown");
        for (let i = 0; i < 20; i += 1) {
          await wait(50);
          active(command, expectedUrl, deadline);
          if (!video.paused && video.currentTime > before + 0.05) return { outcome: "playing" };
        }
        throw new Error("playback_unknown");
      }
      if (command.type === "pause") {
        const video = findVideo();
        active(command, expectedUrl, deadline);
        video.pause();
        await wait(25);
        active(command, expectedUrl, deadline);
        if (!video.paused) throw new Error("pause_not_verified");
        return { outcome: "paused" };
      }
      const video = findVideo();
      if (video.seekable.length === 0) throw new Error("seek_unavailable");
      const target = Math.max(
        video.seekable.start(0),
        Math.min(
          video.seekable.end(video.seekable.length - 1),
          video.currentTime + command.offsetSeconds,
        ),
      );
      active(command, expectedUrl, deadline);
      video.currentTime = target;
      for (let i = 0; i < 20; i += 1) {
        await wait(25);
        active(command, expectedUrl, deadline);
        if (!video.seeking && Math.abs(video.currentTime - target) < 0.5)
          return { outcome: "seeked" };
      }
      throw new Error("seek_not_verified");
    } finally {
      if (mutation === command.actionId) mutation = undefined;
    }
  }
  globalThis.__ellieMediaController = { dispatch };
})();
