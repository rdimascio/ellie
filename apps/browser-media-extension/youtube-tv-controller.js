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
  const player = () => {
    const videos = [...document.querySelectorAll("video")];
    if (videos.length > 16) return { state: "ambiguous" };
    const shown = videos.filter(visible);
    if (shown.length !== 1) return { state: shown.length ? "ambiguous" : "unavailable" };
    const video = shown[0];
    if (video.error || video.readyState < 2) return { state: "unavailable" };
    const state = video.paused || video.ended ? "paused" : "playing";
    const buttons = [...document.querySelectorAll("button,[role='button']")];
    if (buttons.length > 256) return { state: "ambiguous" };
    const controls = buttons.filter(
      (button) =>
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
        (button.getAttribute("aria-label") || button.getAttribute("title") || "")
          .trim()
          .toLowerCase() === (state === "paused" ? "play" : "pause"),
    );
    if (controls.length !== 1) return { state: controls.length ? "ambiguous" : "unavailable" };
    return { state, video, control: controls[0] };
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
    if (observedPlayer.state === "playing" || observedPlayer.state === "paused") {
      const time = observedPlayer.video.currentTime;
      return {
        site: {
          provider: "youtube_tv",
          page: "watch",
          playback: observedPlayer.state,
          ...(Number.isFinite(time) && time >= 0 && time <= 86_400
            ? { currentTimeSeconds: Math.round(time * 10) / 10 }
            : {}),
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
        (["inspect", "play", "pause"].includes(command.type) &&
          exact(command, ["type", "actionId"])) ||
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
        video: observation.player?.video,
        control: observation.player?.control,
        scroll: observation.scroll,
      };
      return {
        snapshotId: snapshot.id,
        candidates: [],
        playback: {
          available: Boolean(observation.player),
          paused: observation.site.playback === "paused",
        },
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
      prior.page !== "watch" ||
      observation.site.page !== "watch" ||
      prior.video !== observation.player?.video ||
      prior.control !== observation.player?.control ||
      prior.playback !== observation.site.playback ||
      prior.playback !== (command.type === "play" ? "paused" : "playing")
    )
      throw new Error("playback_unavailable");
    current(expectedUrl, deadline);
    if (command.type === "play") await observation.player.video.play();
    else observation.player.video.pause();
    return { outcome: "dispatched_unverified" };
  }
  globalThis.__ellieMediaController = { dispatch };
})();
