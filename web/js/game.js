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
import {
  clearSave,
  createNewWorldSave,
  formatSaveSummary,
  loadSave,
  writeSave,
} from "./save.js";
import { Minimap } from "./minimap.js";
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
    this.mode = "planet";
    this.planetIndex = 0;
    this.homeSeed = null;
    this.worldName = "";
    this.spaceMarkers = [];
    this.saveTimer = 0;
    this.generating = false;
    this.entering = false;
    this.loadOverlay = document.getElementById("world-loading");
    this.loadBarFill = document.getElementById("load-bar-fill");
    this.loadStatus = document.getElementById("load-status");
    this.loadWorldName = document.getElementById("load-world-name");

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
    this.minimap = new Minimap(document.getElementById("minimap"));

    this._bindUI();
    this.refreshMenu();
    window.addEventListener("resize", () => this._onResize());
    window.addEventListener("keydown", (e) => this._onKey(e));
    window.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest?.(".side-panel, .overlay, .menu-card, .title-screen, button, .slot, .recipe, .build-item, input")) {
        return;
      }
      if (this.ui.isUiBlocking()) return;
      this.mouse.down = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouse.down = false;
    });
    window.addEventListener("beforeunload", () => {
      if (this.playing) this.saveGame();
    });
  }

  _bindUI() {
    this.btnGenerate = document.getElementById("btn-generate");
    this.btnEnter = document.getElementById("btn-enter");
    this.btnContinue = document.getElementById("btn-continue");
    this.btnDelete = document.getElementById("btn-delete-save");
    this.worldNameInput = document.getElementById("world-name");
    this.saveSummary = document.getElementById("save-summary");
    this.genProgress = document.getElementById("gen-progress");
    this.genBarFill = document.getElementById("gen-bar-fill");
    this.genStatus = document.getElementById("gen-status");

    this.btnGenerate.addEventListener("click", () => this.generateWorld());
    this.btnEnter.addEventListener("click", () => this.enterWorld(false));
    this.btnContinue.addEventListener("click", () => this.enterWorld(true));
    this.btnDelete.addEventListener("click", () => this.deleteWorld());
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
    this.ui.refreshSaveMenu = () => this.refreshMenu();
    this.inventory.onChange(() => {
      this.ui.updateInventory(this.inventory);
      this.player?.setOxygenCapacity(this.inventory.oxygenCapacity());
    });
  }

  refreshMenu() {
    const data = loadSave();
    if (this.saveSummary) this.saveSummary.textContent = formatSaveSummary(data);
    const has = !!data;
    const played = !!data?.played;
    if (this.btnEnter) this.btnEnter.disabled = !has || this.generating || this.entering;
    if (this.btnContinue) this.btnContinue.disabled = !has || !played || this.generating || this.entering;
    if (this.btnDelete) this.btnDelete.disabled = !has || this.generating || this.entering;
    if (this.btnGenerate) this.btnGenerate.disabled = this.generating || this.entering;
    if (this.worldNameInput && data?.worldName && !this.worldNameInput.value) {
      this.worldNameInput.value = data.worldName;
    }
    document.querySelector(".save-card")?.classList.toggle("ready", has);
    document.querySelector(".save-card")?.classList.toggle("played", played);
  }

  async generateWorld() {
    if (this.generating) return;
    const existing = loadSave();
    if (existing?.played) {
      const ok = confirm("Уже есть сохранение с прогрессом. Сгенерировать новый мир и удалить старый?");
      if (!ok) return;
    }

    this.generating = true;
    this.refreshMenu();
    this.genProgress?.classList.remove("hidden");
    this.genBarFill.style.transform = "scaleX(0)";
    const steps = [
      "Сканирование сектора…",
      "Построение рельефа…",
      "Расстановка ресурсов…",
      "Фиксация seed мира…",
      "Сохранение в браузер…",
    ];
    for (let i = 0; i < steps.length; i++) {
      this.genStatus.textContent = steps[i];
      this.genBarFill.style.transform = `scaleX(${(i + 1) / steps.length})`;
      await new Promise((r) => setTimeout(r, 280 + Math.random() * 220));
    }

    const save = createNewWorldSave({ name: this.worldNameInput?.value });
    this.homeSeed = save.homeSeed;
    this.worldName = save.worldName;
    this.generating = false;
    this.genStatus.textContent = `Мир «${save.worldName}» готов. Можно входить.`;
    this.refreshMenu();
    setTimeout(() => this.genProgress?.classList.add("hidden"), 1200);
  }

  deleteWorld() {
    const data = loadSave();
    if (!data) return;
    if (!confirm(`Удалить мир «${data.worldName}»?`)) return;
    clearSave();
    if (this.worldNameInput) this.worldNameInput.value = "";
    this.refreshMenu();
  }

  _showLoading(worldName, continuing) {
    this.loadOverlay?.classList.remove("hidden");
    if (this.loadWorldName) {
      this.loadWorldName.textContent = worldName ? `«${worldName}»` : "";
    }
    if (this.loadBarFill) this.loadBarFill.style.transform = "scaleX(0.08)";
    if (this.loadStatus) {
      this.loadStatus.textContent = continuing
        ? "Восстановление сохранения…"
        : "Открытие сектора…";
    }
  }

  _setLoadProgress(ratio, text) {
    if (this.loadBarFill) {
      this.loadBarFill.style.transform = `scaleX(${Math.max(0.08, Math.min(1, ratio))})`;
    }
    if (text && this.loadStatus) this.loadStatus.textContent = text;
  }

  _hideLoading() {
    this.loadOverlay?.classList.add("hidden");
  }

  async _yieldPaint() {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  async enterWorld(continuePlay) {
    if (this.entering || this.generating) return;
    const data = loadSave();
    if (!data) {
      alert("Сначала сгенерируйте мир.");
      return;
    }
    await this.startFromSave(data, { continuePlay: !!continuePlay });
  }

  async startFromSave(data, { continuePlay = false } = {}) {
    if (this.entering) return;
    let save = data;

    if (!continuePlay && data.played) {
      const choice = confirm(
        "В этом мире уже есть прогресс.\nOK — продолжить игру\nОтмена — остаться в меню"
      );
      if (!choice) return;
      continuePlay = true;
    }

    this.entering = true;
    this.refreshMenu();
    this._showLoading(save.worldName, continuePlay);
    await this._yieldPaint();

    try {
      this._setLoadProgress(0.2, "Чтение координат высадки…");
      await this._yieldPaint();

      this.homeSeed = save.homeSeed;
      this.worldName = save.worldName;
      this.planetIndex = continuePlay ? save.planetIndex ?? 0 : 0;
      this.triggers = continuePlay
        ? { ...save.triggers }
        : {
            mine: false,
            craft: false,
            build: false,
            aurora: false,
            hangar: false,
            ship: false,
          };

      if (continuePlay) this.inventory.load(save.inventory);
      else this.inventory.reset();

      const planetKey = String(this.planetIndex);
      const planet =
        (continuePlay && (save.planets?.[planetKey] || save.planets?.[this.planetIndex])) || {
          seed: save.homeSeed,
          harvested: [],
          buildings: [],
          ships: [],
        };

      this._setLoadProgress(0.45, "Построение рельефа и чанков…");
      await this._yieldPaint();

      this._bootPlanet(planet.seed ?? save.homeSeed, {
        harvested: continuePlay ? planet.harvested || [] : [],
        explored: continuePlay ? planet.explored || [] : [],
        buildings: continuePlay ? planet.buildings || [] : [],
        ships: continuePlay ? planet.ships || [] : [],
        playerState: continuePlay ? save.player : null,
        showIntro: !continuePlay || !save.played,
      });

      this._setLoadProgress(0.85, "Синхронизация скафандра…");
      await this._yieldPaint();

      const next = loadSave() || save;
      next.played = true;
      next.mode = "planet";
      next.planetIndex = this.planetIndex;
      next.inventory = this.inventory.serialize();
      writeSave(next);

      this._setLoadProgress(1, continuePlay ? "Возвращение на поверхность…" : "Высадка…");
      await new Promise((r) => setTimeout(r, 280));
    } finally {
      this.entering = false;
      this._hideLoading();
      this.refreshMenu();
    }
  }

  _bootPlanet(seed, { harvested = [], explored = [], buildings = [], ships = [], playerState = null, showIntro = false } = {}) {
    if (this.world) this.world.dispose();
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview = null;
    }
    this._clearSpaceMarkers();

    this.world = new World(this.scene, seed);
    this.world.setHarvested(harvested);
    this.world.build();
    this.world.restoreStructures({ buildings, ships });
    this.minimap.reset(explored);
    this.minimap.setVisible(true);
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
    if (playerState?.position) {
      this.player.spawn(
        new THREE.Vector3(playerState.position.x, playerState.position.y, playerState.position.z)
      );
      this.player.yaw = playerState.yaw ?? 0;
      this.player.pitch = playerState.pitch ?? 0;
      if (playerState.stats) Object.assign(this.player.stats, playerState.stats);
      this.player.setOxygenCapacity(this.inventory.oxygenCapacity());
      this.player.stats.oxygen = Math.min(
        this.player.o2Capacity,
        playerState.stats?.oxygen ?? this.player.o2Capacity
      );
    } else {
      this.player.spawn();
    }

    this.buildMode = false;
    this.miningTarget = null;
    this.mode = "planet";
    this.playing = true;
    this.saveTimer = 0;
    this.scene.background = new THREE.Color(0x0a1628);
    this.scene.fog = new THREE.Fog(0x0a1628, 50, 160);
    this.ui.showGame();
    this.ui.toggleBuild(false);
    this.ui.toggleInventory(false);
    this.ui.toggleCraft(false);
    this.ui.updateInventory(this.inventory);
    this.ui.showEva(showIntro ? EVA_MESSAGES.start : EVA_MESSAGES.newPlanet);
    this.audio.startAmbience();
    this.canvas.requestPointerLock?.();
    this.saveGame();
  }

  saveGame() {
    if (!this.playing || this.homeSeed == null) return;
    const prev = loadSave() || createNewWorldSave({ name: this.worldName, seed: this.homeSeed });
    const planets = { ...(prev.planets || {}) };

    if (this.mode === "planet" && this.world?.serializePlanet) {
      planets[String(this.planetIndex)] = {
        ...this.world.serializePlanet(),
        explored: this.minimap.serialize(),
      };
    }

    writeSave({
      ...prev,
      worldName: this.worldName || prev.worldName,
      homeSeed: this.homeSeed,
      seed: this.world?.seed ?? prev.seed ?? this.homeSeed,
      planetIndex: this.planetIndex,
      mode: this.mode,
      played: true,
      inventory: this.inventory.serialize(),
      player: this._serializePlayer(),
      triggers: this.triggers,
      planets,
    });
  }

  _serializePlayer() {
    if (!this.player) return null;
    return {
      position: {
        x: this.player.position.x,
        y: this.player.position.y,
        z: this.player.position.z,
      },
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      stats: { ...this.player.stats },
    };
  }

  toMenu() {
    if (this.playing) this.saveGame();
    this.playing = false;
    this.buildMode = false;
    this.miningTarget = null;
    document.exitPointerLock?.();
    this.audio.stopAmbience();
    this.ui.showMenu();
    this.refreshMenu();
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
      this.world.updateChunks?.(this.player.position.x, this.player.position.z);
      this.world.updateDayNight?.(this.clock.elapsedTime);
      this.world.updateAnimals?.(delta, this.player.position);
      this._applyBuildingBuffs(delta);
    } else {
      this._updateSpace(delta);
    }

    this.saveTimer += delta;
    if (this.saveTimer >= 12) {
      this.saveTimer = 0;
      this.saveGame();
    }

    this.ui.updateStats(this.player.stats, {
      tool: this.inventory.equippedTool,
      tank: this.inventory.tankLevel,
      capacity: this.inventory.oxygenCapacity(),
      mode: this.mode,
      planet: this.planetIndex,
    });

    this.minimap.draw({
      x: this.player.position.x,
      z: this.player.position.z,
      yaw: this.player.yaw,
      seed: this.world.seed || this.homeSeed || 0,
      buildings: this.world.buildings || [],
      ships: this.world.ships || [],
      mode: this.mode,
    });

    this._applyCameraShake();

    if (this.player.isDead()) {
      this.player.spawn();
      this.ui.showEva("Системы скафандра перезапущены у точки высадки.");
      this.saveGame();
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
    if (!this.world?.buildings) return;
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
    if (e.code === "KeyM") {
      this.toMenu();
      return;
    }
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
      } else if (!this.ui.isUiBlocking()) {
        this.toMenu();
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
      this.saveGame();
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
      ...(this.world.resources || []),
      ...(this.world.buildings || []),
      ...(this.world.ships || []),
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
    const maxHp = node.userData.maxHp || 70;
    if (node.userData.hp == null) node.userData.hp = maxHp;
    const mult = gatherMultiplier(node.userData.itemId, this.inventory.equippedTool);
    const dmg = CONST.MINE_DAMAGE * mult * Math.max(delta * 4, 0.35);
    node.userData.hp -= dmg;
    this.player.spendMining(delta);
    this.player.mineCooldown = 0.12;
    this.miningTarget = node;
    this.ui.setCrosshairMining(true);
    this.ui.flashCrosshair();
    const progress = 1 - Math.max(0, node.userData.hp) / maxHp;
    this.ui.setMiningProgress({
      progress,
      name: ITEM_NAMES[node.userData.itemId] || "Ресурс",
    });
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
      this.world.markHarvested?.(node);
      this.world.group.remove(node);
      this.world.resources = this.world.resources.filter((r) => r !== node);
      this.world.wreckage = this.world.wreckage.filter((r) => r !== node);
      this.miningTarget = null;
      this.ui.setMiningProgress({ progress: 1, name: ITEM_NAMES[node.userData.itemId] || "Ресурс" });
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
        this.saveGame();
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
    this.saveGame();
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
    this.minimap.setVisible(true);
    this.saveGame();
  }

  _updateSpace() {
    for (const m of this.spaceMarkers) m.rotation.y += 0.003;
  }

  async _landOnNearestPlanet() {
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
    this.planetIndex = nextPlanet;
    const seed = (nextPlanet * 9973 + 42) >>> 0;
    const prev = loadSave() || {};
    const planetKey = String(nextPlanet);
    const planet = prev.planets?.[planetKey] || {
      seed,
      harvested: [],
      explored: [],
      buildings: [],
      ships: [],
    };

    this.entering = true;
    this._showLoading(this.worldName || `Планета #${nextPlanet}`, false);
    this._setLoadProgress(0.3, "Снижение на орбиту…");
    await this._yieldPaint();
    this._setLoadProgress(0.6, "Построение поверхности…");
    await this._yieldPaint();
    this._bootPlanet(seed, {
      harvested: planet.harvested || [],
      explored: planet.explored || [],
      buildings: planet.buildings || [],
      ships: planet.ships || [],
      playerState: null,
      showIntro: false,
    });
    this._setLoadProgress(1, "Касание грунта…");
    await new Promise((r) => setTimeout(r, 220));
    this.entering = false;
    this._hideLoading();
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
    this.saveGame();
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }
}
