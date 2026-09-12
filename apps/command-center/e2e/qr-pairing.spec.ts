import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import QRCode from "qrcode";
import { browserPairingQr } from "@ellie/protocol";

const code = "ab".repeat(32);
const client = {
  id: "qr-phone",
  label: "Camera phone",
  role: "phone_controller",
  expiresAt: Date.now() + 86_400_000,
};

interface QrMatrix {
  size: number;
  data: number[];
}

interface CameraState {
  calls: number;
  stops: number;
  constraints?: MediaStreamConstraints;
}

declare global {
  interface Window {
    qrCameraTest: {
      state: CameraState;
      resolvePermission(): void;
    };
  }
}

function qrMatrix(payload: string): QrMatrix {
  const modules = QRCode.create(payload, { errorCorrectionLevel: "M" }).modules;
  return { size: modules.size, data: [...modules.data] };
}

async function syntheticCamera(
  page: Page,
  options: { payload?: string; pending?: boolean; denied?: boolean } = {},
): Promise<void> {
  const matrix = qrMatrix(options.payload ?? browserPairingQr(code));
  await page.route("**/pair/", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "content-security-policy":
          "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
        "permissions-policy": "camera=(self), microphone=(), geolocation=()",
      },
    });
  });
  await page.addInitScript(
    ({ matrix, pending, denied }) => {
      const tracks: MediaStreamTrack[] = [];
      const state: CameraState = {
        calls: 0,
        get stops() {
          return tracks.filter((track) => track.readyState === "ended").length;
        },
      };
      let resolvePermission = () => {};

      const stream = () => {
        const scale = 8;
        const margin = 4;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = (matrix.size + margin * 2) * scale;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "black";
        for (let row = 0; row < matrix.size; row++) {
          for (let column = 0; column < matrix.size; column++) {
            if (matrix.data[row * matrix.size + column])
              context.fillRect((column + margin) * scale, (row + margin) * scale, scale, scale);
          }
        }
        const captured = canvas.captureStream(10);
        tracks.push(...captured.getVideoTracks());
        return captured;
      };

      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async (constraints: MediaStreamConstraints) => {
            state.calls += 1;
            state.constraints = constraints;
            if (denied) throw new DOMException("Synthetic denial", "NotAllowedError");
            if (pending)
              await new Promise<void>((resolve) => {
                resolvePermission = resolve;
              });
            return stream();
          },
        },
      });
      window.qrCameraTest = {
        state,
        resolvePermission: () => resolvePermission(),
      };
    },
    { matrix, pending: options.pending ?? false, denied: options.denied ?? false },
  );
}

async function browserConnection(
  page: Page,
  options: { paired?: boolean; losePair?: boolean } = {},
) {
  const state = {
    paired: options.paired ?? false,
    posts: 0,
    sessionReads: 0,
    cameraStopsAtPost: undefined as number | undefined,
  };
  await page.route("**/browser/v1/**", async (route) => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1);
    if (operation === "session") {
      state.sessionReads += 1;
      await route.fulfill({
        status: state.paired ? 200 : 401,
        json: state.paired ? { client } : { error: "Not paired" },
      });
      return;
    }
    if (operation === "pair") {
      state.posts += 1;
      state.cameraStopsAtPost = await page.evaluate(() => window.qrCameraTest.state.stops);
      expect(route.request().postDataJSON()).toEqual({ code });
      state.paired = true;
      if (options.losePair) await route.abort("connectionreset");
      else await route.fulfill({ json: { client } });
      return;
    }
    throw new Error(`Unexpected synthetic browser route: ${operation}`);
  });
  return state;
}

test("a real QR frame pairs once, stops the camera first, and leaves no browser-visible code", async ({
  page,
}) => {
  await syntheticCamera(page, { pending: true });
  const connection = await browserConnection(page);
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  await page.goto("/pair/");
  expect(await page.evaluate(() => window.qrCameraTest.state.calls)).toBe(0);

  await page.getByRole("button", { name: "Scan QR code" }).click();
  await expect(page.getByLabel("Camera preview")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.qrCameraTest.state.calls)).toBe(1);
  await page.evaluate(() => window.qrCameraTest.resolvePermission());
  await expect(page.getByRole("heading", { name: "Connected to Ellie" })).toBeVisible();

  expect(connection.posts).toBe(1);
  expect(connection.cameraStopsAtPost).toBe(1);
  expect(await page.evaluate(() => ({ ...window.qrCameraTest.state }))).toMatchObject({
    calls: 1,
    stops: 1,
    constraints: { audio: false, video: { facingMode: { ideal: "environment" } } },
  });
  expect(urls.every((url) => !url.includes(code))).toBe(true);
  expect(
    await page.evaluate(() => [location.hash, localStorage.length, sessionStorage.length]),
  ).toEqual(["", 0, 0]);
  expect(await page.content()).not.toContain(code);
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveCount(0);
});

