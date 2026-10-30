import { beforeAll, describe, expect, it } from "vitest";
import { paintContext, smartFaces } from "../src/app/painting";
import { getManifold } from "../src/core/manifoldBridge";
import { type IndexedMesh, faceCentroids, triCount } from "../src/core/mesh";
import { buildSampleFigure } from "../src/core/sample";

let figure: IndexedMesh;

beforeAll(async () => {
  figure = buildSampleFigure(await getManifold(), 64);
});

/** Fração da seleção que cai na parte esperada e fração da parte que foi selecionada. */
function overlap(faces: number[], inPart: (f: number) => boolean, n: number) {
  let hit = 0;
  let part = 0;
  for (let f = 0; f < n; f++) if (inPart(f)) part++;
  for (const f of faces) if (inPart(f)) hit++;
  return { precision: hit / faces.length, recall: hit / part };
}

describe("seleção inteligente", () => {
  const extreme = (axis: number, sign: 1 | -1) => {
    const c = faceCentroids(figure);
    let best = 0;
    for (let f = 0; f < triCount(figure); f++) if (sign * c[f * 3 + axis] > sign * c[best * 3 + axis]) best = f;
    return best;
  };

  it("seleciona a cabeça e para no pescoço", () => {
    const c = faceCentroids(figure);
    const faces = smartFaces(paintContext(figure), extreme(2, 1));
    const r = overlap(faces, (f) => c[f * 3 + 2] > 80, triCount(figure));
    expect(r.precision).toBeGreaterThan(0.95);
    expect(r.recall).toBeGreaterThan(0.9);
  });

  it("seleciona a mão e para no pulso", () => {
    const c = faceCentroids(figure);
    const faces = smartFaces(paintContext(figure), extreme(0, -1));
    const r = overlap(faces, (f) => Math.hypot(c[f * 3] + 31.5, c[f * 3 + 1], c[f * 3 + 2] - 44.5) < 5.6, triCount(figure));
    expect(r.precision).toBeGreaterThan(0.95);
    expect(r.recall).toBeGreaterThan(0.9);
  });

  it("seleciona o tronco entre pescoço, ombros e quadril", () => {
    const c = faceCentroids(figure);
    let seed = 0;
    let bd = Infinity;
    for (let f = 0; f < triCount(figure); f++) {
      const d = Math.hypot(c[f * 3], c[f * 3 + 1] + 11, c[f * 3 + 2] - 60);
      if (d < bd) {
        bd = d;
        seed = f;
      }
    }
    const faces = smartFaces(paintContext(figure), seed);
    for (const f of faces) {
      expect(c[f * 3 + 2]).toBeGreaterThan(38);
      expect(c[f * 3 + 2]).toBeLessThan(78);
    }
  });
});
