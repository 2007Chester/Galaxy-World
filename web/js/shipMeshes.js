import * as THREE from "three";

/**
 * Modern light scout craft — sleek hull, canopy, delta wings, twin thrusters.
 * Nose points toward -Z (Three.js look direction).
 */
export function buildShipVisual() {
  const root = new THREE.Group();

  const hull = new THREE.MeshPhysicalMaterial({
    color: 0xc5d0dc,
    metalness: 0.92,
    roughness: 0.22,
    clearcoat: 0.65,
    clearcoatRoughness: 0.18,
    envMapIntensity: 1.35,
  });
  const dark = new THREE.MeshPhysicalMaterial({
    color: 0x2a323c,
    metalness: 0.88,
    roughness: 0.32,
    clearcoat: 0.25,
    envMapIntensity: 1.1,
  });
  const accent = new THREE.MeshPhysicalMaterial({
    color: 0x3d8bfd,
    metalness: 0.7,
    roughness: 0.28,
    emissive: 0x1a4a9a,
    emissiveIntensity: 0.35,
    envMapIntensity: 1.2,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x7ee8ff,
    metalness: 0.05,
    roughness: 0.04,
    transmission: 0.72,
    thickness: 0.55,
    transparent: true,
    opacity: 0.88,
    emissive: 0x33aacc,
    emissiveIntensity: 0.28,
    envMapIntensity: 1.6,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });
  const glow = new THREE.MeshStandardMaterial({
    color: 0x66eeff,
    emissive: 0x44ddff,
    emissiveIntensity: 2.4,
    roughness: 0.35,
    metalness: 0.1,
  });
  const thrusterCore = new THREE.MeshStandardMaterial({
    color: 0xffaa66,
    emissive: 0xff6622,
    emissiveIntensity: 3.2,
    roughness: 0.4,
    metalness: 0.05,
  });

  // Main fuselage — tapered capsule silhouette
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 2.8, 8, 16), hull);
  body.rotation.x = Math.PI / 2;
  body.position.set(0, 0.95, 0.15);
  body.scale.set(1.15, 1, 0.92);
  root.add(body);

  // Lower belly plate
  const belly = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.22, 3.4), dark);
  belly.position.set(0, 0.55, 0.2);
  belly.scale.set(1, 1, 1);
  root.add(belly);

  // Nose cone
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.48, 1.35, 14), hull);
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 0.92, -2.05);
  nose.scale.set(1.05, 1, 0.85);
  root.add(nose);

  // Cockpit canopy bubble
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.62, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62), glass);
  canopy.position.set(0, 1.28, -0.85);
  canopy.scale.set(0.95, 0.72, 1.15);
  root.add(canopy);

  // Canopy frame ring
  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.035, 8, 24), dark);
  frame.rotation.x = Math.PI / 2.4;
  frame.position.set(0, 1.15, -0.55);
  frame.scale.set(1.05, 1.2, 1);
  root.add(frame);

  // Delta wings
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0);
  wingShape.lineTo(2.4, 0.55);
  wingShape.lineTo(2.55, 0.15);
  wingShape.lineTo(0.35, -1.1);
  wingShape.lineTo(0, -0.9);
  wingShape.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, {
    depth: 0.08,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 2,
  });
  wingGeo.rotateX(-Math.PI / 2);
  wingGeo.rotateY(Math.PI / 2);

  const wingL = new THREE.Mesh(wingGeo, dark);
  wingL.position.set(-0.35, 0.72, 0.35);
  wingL.scale.set(1, 1, 0.95);
  root.add(wingL);

  const wingR = wingL.clone();
  wingR.scale.x = -1;
  wingR.position.x = 0.35;
  root.add(wingR);

  // Wing accent strips
  for (const side of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 1.8), accent);
    strip.position.set(side * 1.55, 0.78, 0.15);
    strip.rotation.y = side * 0.18;
    root.add(strip);
  }

  // Vertical stabilizer
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.95, 1.1), dark);
  fin.position.set(0, 1.55, 1.55);
  fin.rotation.x = -0.15;
  root.add(fin);
  const finTip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 1.15), accent);
  finTip.position.set(0, 2.05, 1.5);
  root.add(finTip);

  // Twin nacelles + thrusters
  for (const side of [-1, 1]) {
    const nacelle = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 1.6, 12), hull);
    nacelle.rotation.x = Math.PI / 2;
    nacelle.position.set(side * 0.72, 0.7, 1.55);
    root.add(nacelle);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.04, 8, 18), accent);
    ring.position.set(side * 0.72, 0.7, 2.35);
    root.add(ring);

    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.35, 12), dark);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(side * 0.72, 0.7, 2.45);
    root.add(nozzle);

    const core = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), thrusterCore);
    core.position.set(side * 0.72, 0.7, 2.55);
    core.scale.set(1, 1, 1.4);
    root.add(core);

    // Soft engine light
    const light = new THREE.PointLight(0xff7733, 0.85, 8, 2);
    light.position.set(side * 0.72, 0.7, 2.7);
    root.add(light);
  }

  // Intake scoops under nose
  for (const side of [-1, 1]) {
    const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.7), dark);
    scoop.position.set(side * 0.42, 0.62, -1.35);
    scoop.rotation.x = 0.2;
    root.add(scoop);
  }

  // Hull panel lines
  for (let i = 0; i < 3; i++) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.02, 0.04), accent);
    line.position.set(0, 1.22, -0.2 + i * 0.55);
    root.add(line);
  }

  // Nav lights
  const navL = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), glow);
  navL.position.set(-2.35, 0.82, 0.5);
  root.add(navL);
  const navR = navL.clone();
  navR.material = new THREE.MeshStandardMaterial({
    color: 0xff5566,
    emissive: 0xff2233,
    emissiveIntensity: 2.2,
    roughness: 0.4,
  });
  navR.position.x = 2.35;
  root.add(navR);

  // Landing skids
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.55, 6), dark);
    leg.position.set(side * 0.55, 0.28, 0.3);
    root.add(leg);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.06, 0.7), dark);
    pad.position.set(side * 0.55, 0.04, 0.3);
    root.add(pad);
  }
  const noseLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.45, 6), dark);
  noseLeg.position.set(0, 0.28, -1.4);
  root.add(noseLeg);
  const nosePad = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.4), dark);
  nosePad.position.set(0, 0.04, -1.4);
  root.add(nosePad);

  // Sensor / antenna
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.55, 6), dark);
  mast.position.set(0.25, 1.75, 0.2);
  root.add(mast);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), accent);
  dish.position.set(0.25, 2.05, 0.2);
  root.add(dish);

  // Cockpit interior glow hint
  const dash = new THREE.PointLight(0x66ddff, 0.4, 4, 2);
  dash.position.set(0, 1.1, -0.9);
  root.add(dash);

  root.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });

  return root;
}