test("a lost QR pairing response checks the session without restarting camera or POST", async ({
  page,
}) => {
  await syntheticCamera(page);
  const connection = await browserConnection(page, { losePair: true });
  await page.goto("/pair/");
  await page.getByRole("button", { name: "Scan QR code" }).click();
  await expect(page.getByRole("heading", { name: "Connected to Ellie" })).toBeVisible();
  expect(connection.posts).toBe(1);
  expect(connection.sessionReads).toBe(2);
  expect(await page.evaluate(() => window.qrCameraTest.state)).toMatchObject({
    calls: 1,
    stops: 1,
  });
});

test("a URL QR is rejected locally without a pairing request", async ({ page }) => {
  await syntheticCamera(page, { payload: `https://ellie.local/#${code}` });
  const connection = await browserConnection(page);
  await page.goto("/pair/");
  await page.getByRole("button", { name: "Scan QR code" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "That isn’t an Ellie pairing code. Try the QR code shown by Ellie.",
  );
  await page.screenshot({ path: test.info().outputPath("qr-scanner.png"), fullPage: true });
  expect(connection.posts).toBe(0);
  expect(await page.evaluate(() => [location.search, location.hash])).toEqual(["", ""]);
  await page.getByRole("button", { name: "Cancel scanning" }).click();
  await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.qrCameraTest.state.stops)).toBe(1);
});

test("camera denial closes the scanner and the manual fallback still pairs", async ({ page }) => {
  await syntheticCamera(page, { denied: true });
  const connection = await browserConnection(page);
  await page.goto("/pair/");
  await page.getByRole("button", { name: "Scan QR code" }).click();
  await expect(page.getByLabel("Camera preview")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(/camera|browser/i);
  await page.getByLabel("Pairing code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Connect to Ellie", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connected to Ellie" })).toBeVisible();
  expect(connection.posts).toBe(1);
});

test("cancelling a pending camera request stops a late permission stream", async ({ page }) => {
  await syntheticCamera(page, { pending: true });
  await browserConnection(page);
  await page.goto("/pair/");
  await page.getByRole("button", { name: "Scan QR code" }).click();
  await page.getByRole("button", { name: "Cancel scanning" }).click();
  await page.evaluate(() => window.qrCameraTest.resolvePermission());
  await expect.poll(() => page.evaluate(() => window.qrCameraTest.state.stops)).toBe(1);
  await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
});

test("hiding the page stops an active scanner", async ({ page }) => {
  await syntheticCamera(page, { payload: "not-an-ellie-code" });
  await browserConnection(page);
  await page.goto("/pair/");
  await page.getByRole("button", { name: "Scan QR code" }).click();
  await expect(page.getByLabel("Camera preview")).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.evaluate(() => window.qrCameraTest.state.stops)).toBe(1);
});

test("the one-minute scanner limit stops the camera and restores manual pairing", async ({
  page,
}) => {
  await page.clock.install();
  await syntheticCamera(page, { payload: "not-an-ellie-code" });
  await browserConnection(page);
  await page.goto("/pair/");
  await page.getByRole("button", { name: "Scan QR code" }).click();
  await expect(page.getByLabel("Camera preview")).toBeVisible();
  await page.clock.runFor(60_100);
  await expect(page.getByLabel("Camera preview")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(/timed out/i);
  await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.qrCameraTest.state.stops)).toBe(1);
});

test("an already connected page never requests camera access", async ({ page }) => {
  await syntheticCamera(page);
  await browserConnection(page, { paired: true });
  await page.goto("/pair/");
  await expect(page.getByRole("heading", { name: "Connected to Ellie" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan QR code" })).toHaveCount(0);
  expect(await page.evaluate(() => window.qrCameraTest.state.calls)).toBe(0);
});
