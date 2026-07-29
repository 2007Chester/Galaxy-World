import * as THREE from "three";
import { ItemId } from "./constants.js";

function gloveMat(color = 0xc5d4e8) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.15,
  });
}

function darkMat(color = 0x3a4a5c) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.7,
    metalness: 0.25,
  });
}

function makeHand(side = 1) {
  const g = new THREE.Group();
  const skin = gloveMat();
  const cuff = darkMat(0x2a3648);

  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.22), skin);
  palm.position.set(0, 0, 0);
  g.add(palm);

  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.14, 8), cuff);
  wrist.rotation.x = Math.PI / 2;
  wrist.position.set(0, 0, 0.16);
  g.add(wrist);

  const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.35), cuff);
  forearm.position.set(0, 0.02, 0.38);
  g.add(forearm);

  // Fingers
  for (let i = 0; i < 4; i++) {
    const finger = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.035, 0.1),
      skin
    );
    finger.position.set((-0.05 + i * 0.035) * side, -0.01, -0.14);
    finger.rotation.x = -0.25;
    g.add(finger);
  }
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, 0.08), skin);
  thumb.position.set(0.09 * side, 0.01, -0.04);
  thumb.rotation.y = side * 0.6;
  thumb.rotation.x = -0.4;
  g.add(thumb);

  g.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = false;
      c.frustumCulled = false;
    }
  });
  return g;
}

function makeToolMesh(itemId) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.9 });
  const metal = new THREE.MeshStandardMaterial({
    color: 0x9aa4b0,
    metalness: 0.7,
    roughness: 0.35,
  });
  const clay = new THREE.MeshStandardMaterial({ color: 0xb87333, roughness: 1 });

  if (itemId === ItemId.AXE) {
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.45, 6), wood);
    handle.position.y = 0.15;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.04), metal);
    head.position.set(0.05, 0.36, 0);
    g.add(handle, head);
  } else if (itemId === ItemId.SHOVEL) {
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.48, 6), wood);
    handle.position.y = 0.16;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.16), metal);
    blade.position.set(0, 0.4, 0.02);
    g.add(handle, blade);
  } else if (itemId === ItemId.PICKAXE) {
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.45, 6), wood);
    handle.position.y = 0.15;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.05), metal);
    head.position.set(0, 0.36, 0);
    g.add(handle, head);
  } else if (itemId === ItemId.KNIFE) {
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.12), wood);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.01, 0.18), metal);
    blade.position.z = -0.14;
    g.add(handle, blade);
  } else if (itemId === ItemId.BUCKET) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.14, 10), clay);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.01, 6, 12, Math.PI), wood);
    handle.rotation.x = Math.PI / 2;
    handle.position.y = 0.08;
    g.add(body, handle);
  } else if (itemId === ItemId.FISHING_ROD) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.72, 6), wood);
    pole.position.set(0.05, 0.28, -0.05);
    pole.rotation.z = -0.35;
    pole.rotation.x = 0.2;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.015, 6, 4), metal);
    tip.position.set(0.18, 0.58, -0.12);
    const line = new THREE.Mesh(
      new THREE.CylinderGeometry(0.003, 0.003, 0.28, 4),
      new THREE.MeshStandardMaterial({ color: 0xdde8f0, roughness: 0.6 })
    );
    line.position.set(0.18, 0.42, -0.12);
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.006, 4, 8, Math.PI), metal);
    hook.position.set(0.18, 0.28, -0.12);
    hook.rotation.x = Math.PI / 2;
    g.add(pole, tip, line, hook);
  } else {
    return null;
  }

  g.traverse((c) => {
    if (c.isMesh) c.frustumCulled = false;
  });
  return g;
}

/**
 * First-person suit hands attached to the camera.
 */
export class ViewHands {
  constructor(camera) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.name = "view-hands";
    camera.add(this.root);

    this.left = makeHand(-1);
    this.right = makeHand(1);
    this.left.position.set(-0.28, -0.28, -0.45);
    this.right.position.set(0.3, -0.3, -0.48);
    this.left.rotation.set(0.35, 0.15, 0.2);
    this.right.rotation.set(0.4, -0.2, -0.25);
    this.root.add(this.left, this.right);

    this.baseLeft = this.left.position.clone();
    this.baseRight = this.right.position.clone();
    this.baseLeftRot = this.left.rotation.clone();
    this.baseRightRot = this.right.rotation.clone();

    this.toolSlot = new THREE.Group();
    this.toolSlot.position.set(0.02, 0.05, -0.12);
    this.right.add(this.toolSlot);
    this.currentTool = -1;
    this.toolMesh = null;

    this.swing = 0;
    this.swinging = false;
    this.bob = 0;
    this.visible = true;
  }

  setVisible(on) {
    this.visible = on;
    this.root.visible = on;
  }

  setTool(itemId) {
    if (itemId === this.currentTool) return;
    this.currentTool = itemId;
    while (this.toolSlot.children.length) {
      this.toolSlot.remove(this.toolSlot.children[0]);
    }
    this.toolMesh = null;
    if (itemId < 0) return;
    const mesh = makeToolMesh(itemId);
    if (!mesh) return;
    mesh.rotation.set(-0.4, 0.2, 0.3);
    this.toolSlot.add(mesh);
    this.toolMesh = mesh;
  }

  punch() {
    this.swing = 1;
    this.swinging = true;
  }

  update(delta, { moving = false, sprint = false, mining = false, flying = false } = {}) {
    if (!this.visible || flying) {
      this.root.visible = !flying && this.visible;
      return;
    }
    this.root.visible = true;

    if (moving) {
      this.bob += delta * (sprint ? 11 : 8);
    } else {
      this.bob *= Math.pow(0.001, delta);
    }

    const bobY = Math.sin(this.bob) * 0.018;
    const bobX = Math.cos(this.bob * 0.5) * 0.012;

    if (this.swinging) {
      this.swing = Math.max(0, this.swing - delta * 4.5);
      if (this.swing <= 0) this.swinging = false;
    }
    const punch = this.swinging ? Math.sin((1 - this.swing) * Math.PI) : 0;
    const mineIdle = mining ? 0.04 : 0;

    this.left.position.set(
      this.baseLeft.x + bobX,
      this.baseLeft.y + bobY,
      this.baseLeft.z
    );
    this.right.position.set(
      this.baseRight.x - bobX,
      this.baseRight.y + bobY + punch * 0.08,
      this.baseRight.z - punch * 0.22 - mineIdle
    );

    this.left.rotation.set(
      this.baseLeftRot.x + bobY * 2,
      this.baseLeftRot.y,
      this.baseLeftRot.z
    );
    this.right.rotation.set(
      this.baseRightRot.x - punch * 1.1,
      this.baseRightRot.y + punch * 0.3,
      this.baseRightRot.z - punch * 0.4
    );
  }
}
