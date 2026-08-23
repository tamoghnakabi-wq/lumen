/**
 * Generative artwork used to seed the demo with real image files.
 * Everything is produced locally as SVG and rasterised by sharp — no network,
 * no bundled binaries, and every image is deterministic for a given seed.
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Palette = { name: string; sky: string[]; blobs: string[]; ground: string };

export const PALETTES: Palette[] = [
  { name: "dusk", sky: ["#2b1055", "#7597de"], blobs: ["#ff8a5c", "#ffd36e", "#c04fd4"], ground: "#170a2e" },
  { name: "ocean", sky: ["#012d4a", "#2ba0b5"], blobs: ["#7ef0d0", "#0f6fa8", "#c9f7ff"], ground: "#01131f" },
  { name: "forest", sky: ["#0b3d2e", "#8fd39a"], blobs: ["#f2e8a2", "#2f7d5c", "#d7f5b8"], ground: "#05231a" },
  { name: "desert", sky: ["#7a2f1d", "#f4a259"], blobs: ["#ffe0b5", "#c8553d", "#f9d371"], ground: "#3b1a10" },
  { name: "city", sky: ["#101426", "#4b5d9e"], blobs: ["#ff5f7e", "#ffc46b", "#6ee7ff"], ground: "#070912" },
  { name: "bloom", sky: ["#4a1042", "#e28ec4"], blobs: ["#ffd1e8", "#a63f8f", "#ffe9a8"], ground: "#280a24" },
  { name: "arctic", sky: ["#1b3b5a", "#a8d8ea"], blobs: ["#ffffff", "#5fa8d3", "#dff6ff"], ground: "#0d2233" },
  { name: "ember", sky: ["#1a0a0a", "#c1440e"], blobs: ["#ffb347", "#ff6b35", "#4a1c14"], ground: "#0d0505" },
];

type Scene = "peaks" | "waves" | "skyline" | "arches" | "dunes" | "grove";
const SCENES: Scene[] = ["peaks", "waves", "skyline", "arches", "dunes", "grove"];

function silhouette(scene: Scene, w: number, h: number, rand: () => number, color: string): string {
  const baseY = h * (0.6 + rand() * 0.15);
  switch (scene) {
    case "peaks": {
      const pts: string[] = [`0,${h}`, `0,${baseY}`];
      let x = 0;
      while (x < w) {
        const step = w * (0.12 + rand() * 0.16);
        const peak = baseY - h * (0.08 + rand() * 0.28);
        pts.push(`${(x + step / 2).toFixed(0)},${peak.toFixed(0)}`);
        x += step;
        pts.push(`${Math.min(x, w).toFixed(0)},${(baseY - h * rand() * 0.05).toFixed(0)}`);
      }
      pts.push(`${w},${h}`);
      return `<polygon points="${pts.join(" ")}" fill="${color}" opacity="0.92"/>`;
    }
    case "waves": {
      let out = "";
      for (let i = 0; i < 4; i++) {
        const y = baseY + i * h * 0.08;
        const amp = h * (0.03 + rand() * 0.04);
        const d = `M0,${y} Q${w * 0.25},${y - amp} ${w * 0.5},${y} T${w},${y} L${w},${h} L0,${h} Z`;
        out += `<path d="${d}" fill="${color}" opacity="${(0.35 + i * 0.2).toFixed(2)}"/>`;
      }
      return out;
    }
    case "skyline": {
      let out = `<rect x="0" y="${baseY}" width="${w}" height="${h - baseY}" fill="${color}"/>`;
      let x = -20;
      while (x < w) {
        const bw = w * (0.06 + rand() * 0.09);
        const bh = h * (0.08 + rand() * 0.32);
        out += `<rect x="${x.toFixed(0)}" y="${(baseY - bh).toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" fill="${color}"/>`;
        // lit windows
        const cols = Math.max(1, Math.floor(bw / 26));
        const rows = Math.max(1, Math.floor(bh / 34));
        for (let c = 0; c < cols; c++) {
          for (let r = 0; r < rows; r++) {
            if (rand() > 0.62) {
              out += `<rect x="${(x + 10 + c * 26).toFixed(0)}" y="${(baseY - bh + 14 + r * 34).toFixed(0)}" width="8" height="12" fill="#ffd97d" opacity="${(0.35 + rand() * 0.5).toFixed(2)}"/>`;
            }
          }
        }
        x += bw + w * 0.012;
      }
      return out;
    }
    case "arches": {
      let out = `<rect x="0" y="${baseY}" width="${w}" height="${h - baseY}" fill="${color}" opacity="0.9"/>`;
      const count = 3 + Math.floor(rand() * 3);
      for (let i = 0; i < count; i++) {
        const cx = (w / count) * (i + 0.5);
        const rx = (w / count) * 0.32;
        const ry = h * (0.12 + rand() * 0.14);
        out += `<path d="M${cx - rx},${baseY} a${rx},${ry} 0 0 1 ${rx * 2},0 z" fill="${color}" opacity="0.85"/>`;
      }
      return out;
    }
    case "dunes": {
      let out = "";
      for (let i = 0; i < 3; i++) {
        const y = baseY + i * h * 0.1;
        const cx = w * (0.2 + rand() * 0.6);
        out += `<path d="M0,${h} L0,${y} Q${cx},${y - h * 0.14} ${w},${y - h * 0.02} L${w},${h} Z" fill="${color}" opacity="${(0.4 + i * 0.22).toFixed(2)}"/>`;
      }
      return out;
    }
    case "grove": {
      let out = `<rect x="0" y="${baseY + h * 0.12}" width="${w}" height="${h}" fill="${color}" opacity="0.85"/>`;
      const count = 5 + Math.floor(rand() * 5);
      for (let i = 0; i < count; i++) {
        const x = (w / count) * (i + 0.3 + rand() * 0.4);
        const tw = w * 0.012;
        const top = baseY - h * (0.05 + rand() * 0.3);
        out += `<rect x="${x.toFixed(0)}" y="${top.toFixed(0)}" width="${tw.toFixed(0)}" height="${(h - top).toFixed(0)}" fill="${color}" opacity="0.9"/>`;
        out += `<ellipse cx="${(x + tw / 2).toFixed(0)}" cy="${top.toFixed(0)}" rx="${(w * 0.05).toFixed(0)}" ry="${(h * 0.045).toFixed(0)}" fill="${color}" opacity="0.75"/>`;
      }
      return out;
    }
  }
}

export function artworkSvg(seed: number, width = 1200, height = 1500): string {
  const rand = mulberry32(seed);
  const palette = PALETTES[Math.floor(rand() * PALETTES.length)];
  const scene = SCENES[Math.floor(rand() * SCENES.length)];

  const blobs = Array.from({ length: 3 + Math.floor(rand() * 3) }, () => {
    const cx = rand() * width;
    const cy = rand() * height * 0.75;
    const r = (0.18 + rand() * 0.3) * Math.min(width, height);
    const fill = palette.blobs[Math.floor(rand() * palette.blobs.length)];
    return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" fill="${fill}" opacity="${(0.3 + rand() * 0.4).toFixed(2)}"/>`;
  }).join("");

  const sunY = height * (0.18 + rand() * 0.3);
  const sun = `<circle cx="${(width * (0.2 + rand() * 0.6)).toFixed(0)}" cy="${sunY.toFixed(0)}" r="${(Math.min(width, height) * 0.09).toFixed(0)}" fill="#fff6d8" opacity="0.85"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0%" stop-color="${palette.sky[0]}"/>
      <stop offset="100%" stop-color="${palette.sky[1]}"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="${(Math.min(width, height) * 0.07).toFixed(0)}"/>
    </filter>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <linearGradient id="vig" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0.25"/>
      <stop offset="45%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.35"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  ${sun}
  <g filter="url(#soft)">${blobs}</g>
  ${silhouette(scene, width, height, rand, palette.ground)}
  <rect width="${width}" height="${height}" fill="url(#vig)"/>
  <rect width="${width}" height="${height}" filter="url(#grain)" opacity="0.06"/>
</svg>`;
}

/** Circular monogram avatar. */
export function avatarSvg(seed: number, initials: string, size = 512): string {
  const rand = mulberry32(seed + 991);
  const palette = PALETTES[Math.floor(rand() * PALETTES.length)];
  const a = palette.blobs[Math.floor(rand() * palette.blobs.length)];
  const b = palette.sky[Math.floor(rand() * palette.sky.length)];
  const angle = Math.floor(rand() * 360);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)">
      <stop offset="0%" stop-color="${a}"/>
      <stop offset="100%" stop-color="${b}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#g)"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="${size * 0.4}" font-weight="600"
        fill="#ffffff" fill-opacity="0.92">${initials.toUpperCase()}</text>
</svg>`;
}
