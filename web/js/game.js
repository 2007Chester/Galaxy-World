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
  ItemId,
  RECIPES,
  gatherMultiplier,
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
    this.triggers = {
      mine: false,
      craft: false,
      build: false,
      aurora: false,
      hangar: false,
      ship: false,
    };
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.mouse = { down: false };
    this.shake = new CameraShake();
    this.particles = null;
    this.miningTarget = null;
    this.mode = "planet"; // planet | space
    this.planetIndex = 0;
    this.spaceMarkers = [];

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
    this.scene.fog = new THREE.Fog(0x0a1628, 50, 160);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.32,
      0.5,
      0.85
    );
    this.composer.addPass(this.bloomPass);

    this.world = null;
    this.player = null;
    this.preview = null;

    this._bindUI();
    window.addEventListener("resize", () => this._onResize());
    window.addEventListener("keydown", (e) => this._onKey(e));
    window.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest?.(".side-panel, .overlay, .menu-card, button, .slot, .recipe, .build-item")) {
        return;
      }
      if (this.ui.isUiBlocking()) return;
      this.mouse.down = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouse.down = false;
    });
  }

  _bindUI() {
    document.getElementById("btn-start").addEventListener("click", () => this.start());
    document.getElementById("btn-menu").addEventListener("click", () => this.toMenu());
    document.getElementById("btn-craft").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._craftSelected();
    });
    this.ui.setBuildHandler((id) => {
      this.selectedBuilding = id;
      this.ui.setBuildActive(id);
      this._refreshPreview();
    });
    this.ui.onEquipSlot = (index) => this._useInventorySlot(index);
    this.inventory.onChange(() => {
      this.ui.updateInventory(this.inventory);
      this.player?.setOxygenCapacity(this.inventory.oxygenCapacity());
    });
  }

  start(seed = (Math.random() * 1e9) | 0, { keepInventory = false, planetIndex = null } = {}) {
    if (planetIndex != null) this.planetIndex = planetIndex;
    if (!keepInventory) {
      this.planetIndex = planetIndex != null ? planetIndex : 0;
      this.inventory.reset();
    }

    if (this.world) this.world.dispose();
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview = null;
    }
    this._clearSpaceMarkers();

    this.world = new World(this.scene, seed);
    this.world.build();
    this.particles = new ParticleBurst(this.scene);
    if (!this.player) {
      this.player = new Player(this.camera, this.world);
      this.player.bindInput(this.canvas);
      this.player.onFootstep = () => {
        if (this.player.pointerLocked) this.audio.playFootstep();
      };
    } else {
      this.player.world = this.world;
      this.player.flying = false;
    }
    this.player.setOxygenCapacity(this.inventory.oxygenCapacity());
    this.player.spawn();
    this.triggers = {
      mine: false,
      craft: false,
      build: false,
      aurora: false,
      hangar: false,
      ship: false,
    };
    this.buildMode = false;
    this.miningTarget = null;
    this.mode = "planet";
    this.playing = true;
    this.scene.background = new THREE.Color(0x0a1628);
    this.scene.fog = new THREE.Fog(0x0a1628, 50, 160);
    this.ui.showGame();
    this.ui.toggleBuild(false);
    this.ui.toggleInventory(false);
    this.ui.toggleCraft(false);
    this.ui.updateInventory(this.inventory);
    this.ui.showEva(this.planetIndex === 0 ? EVA_MESSAGES.start : EVA_MESSAGES.newPlanet);
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

    if (this.mode === "planet") {
      this.world.updateChunks(this.player.position.x, this.player.position.z);
      this.world.updateDayNight(this.clock.elapsedTime);
      this._applyBuildingBuffs(delta);
    } else {
      this._updateSpace(delta);
    }

    this.ui.updateStats(this.player.stats, {
      tool: this.inventory.equippedTool,
      tank: this.inventory.tankLevel,
      capacity: this.inventory.oxygenCapacity(),
      mode: this.mode,
      planet: this.planetIndex,
    });
    this._applyCameraShake();

    if (this.player.isDead()) {
      this.player.spawn();
      this.ui.showEva("Системы скафандра перезапущены у точки высадки.");
    }

    if (this.buildMode && this.mode === "planet") {
      this._updatePreview();
      if (this.mouse.down) {
        this.mouse.down = false;
        this._placeBuilding();
      }
    } else if (this.mouse.down && this.player.pointerLocked && this.mode === "planet") {
      this._tryMine(delta);
    } else {
      this.ui.setCrosshairMining(false);
    }

    this.composer.render();
  }

  _applyCameraShake() {
    if (this.shake.intensity <= 0) return;
    this.camera.position.add(this.shake.offset);
  }

  _applyBuildingBuffs(delta) {
    for (const b of this.world.buildings) {
      const id = b.userData.buildingId;
      const dist = b.position.distanceTo(this.player.position);
      if (
        (id === BuildingId.GENERATOR || id === BuildingId.OXYGEN_STATION || id === BuildingId.O2_FILLER) &&
        dist <= (id === BuildingId.O2_FILLER ? CONST.O2_FILLER_RADIUS : CONST.GENERATOR_O2_RADIUS)
      ) {
        const rate = id === BuildingId.O2_FILLER ? CONST.O2_FILLER_RATE : CONST.GENERATOR_O2_RATE;
        this.player.applyGeneratorO2(rate * delta);
      }
      if (id === BuildingId.FARM_PLOT && dist < 4) {
        // Passive food trickle while near farm
        if (Math.random() < delta * 0.15) this.inventory.addItem(ItemId.FOOD, 1);
      }
    }
  }

  _useInventorySlot(index) {
    const result = this.inventory.equipFromSlot(index);
    if (result === "tool") {
      this.ui.showEva(
        `Экипировано: ${ITEM_NAMES[this.inventory.equippedTool]}. Добыча с инструментом быстрее.`,
        4
      );
    } else if (result === "tank") {
      this.player.setOxygenCapacity(this.inventory.oxygenCapacity());
      this.ui.showEva(
        `Баллон улучшен до ур.${this.inventory.tankLevel}. Ёмкость O₂: ${this.inventory.oxygenCapacity()}.`,
        5
      );
    } else if (result === "food") {
      this.player.eat();
      this.ui.showEva("Еда восстановлена.", 3);
    } else if (result === "water") {
      this.player.drink();
      this.ui.showEva("Вода восстановлена.", 3);
    }
  }

  _onKey(e) {
    if (!this.playing) return;
    if (e.code === "Tab") {
      e.preventDefault();
      this.ui.toggleInventory();
      this.ui.updateInventory(this.inventory);
      return;
    }
    if (e.code === "KeyC" && !this.player.flying) {
      this.ui.toggleCraft();
      this.ui.updateCraftStatus(this.inventory);
      return;
    }
    if (e.code === "KeyB" && this.mode === "planet") {
      this.buildMode = !this.buildMode;
      this.ui.toggleBuild(this.buildMode);
      if (this.buildMode) {
        this.ui.setBuildActive(this.selectedBuilding);
        this._refreshPreview();
      } else if (this.preview) {
        this.scene.remove(this.preview);
        this.preview = null;
      }
      return;
    }
    if (this.buildMode && e.code >= "Digit1" && e.code <= "Digit8") {
      this.selectedBuilding = Number(e.code.replace("Digit", "")) - 1;
      this.ui.setBuildActive(this.selectedBuilding);
      this._refreshPreview();
    }
    if (e.code === "Enter" && !this.ui.craftPanel.classList.contains("hidden")) {
      this._craftSelected();
      return;
    }
    if (e.code === "KeyE" && !this.ui.isUiBlocking()) this._tryInteract();
    if (e.code === "KeyF" && !this.ui.isUiBlocking()) this._tryShip();
    if (e.code === "KeyG" && this.mode === "space") this._landOnNearestPlanet();
    if (e.code === "Escape") {
      if (this.ui.isUiBlocking() && this.ui.mainMenu.classList.contains("hidden")) {
        this.ui.toggleInventory(false);
        this.ui.toggleCraft(false);
        if (this.buildMode) {
          this.buildMode = false;
          this.ui.toggleBuild(false);
          if (this.preview) {
            this.scene.remove(this.preview);
            this.preview = null;
          }
        }
        this.canvas.requestPointerLock?.();
      } else {
        document.exitPointerLock?.();
      }
    }
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
      if (recipe.outputId === ItemId.SHIP_KIT) {
        this.ui.showEva("Набор корабля готов. Подойдите к ангару и нажмите E.", 6);
      }
    } else {
      this.ui.craftStatus.textContent = "Недостаточно ресурсов";
    }
  }

  _findGameObject(obj) {
    let o = obj;
    while (o) {
      if (o.userData?.kind) return o;
      o = o.parent;
    }
    return obj;
  }

  _getLookTargets(range) {
    const { origin, dir } = this.player.lookRay(range);
    this.raycaster.set(origin, dir);
    this.raycaster.far = range;
    const targets = [
      ...this.world.resources,
      ...this.world.buildings,
      ...this.world.ships,
    ];
    return this.raycaster.intersectObjects(targets, true);
  }

  _tryMine(delta) {
    if (this.player.mineCooldown > 0) return;
    const hits = this._getLookTargets(CONST.MINE_RANGE);
    const hit = hits.find((h) => this._findGameObject(h.object).userData.kind === "resource");
    if (!hit) {
      this.miningTarget = null;
      this.ui.setCrosshairMining(false);
      return;
    }
    const node = this._findGameObject(hit.object);
    const mult = gatherMultiplier(node.userData.itemId, this.inventory.equippedTool);
    const dmg = CONST.MINE_DAMAGE * mult * Math.max(delta * 4, 0.35);
    node.userData.hp -= dmg;
    this.player.spendMining(delta);
    this.player.mineCooldown = 0.12;
    this.miningTarget = node;
    this.ui.setCrosshairMining(true);
    this.ui.flashCrosshair();
    this.audio.playMineHit();
    this.shake.add(0.035 / Math.max(mult, 0.35));
    this.particles?.spawn(hit.point, ITEM_COLORS[node.userData.itemId] || 0xffffff, 8);
    node.scale.setScalar(0.92);
    setTimeout(() => {
      if (node.parent) node.scale.setScalar(1);
    }, 50);

    if (node.userData.hp <= 0) {
      this.audio.playMineBreak();
      this.shake.add(0.1);
      this.particles?.spawn(hit.point, ITEM_COLORS[node.userData.itemId] || 0xffffff, 16);
      this.inventory.addItem(node.userData.itemId, node.userData.drop);
      this.world.group.remove(node);
      this.world.resources = this.world.resources.filter((r) => r !== node);
      this.world.wreckage = this.world.wreckage.filter((r) => r !== node);
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
    const hit = hits[0];
    if (!hit) return;
    const obj = this._findGameObject(hit.object);

    if (obj.userData.kind === "building" && obj.userData.buildingId === BuildingId.HANGAR) {
      if (this.inventory.getCount(ItemId.SHIP_KIT) > 0) {
        this.inventory.removeItem(ItemId.SHIP_KIT, 1);
        const p = obj.position.clone();
        p.z += 8;
        this.world.addShip(p);
        this.triggers.ship = true;
        this.ui.showEva(EVA_MESSAGES.shipReady, 8);
      } else if (!this.triggers.hangar) {
        this.triggers.hangar = true;
        this.ui.showEva(EVA_MESSAGES.hangar, 8);
      } else {
        const parts = this.inventory.getCount(ItemId.WRECK_PART);
        this.ui.showEva(
          `Ангар онлайн. Обломков: ${parts}/${CONST.SHIP_PARTS_NEEDED}. Скрафтите «Набор корабля», затем E у ангара.`,
          6
        );
      }
      return;
    }

    if (obj.userData.kind === "building" && obj.userData.buildingId === BuildingId.O2_FILLER) {
      this.player.applyGeneratorO2(40);
      this.ui.showEva("Баллон заправлен у O₂ станции.", 3);
    }
  }

  _tryShip() {
    if (this.mode === "space") {
      this._landOnNearestPlanet();
      return;
    }
    const hits = this._getLookTargets(5);
    const shipHit = hits.find((h) => this._findGameObject(h.object).userData.kind === "ship");
    const nearShip =
      !!shipHit ||
      this.world.ships.some((s) => s.position.distanceTo(this.player.position) < 10);
    if (!nearShip) {
      if (this.world.ships.length === 0) {
        this.ui.showEva("Нет корабля. Постройте ангар и соберите набор корабля.", 4);
      } else {
        this.ui.showEva("Подойдите ближе к кораблю и нажмите F.", 3);
      }
      return;
    }
    this._enterSpace();
  }

  _enterSpace() {
    this.mode = "space";
    this.buildMode = false;
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview = null;
    }
    this.ui.toggleBuild(false);
    if (this.world) this.world.dispose();
    this.world = {
      seed: 0,
      group: new THREE.Group(),
      resources: [],
      buildings: [],
      ships: [],
      wreckage: [],
      dispose() {
        this.group.parent?.remove(this.group);
      },
      updateChunks() {},
      updateDayNight() {},
      surfaceY: () => 0,
    };
    this.scene.add(this.world.group);
    this.scene.background = new THREE.Color(0x02050c);
    this.scene.fog = null;
    const stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          Float32Array.from({ length: 6000 }, () => (Math.random() - 0.5) * 800),
          3
        )
      ),
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.7 })
    );
    this.world.group.add(stars);
    this._clearSpaceMarkers();
    for (let i = 0; i < 5; i++) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(3 + i * 0.4, 16, 16),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color().setHSL(0.55 + i * 0.08, 0.5, 0.45),
          emissive: 0x113355,
          emissiveIntensity: 0.35,
        })
      );
      marker.position.set((i - 2) * 40, (i % 2) * 10, -60 - i * 25);
      marker.userData = { kind: "planetMarker", planetId: this.planetIndex + 1 + i };
      this.world.group.add(marker);
      this.spaceMarkers.push(marker);
    }
    this.player.flying = true;
    this.player.position.set(0, 5, 30);
    this.ui.showEva("Космос. Летите к планете (WASD/Space/Ctrl) и нажмите G или F для посадки.", 8);
  }

  _updateSpace() {
    // gentle marker spin
    for (const m of this.spaceMarkers) m.rotation.y += 0.003;
  }

  _landOnNearestPlanet() {
    if (this.spaceMarkers.length === 0) return;
    let best = this.spaceMarkers[0];
    let bestD = best.position.distanceTo(this.player.position);
    for (const m of this.spaceMarkers) {
      const d = m.position.distanceTo(this.player.position);
      if (d < bestD) {
        best = m;
        bestD = d;
      }
    }
    if (bestD > 25) {
      this.ui.showEva("Подлетите ближе к планете для посадки.", 3);
      return;
    }
    const nextPlanet = best.userData.planetId;
    this.player.flying = false;
    this._clearSpaceMarkers();
    this.start((nextPlanet * 9973 + 42) >>> 0, {
      keepInventory: true,
      planetIndex: nextPlanet,
    });
  }

  _clearSpaceMarkers() {
    for (const m of this.spaceMarkers) {
      m.parent?.remove(m);
    }
    this.spaceMarkers = [];
  }

  _refreshPreview() {
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview = null;
    }
    if (!this.buildMode) return;
    const size = this.selectedBuilding === BuildingId.HANGAR ? 8 : 2;
    this.preview = new THREE.Mesh(
      new THREE.BoxGeometry(size, 1, size === 8 ? 10 : 2),
      new THREE.MeshStandardMaterial({
        color: 0x66aaff,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
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
    this.preview.position.set(x, this.world.surfaceY(x, z) + 0.6, z);
  }

  _placeBuilding() {
    if (!this.crafting.canBuild(this.selectedBuilding) || !this.preview) return;
    if (!this.crafting.consumeBuild(this.selectedBuilding)) return;
    const pos = this.preview.position.clone();
    this.world.addBuilding(this.selectedBuilding, pos);
    if (!this.triggers.build) {
      this.triggers.build = true;
      this.ui.showEva(EVA_MESSAGES.firstBuild);
    }
    if (this.selectedBuilding === BuildingId.HANGAR) {
      this.ui.showEva(EVA_MESSAGES.hangar, 8);
    }
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }
}
