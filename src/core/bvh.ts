import { Box3, BufferAttribute, BufferGeometry, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";
import { trianglesCross } from "./intersect";
import { type IndexedMesh, computeBounds, triCount } from "./mesh";

/** BVH indireto: não reordena os índices, então os números das faces continuam válidos. */
export function buildBVH(mesh: IndexedMesh): MeshBVH {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices.slice(), 1));
  return new MeshBVH(geometry, { indirect: true });
}

/** Distância tratada como zero: o passo de arredondamento das coordenadas em float32. */
export function roundingTolerance(mesh: IndexedMesh): number {
  const b = computeBounds(mesh.positions);
  const reach = Math.max(1, ...b.min.map(Math.abs), ...b.max.map(Math.abs));
  return reach * 4e-7;
}

/**
 * Pares de triângulos que realmente se cruzam (até `limit`). Vizinhos por aresta não contam;
 * encostar num ponto ou ao longo de uma aresta também não (ver `trianglesCross`).
 */
export function findSelfIntersections(
  mesh: IndexedMesh,
  limit = 1000,
  eps = roundingTolerance(mesh),
  /** Só considera os pares que passam no filtro (ex.: os que envolvem uma face nova). */
  filter?: (i: number, j: number) => boolean,
  /** Só testa estas faces (contra a malha toda), com uma BVH já construída sobre `mesh`. */
  local?: { faces: Iterable<number>; bvh: MeshBVH },
): [number, number][] {
  const n = triCount(mesh);
  const bvh = local?.bvh ?? buildBVH(mesh);
  const idx = mesh.indices;
  const p = mesh.positions;
  const box = new Box3();
  const v = new Vector3();
  const pairs: [number, number][] = [];
  const seen = new Set<number>();
  const test = (i: number) => {
    const a = idx[i * 3];
    const b = idx[i * 3 + 1];
    const c = idx[i * 3 + 2];
    box.makeEmpty();
    for (const k of [a, b, c]) box.expandByPoint(v.set(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]));
    box.expandByScalar(eps);
    bvh.shapecast({
      intersectsBounds: (bounds) => bounds.intersectsBox(box),
      intersectsTriangle: (_other, j) => {
        if (local ? j === i : j <= i) return false;
        const x = idx[j * 3];
        const y = idx[j * 3 + 1];
        const z = idx[j * 3 + 2];
        let shared = 0;
        for (const s of [x, y, z]) if (s === a || s === b || s === c) shared++;
        if (shared >= 2) return false;
        if (filter && !filter(i, j)) return false;
        if (!trianglesCross(p, [a, b, c], p, [x, y, z], eps)) return false;
        const lo = Math.min(i, j);
        const key = lo * n + Math.max(i, j);
        if (seen.has(key)) return false;
        seen.add(key);
        pairs.push([lo, Math.max(i, j)]);
        return pairs.length >= limit;
      },
    });
  };
  if (local) {
    for (const i of local.faces) {
      test(i);
      if (pairs.length >= limit) break;
    }
  } else {
    for (let i = 0; i < n && pairs.length < limit; i++) test(i);
    bvh.geometry.dispose();
  }
  return pairs;
}

/** Quantos pares de triângulos se cruzam (para no limite). */
export function countSelfIntersections(
  mesh: IndexedMesh,
  limit = 1000,
  eps = roundingTolerance(mesh),
  filter?: (i: number, j: number) => boolean,
): number {
  return findSelfIntersections(mesh, limit, eps, filter).length;
}
