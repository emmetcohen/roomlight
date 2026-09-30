/**
 * OKLab / OKLCH (Björn Ottosson, 2020) for linear-sRGB pixels. Used by the colour mixer and
 * colour grading because hue and chroma are perceptually uniform there, so rotating hue or
 * scaling chroma does not cause the brightness/saturation drift of HSV/HSL.
 */
import type { Vec3 } from '../color/colorSpace';

const cbrt = (x: number) => Math.sign(x) * Math.pow(Math.abs(x), 1 / 3);

export function linearToOklab(c: Vec3): Vec3 {
  const l = cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  const m = cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  const s = cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToLinear(lab: Vec3): Vec3 {
  const l = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
  const m = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
  const s = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2];
  const l3 = l * l * l, m3 = m * m * m, s3 = s * s * s;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

/** OKLCH (L, chroma, hue in degrees) -> linear sRGB. */
export function oklchToLinear(L: number, C: number, hDeg: number): Vec3 {
  const h = (hDeg * Math.PI) / 180;
  return oklabToLinear([L, C * Math.cos(h), C * Math.sin(h)]);
}
