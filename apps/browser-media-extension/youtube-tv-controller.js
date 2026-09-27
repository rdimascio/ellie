(() => {
  if (globalThis.__ellieMediaController) return;
  const origin = "https://tv.youtube.com";
  const session = crypto.randomUUID();
  const seen = new Set();
  let snapshot;
  const uuid = (value) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  const exact = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join();
  const boundedText = (value, maximum = 200) => {
    const text = value?.replace(/\s+/g, " ").trim();
    return text && !/[\p{C}]/u.test(text) && new TextEncoder().encode(text).length <= maximum
      ? text
      : undefined;
  };
  const geometry = (element) => {
    const rect = element.getBoundingClientRect();
    const values = [rect.left, rect.top, rect.width, rect.height];
    return values.every(Number.isFinite) ? values : undefined;
  };
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
    }
    return true;
  };
  const page = () => {
    const url = new URL(location.href);
    if (url.origin !== origin || url.username || url.password) return "unsupported";
    if (/^\/(?:welcome|signin|login)(?:\/|$)/i.test(url.pathname)) return "login";
    if (
      /^\/(?:signup|subscribe|purchase|checkout|billing|account|settings)(?:\/|$)/i.test(
        url.pathname,
      ) ||
      document.querySelector("input[type='password'], [aria-modal='true'], [role='dialog']")
    )
      return "unsupported";
    const gates = [...document.querySelectorAll("a,button")];
    if (gates.length > 500) return "unsupported";
    if (
      gates.some(
        (element) =>
          visible(element) &&
          /^(?:sign in|start free trial|subscribe|buy|purchase|checkout)$/i.test(
            (element.getAttribute("aria-label") || element.textContent || "").trim(),
          ),
      )
    )
      return "unsupported";
    return document.querySelector("main,[role='main']") ? "browse" : "unsupported";
  };
  // Playback exists only when the page exposes one explicit title/region/video/control
  // relationship. This never guesses a provider selector or invokes the video element.
  const player = () => {
    if (page() !== "browse") return undefined;
    const headings = [...document.querySelectorAll("h1")]
      .filter(visible)
      .map((heading) => ({ heading, title: boundedText(heading.textContent) }))
      .filter(({ title }) => title);
    if (headings.length !== 1) return undefined;
    const headingId = headings[0].heading.id;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(headingId)) return undefined;
    const regions = [...document.querySelectorAll("[role='region'][aria-labelledby]")].filter(
      (region) => region.getAttribute("aria-labelledby") === headingId && visible(region),
    );
    if (regions.length !== 1) return undefined;
    const region = regions[0];
    const videos = [...document.querySelectorAll("video")];
    if (videos.length > 16) return undefined;
    const shown = videos.filter(visible);
    if (shown.length !== 1) return undefined;
    const video = shown[0];
    const videoId = video.id;
    const source = video.currentSrc || video.srcObject?.id;
    const currentTime = video.currentTime;
    const duration = video.duration;
    const durationKey = Number.isFinite(duration)
      ? duration
      : duration === Infinity
        ? "live"
        : undefined;
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(videoId) ||
      !region.contains(video) ||
      typeof source !== "string" ||
      source.length < 1 ||
      new TextEncoder().encode(source).length > 2048 ||
      video.error ||
      video.readyState < 2 ||
      video.loop ||
      video.autoplay ||
      !Number.isFinite(currentTime) ||
      currentTime < 0 ||
      currentTime > 86_400 ||
      durationKey === undefined ||
      (typeof durationKey === "number" && (durationKey <= 0 || durationKey > 86_400))
    )
      return undefined;
    const state = video.paused || video.ended ? "paused" : "playing";
    const buttons = [...document.querySelectorAll("button,[role='button']")];
    if (buttons.length > 256) return undefined;
    const controls = buttons.filter(
      (button) =>
        button.getAttribute("aria-controls") === videoId &&
        region.contains(button) &&
        visible(button) &&
        !button.matches(":disabled") &&
        !button.closest("[inert]") &&
        !button.closest("[aria-disabled='true']") &&
        !button.closest("[role='dialog'],[aria-modal='true']") &&
        (() => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return Boolean(hit && (hit === button || button.contains(hit)));
        })() &&
        boundedText(
          button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent,
          100,
        )?.toLowerCase() === (state === "paused" ? "play" : "pause"),
    );
    if (controls.length !== 1) return undefined;
    const regionGeometry = geometry(region);
    const videoGeometry = geometry(video);
    const controlGeometry = geometry(controls[0]);
    if (!regionGeometry || !videoGeometry || !controlGeometry) return undefined;
    return {
      title: headings[0].title,
      heading: headings[0].heading,
      region,
      video,
      videoId,
      source,
      currentTime,
      duration: durationKey,
      state,
      control: controls[0],
      action: state === "paused" ? "play" : "pause",
      regionGeometry,
      videoGeometry,
      controlGeometry,
    };
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
    const directions = [
      ...(top > 1 ? ["up"] : []),
      ...(top < height - viewport - 1 ? ["down"] : []),
    ];
    return { state: "available", root, top, height, viewport, directions };
  };
  const observe = () => {
    const observedPage = page();
    if (observedPage !== "browse")
      return { site: { provider: "youtube_tv", page: observedPage, playback: "unavailable" } };
    const observedPlayer = player();
    if (observedPlayer) {
      return {
        site: {
          provider: "youtube_tv",
          page: "watch",
          playback: observedPlayer.state,
          currentTimeSeconds: Math.round(observedPlayer.currentTime * 10) / 10,
        },
        player: observedPlayer,
      };
    }
    const scroll = viewportScroll();
    return {
      site: {
        provider: "youtube_tv",
        page: "browse",
        playback: "unavailable",
        verticalScrollDirections: scroll.directions || [],
      },
      scroll,
    };
  };
  const current = (expectedUrl, deadline) => {
    if (location.origin !== origin || location.href !== expectedUrl)
      throw new Error("page_changed");
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("command_timeout");
  };
  async function dispatch(command, expectedUrl, deadline) {
    if (!uuid(command?.actionId)) throw new Error("invalid_command");
    if (
      !(
        (command.type === "inspect" && exact(command, ["type", "actionId"])) ||
        (["play", "pause"].includes(command.type) &&
          exact(command, ["type", "actionId", "snapshotId"]) &&
          uuid(command.snapshotId)) ||
        (command.type === "scrollViewport" &&
          exact(command, ["type", "actionId", "direction", "snapshotId"]) &&
          ["up", "down"].includes(command.direction) &&
          uuid(command.snapshotId))
      )
    )
      throw new Error("unsupported_command");
    current(expectedUrl, deadline);
    if (seen.has(command.actionId) || seen.size >= 256) throw new Error("duplicate_action");
    seen.add(command.actionId);
    if (command.type === "inspect") {
      const observation = observe();
      snapshot = {
        id: crypto.randomUUID(),
        session,
        url: expectedUrl,
        created: Date.now(),
        page: observation.site.page,
        playback: observation.site.playback,
        player: observation.player,
        scroll: observation.scroll,
      };
      return {
        snapshotId: snapshot.id,
        candidates: [],
        playback: {
          available: Boolean(observation.player),
          paused: observation.site.playback === "paused",
        },
        ...(observation.player ? { title: observation.player.title } : {}),
        site: observation.site,
      };
    }
    const prior = snapshot;
    snapshot = undefined;
    if (
      !prior ||
      prior.session !== session ||
      prior.url !== expectedUrl ||
      Date.now() - prior.created >= 30_000
    )
      throw new Error("stale_snapshot");
    const observation = observe();
    if (command.type === "scrollViewport") {
      if (prior.page !== "browse" || observation.site.page !== "browse")
        throw new Error("scroll_unavailable");
      const currentScroll = observation.scroll;
      if (prior.scroll?.state !== "available" || currentScroll.state !== "available")
        throw new Error(
          currentScroll.state === "scroll_ambiguous" ? "scroll_ambiguous" : "scroll_unavailable",
        );
      if (
        command.snapshotId !== prior.id ||
        currentScroll.root !== prior.scroll.root ||
        currentScroll.top !== prior.scroll.top ||
        currentScroll.height !== prior.scroll.height ||
        currentScroll.viewport !== prior.scroll.viewport ||
        !prior.scroll.directions.includes(command.direction) ||
        !currentScroll.directions.includes(command.direction)
      )
        throw new Error("stale_snapshot");
      current(expectedUrl, deadline);
      currentScroll.root.scrollBy({
        top: (command.direction === "down" ? 1 : -1) * Math.max(1, currentScroll.viewport - 80),
        behavior: "instant",
      });
      return {
        outcome:
          currentScroll.root.scrollTop === currentScroll.top ? "scroll_unverified" : "scrolled",
      };
    }
    if (
      command.snapshotId !== prior.id ||
      prior.page !== "watch" ||
      observation.site.page !== "watch" ||
      !prior.player ||
      !observation.player ||
      command.type !== prior.player.action ||
      observation.player.action !== prior.player.action ||
      observation.player.title !== prior.player.title ||
      observation.player.heading !== prior.player.heading ||
      observation.player.region !== prior.player.region ||
      observation.player.video !== prior.player.video ||
      observation.player.control !== prior.player.control ||
      observation.player.videoId !== prior.player.videoId ||
      observation.player.source !== prior.player.source ||
      (prior.player.state === "paused"
        ? observation.player.currentTime !== prior.player.currentTime
        : observation.player.currentTime < prior.player.currentTime ||
          observation.player.currentTime - prior.player.currentTime > 30) ||
      observation.player.duration !== prior.player.duration ||
      prior.playback !== observation.site.playback ||
      prior.playback !== (command.type === "play" ? "paused" : "playing") ||
      observation.player.regionGeometry.some(
        (value, index) => value !== prior.player.regionGeometry[index],
      ) ||
      observation.player.videoGeometry.some(
        (value, index) => value !== prior.player.videoGeometry[index],
      ) ||
      observation.player.controlGeometry.some(
        (value, index) => value !== prior.player.controlGeometry[index],
      )
    )
      throw new Error("playback_unavailable");
    current(expectedUrl, deadline);
    prior.player.control.click();
    return { outcome: "playback_unverified" };
  }
  globalThis.__ellieMediaController = { dispatch };
})();
