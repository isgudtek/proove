/**
 * specimen.js: live 3D preview of an artifact. Procedural geometry only (no external 3D assets), seeded per item.
 * Three.js r187 loads from jsDelivr as ES modules.
 */
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.187.0/+esm";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/controls/OrbitControls.js/+esm";

function seeded(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function createSpecimenViewer(container, { background = 0x101418 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(3.2, 2.2, 3.6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.4;
  controls.minDistance = 2.5;
  controls.maxDistance = 9;
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1410, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(4, 6, 3);
  key.castShadow = true;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 1.2);
  rim.position.set(-4, 2, -3);
  scene.add(rim);
  // pedestal
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.45, 0.25, 64), new THREE.MeshStandardMaterial({ color: 0x1d232b, roughness: 0.4, metalness: 0.3 }));
  ped.position.y = -0.95;
  ped.receiveShadow = true;
  scene.add(ped);
  let group = null;

  const resize = () => { const w = container.clientWidth || 400, h = container.clientHeight || 300; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  function rock(R, { radius = 1, rough = 0.18, color = 0x3a3632, metal = 0.55, dents = 7 } = {}) {
    const g = new THREE.IcosahedronGeometry(radius, 5);
    const p = g.attributes.position, v = new THREE.Vector3();
    const centers = Array.from({ length: dents }, () => new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).normalize());
    const sx = 0.8 + R() * 0.5, sy = 0.6 + R() * 0.3, sz = 0.7 + R() * 0.4;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = v.clone().normalize();
      let d = 1 + rough * (Math.sin(n.x * 5 + R() * 0.01) * Math.cos(n.y * 4) * 0.5 + Math.sin(n.z * 7) * 0.3);
      for (const c of centers) { const dot = n.dot(c); if (dot > 0.9) d -= (dot - 0.9) * 1.4; } // regmaglypts (thumbprints)
      v.copy(n).multiplyScalar(radius * d);
      p.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: metal, flatShading: false }));
    m.castShadow = true;
    return m;
  }

  const builders = {
    meteorite: (R) => rock(R, { color: 0x2e2b28, metal: 0.65, dents: 9 }),
    pallasite: (R) => {
      const g = new THREE.Group();
      const slab = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.12, 9, 1), new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.95, roughness: 0.22 }));
      slab.rotation.x = Math.PI / 2.4; slab.castShadow = true; g.add(slab);
      for (let i = 0; i < 26; i++) {
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.09 + R() * 0.08, 0), new THREE.MeshPhysicalMaterial({ color: 0xc7b83c, transmission: 0.6, roughness: 0.1, thickness: 0.3, emissive: 0x2a2400 }));
        const a = R() * Math.PI * 2, rr = Math.sqrt(R()) * 0.95;
        gem.position.set(Math.cos(a) * rr, Math.sin(a) * rr * 0.4, 0.07);
        slab.add(gem);
      }
      return g;
    },
    crystal: (R) => {
      const g = new THREE.Group();
      const base = rock(R, { radius: 0.55, color: 0x4a3c38, metal: 0.1 });
      base.position.y = -0.4; g.add(base);
      const hue = R() < 0.5 ? 0xd95a7a : 0x5a7ad9;
      for (let i = 0; i < 9; i++) {
        const h = 0.6 + R() * 1.0;
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.12 + R() * 0.1, h, 6), new THREE.MeshPhysicalMaterial({ color: hue, transmission: 0.55, roughness: 0.08, thickness: 0.4, emissive: hue, emissiveIntensity: 0.08 }));
        c.position.set((R() - 0.5) * 0.7, -0.2 + h / 2, (R() - 0.5) * 0.7);
        c.rotation.set((R() - 0.5) * 0.7, R() * 3, (R() - 0.5) * 0.7);
        c.castShadow = true;
        g.add(c);
      }
      return g;
    },
    nugget: (R) => rock(R, { radius: 0.85, rough: 0.35, color: 0xd9a21b, metal: 1, dents: 4 }),
    coin: (R) => {
      const g = new THREE.Group();
      const gold = new THREE.MeshStandardMaterial({ color: 0xd4a73a, metalness: 1, roughness: 0.28 });
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.1, 96), gold);
      disc.rotation.x = Math.PI / 2.6; disc.castShadow = true; g.add(disc);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.88, 0.035, 12, 96), gold);
      ring.position.y = 0.055; disc.add(ring);
      const star = new THREE.Mesh(new THREE.TorusKnotGeometry(0.28, 0.06, 80, 8, 2, 5), gold);
      star.position.y = 0.06; star.scale.set(1, 1, 0.25); star.rotation.x = Math.PI / 2; disc.add(star);
      return g;
    },
    artwork: (R) => {
      const g = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.4, 0.08), new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.6 }));
      frame.castShadow = true; g.add(frame);
      const cv = document.createElement("canvas"); cv.width = 256; cv.height = 192;
      const x = cv.getContext("2d");
      x.fillStyle = "#efe6d4"; x.fillRect(0, 0, 256, 192);
      for (let i = 0; i < 14; i++) { x.fillStyle = `hsla(${Math.floor(R() * 360)},55%,${35 + R() * 30}%,0.75)`; x.beginPath(); x.arc(R() * 256, R() * 192, 10 + R() * 50, 0, Math.PI * 2); x.fill(); }
      const art = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.2), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(cv), roughness: 0.9 }));
      art.position.z = 0.045; g.add(art);
      g.position.y = 0.1;
      return g;
    },
    document: (R) => {
      const g = new THREE.Group();
      const geo = new THREE.PlaneGeometry(1.5, 1.9, 24, 24);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) { const y = p.getY(i), xx = p.getX(i); p.setZ(i, Math.sin(xx * 2.2) * 0.05 + (y > 0.8 ? (y - 0.8) * 0.6 : 0) + (R() - 0.5) * 0.01); }
      geo.computeVertexNormals();
      const cv = document.createElement("canvas"); cv.width = 192; cv.height = 256;
      const x = cv.getContext("2d");
      x.fillStyle = "#d9c79c"; x.fillRect(0, 0, 192, 256);
      x.strokeStyle = "rgba(60,40,20,.55)";
      for (let l = 30; l < 240; l += 11) { x.beginPath(); x.moveTo(16, l); for (let c = 16; c < 176; c += 8) x.lineTo(c, l + (R() - 0.5) * 3); x.stroke(); }
      const sheet = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(cv), side: THREE.DoubleSide, roughness: 0.95 }));
      sheet.rotation.x = -0.35; sheet.castShadow = true; g.add(sheet);
      return g;
    },
  };

  function show(item) {
    if (group) { group.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose?.(); }); scene.remove(group); }
    const R = seeded(item.id || item.title);
    group = (builders[item.shape] || builders.meteorite)(R);
    // grams set a gentle size cue for physical specimens
    if (item.measure > 1 && ["meteorite", "nugget", "crystal"].includes(item.shape)) group.scale.setScalar(0.75 + Math.min(1, Math.log10(item.measure) / 2.4) * 0.35);
    scene.add(group);
  }

  let raf = 0;
  const tick = () => { raf = requestAnimationFrame(tick); controls.update(); renderer.render(scene, camera); };
  tick();
  return {
    show,
    setAutoRotate: (v) => { controls.autoRotate = !!v; },
    dispose: () => { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); renderer.domElement.remove(); },
  };
}
