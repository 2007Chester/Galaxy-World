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
    this.wasOnGround = true;
    this.o2Capacity = CONST.BASE_O2_CAPACITY;
    this.stats = {
      oxygen: CONST.BASE_O2_CAPACITY,
      energy: 100,
      health: 100,
      temperature: 22,
      hunger: 100,
      thirst: 100,
    };
    this.keys = new Set();
    this.mineCooldown = 0;
    this.pointerLocked = false;
    this.walkPhase = 0;
    this.footstepTimer = 0;
    this.targetFov = 75;
    this.onFootstep = null;
    this.flying = false;
  }

  spawn(at = null) {
    if (at) this.position.copy(at);
    else {
      this.position.copy(this.world.spawn);
      this.position.y += 1.2;
    }
    this.velocity.set(0, 0, 0);
    this.stats.oxygen = this.o2Capacity;
    this.stats.energy = 100;
    this.stats.health = 100;
    this.stats.hunger = 100;
    this.stats.thirst = 100;
    this.flying = false;
    this._syncCamera();
  }

  setOxygenCapacity(cap) {
    this.o2Capacity = cap;
    this.stats.oxygen = Math.min(this.stats.oxygen, cap);
  }

  bindInput(dom) {
    if (this._inputBound) return;
    this._inputBound = true;
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (["Tab", "Space"].includes(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    dom.addEventListener("click", () => {
      if (document.body.classList.contains("ui-open")) return;
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

    if (this.flying) {
      this._updateFlight(delta);
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
    this.targetFov = sprint && moving ? 82 : 75;

    const accel = 14;
    this.velocity.x = THREE.MathUtils.damp(this.velocity.x, wish.x * speed, accel, delta);
    this.velocity.z = THREE.MathUtils.damp(this.velocity.z, wish.z * speed, accel, delta);
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
    this.wasOnGround = this.onGround;

    if (moving && this.onGround) {
      this.walkPhase += delta * (sprint ? 11 : 8);
      this.footstepTimer -= delta;
      if (this.footstepTimer <= 0) {
        this.footstepTimer = sprint ? 0.28 : 0.42;
        this.onFootstep?.();
      }
    } else {
      this.walkPhase *= Math.pow(0.001, delta);
    }

    this.stats.oxygen -= CONST.O2_IDLE * delta;
    this.stats.hunger = Math.max(0, this.stats.hunger - CONST.HUNGER_DRAIN * delta);
    this.stats.thirst = Math.max(0, this.stats.thirst - CONST.THIRST_DRAIN * delta);
    this.stats.energy = Math.max(0, this.stats.energy - 0.15 * delta);
    if (moving) {
      this.stats.oxygen -= CONST.O2_MOVE * (sprint ? 1.5 : 1) * delta;
      this.stats.energy -= CONST.ENERGY_MOVE * (sprint ? 1.8 : 1) * delta;
    }
    if (this.stats.hunger <= 0 || this.stats.thirst <= 0) {
      this.stats.health -= 4 * delta;
    }
    this.stats.oxygen = Math.max(0, Math.min(this.o2Capacity, this.stats.oxygen));
    this.stats.health = Math.max(0, this.stats.health);
    this.mineCooldown = Math.max(0, this.mineCooldown - delta);

    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, this.targetFov, 6, delta);
    this.camera.updateProjectionMatrix();
    this._syncCamera();
  }

  _updateFlight(delta) {
    const forward = new THREE.Vector3(0, 0, -1).applyEuler(
      new THREE.Euler(this.pitch, this.yaw, 0, "YXZ")
    );
    let boost = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 48 : 22;
    if (this.keys.has("KeyW")) this.position.addScaledVector(forward, boost * delta);
    if (this.keys.has("KeyS")) this.position.addScaledVector(forward, -boost * 0.6 * delta);
    if (this.keys.has("Space")) this.position.y += 18 * delta;
    if (this.keys.has("ControlLeft") || this.keys.has("KeyC")) this.position.y -= 18 * delta;
    this.stats.oxygen -= CONST.O2_IDLE * 0.3 * delta;
    this.stats.oxygen = Math.max(0, this.stats.oxygen);
    this.targetFov = 90;
    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, this.targetFov, 4, delta);
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(this.position);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  getBobOffset() {
    if (this.flying) return new THREE.Vector3();
    return new THREE.Vector3(
      Math.cos(this.walkPhase * 0.5) * 0.03,
      Math.sin(this.walkPhase) * 0.06,
      0
    );
  }

  applyGeneratorO2(amount) {
    this.stats.oxygen = Math.min(this.o2Capacity, this.stats.oxygen + amount);
  }

  eat() {
    this.stats.hunger = Math.min(100, this.stats.hunger + CONST.FOOD_RESTORE);
  }

  drink() {
    this.stats.thirst = Math.min(100, this.stats.thirst + CONST.WATER_RESTORE);
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
    return { origin: this.camera.position.clone(), dir, far: length };
  }

  _syncCamera() {
    this.camera.position.copy(this.position).add(this.getBobOffset());
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }
}
