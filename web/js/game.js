import * as THREE from "three";
import {
  BuildingId,
  CONST,
  EVA_MESSAGES,
  ITEM_NAMES,
  RECIPES,
} from "./constants.js";
import { Crafting } from "./crafting.js";
import { Inventory } from "./inventory.js";
import { Player } from "./player.js";
import { UI } from "./ui.js";
import { World } from "./world.js";

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ui = new UI();
    this.inventory = new Inventory();
    this.crafting = new Crafting(this.inventory);
    this.playing = false;
    this.buildMode = false;
    this.selectedBuilding = BuildingId.FOUNDATION;
    this.triggers = { mine: false, craft: false, build: false };
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.mouse = { down: false };

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1628);
    this.scene.fog = new THREE.Fog(0x0a1628, 40, 140);

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      300
    );

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
    this.player = new Player(this.camera, this.world);
    this.player.bindInput(this.canvas);
    this.player.spawn();
    this.inventory.reset();
    this.triggers = { mine: false, craft: false, build: false };
    this.buildMode = false;
    this.playing = true;
    this.ui.showGame();
    this.ui.toggleBuild(false);
    this.ui.toggleInventory(false);
    this.ui.toggleCraft(false);
    this.ui.updateInventory(this.inventory);
    this.ui.showEva(EVA_MESSAGES.start);
    this.canvas.requestPointerLock?.();
  }

  toMenu() {
    this.playing = false;
    this.buildMode = false;
    document.exitPointerLock?.();
    this.ui.showMenu();
  }

  update() {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.ui.update(delta);

    if (!this.playing || !this.player || !this.world) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const blocked = this.ui.isOverlayOpen() && !this.ui.buildModeOpen();
    this.player.update(delta, !blocked || this.ui.buildModeOpen());
    this.world.updateDayNight(this.clock.elapsedTime);
    this._applyGeneratorBuff(delta);
    this.ui.updateStats(this.player.stats);

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
    }

    this.renderer.render(this.scene, this.camera);
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

  _getLookTargets(range) {
    const { origin, dir } = this.player.lookRay(range);
    this.raycaster.set(origin, dir);
    this.raycaster.far = range;
    const targets = [...this.world.resources, ...this.world.wreckage, ...this.world.buildings];
    return this.raycaster.intersectObjects(targets, false);
  }

  _tryMine(delta) {
    if (this.player.mineCooldown > 0) return;
    const hits = this._getLookTargets(CONST.MINE_RANGE);
    const hit = hits.find((h) => h.object.userData.kind === "resource");
    if (!hit) return;
    const node = hit.object;
    node.userData.hp -= CONST.MINE_DAMAGE;
    node.scale.setScalar(0.9);
    setTimeout(() => node.scale.setScalar(1), 60);
    this.player.spendMining(delta);
    this.player.mineCooldown = 0.25;
    if (node.userData.hp <= 0) {
      this.inventory.addItem(node.userData.itemId, node.userData.drop);
      this.world.group.remove(node);
      this.world.resources = this.world.resources.filter((r) => r !== node);
      if (!this.triggers.mine) {
        this.triggers.mine = true;
        this.ui.showEva(EVA_MESSAGES.firstMine);
      }
    }
  }

  _tryInteract() {
    const hits = this._getLookTargets(CONST.INTERACT_RANGE);
    const hit = hits.find((h) => h.object.userData.kind === "wreckage");
    if (!hit) return;
    const wreck = hit.object;
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
      this.ui.showComplete();
    }
  }

  _refreshPreview() {
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview = null;
    }
    if (!this.buildMode) return;
    const color = 0x66aaff;
    this.preview = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1, 2),
      new THREE.MeshStandardMaterial({
        color,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      })
    );
    this.scene.add(this.preview);
  }

  _updatePreview() {
    if (!this.preview) return;
    const { origin, dir } = this.player.lookRay(20);
    const groundY = this.world.surfaceY(
      origin.x + dir.x * 8,
      origin.z + dir.z * 8
    );
    let x = origin.x + dir.x * 8;
    let z = origin.z + dir.z * 8;
    const g = CONST.BUILD_GRID;
    x = Math.round(x / g) * g;
    z = Math.round(z / g) * g;
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
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
