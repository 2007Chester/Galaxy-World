import * as THREE from "three";

export class ParticleBurst {
  constructor(scene) {
    this.scene = scene;
    this.particles = [];
  }

  spawn(position, color = 0xaabbcc, count = 12) {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = [];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = position.z;
      velocities.push(
        new THREE.Vector3(
          (Math.random() - 0.5) * 4,
          Math.random() * 3 + 1,
          (Math.random() - 0.5) * 4
        )
      );
    }
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color,
      size: 0.18,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.particles.push({ points, velocities, life: 0.55, maxLife: 0.55 });
  }

  update(delta) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= delta;
      if (p.life <= 0) {
        this.scene.remove(p.points);
        p.points.geometry.dispose();
        p.points.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      const pos = p.points.geometry.attributes.position;
      for (let j = 0; j < p.velocities.length; j++) {
        p.velocities[j].y -= 9 * delta;
        pos.setXYZ(
          j,
          pos.getX(j) + p.velocities[j].x * delta,
          pos.getY(j) + p.velocities[j].y * delta,
          pos.getZ(j) + p.velocities[j].z * delta
        );
      }
      pos.needsUpdate = true;
      p.points.material.opacity = p.life / p.maxLife;
    }
  }
}

export class CameraShake {
  constructor() {
    this.intensity = 0;
    this.offset = new THREE.Vector3();
  }

  add(amount) {
    this.intensity = Math.min(0.35, this.intensity + amount);
  }

  update(delta) {
    if (this.intensity <= 0.001) {
      this.offset.set(0, 0, 0);
      this.intensity = 0;
      return;
    }
    this.intensity *= Math.pow(0.05, delta);
    this.offset.set(
      (Math.random() - 0.5) * this.intensity,
      (Math.random() - 0.5) * this.intensity * 0.6,
      (Math.random() - 0.5) * this.intensity * 0.3
    );
  }
}
