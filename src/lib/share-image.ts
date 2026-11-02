import { toBlob } from "html-to-image";

const PIXEL_RATIO = 3;

// Draws the node to a PNG. Fonts and every image in it must be loaded first; the
// first capture is thrown away because Safari can paint images blank the first time.
export async function capturePng(node: HTMLElement): Promise<Blob> {
  await document.fonts.ready;
  await Promise.all(Array.from(node.querySelectorAll("img"), (img) => img.decode().catch(() => undefined)));
  const options = { pixelRatio: PIXEL_RATIO, cacheBust: false };
  await toBlob(node, options);
  const blob = await toBlob(node, options);
  if (!blob) throw new Error("capture failed");
  return blob;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Opens the share sheet with the PNG when the browser can send files. Otherwise saves
// the PNG and returns "downloaded", so the caller can offer a text link.
export async function sharePng(blob: Blob, filename: string, text: string): Promise<"shared" | "canceled" | "downloaded"> {
  const file = new File([blob], filename, { type: "image/png" });
  if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "canceled";
      // Any other refusal (Safari drops the tap permission during a slow capture) falls back to a download.
    }
  }
  download(blob, filename);
  return "downloaded";
}

export const whatsappUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;
