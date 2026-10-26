/** Paleta de cores distintas para peças e regiões. */
export const PALETTE = [
  "#4f8cff",
  "#ff7a45",
  "#36cfa0",
  "#f5c542",
  "#c06cf0",
  "#ff5d7a",
  "#4dd0e1",
  "#a3d65c",
  "#ff9f1c",
  "#7c8cff",
  "#e66fd2",
  "#2ec4b6",
  "#f28482",
  "#9bb1c8",
  "#d4a373",
  "#84a59d",
];

export const NEUTRAL = "#c9ced6";

export function paletteColor(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/** Próxima cor da paleta ainda não usada. */
export function nextColor(used: string[]): string {
  const set = new Set(used.map((c) => c.toLowerCase()));
  return PALETTE.find((c) => !set.has(c)) ?? paletteColor(used.length);
}

