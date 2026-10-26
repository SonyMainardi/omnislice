import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/core/analysis";
import { slugify, uniqueSlugs } from "../src/core/io/names";
import { parseOBJ, writeOBJ } from "../src/core/io/obj";
import { parseSTL, writeSTL } from "../src/core/io/stl";
import { decodePaintState, parse3MF, write3MF } from "../src/core/io/threemf";
import { bedPresets, chooseOrientation, layoutPlates } from "../src/core/layout";
import { type Wasm, getManifold } from "../src/core/manifoldBridge";
import { frameFromNormal, rotationAxisAngle, transformPoint, translation } from "../src/core/math";
import { computeBounds, triCount, weldSoup } from "../src/core/mesh";
import { geometryFromMesh } from "../src/core/part";
import { buildBox, buildSampleFigure } from "../src/core/sample";
import { cutByPlane } from "../src/core/split";

let w: Wasm;
beforeAll(async () => {
  w = await getManifold();
});

describe("arquivos", () => {
  it("STL binário vai e volta", () => {
    const box = buildBox(w, [10, 20, 30]);
    const parsed = parseSTL(writeSTL(box, "caixa").slice().buffer);
    const mesh = weldSoup(parsed.soup);
    expect(triCount(mesh)).toBe(12);
    expect(analyzeMesh(mesh).volume).toBeCloseTo(6000, 2);
  });

  it("lê STL ASCII", () => {
    const text = `solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid t`;
    const parsed = parseSTL(strToU8(text).buffer as ArrayBuffer);
    expect(parsed.soup.length).toBe(9);
  });

  it("OBJ preserva materiais e objetos", () => {
    const text = `o cubo
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
usemtl vermelho
f 1 2 3 4
o outro
usemtl azul
f 1/1/1 3/3/3 4/4/4`;
    const parsed = parseOBJ(text);
    expect(parsed.soup.length / 9).toBe(3);
    expect(parsed.materialNames).toContain("vermelho");
    expect(Array.from(parsed.faceMaterials!)).toEqual([1, 1, 2]);
    expect(parsed.objectNames).toContain("outro");
    const out = writeOBJ([{ name: "x", mesh: buildBox(w, [1, 1, 1]) }]);
    expect(out).toMatch(/^o x$/m);
    expect(parseOBJ(out).soup.length / 9).toBe(12);
  });

  it("3MF com várias peças nomeadas, coloridas e posicionadas", () => {
    const a = buildBox(w, [10, 10, 10]);
    const b = buildBox(w, [5, 5, 5]);
    const bytes = write3MF(
      [
        { name: "cabeça", mesh: a, color: "#ff0000" },
        { name: "tronco & base", mesh: b, color: "#00ff00", transform: translation(50, 0, 0) },
      ],
      "teste",
    );
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]));
    const xml = strFromU8(files["3D/3dmodel.model"]);
    expect(xml).toContain('name="tronco &amp; base"');
    const back = parse3MF(bytes.slice().buffer);
    expect(back.objectNames).toEqual(["cabeça", "tronco & base"]);
    expect(back.soup.length / 9).toBe(24);
    expect(back.faceColors?.[0]).toBe(0xff0000);
    expect(back.faceColors?.[12]).toBe(0x00ff00);
    // A segunda peça foi deslocada 50 mm em X pelo item do build.
    const xs = Array.from(back.soup.filter((_, i) => i % 3 === 0 && i >= 12 * 9));
    expect(Math.min(...xs)).toBeCloseTo(47.5, 3);
  });

  it("decodifica a pintura multicolor do Bambu Studio / PrusaSlicer", () => {
    expect(decodePaintState("")).toBe(0);
    expect(decodePaintState("4")).toBe(1);
    expect(decodePaintState("8")).toBe(2);
    expect(decodePaintState("0C")).toBe(3);
    expect(decodePaintState("1C")).toBe(4);
    // Triângulo dividido em 4 filhos: três com estado 2 e um com estado 1.
    expect(decodePaintState("88843")).toBe(2);
  });

  it("lê 3MF pintado com componentes em arquivos separados", () => {
    const object = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources><object id="1" type="model"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>
</vertices><triangles>
<triangle v1="0" v2="2" v3="1" paint_color="4"/><triangle v1="0" v2="1" v3="3" paint_color="8"/>
<triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3" paint_color="8"/>
</triangles></mesh></object></resources></model>`;
    const root = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
<resources><object id="2" type="model" name="Figura"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object></resources>
<build><item objectid="2"/></build></model>`;
    const bytes = zipSync({
      "3D/3dmodel.model": strToU8(root),
      "3D/Objects/object_1.model": strToU8(object),
      "Metadata/project_settings.config": strToU8(JSON.stringify({ filament_colour: ["#FFFFFF", "#112233"] })),
    });
    const parsed = parse3MF(bytes.slice().buffer);
    expect(parsed.soup.length / 9).toBe(4);
    expect(Array.from(parsed.faceColors!)).toEqual([0xffffff, 0x112233, 0xffffff, 0x112233]);
    expect(parsed.soup[0]).toBe(5);
    expect(parsed.notes.join(" ")).toMatch(/multicolor/);
  });

  it("gera nomes de arquivo organizados", () => {
    expect(slugify("Braço esquerdo")).toBe("braco_esquerdo");
    expect(slugify("Cabeça")).toBe("cabeca");
    expect(uniqueSlugs(["Peça", "peça", "Base"])).toEqual(["peca", "peca_2", "base"]);
  });
});

