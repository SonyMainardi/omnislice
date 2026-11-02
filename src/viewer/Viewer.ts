import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ConnectorPlan } from "../core/connectors";
import type { Mat4, PlaneFrame, Vec3 } from "../core/math";
import { toSoup } from "../core/mesh";
import { CONNECTOR_TAG, type PartGeometry, tagCutId } from "../core/part";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface ViewerPart {
  id: string;
  color: string;
  visible: boolean;
  geometry: PartGeometry;
}

export interface PickHit {
  partId: string;
  face: number;
  point: Vec3;
  normal: Vec3;
  viewDir: Vec3;
}

export interface ViewerCallbacks {
  onPointer?: (phase: "down" | "move" | "up", hit: PickHit | null, ev: PointerEvent) => void;
  onPlaneChange?: (frame: PlaneFrame) => void;
  onPartClick?: (partId: string | null) => void;
}

interface PartView {
  part: ViewerPart;
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  colors: THREE.BufferAttribute;
  uniforms: { uPlane: { value: THREE.Vector4 }; uPlaneOn: { value: number }; uLine: { value: number } };
  center: THREE.Vector3;
  connectors: THREE.Group;
}

export type PaintTool = "orbitar" | "pincel" | "borracha" | "inteligente" | "balde" | "casca" | "atributo" | "plano";

const tmpColor = new THREE.Color();

