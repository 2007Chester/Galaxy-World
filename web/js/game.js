import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import {
  BuildingId,
  CONST,
  EVA_MESSAGES,
  ITEM_COLORS,
  ITEM_NAMES,
  RECIPES,
} from "./constants.js";
import { GameAudio } from "./audio.js";
import { Crafting } from "./crafting.js";
import { CameraShake, ParticleBurst } from "./effects.js";
import { Inventory } from "./inventory.js";
import { Player } from "./player.js";
import { UI } from "./ui.js";
import { World } from "./world.js";

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ui = new UI();
    this.audio = new GameAudio();
    this.inventory = new Inventory();
    this.crafting = new Crafting(this.inventory);
    this.playing = false;
    this.buildMode = false;
    this.selectedBuilding = BuildingId.FOUNDATION;
    this.triggers = { mine: false, craft: false, build: false };
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.mouse = { down: false };
    this.shake = new CameraShake();
    this.particles = null;
    this.miningTarget = null;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1628);
    this.scene.fog = new THREE.Fog(0x0a1628, 40, 140);

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      300
    );

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.35,
      0.55,
      0.82
    );
    this.composer.addPass(this.bloomPass);

    this.world = null;
    this.player = null;
    this.preview = null;

    this._bindUI();
    window.addEventListener("resize", () => this._onResize());
    window.addEventListener("keydown", (e) => this._onKey(e));
    window.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouse.down = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouse.down = false;
    });
  }

  _bindUI() {
    document.getElementById("btn-start").addEventListener("click", () => this.start());
    document.getElementById("btn-menu").addEventListener("click", () => this.toMenu());
    document.getElementById("btn-craft").addEventListener("click", () => this._craftSelected());
    this.ui.setBuildHandler((id) => {
      this.selectedBuilding = id;
      this.ui.setBuildActive(id);
      this._refreshPreview();
    });
    this.inventory.onChange(() => this.ui.updateInventory(this.inventory));
  }

  start() {
    if (this.world) this.world.dispose();
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview = null;
    }

    const seed = (Math.random() * 1e9) | 0;
    this.world = new World(this.scene, seed);
    this.world.build();
    this.particles = new ParticleBurst(this.scene);
    this.player = new Player(this.camera, this.world);
    this.player.bindInput(this.canvas);
    this.player.onFootstep = () => {
      if (this.player.pointerLocked) this.audio.playFootstep();
    };
    this.player.spawn();
    this.inventory.reset();
    this.triggers = { mine: false, craft: false, build: false };
    this.buildMode = false;
    this.miningTarget = null;
    this.playing = true;
    this.ui.showGame();
    this.ui.toggleBuild(false);
    this.ui.toggleInventory(false);
    this.ui.toggleCraft(false);
    this.ui.updateInventory(this.inventory);
    this.ui.showEva(EVA_MESSAGES.start);
    this.audio.startAmbience();
    this.canvas.requestPointerLock?.();
  }

  toMenu() {
    this.playing = false;
    this.buildMode = false;
    this.miningTarget = null;
    document.exitPointerLock?.();
    this.audio.stopAmbience();
    this.ui.showMenu();
  }

  update() {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.ui.update(delta);
    this.shake.update(delta);
    this.particles?.update(delta);

    if (!this.playing || !this.player || !this.world) {
      this.composer.render();
      return;
    }

    const blocked = this.ui.isOverlayOpen() && !this.ui.buildModeOpen();
    this.player.update(delta, !blocked || this.ui.buildModeOpen());
    this.world.updateDayNight(this.clock.elapsedTime);
    this._applyGeneratorBuff(delta);
    this.ui.updateStats(this.player.stats);
    this._applyCameraShake();

    if (this.player.isDead()) {
      this.player.spawn();
      this.ui.showEva("Системы скафандра перезапущены. Респавн у капсулы.");
    }

    if (this.buildMode) {
      this._updatePreview();
      if (this.mouse.down) {
        this.mouse.down = false;
        this._placeBuilding();
      }
    } else if (this.mouse.down && this.player.pointerLocked) {
      this._tryMine(delta);
    } else {
      this.miningTarget = null;
      this.ui.setCrosshairMining(false);
    }

    this.composer.render();
  }

  _applyCameraShake() {
    if (this.shake.intensity <= 0) return;
    this.camera.position.add(this.shake.offset);
  }

  _onKey(e) {
    if (!this.playing) return;
    if (e.code === "Tab") {
      e.preventDefault();
      this.ui.toggleInventory();
      this.ui.updateInventory(this.inventory);
    }
    if (e.code === "KeyC") {
      this.ui.toggleCraft();
      this.ui.updateCraftStatus(this.inventory);
    }
    if (e.code === "KeyB") {
      this.buildMode = !this.buildMode;
      this.ui.toggleBuild(this.buildMode);
      if (this.buildMode) {
        this.ui.setBuildActive(this.selectedBuilding);
        this._refreshPreview();
      } else if (this.preview) {
        this.scene.remove(this.preview);
        this.preview = null;
      }
    }
    if (this.buildMode && e.code >= "Digit1" && e.code <= "Digit5") {
      this.selectedBuilding = Number(e.code.replace("Digit", "")) - 1;
      this.ui.setBuildActive(this.selectedBuilding);
      this._refreshPreview();
    }
    if (e.code === "KeyE") this._tryInteract();
    if (e.code === "Escape") document.exitPointerLock?.();
  }

  _craftSelected() {
    const recipe = RECIPES[this.ui.selectedRecipe];
    if (!recipe) return;
    if (this.crafting.craft(recipe)) {
      this.ui.craftStatus.textContent = `Создано: ${recipe.name}`;
      if (!this.triggers.craft) {
        this.triggers.craft = true;
        this.ui.showEva(EVA_MESSAGES.firstCraft);
      }
    } else {
      this.ui.craftStatus.textContent = "Недостаточно ресурсов";
    }
  }

  _findGameObject(obj) {
    let cur = obj;
    while (cur) {
      const d = cur.userData;
      if (d?.maxHp !== undefined || d?.looted !== undefined || d?.buildingId !== undefined) {
        return cur;
      }
      cur = cur.parent;
    }
    return obj;
  }

  _getLookTargets(range) {
    const { origin, dir } = this.player.lookRay(range);
    this.raycaster.set(origin, dir);
    this.raycaster.far = range;
    const targets = [...this.world.resources, ...this.world.wreckage, ...this.world.buildings];
    return this.raycaster.intersectObjects(targets, true);
  }

  _tryMine(delta) {
    if (this.player.mineCooldown > 0) return;
    const hits = this._getLookTargets(CONST.MINE_RANGE);
    const hit = hits.find((h) => {
      const root = this._findGameObject(h.object);
      return root.userData.kind === "resource";
    });
    if (!hit) {
      this.miningTarget = null;
      this.ui.setCrosshairMining(false);
      return;
    }

    const node = this._findGameObject(hit.object);
    this.miningTarget = node;
    this.ui.setCrosshairMining(true);

    node.userData.hp -= CONST.MINE_DAMAGE;
    const newRatio = node.userData.hp / node.userData.maxHp;
    const punch = 0.85 + (1 - newRatio) * 0.15;
    node.scale.setScalar(punch);
    setTimeout(() => {
      if (node.parent) node.scale.setScalar(1 + Math.sin(this.clock.elapsedTime * 2.5 + node.userData.pulse) * 0.06);
    }, 50);

    this.shake.add(0.06);
    this.audio.playMineHit();
    this.particles.spawn(
      hit.point,
      ITEM_COLORS[node.userData.itemId] || 0xaabbcc,
      8 + Math.floor((1 - newRatio) * 6)
    );
    this.ui.flashCrosshair();

    this.player.spendMining(delta);
    this.player.mineCooldown = 0.22;

    if (node.userData.hp <= 0) {
      this.audio.playMineBreak();
      this.shake.add(0.12);
      this.particles.spawn(hit.point, ITEM_COLORS[node.userData.itemId] || 0xffffff, 18);
      this.inventory.addItem(node.userData.itemId, node.userData.drop);
      this.world.group.remove(node);
      this.world.resources = this.world.resources.filter((r) => r !== node);
      this.miningTarget = null;
      this.ui.setCrosshairMining(false);
      if (!this.triggers.mine) {
        this.triggers.mine = true;
        this.ui.showEva(EVA_MESSAGES.firstMine);
      }
    }
  }

  _tryInteract() {
    const hits = this._getLookTargets(CONST.INTERACT_RANGE);
    const hit = hits.find((h) => this._findGameObject(h.object).userData.kind === "wreckage");
    if (!hit) return;
    const wreck = this._findGameObject(hit.object);
    if (!wreck.userData.looted) {
      wreck.userData.looted = true;
      this.inventory.addItem(wreck.userData.lootItem, wreck.userData.lootAmount);
      this.ui.showEva(
        `Обломок Aurora: получено ${ITEM_NAMES[wreck.userData.lootItem]} x${wreck.userData.lootAmount}.`
      );
    }
    if (wreck.userData.isCore) {
      this.ui.showEva(EVA_MESSAGES.auroraCore);
      this.playing = false;
      this.audio.stopAmbience();
      this.ui.showComplete();
    }
  }

  _refreshPreview() {
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview = null;
    }
    if (!this.buildMode) return;
    this.preview = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1, 2),
      new THREE.MeshStandardMaterial({
        color: 0x66aaff,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        emissive: 0x2266aa,
        emissiveIntensity: 0.4,
      })
    );
    this.scene.add(this.preview);
  }

  _updatePreview() {
    if (!this.preview) return;
    const { origin, dir } = this.player.lookRay(20);
    let x = origin.x + dir.x * 8;
    let z = origin.z + dir.z * 8;
    const g = CONST.BUILD_GRID;
    x = Math.round(x / g) * g;
    z = Math.round(z / g) * g;
    const groundY = this.world.surfaceY(x, z);
    this.preview.position.set(x, groundY + 0.6, z);
  }

  _placeBuilding() {
    if (!this.crafting.canBuild(this.selectedBuilding) || !this.preview) return;
    if (!this.crafting.consumeBuild(this.selectedBuilding)) return;
    const pos = this.preview.position.clone();
    pos.y = this.world.surfaceY(pos.x, pos.z);
    this.world.addBuilding(this.selectedBuilding, pos);
    if (!this.triggers.build) {
      this.triggers.build = true;
      this.ui.showEva(EVA_MESSAGES.firstBuild);
    }
  }

  _applyGeneratorBuff(delta) {
    for (const b of this.world.buildings) {
      if (b.userData.buildingId !== BuildingId.GENERATOR) continue;
      if (b.position.distanceTo(this.player.position) <= CONST.GENERATOR_O2_RADIUS) {
        this.player.applyGeneratorO2(CONST.GENERATOR_O2_RATE * delta);
      }
    }
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomPass.resolution.set(w, h);
  }
}
