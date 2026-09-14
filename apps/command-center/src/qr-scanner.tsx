import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { parseBrowserPairingQr } from "@ellie/protocol";

interface ScannerProps {
  onCode: (code: string) => void;
  onCancel: (note?: string) => void;
}

/** Frames and decoded invitations stay in memory on this device. */
export function QrScanner({ onCode, onCancel }: ScannerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onCode, onCancel });
  callbacks.current = { onCode, onCancel };
  const [note, setNote] = useState("Allow camera access to scan the QR code shown by Ellie.");

  useEffect(() => {
    let active = true;
    let stream: MediaStream | undefined;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const preview = video.current!;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const stop = () => {
      active = false;
      clearTimeout(frameTimer);
      clearTimeout(deadline);
      stream?.getTracks().forEach((track) => track.stop());
      stream = undefined;
      preview.pause();
      preview.srcObject = null;
      canvas.width = 0;
      canvas.height = 0;
    };
    const cancel = (message: string) => {
      if (!active) return;
      stop();
      callbacks.current.onCancel(message);
    };
    const hidden = () => {
      if (document.hidden) cancel("Camera stopped. Tap Scan QR code when you’re ready.");
    };
    const leaving = () => cancel("Camera stopped. Tap Scan QR code when you’re ready.");
    const scan = () => {
      if (!active) return;
      try {
        if (preview.readyState >= 2 && preview.videoWidth > 0 && preview.videoHeight > 0) {
          const scale = Math.min(1, 640 / Math.max(preview.videoWidth, preview.videoHeight));
          canvas.width = Math.max(1, Math.round(preview.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(preview.videoHeight * scale));
          context!.drawImage(preview, 0, 0, canvas.width, canvas.height);
          const pixels = context!.getImageData(0, 0, canvas.width, canvas.height);
          const decoded = jsQR(pixels.data, pixels.width, pixels.height, {
            inversionAttempts: "dontInvert",
          });
          if (decoded) {
            const code = parseBrowserPairingQr(decoded.data);
            if (code) {
              stop();
              callbacks.current.onCode(code);
              return;
            }
            setNote("That isn’t an Ellie pairing code. Try the QR code shown by Ellie.");
          }
        }
        frameTimer = setTimeout(scan, 200);
      } catch {
        cancel("The camera couldn’t read a code. You can enter the pairing code instead.");
      }
    };

    cancelButton.current?.focus();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    deadline = setTimeout(
      () => cancel("Scanning timed out. Try again or enter the pairing code instead."),
      60_000,
    );
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !context) {
      cancel("This browser can’t scan codes here. You can enter the pairing code instead.");
    } else {
      void navigator.mediaDevices
        .getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        })
        .then(async (media) => {
          if (!active || document.hidden) {
            media.getTracks().forEach((track) => track.stop());
            if (active) hidden();
            return;
          }
          stream = media;
          preview.srcObject = media;
          await preview.play();
          if (!active) return;
          setNote("Point your camera at the QR code shown by Ellie on your Mac.");
          scan();
        })
        .catch(() => {
          cancel("Camera access wasn’t available. You can enter the pairing code instead.");
        });
    }
    return () => {
      stop();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
    };
  }, []);

  return (
    <section className="qr-scanner" aria-label="Scan pairing QR code">
      <video ref={video} muted autoPlay playsInline aria-label="Camera preview" />
      <p className="scan-note" role="status">
        {note}
      </p>
      <p className="code-help">
        Camera images stay on this device. Scanning stops after one minute.
      </p>
      <button
        ref={cancelButton}
        className="pairing-button secondary"
        type="button"
        onClick={() => onCancel()}
      >
        Cancel scanning
      </button>
    </section>
  );
}
