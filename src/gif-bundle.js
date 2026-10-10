import omggif from "omggif";
import { GIFEncoder, quantize, applyPalette, snapColorsToPalette, prequantize } from "gifenc/dist/gifenc.esm.js";

if (typeof window !== "undefined") {
  window.GifReader = omggif.GifReader;
  window.GIFEncoder = GIFEncoder;
  window.quantize = quantize;
  window.applyPalette = applyPalette;
  window.snapColorsToPalette = snapColorsToPalette;
  window.prequantize = prequantize;
}

export { omggif, GIFEncoder, quantize, applyPalette, snapColorsToPalette, prequantize };
