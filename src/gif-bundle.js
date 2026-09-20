import omggif from "omggif";
import { GIFEncoder, quantize, applyPalette } from "gifenc/dist/gifenc.esm.js";

if (typeof window !== "undefined") {
  window.GifReader = omggif.GifReader;
  window.GIFEncoder = GIFEncoder;
  window.quantize = quantize;
  window.applyPalette = applyPalette;
}

export { omggif, GIFEncoder, quantize, applyPalette };
