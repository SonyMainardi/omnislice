import type { Manifold } from "manifold-3d";
import { Arena, type Wasm } from "./manifoldBridge";
import type { Vec3 } from "./math";
import type { IndexedMesh } from "./mesh";

/**
 * Boneco de exemplo (~100 mm) em pose "A", com base redonda. Todas as partes são fundidas em uma
 * única casca estanque, como acontece com figuras geradas por IA, o que torna a divisão não trivial.
 */
export function buildSampleFigure(w: Wasm, detail = 40): IndexedMesh {
  const { Manifold } = w;
  const arena = new Arena();
  try {
    const sphere = (c: Vec3, r: number) => arena.track(Manifold.sphere(r, detail).translate(c));
    const capsule = (a: Vec3, b: Vec3, r: number) => arena.track(Manifold.hull([sphere(a, r), sphere(b, r)]));
    const ellipsoid = (c: Vec3, r: Vec3) =>
      arena.track(Manifold.sphere(1, detail).scale(r).translate(c));

    const parts: Manifold[] = [
      // Base com borda levemente chanfrada.
      arena.track(Manifold.cylinder(5, 28, 26, detail * 2)),
      arena.track(Manifold.cylinder(1.5, 26, 26, detail * 2).translate([0, 0, 4.9])),
      // Pernas e pés.
      capsule([-8, 0, 9], [-9, 0, 42], 6.2),
      capsule([8, 0, 9], [9, 0, 42], 6.2),
      ellipsoid([-8.5, -3, 8.5], [6, 9, 3.6]),
      ellipsoid([8.5, -3, 8.5], [6, 9, 3.6]),
      // Tronco: quadril e peito unidos por um envoltório convexo.
      arena.track(
        Manifold.hull([ellipsoid([0, 0, 47], [15, 10, 8]), ellipsoid([0, 0, 66], [17, 11, 10])]),
      ),
      // Pescoço e cabeça.
      arena.track(Manifold.cylinder(9, 5, 5, detail).translate([0, 0, 74])),
      ellipsoid([0, 0, 92], [10.5, 11, 12]),
      // Braços em "A" e mãos.
      capsule([-15, 0, 70], [-30, 0, 47], 4.6),
      capsule([15, 0, 70], [30, 0, 47], 4.6),
      sphere([-31.5, 0, 44.5], 5.4),
      sphere([31.5, 0, 44.5], 5.4),
    ];
    const body = arena.track(Manifold.union(parts));
    const mesh = body.getMesh();
    return { positions: Float32Array.from(mesh.vertProperties), indices: Uint32Array.from(mesh.triVerts) };
  } finally {
    arena.dispose();
  }
}

/** Cubo simples para testes. */
export function buildBox(w: Wasm, size: Vec3, center = true): IndexedMesh {
  const m = w.Manifold.cube(size, center);
  try {
    const mesh = m.getMesh();
    return { positions: Float32Array.from(mesh.vertProperties), indices: Uint32Array.from(mesh.triVerts) };
  } finally {
    m.delete();
  }
}