function frameFromObject(obj: THREE.Object3D): PlaneFrame {
  obj.updateMatrixWorld();
  const e = obj.matrixWorld.elements;
  const u = new THREE.Vector3(e[0], e[1], e[2]).normalize();
  const v = new THREE.Vector3(e[4], e[5], e[6]).normalize();
  const n = new THREE.Vector3(e[8], e[9], e[10]).normalize();
  return { origin: [e[12], e[13], e[14]], normal: n.toArray() as Vec3, u: u.toArray() as Vec3, v: v.toArray() as Vec3 };
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private transform: TransformControls;
  private views = new Map<string, PartView>();
  private root = new THREE.Group();
  private bedGroup = new THREE.Group();
  private planeObject = new THREE.Group();
  private planeTarget: string | null = null;
  private cursor: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private needsRender = true;
  private disposed = false;
  private tool: PaintTool = "orbitar";
  private brushRadius = 4;
  private explode = 0;
  private layout: { matrices: Map<string, Mat4>; plates: number; bed: Vec3 } | null = null;
  private bed: Vec3 = [256, 256, 256];
  private modelCenter = new THREE.Vector3();
  private modelRadius = 50;
  private pointerDown = false;
  private highlightCut: number | null = null;
  private resizeObserver: ResizeObserver;

  constructor(
    private container: HTMLElement,
    private callbacks: ViewerCallbacks = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0d1117, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = "none";

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 20000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(180, -260, 180);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener("change", () => this.invalidate());

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2f3a, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, -1.5, 2.5);
    this.camera.add(key);
    const fill = new THREE.DirectionalLight(0x9fb8ff, 0.7);
    fill.position.set(-2, 1, -1);
    this.camera.add(fill);
    this.scene.add(this.camera);
    this.scene.add(this.root, this.bedGroup);

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(0.9);
    this.transform.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
    });
    this.transform.addEventListener("objectChange", () => {
      this.callbacks.onPlaneChange?.(frameFromObject(this.planeObject));
      this.updatePlaneUniforms();
      this.invalidate();
    });
    this.transform.addEventListener("change", () => this.invalidate());
    this.scene.add(this.transform.getHelper());

    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.88, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }),
    );
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    this.buildBed();
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointerleave", () => {
      this.cursor.visible = false;
      this.invalidate();
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.applyToolMouseButtons();
    const loop = () => {
      if (this.disposed) return;
      requestAnimationFrame(loop);
      const moved = this.controls.update();
      if (moved || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  invalidate() {
    this.needsRender = true;
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    window.removeEventListener("pointerup", this.onPointerUp);
    for (const v of this.views.values()) this.disposeView(v);
    this.transform.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  // -----------------------------------------------------------------------------------------
  // Peças
  // -----------------------------------------------------------------------------------------

  setParts(parts: ViewerPart[]) {
    const keep = new Set(parts.map((p) => p.id));
    for (const [id, v] of this.views)
      if (!keep.has(id)) {
        this.disposeView(v);
        this.views.delete(id);
      }
    for (const p of parts) {
      const existing = this.views.get(p.id);
      if (existing && existing.part.geometry === p.geometry) {
        const colorChanged = existing.part.color !== p.color;
        existing.part = p;
        existing.group.visible = p.visible;
        if (colorChanged) this.paintPartColors(existing);
        continue;
      }
      if (existing) {
        this.disposeView(existing);
        this.views.delete(p.id);
      }
      this.views.set(p.id, this.createView(p));
    }
    this.updateModelBounds();
    this.applyPlacement();
    this.invalidate();
  }

  private createView(part: ViewerPart): PartView {
    const soup = toSoup(part.geometry.mesh);
    let geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(soup, 3));
    geom = toCreasedNormals(geom, (35 * Math.PI) / 180);
    const colors = new THREE.BufferAttribute(new Uint8Array(soup.length), 3, true);
    geom.setAttribute("color", colors);
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    geom.computeBoundsTree({ indirect: true });
    const uniforms = {
      uPlane: { value: new THREE.Vector4(0, 0, 1, 0) },
      uPlaneOn: { value: 0 },
      uLine: { value: 0.3 },
    };
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.04 });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;")
        .replace("#include <fog_vertex>", "#include <fog_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vWorldPos;\nuniform vec4 uPlane;\nuniform float uPlaneOn;\nuniform float uLine;",
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          if (uPlaneOn > 0.5) {
            float d = dot(uPlane.xyz, vWorldPos) - uPlane.w;
            diffuseColor.rgb = mix(diffuseColor.rgb, d > 0.0 ? vec3(0.30, 0.55, 1.0) : vec3(1.0, 0.50, 0.25), 0.55);
            if (abs(d) < uLine) diffuseColor.rgb = vec3(1.0);
          }`,
        );
    };
    const mesh = new THREE.Mesh(geom, material);
    mesh.userData.partId = part.id;
    const group = new THREE.Group();
    group.add(mesh);
    const connectors = new THREE.Group();
    group.add(connectors);
    group.visible = part.visible;
    this.root.add(group);
    const bb = geom.boundingBox!;
    const view: PartView = { part, group, mesh, colors, uniforms, center: bb.getCenter(new THREE.Vector3()), connectors };
    this.paintPartColors(view);
    return view;
  }

  private disposeView(v: PartView) {
    this.root.remove(v.group);
    v.mesh.geometry.disposeBoundsTree();
    v.mesh.geometry.dispose();
    v.mesh.material.dispose();
    this.clearConnectorMeshes(v);
  }

  /** Cores por peça: faces de corte um pouco mais escuras, encaixes em destaque. */
  private paintPartColors(v: PartView) {
    const base = new THREE.Color(v.part.color);
    const cutColor = base.clone().multiplyScalar(0.72);
    const highlight = new THREE.Color("#ffd166");
    const connector = new THREE.Color("#e8ecf2");
    const arr = v.colors.array as Uint8Array;
    const cut = v.part.geometry.cut;
    for (let f = 0; f < cut.length; f++) {
      const t = cut[f];
      const c = t === CONNECTOR_TAG ? connector : t >= 0 ? (this.highlightCut !== null && tagCutId(t) === this.highlightCut ? highlight : cutColor) : base;
      const r = Math.round(c.r * 255);
      const g = Math.round(c.g * 255);
      const b = Math.round(c.b * 255);
      for (let k = 0; k < 3; k++) {
        arr[f * 9 + k * 3] = r;
        arr[f * 9 + k * 3 + 1] = g;
        arr[f * 9 + k * 3 + 2] = b;
      }
    }
    v.colors.needsUpdate = true;
    this.invalidate();
  }

  /** Mostra a pintura de regiões de uma peça (null volta às cores das peças). */
  setRegionColors(partId: string | null, labels: Uint16Array | null, colors: string[], faces?: number[]) {
    for (const v of this.views.values()) {
      if (v.part.id !== partId || !labels) {
        if (v.mesh.userData.regionMode) {
          v.mesh.userData.regionMode = false;
          this.paintPartColors(v);
        }
        continue;
      }
      v.mesh.userData.regionMode = true;
      const arr = v.colors.array as Uint8Array;
      const rgb = colors.map((c) => {
        tmpColor.set(c);
        return [Math.round(tmpColor.r * 255), Math.round(tmpColor.g * 255), Math.round(tmpColor.b * 255)];
      });
      const paint = (f: number) => {
        const c = rgb[labels[f]] ?? [200, 200, 200];
        for (let k = 0; k < 3; k++) {
          arr[f * 9 + k * 3] = c[0];
          arr[f * 9 + k * 3 + 1] = c[1];
          arr[f * 9 + k * 3 + 2] = c[2];
        }
      };
      if (faces) for (const f of faces) paint(f);
      else for (let f = 0; f < labels.length; f++) paint(f);
      v.colors.needsUpdate = true;
    }
    this.invalidate();
  }

  setHighlightCut(cutId: number | null) {
    if (this.highlightCut === cutId) return;
    this.highlightCut = cutId;
    for (const v of this.views.values()) if (!v.mesh.userData.regionMode) this.paintPartColors(v);
  }

  setSelected(partId: string | null) {
    for (const v of this.views.values()) v.mesh.material.emissive.set(v.part.id === partId ? 0x1c2433 : 0x000000);
    this.invalidate();
  }

  setWireframe(on: boolean) {
    for (const v of this.views.values()) v.mesh.material.wireframe = on;
    this.invalidate();
  }

  setDimmed(partIds: Set<string> | null) {
    for (const v of this.views.values()) {
      const dim = partIds ? !partIds.has(v.part.id) : false;
      v.mesh.material.transparent = dim;
      v.mesh.material.opacity = dim ? 0.18 : 1;
      v.mesh.material.depthWrite = !dim;
    }
    this.invalidate();
  }

  // -----------------------------------------------------------------------------------------
  // Posicionamento: montado, explodido ou distribuído nas mesas
  // -----------------------------------------------------------------------------------------

  setExplode(t: number) {
    this.explode = t;
    this.applyPlacement();
  }

  setLayout(layout: { matrices: Map<string, Mat4>; plates: number; bed: Vec3 } | null) {
    this.layout = layout;
    this.buildBed();
    this.applyPlacement();
  }

  setBed(bed: Vec3) {
    this.bed = bed;
    this.buildBed();
  }

  private updateModelBounds() {
    const box = new THREE.Box3();
    for (const v of this.views.values()) box.union(v.mesh.geometry.boundingBox!);
    if (box.isEmpty()) return;
    box.getCenter(this.modelCenter);
    this.modelRadius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
  }

  private applyPlacement() {
    for (const v of this.views.values()) {
      const m = this.layout?.matrices.get(v.part.id);
      if (this.layout && m) {
        v.group.matrixAutoUpdate = false;
        v.group.matrix.fromArray(m);
        v.group.matrixWorldNeedsUpdate = true;
        v.connectors.visible = false;
      } else if (this.layout) {
        v.group.matrixAutoUpdate = false;
        v.group.matrix.makeScale(0, 0, 0);
        v.group.matrixWorldNeedsUpdate = true;
      } else {
        v.group.matrixAutoUpdate = true;
        const dir = v.center.clone().sub(this.modelCenter);
        v.group.position.copy(dir.multiplyScalar(this.explode * 1.1));
        v.connectors.visible = true;
      }
    }
    this.updatePlaneUniforms();
    this.invalidate();
  }

  private buildBed() {
    this.bedGroup.clear();
    const plates = this.layout ? this.layout.plates : 1;
    const bed = this.layout ? this.layout.bed : this.bed;
    const gap = 30;
    for (let i = 0; i < plates; i++) {
      const ox = this.layout ? i * (bed[0] + gap) : -bed[0] / 2;
      const oy = this.layout ? 0 : -bed[1] / 2;
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(bed[0], bed[1]),
        new THREE.MeshBasicMaterial({ color: 0x161b24, transparent: true, opacity: 0.92, depthWrite: false }),
      );
      plate.position.set(ox + bed[0] / 2, oy + bed[1] / 2, -0.05);
      plate.renderOrder = -1;
      this.bedGroup.add(plate);
      const pts: number[] = [];
      const step = 10;
      for (let x = 0; x <= bed[0] + 1e-6; x += step) pts.push(ox + x, oy, 0, ox + x, oy + bed[1], 0);
      for (let y = 0; y <= bed[1] + 1e-6; y += step) pts.push(ox, oy + y, 0, ox + bed[0], oy + y, 0);
      const grid = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)),
        new THREE.LineBasicMaterial({ color: 0x2a3342 }),
      );
      this.bedGroup.add(grid);
      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.Float32BufferAttribute([ox, oy, 0, ox + bed[0], oy, 0, ox + bed[0], oy + bed[1], 0, ox, oy + bed[1], 0], 3),
        ),
        new THREE.LineBasicMaterial({ color: 0x4f8cff }),
      );
      this.bedGroup.add(border);
    }
    this.invalidate();
  }

  // -----------------------------------------------------------------------------------------
  // Câmera
  // -----------------------------------------------------------------------------------------

  fit(view: "iso" | "frente" | "topo" | "lado" = "iso") {
    const box = new THREE.Box3();
    for (const v of this.views.values()) if (v.group.visible) box.expandByObject(v.group);
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 100));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 5);
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.05;
    const dirs = {
      iso: new THREE.Vector3(0.55, -0.75, 0.45),
      frente: new THREE.Vector3(0, -1, 0.05),
      topo: new THREE.Vector3(0, -0.02, 1),
      lado: new THREE.Vector3(1, 0, 0.05),
    };
    const d = dirs[view].normalize();
    this.camera.position.copy(center).addScaledVector(d, dist);
    this.camera.near = Math.max(dist / 1000, 0.05);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.invalidate();
  }

  // -----------------------------------------------------------------------------------------
  // Ferramentas e seleção
  // -----------------------------------------------------------------------------------------

  setTool(tool: PaintTool, brushRadius: number) {
    this.tool = tool;
    this.brushRadius = brushRadius;
    this.applyToolMouseButtons();
    if (tool === "orbitar" || tool === "plano") this.cursor.visible = false;
    this.invalidate();
  }

  private applyToolMouseButtons() {
    const painting = this.tool !== "orbitar" && this.tool !== "plano";
    // Ao pintar, o botão esquerdo pinta; o direito gira e o do meio move a vista.
    this.controls.mouseButtons = painting
      ? { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  }

  pick(ev: PointerEvent, onlyPart?: string | null): PickHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.firstHitOnly = true;
    const targets: THREE.Object3D[] = [];
    for (const v of this.views.values())
      if (v.group.visible && (!onlyPart || v.part.id === onlyPart) && !v.mesh.material.transparent) targets.push(v.mesh);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null;
    const mesh = hit.object as THREE.Mesh;
    // Converte para coordenadas do modelo (desfaz a explosão/posicionamento do grupo).
    const inv = mesh.parent!.matrixWorld.clone().invert();
    const local = hit.point.clone().applyMatrix4(inv);
    const normal = hit.face!.normal.clone();
    const viewDir = this.raycaster.ray.direction.clone().transformDirection(inv);
    return {
      partId: mesh.userData.partId as string,
      face: hit.faceIndex,
      point: local.toArray() as Vec3,
      normal: normal.toArray() as Vec3,
      viewDir: viewDir.toArray() as Vec3,
    };
  }

  private paintTarget: string | null = null;
  /** Limita o pincel a uma peça (a que está sendo pintada). */
  setPaintTarget(partId: string | null) {
    this.paintTarget = partId;
  }

  private onPointerDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    this.pointerDown = true;
    const painting = this.tool !== "orbitar" && this.tool !== "plano";
    const hit = this.pick(ev, painting ? this.paintTarget : null);
    if (this.tool === "orbitar") this.downAt = [ev.clientX, ev.clientY];
    this.callbacks.onPointer?.("down", hit, ev);
  };

  private downAt: [number, number] | null = null;

  private onPointerMove = (ev: PointerEvent) => {
    const painting = this.tool !== "orbitar" && this.tool !== "plano";
    if (!painting) return;
    const hit = this.pick(ev, this.paintTarget);
    this.updateCursor(hit);
    if (this.pointerDown) this.callbacks.onPointer?.("move", hit, ev);
  };

  private onPointerUp = (ev: PointerEvent) => {
    if (!this.pointerDown) return;
    this.pointerDown = false;
    if (this.tool === "orbitar" && this.downAt) {
      const moved = Math.hypot(ev.clientX - this.downAt[0], ev.clientY - this.downAt[1]);
      this.downAt = null;
      if (moved < 4 && ev.target === this.renderer.domElement) {
        const hit = this.pick(ev);
        this.callbacks.onPartClick?.(hit?.partId ?? null);
      }
    }
    this.callbacks.onPointer?.("up", null, ev);
  };

  private updateCursor(hit: PickHit | null) {
    const showRing = hit && (this.tool === "pincel" || this.tool === "borracha");
    if (!showRing || !hit) {
      if (this.cursor.visible) {
        this.cursor.visible = false;
        this.invalidate();
      }
      return;
    }
    const v = this.views.get(hit.partId);
    const p = new THREE.Vector3(...hit.point);
    if (v) p.applyMatrix4(v.group.matrixWorld);
    const n = new THREE.Vector3(...hit.normal).normalize();
    this.cursor.position.copy(p).addScaledVector(n, 0.05);
    this.cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.cursor.scale.setScalar(this.brushRadius);
    this.cursor.visible = true;
    this.invalidate();
  }

  // -----------------------------------------------------------------------------------------
  // Plano de corte
  // -----------------------------------------------------------------------------------------

  /** Mostra (ou esconde) o plano de corte sobre uma peça, com alças para mover e girar. */
  setPlane(frame: PlaneFrame | null, partId: string | null, mode: "translate" | "rotate" = "translate") {
    this.planeTarget = frame ? partId : null;
    if (!frame) {
      this.transform.detach();
      this.planeObject.removeFromParent();
      this.updatePlaneUniforms();
      this.invalidate();
      return;
    }
    if (!this.planeObject.parent) {
      this.planeObject.clear();
      const size = this.modelRadius * 2.4;
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
      );
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)),
        new THREE.LineBasicMaterial({ color: 0x8fb4ff }),
      );
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), this.modelRadius * 0.5, 0x4f8cff);
      this.planeObject.add(quad, edge, arrow);
      this.scene.add(this.planeObject);
    }
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...frame.u),
      new THREE.Vector3(...frame.v),
      new THREE.Vector3(...frame.normal),
    );
    basis.setPosition(new THREE.Vector3(...frame.origin));
    // O plano está em coordenadas do modelo: acompanha o deslocamento da peça na vista.
    const v = partId ? this.views.get(partId) : undefined;
    if (v) basis.premultiply(v.group.matrixWorld);
    basis.decompose(this.planeObject.position, this.planeObject.quaternion, this.planeObject.scale);
    this.transform.attach(this.planeObject);
    this.transform.setMode(mode);
    this.transform.setSpace("local");
    this.updatePlaneUniforms();
    this.invalidate();
  }

  setPlaneMode(mode: "translate" | "rotate") {
    this.transform.setMode(mode);
    this.invalidate();
  }

  private updatePlaneUniforms() {
    for (const v of this.views.values()) {
      const on = this.planeTarget === v.part.id && !!this.planeObject.parent;
      v.uniforms.uPlaneOn.value = on ? 1 : 0;
      if (!on) continue;
      const f = frameFromObject(this.planeObject);
      const n = new THREE.Vector3(...f.normal);
      const o = new THREE.Vector3(...f.origin);
      v.uniforms.uPlane.value.set(n.x, n.y, n.z, n.dot(o));
      v.uniforms.uLine.value = Math.max(this.modelRadius * 0.004, 0.08);
    }
  }

  /** Converte um referencial do mundo da vista para coordenadas do modelo da peça. */
  toPartFrame(frame: PlaneFrame, partId: string): PlaneFrame {
    const v = this.views.get(partId);
    if (!v) return frame;
    const inv = v.group.matrixWorld.clone().invert();
    const o = new THREE.Vector3(...frame.origin).applyMatrix4(inv);
    const n = new THREE.Vector3(...frame.normal).transformDirection(inv);
    const u = new THREE.Vector3(...frame.u).transformDirection(inv);
    const vv = new THREE.Vector3(...frame.v).transformDirection(inv);
    return { origin: o.toArray() as Vec3, normal: n.toArray() as Vec3, u: u.toArray() as Vec3, v: vv.toArray() as Vec3 };
  }

  // -----------------------------------------------------------------------------------------
  // Prévia de encaixes
  // -----------------------------------------------------------------------------------------

  private clearConnectorMeshes(v: PartView) {
    for (const child of [...v.connectors.children]) {
      v.connectors.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
  }

  setConnectorPreview(plans: { plan: ConnectorPlan; front: string; back: string }[], selected: string | null) {
    for (const v of this.views.values()) this.clearConnectorMeshes(v);
    for (const { plan, front, back } of plans) {
      if (!plan.points.length) continue;
      const active = selected === null || plan.interfaceId === selected;
      const male = plan.maleSide === "front" ? front : back;
      const female = plan.maleSide === "front" ? back : front;
      const n = new THREE.Vector3(...plan.frame.normal);
      const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...plan.frame.u), new THREE.Vector3(...plan.frame.v), n);
      for (const p of plan.points) {
        const origin = new THREE.Vector3(...plan.frame.origin)
          .addScaledVector(new THREE.Vector3(...plan.frame.u), p[0])
          .addScaledVector(new THREE.Vector3(...plan.frame.v), p[1]);
        const add = (partId: string, color: number, radius: number, z0: number, z1: number, opacity: number) => {
          const view = this.views.get(partId);
          if (!view) return;
          const h = Math.abs(z1 - z0);
          const geom =
            plan.kind === "square"
              ? new THREE.BoxGeometry(radius * 2, radius * 2, h)
              : new THREE.CylinderGeometry(radius, radius, h, plan.kind === "hex" ? 6 : 32).rotateX(Math.PI / 2);
          const mesh = new THREE.Mesh(
            geom,
            new THREE.MeshStandardMaterial({
              color,
              transparent: opacity < 1,
              opacity: active ? opacity : opacity * 0.35,
              depthTest: opacity >= 1,
              roughness: 0.4,
            }),
          );
          mesh.renderOrder = opacity < 1 ? 5 : 0;
          const m = basis.clone().setPosition(origin);
          mesh.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, (z0 + z1) / 2));
          mesh.applyMatrix4(m);
          view.connectors.add(mesh);
        };
        const r = plan.size / 2;
        if (plan.kind === "socket" && plan.profile) {
          // Plugue e rebaixo com o formato do corte, extrudados ao longo da normal.
          const dir = plan.maleSide === "front" ? -1 : 1;
          const addShape = (partId: string, color: number, z1: number, opacity: number) => {
            const view = this.views.get(partId);
            if (!view) return;
            const geom = new THREE.ExtrudeGeometry(profileShapes(plan.profile!), { depth: Math.abs(z1), bevelEnabled: false });
            if (z1 < 0) geom.translate(0, 0, z1);
            const mesh = new THREE.Mesh(
              geom,
              new THREE.MeshStandardMaterial({
                color,
                transparent: opacity < 1,
                opacity: active ? opacity : opacity * 0.35,
                depthTest: opacity >= 1,
                roughness: 0.4,
                side: THREE.DoubleSide,
              }),
            );
            mesh.renderOrder = opacity < 1 ? 5 : 0;
            mesh.applyMatrix4(basis.clone().setPosition(origin));
            view.connectors.add(mesh);
          };
          addShape(male, 0x36cfa0, dir * plan.length, 1);
          addShape(female, 0xff5d7a, dir * (plan.length + 0.4), 0.45);
          continue;
        }
        if (plan.kind === "dowel" && plan.dowelDepths) {
          add(front, 0xffd166, r, -plan.dowelDepths[1], plan.dowelDepths[0], 1);
        } else if (plan.kind === "magnet") {
          add(front, 0xc06cf0, r + plan.clearance, 0, plan.length + 0.2, 0.75);
          add(back, 0xc06cf0, r + plan.clearance, -(plan.length + 0.2), 0, 0.75);
        } else {
          const dir = plan.maleSide === "front" ? -1 : 1;
          add(male, 0x36cfa0, r, 0, dir * plan.length, 1);
          add(female, 0xff5d7a, r + plan.clearance, 0, dir * (plan.length + 0.4), 0.45);
        }
      }
    }
    this.invalidate();
  }
}

/** Contornos de um encaixe (externos anti-horários, furos horários) como formas do three.js. */
function profileShapes(polys: [number, number][][]): THREE.Shape[] {
  const area = (p: [number, number][]) => {
    let a = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
    return a / 2;
  };
  const inside = (pt: [number, number], poly: [number, number][]) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
      if (poly[i][1] > pt[1] !== poly[j][1] > pt[1] && pt[0] < ((poly[j][0] - poly[i][0]) * (pt[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
    return c;
  };
  // O maior contorno é sempre externo: o sinal dele define o sentido dos externos.
  const sign = Math.sign(polys.reduce((best, p) => (Math.abs(area(p)) > Math.abs(best) ? area(p) : best), 0)) || 1;
  const outers = polys.filter((p) => area(p) * sign > 0);
  const shapes = outers.map((p) => new THREE.Shape(p.map(([x, y]) => new THREE.Vector2(x, y))));
  for (const hole of polys.filter((p) => area(p) * sign < 0)) {
    const k = outers.findIndex((o) => inside(hole[0], o));
    if (k >= 0) shapes[k].holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
  }
  return shapes;
}
