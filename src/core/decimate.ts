import type { Wasm } from "./manifoldBridge";
import { type IndexedMesh, computeBounds, triCount } from "./mesh";

/**
 * Versão simplificada de uma malha fechada (Manifold.simplify), com no máximo `target` triângulos
 * quando possível. Devolve null se a malha não for um sólido válido.
 */
export function decimateManifold(w: Wasm, mesh: IndexedMesh, target: number): IndexedMesh | null {
  if (triCount(mesh) <= target) return mesh;
  let solid;
  try {
    solid = new w.Manifold(new w.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  } catch {
    return null;
  }
  try {
    const b = computeBounds(mesh.positions);
    const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    let tol = diag * 0.0003;
    let simple = solid.simplify(tol);
    while (simple.numTri() > target && tol < diag * 0.02) {
      simple.delete();
      tol *= 1.6;
      simple = solid.simplify(tol);
    }
    const out = simple.getMesh();
    simple.delete();
    return { positions: Float32Array.from(out.vertProperties), indices: Uint32Array.from(out.triVerts) };
  } finally {
    solid.delete();
  }
}
