/** "Braço esquerdo" → "braco_esquerdo" (seguro para nomes de arquivo). */
export function slugify(name: string, fallback = "peca"): string {
  const s = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || fallback;
}

/** Garante nomes únicos acrescentando _2, _3… */
export function uniqueSlugs(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((n) => {
    const base = slugify(n);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

export function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}
