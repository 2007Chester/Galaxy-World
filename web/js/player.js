import * as THREE from "three";
import { CONST } from "./constants.js";
import { getHeight } from "./world.js";

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.stats = { oxygen: 100, energy: 100, health: 100, temperature: 22 };
    this.keys = new Set();
    this.mineCooldown = 0;
    this.pointerLocked = false;
  }

  spawn() {
    this.position.copy(this.world.spawn);
    this.position.y += 1.2;
    this.velocity.set(0, 0, 0);
    this.stats = { oxygen: 100, energy: 100, health: 100, temperature: 22 };
    this._syncCamera();
  }

  bindInput(dom) {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (["Tab", "Space"].includes(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    dom.addEventListener("click", () => {
      if (!this.pointerLocked) dom.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === dom;
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.pointerLocked) return;
      this.yaw -= e.movementX * CONST.MOUSE_SENS;
      this.pitch -= e.movementY * CONST.MOUSE_SENS;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
    });
  }

  update(delta, canAct) {
    if (!canAct) {
      this._syncCamera();
      return;
    }

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (this.keys.has("KeyW")) wish.add(forward);
    if (this.keys.has("KeyS")) wish.sub(forward);
    if (this.keys.has("KeyD")) wish.add(right);
    if (this.keys.has("KeyA")) wish.sub(right);
    const moving = wish.lengthSq() > 0;
    if (moving) wish.normalize();

    const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const speed = CONST.PLAYER_SPEED * (sprint ? CONST.PLAYER_SPRINT : 1);
    this.velocity.x = wish.x * speed;
    this.velocity.z = wish.z * speed;
    this.velocity.y -= CONST.GRAVITY * delta;

    if (this.keys.has("Space") && this.onGround) {
      this.velocity.y = CONST.JUMP;
      this.onGround = false;
    }

    this.position.x += this.velocity.x * delta;
    this.position.z += this.velocity.z * delta;
    this.position.y += this.velocity.y * delta;

    const ground = getHeight(this.position.x, this.position.z, this.world.seed) + 1.6;
    if (this.position.y <= ground) {
      this.position.y = ground;
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // keep on planet bounds
    const lim = (CONST.PLANET_SIZE * CONST.PLANET_SCALE) / 2 - 2;
    this.position.x = THREE.MathUtils.clamp(this.position.x, -lim, lim);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -lim, lim);

    this.stats.oxygen -= CONST.O2_IDLE * delta;
    this.stats.energy = Math.max(0, this.stats.energy - 0.2 * delta);
    if (moving) {
      this.stats.oxygen -= CONST.O2_MOVE * (sprint ? 1.5 : 1) * delta;
      this.stats.energy -= CONST.ENERGY_MOVE * (sprint ? 1.8 : 1) * delta;
    }
    this.stats.oxygen = Math.max(0, this.stats.oxygen);
    this.stats.energy = Math.max(0, this.stats.energy);
    this.mineCooldown = Math.max(0, this.mineCooldown - delta);
    this._syncCamera();
  }

  applyGeneratorO2(amount) {
    this.stats.oxygen = Math.min(100, this.stats.oxygen + amount);
  }

  spendMining(delta) {
    this.stats.oxygen = Math.max(0, this.stats.oxygen - CONST.O2_MINE * delta);
    this.stats.energy = Math.max(0, this.stats.energy - CONST.ENERGY_MINE * delta);
  }

  isDead() {
    return this.stats.oxygen <= 0 || this.stats.health <= 0;
  }

  lookRay(length = 6) {
    const dir = new THREE.Vector3(0, 0, -1)
      .applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"))
      .normalize();
    const origin = this.camera.position.clone();
    return { origin, dir, far: length };
  }

  _syncCamera() {
    this.camera.position.copy(this.position);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }
}