describe("preparação para impressão", () => {
  it("apoia a peça na face de corte e verifica a mesa", () => {
    const figure = buildSampleFigure(w, 24);
    const frame = frameFromNormal([0, 0, 78], [0, 0, 1]);
    const { front, back } = cutByPlane(w, geometryFromMesh(figure), frame, 1, false);
    // A cabeça (frente) tem a face de corte voltada para −Z: já fica apoiada nela.
    const head = chooseOrientation(front[0], new Set());
    expect(head.reason).toMatch(/face de corte/);
    // Cabeça de z=78 até o topo (z≈104).
    expect(head.size[2]).toBeCloseTo(26, 0);
    // O corpo tem a face de corte no topo: é virado de cabeça para baixo se ela for a maior área plana.
    const body = chooseOrientation(back[0], new Set());
    expect(body.size[2]).toBeGreaterThan(70);
    const bed = bedPresets.find((b) => b.id === "bambu-a1")!.size;
    const { placements, plates } = layoutPlates(
      [
        { id: "cabeca", geometry: front[0], maleTags: new Set() },
        { id: "corpo", geometry: back[0], maleTags: new Set() },
      ],
      bed,
    );
    expect(plates).toBe(1);
    for (const p of placements) {
      expect(p.fits).toBe(true);
      const g = p.id === "cabeca" ? front[0] : back[0];
      const pts: number[] = [];
      for (let i = 0; i < g.mesh.positions.length; i += 3) {
        const q = transformPoint(p.matrix, [g.mesh.positions[i], g.mesh.positions[i + 1], g.mesh.positions[i + 2]]);
        pts.push(...q);
      }
      const b = computeBounds(pts);
      expect(b.min[2]).toBeCloseTo(0, 4);
      expect(b.min[0]).toBeGreaterThanOrEqual(0);
      expect(b.max[0]).toBeLessThanOrEqual(bed[0]);
      expect(b.max[1]).toBeLessThanOrEqual(bed[1]);
    }
  });

  it("respeita a orientação escolhida à mão", () => {
    const g = geometryFromMesh(buildBox(w, [10, 20, 40], false));
    const auto = layoutPlates([{ id: "a", geometry: g, maleTags: new Set() }], [200, 200, 200]);
    expect(auto.placements[0].size[2]).toBeCloseTo(40, 3);
    // Deitada: 90° em X troca a altura de 40 para 20.
    const lying = layoutPlates(
      [{ id: "a", geometry: g, maleTags: new Set(), rotation: rotationAxisAngle([1, 0, 0], 90) }],
      [200, 200, 200],
    );
    expect(lying.placements[0].size[2]).toBeCloseTo(20, 3);
    expect(lying.placements[0].reason).toMatch(/manualmente/);
  });

  it("separa em mesas e marca peças grandes demais", () => {
    const big = geometryFromMesh(buildBox(w, [300, 40, 40]));
    const small = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`,
      geometry: geometryFromMesh(buildBox(w, [60, 60, 20])),
      maleTags: new Set<number>(),
    }));
    const { placements, plates } = layoutPlates(
      [{ id: "grande", geometry: big, maleTags: new Set() }, ...small],
      [180, 180, 180],
    );
    expect(placements.find((p) => p.id === "grande")!.fits).toBe(false);
    expect(plates).toBeGreaterThan(2);
  });
});
