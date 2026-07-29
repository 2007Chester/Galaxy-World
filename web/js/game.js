import * as THREE from "three";
import {
  BuildingId,
  BUILDING_NAMES,
  BUILD_COSTS,
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
import { ViewHands } from "./hands.js";
import { UI } from "./ui.js";
import { buildBuildingVisual } from "./buildingMeshes.js";
import { World } from "./world.js";
import {
  createPostPipeline,
  resizePostPipeline,
  setupRenderer,
} from "./graphics.js";

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
    this._placingBuilding = false;
    this.triggers = {
      mine: false,
      craft: false,
      build: false,
      aurora: false,
      hangar: false,
      ship: false,
      hangarReady: false,
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
    this.hasSpacecraft = false;
    this.activeShip = null;
    this._spaceHintShown = false;
    this.saveTimer = 0;
    this.generating = false;
    this.entering = false;
    this.loadOverlay = document.getElementById("world-loading");
    this.loadBarFill = document.getElementById("load-bar-fill");
    this.loadStatus = document.getElementById("load-status");
    this.loadWorldName = document.getElementById("load-world-name");

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // SMAA handles AA — saves fillrate for SSAO
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    setupRenderer(this.renderer);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87a8c8);
    this.scene.fog = new THREE.FogExp2(0x87a8c8, 0.0085);

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.08, 2500);
    this.scene.add(this.camera);
    this.hands = new ViewHands(this.camera);

    this.post = createPostPipeline(this.renderer, this.scene, this.camera);
    this.composer = this.post.composer;
    this.bloomPass = this.post.bloomPass;

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
    this.ui.setBuildHandler((id, canBuild = true) => {
      if (!canBuild) {
        const cost = BUILD_COSTS[id] || {};
        const missing = Object.entries(cost)
          .filter(([item, need]) => this.inventory.getCount(Number(item)) < need)
          .map(([item, need]) => {
            const have = this.inventory.getCount(Number(item));
            return `${ITEM_NAMES[item]} ×${need - have}`;
          });
        this.ui.showEva(
          `Пока нельзя: ${BUILDING_NAMES[id]}. Не хватает: ${missing.join(", ") || "ресурсов"}.`,
          5
        );
        return;
      }
      this._selectBuildingToPlace(id);
    });
    this.ui.onEquipSlot = (index) => this._useInventorySlot(index);
    this.ui.refreshSaveMenu = () => this.refreshMenu();
    this.inventory.onChange(() => {
      this.ui.updateInventory(this.inventory);
      this.player?.setOxygenCapacity(this.inventory.oxygenCapacity());
      this._onInventoryChanged();
    });
  }

  _onInventoryChanged() {
    const hangarCost = BUILD_COSTS[BuildingId.HANGAR];
    const canHangar = this.inventory.hasItems(hangarCost);
    if (canHangar && !this.triggers.hangarReady) {
      this.triggers.hangarReady = true;
      if (this.playing) {
        this.ui.showEva(
          "Хватает дерева, глины и камня — Ангар теперь можно построить (B).",
          7
        );
      }
    }
    if (this.ui.buildModeOpen()) {
      this.ui.refreshBuildList(this.inventory);
    }
    if (this.buildMode) {
      this.ui.refreshBuildList(this.inventory);
      // Don't rewrite selection while a place click is resolving — only when
      // the current choice is no longer affordable after the list refresh.
      const affordable = this.ui.getAffordableBuildingIds();
      if (affordable.length && !affordable.includes(this.selectedBuilding)) {
        // Keep current selection if player is mid-action; switch only for preview
        // after resources dropped below cost (e.g. spent elsewhere).
        if (!this._placingBuilding) {
          this.selectedBuilding = affordable[0];
          this.ui.setBuildActive(this.selectedBuilding);
          this._refreshPreview();
          this.ui.setPlaceHint(BUILDING_NAMES[this.selectedBuilding]);
        }
      } else if (!affordable.length && !this._placingBuilding) {
        this._exitBuildMode();
      }
    }
  }

  _selectBuildingToPlace(id) {
    this.selectedBuilding = id;
    this.buildMode = true;
    this.ui.setBuildActive(id);
    this.ui.toggleBuild(false);
    this._refreshPreview();
    this.ui.setPlaceHint(BUILDING_NAMES[id]);
    this.canvas.requestPointerLock?.();
  }

  _exitBuildMode() {
    this.buildMode = false;
    this.ui.toggleBuild(false);
    this.ui.setPlaceHint(null);
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview = null;
    }
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
        ? { hangarReady: false, ...save.triggers }
        : {
            mine: false,
            craft: false,
            build: false,
            aurora: false,
            hangar: false,
            ship: false,
            hangarReady: false,
          };

      if (continuePlay) this.inventory.load(save.inventory);
      else this.inventory.reset();

      this.triggers.hangarReady = this.inventory.hasItems(BUILD_COSTS[BuildingId.HANGAR]);
      this.ui.refreshBuildList(this.inventory);

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
      this.hasSpacecraft =
        !!(continuePlay && (planet.ships?.length || save.triggers?.ship)) ||
        this.world.ships.length > 0;

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

    this.world = new World(this.scene, seed, this.renderer);
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
    this.activeShip = null;
    this._spaceHintShown = false;
    if (this.player) {
      this.player.shipFlight = false;
      this.player.flying = false;
    }
    this.playing = true;
    this.saveTimer = 0;
    this.scene.background = new THREE.Color(0x87a8c8);
    this.scene.fog = new THREE.FogExp2(0x87a8c8, 0.0085);
    this.ui.showGame();
    this.ui.toggleBuild(false);
    this.ui.toggleInventory(false);
    this.ui.toggleCraft(false);
    this.ui.updateInventory(this.inventory);
    let intro = showIntro ? EVA_MESSAGES.start : EVA_MESSAGES.newPlanet;
    if (!showIntro) {
      intro += " Вдали — леса, пустыни и горы; рядом с лагерем равнины.";
    }
    this.ui.showEva(intro);
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
      this.world.updateDayNight?.(this.clock.elapsedTime, this.camera);
      this.world.updateAnimals?.(delta, this.player.position);
      this._applyBuildingBuffs(delta);
      this._updateShipFlight(delta);
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
      swimming: this.player.swimming,
      underwater: this.player.underwater,
      diveBreath: this.player.diveBreath / CONST.DIVE_BREATH,
    });

    if (this.mode === "planet" && this.scene.fog) {
      if (this.player.shipFlight) {
        const ground = this.world.surfaceY(this.player.position.x, this.player.position.z);
        const agl = this.player.position.y - ground;
        const t = THREE.MathUtils.clamp(agl / CONST.SPACE_EXIT_ALTITUDE, 0, 1);
        const sky = this.scene.fog.color.clone().lerp(new THREE.Color(0x02050c), t * 0.92);
        this.scene.background.copy(sky);
        this.scene.fog.color.copy(sky);
        this.scene.fog.density = THREE.MathUtils.lerp(0.008, 0.002, t);
        if (this.post?.gradePass) {
          this.post.gradePass.uniforms.uVignette.value = THREE.MathUtils.lerp(0.34, 0.52, t);
        }
      } else if (this.player.underwater) {
        this.scene.background = new THREE.Color(0x0a3a55);
        this.scene.fog.color.set(0x0a3a55);
        this.scene.fog.density = 0.055;
      } else if (this.post?.gradePass) {
        this.post.gradePass.uniforms.uVignette.value = 0.34;
      }
    }

    if (this.post?.gradePass) {
      this.post.gradePass.uniforms.uTime.value = this.clock.elapsedTime;
    }

    this.hands.setTool(this.inventory.equippedTool);
    this.hands.setVisible(this.mode === "planet" && !this.ui.isUiBlocking());
    const moving =
      this.player.keys.has("KeyW") ||
      this.player.keys.has("KeyA") ||
      this.player.keys.has("KeyS") ||
      this.player.keys.has("KeyD");
    const sprint = this.player.keys.has("ShiftLeft") || this.player.keys.has("ShiftRight");
    this.hands.update(delta, {
      moving: moving && this.player.onGround,
      sprint,
      mining: this.mouse.down && this.mode === "planet" && !this.buildMode && !this.player.shipFlight,
      flying: this.player.flying || this.mode === "space",
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

    if (this.buildMode && this.mode === "planet" && !this.player.shipFlight) {
      this._updatePreview();
      if (this.mouse.down) {
        this.mouse.down = false;
        this._placeBuilding();
      }
    } else if (
      this.mouse.down &&
      this.player.pointerLocked &&
      this.mode === "planet" &&
      !this.player.shipFlight &&
      !this.ui.isUiBlocking()
    ) {
      this._tryMine(delta);
    } else {
      this.ui.setCrosshairMining(false);
      if (!this.mouse.down) this.ui.setMiningProgress(null);
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
    if (e.code === "KeyB" && this.mode === "planet" && !this.player?.shipFlight) {
      if (this.ui.buildModeOpen() || this.buildMode) {
        this._exitBuildMode();
      } else {
        this.ui.refreshBuildList(this.inventory);
        this.ui.toggleBuild(true);
      }
      return;
    }
    if ((this.buildMode || this.ui.buildModeOpen()) && e.code >= "Digit1" && e.code <= "Digit8") {
      this.ui.refreshBuildList(this.inventory);
      const visible = this.ui.getVisibleBuildingIds();
      const idx = Number(e.code.replace("Digit", "")) - 1;
      if (visible[idx] != null) {
        const id = visible[idx];
        const can = this.crafting.canBuild(id);
        if (this.ui.buildModeOpen()) {
          this.ui._buildSelectHandler?.(id, can);
        } else if (can) {
          this.selectedBuilding = id;
          this.ui.setBuildActive(this.selectedBuilding);
          this._refreshPreview();
          this.ui.setPlaceHint(BUILDING_NAMES[this.selectedBuilding]);
        }
      }
      return;
    }
    if (e.code === "Enter" && !this.ui.craftPanel.classList.contains("hidden")) {
      this._craftSelected();
      return;
    }
    if (e.code === "KeyE" && !e.repeat && !this.ui.isUiBlocking()) {
      if (this.player?.shipFlight) return;
      if (!this._tryPickup()) this._tryInteract();
    }
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
        if (this.buildMode || this.ui.buildModeOpen()) {
          this._exitBuildMode();
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
    let best = null;
    while (o) {
      if (o.userData?.kind) best = o;
      o = o.parent;
    }
    return best || obj;
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

  _isLookingAtResource() {
    const range =
      this.inventory.equippedTool === ItemId.FISHING_ROD ? 9 : CONST.MINE_RANGE;
    const hits = this._getLookTargets(range);
    return hits.some((h) => {
      const u = this._findGameObject(h.object).userData;
      return u?.kind === "resource" && !u.pickup && u.itemId !== ItemId.WRECK_PART;
    });
  }

  /** Instant pickup for loot items (wreck parts, etc.). Returns true if picked something. */
  _tryPickup() {
    if (this.mode !== "planet" || !this.world) return false;
    const hits = this._getLookTargets(CONST.INTERACT_RANGE);
    const hit = hits.find((h) => {
      const u = this._findGameObject(h.object).userData;
      return u?.kind === "resource" && (u.pickup || u.itemId === ItemId.WRECK_PART);
    });
    if (!hit) return false;
    const node = this._findGameObject(hit.object);
    if (!node?.userData || !node.parent) return false;

    const itemId = node.userData.itemId;
    const dropAmount = node.userData.drop || 1;
    const itemName =
      node.userData.displayName || ITEM_NAMES[itemId] || "Предмет";
    const got = this.inventory.addItem(itemId, dropAmount);
    this.audio.playMineBreak();
    this.shake.add(0.06);
    this.particles?.spawn(hit.point, ITEM_COLORS[itemId] || 0xffffff, 12);
    this.ui.showLootToast(itemName, got || dropAmount);
    this._removeResourceNode(node);

    if (!this.triggers.mine) {
      this.triggers.mine = true;
      this.ui.showEva(EVA_MESSAGES.firstMine);
    }
    if (itemId === ItemId.WRECK_PART && !this.triggers.wreck) {
      this.triggers.wreck = true;
      this.ui.showEva(
        `Обломок Aurora подобран (E). Нужно ${CONST.SHIP_PARTS_NEEDED} шт. для набора корабля.`,
        6
      );
    }
    this.saveGame();
    return true;
  }

  _tryMine(delta) {
    if (this.player.mineCooldown > 0) return;
    const tool = this.inventory.equippedTool;
    const fishRange = tool === ItemId.FISHING_ROD ? 9 : CONST.MINE_RANGE;
    const hits = this._getLookTargets(Math.max(CONST.MINE_RANGE, fishRange));

    let hit = null;
    let node = null;

    if (tool === ItemId.FISHING_ROD) {
      const fishHit = hits.find((h) => this._findGameObject(h.object).userData?.isFish);
      if (fishHit) {
        hit = fishHit;
        node = this._findGameObject(fishHit.object);
      } else {
        const waterHit = hits.find(
          (h) => this._findGameObject(h.object).userData?.itemId === ItemId.WATER
        );
        if (waterHit) {
          node = this._nearestFish(waterHit.point, 10);
          if (node) hit = { point: node.position.clone() };
          else {
            this.ui.setCrosshairMining(false);
            this.ui.setMiningProgress(null);
            this._rodHintTimer = (this._rodHintTimer || 0) - delta;
            if (this._rodHintTimer <= 0) {
              this.ui.showEva("В воде пока нет рыбы рядом — обойдите берег озера или реки.", 4);
              this._rodHintTimer = 5;
            }
            return;
          }
        }
      }
    }

    if (!node) {
      hit = hits.find((h) => {
        const obj = this._findGameObject(h.object);
        // With rod, ignore water surface (handled above); skip pickup loot
        if (tool === ItemId.FISHING_ROD && obj.userData?.itemId === ItemId.WATER) return false;
        if (obj.userData?.pickup || obj.userData?.itemId === ItemId.WRECK_PART) return false;
        return obj.userData?.kind === "resource";
      });
      if (!hit) {
        this.miningTarget = null;
        this.ui.setCrosshairMining(false);
        return;
      }
      node = this._findGameObject(hit.object);
    }

    if (!node?.userData || node.userData.hp <= 0 || !node.parent) {
      this.ui.setCrosshairMining(false);
      return;
    }

    // Pickup items (wreck parts) — use E, not LMB
    if (node.userData.pickup || node.userData.itemId === ItemId.WRECK_PART) {
      this.ui.setCrosshairMining(false);
      this.ui.setMiningProgress(null);
      this._pickupHintTimer = (this._pickupHintTimer || 0) - delta;
      if (this._pickupHintTimer <= 0) {
        this.ui.showEva("E — подобрать предмет.", 3);
        this._pickupHintTimer = 3.5;
      }
      return;
    }

    // Fish requires fishing rod
    if (node.userData.isFish || node.userData.itemId === ItemId.FISH) {
      if (tool !== ItemId.FISHING_ROD) {
        this.ui.setCrosshairMining(false);
        this.ui.setMiningProgress(null);
        this._rodHintTimer = (this._rodHintTimer || 0) - delta;
        if (this._rodHintTimer <= 0) {
          this.ui.showEva(EVA_MESSAGES.needRod, 5);
          this._rodHintTimer = 4;
        }
        return;
      }
    }

    // Water requires an equipped bucket
    if (node.userData.itemId === ItemId.WATER) {
      if (tool !== ItemId.BUCKET) {
        this.ui.setCrosshairMining(false);
        this.ui.setMiningProgress(null);
        this._bucketHintTimer = (this._bucketHintTimer || 0) - delta;
        if (this._bucketHintTimer <= 0) {
          this.ui.showEva(EVA_MESSAGES.needBucket, 5);
          this._bucketHintTimer = 4;
        }
        return;
      }
    }

    const maxHp = node.userData.maxHp || 70;
    if (node.userData.hp == null) node.userData.hp = maxHp;
    const dropAmount = node.userData.drop || 1;
    const itemName =
      node.userData.displayName ||
      ITEM_NAMES[node.userData.itemId] ||
      "Ресурс";
    const mult = gatherMultiplier(node.userData.itemId, tool);
    const dmg = CONST.MINE_DAMAGE * mult * Math.max(delta * 4, 0.35);
    node.userData.hp -= dmg;
    this.player.spendMining(delta);
    this.player.mineCooldown = 0.12;
    this.miningTarget = node;
    this.ui.setCrosshairMining(true);
    this.ui.flashCrosshair();
    this.hands.punch();
    const progress = 1 - Math.max(0, node.userData.hp) / maxHp;
    this.ui.setMiningProgress({
      progress,
      name: itemName,
      amount: dropAmount,
    });
    this.audio.playMineHit();
    this.shake.add(0.035 / Math.max(mult, 0.35));
    this.particles?.spawn(hit.point, ITEM_COLORS[node.userData.itemId] || 0xffffff, 8);
    if (!node.userData.infinite) {
      node.scale.setScalar(0.92);
      setTimeout(() => {
        if (node.parent && node.userData.hp > 0) node.scale.setScalar(1);
      }, 50);
    }

    if (node.userData.hp <= 0) {
      const itemId = node.userData.itemId;
      this.audio.playMineBreak();
      this.shake.add(0.1);
      this.particles?.spawn(hit.point, ITEM_COLORS[itemId] || 0xffffff, 16);
      const got = this.inventory.addItem(itemId, dropAmount);
      this.miningTarget = null;
      this.ui.setCrosshairMining(false);
      this.ui.showLootToast(
        itemId === ItemId.WATER ? "Вода" : itemName,
        got || dropAmount
      );
      if (node.userData.infinite) {
        node.userData.hp = node.userData.maxHp || 50;
      } else {
        this._removeResourceNode(node);
      }
      if (!this.triggers.mine) {
        this.triggers.mine = true;
        this.ui.showEva(EVA_MESSAGES.firstMine);
      }
      if (itemId === ItemId.WATER && !this.triggers.water) {
        this.triggers.water = true;
        this.ui.showEva("Вода набрана ведром. Можно снова черпать из озера, реки или моря.", 6);
      }
      if (itemId === ItemId.CLAY && !this.triggers.clay) {
        this.triggers.clay = true;
        this.ui.showEva("Глина только в отмелях у воды (рыжие пятна). Землю копайте на бурых участках лопатой.", 7);
      }
      if (itemId === ItemId.DIRT && !this.triggers.dirt) {
        this.triggers.dirt = true;
        this.ui.showEva("Земля собрана. Глина — отдельно, в глиняных отмелях у берегов.", 6);
      }
      if (itemId === ItemId.FISH && !this.triggers.fish) {
        this.triggers.fish = true;
        this.ui.showEva("Рыба поймана! Можно съесть из инвентаря — восстанавливает голод.", 6);
      }
    }
  }

  _nearestFish(point, radius) {
    let best = null;
    let bestD = radius;
    for (const r of this.world?.resources || []) {
      if (!r.userData?.isFish || !r.parent) continue;
      const d = r.position.distanceTo(point);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  _removeResourceNode(node) {
    if (!node || !this.world) return;
    this.world.markHarvested?.(node);
    node.visible = false;
    node.parent?.remove(node);
    this.world.group?.remove(node);
    this.world.resources = (this.world.resources || []).filter((r) => r !== node);
    this.world.wreckage = (this.world.wreckage || []).filter((r) => r !== node);
    if (this.world.chunks) {
      for (const chunk of this.world.chunks.values()) {
        if (chunk.nodes) chunk.nodes = chunk.nodes.filter((n) => n !== node);
      }
    }
  }

  _tryInteract() {
    if (this.mode !== "planet" || !this.world) return;

    // Prefer hangar when player has a ship kit (large building, easy to miss with short ray)
    if (this.inventory.getCount(ItemId.SHIP_KIT) > 0) {
      const hangar = this._findInteractHangar();
      if (hangar) {
        this._assembleShipAtHangar(hangar);
        return;
      }
    }

    const hits = this._getLookTargets(CONST.HANGAR_INTERACT_RANGE);
    let building = null;
    for (const h of hits) {
      const obj = this._findGameObject(h.object);
      if (obj?.userData?.kind === "building") {
        building = obj;
        break;
      }
    }

    // Proximity fallback for large structures
    if (!building) {
      building = this._nearestBuilding(CONST.INTERACT_RANGE + 2);
    }
    if (!building) return;

    const id = building.userData.buildingId;
    if (id === BuildingId.HANGAR) {
      if (this.inventory.getCount(ItemId.SHIP_KIT) > 0) {
        this._assembleShipAtHangar(building);
      } else if (!this.triggers.hangar) {
        this.triggers.hangar = true;
        this.ui.showEva(EVA_MESSAGES.hangar, 8);
      } else {
        const parts = this.inventory.getCount(ItemId.WRECK_PART);
        const kits = this.inventory.getCount(ItemId.SHIP_KIT);
        this.ui.showEva(
          kits > 0
            ? "Набор корабля есть — подойдите ближе к ангару и нажмите E."
            : `Ангар онлайн. Обломков: ${parts}/${CONST.SHIP_PARTS_NEEDED}. Скрафтите «Набор корабля», затем E у ангара.`,
          6
        );
      }
      return;
    }

    if (id === BuildingId.O2_FILLER) {
      this.player.applyGeneratorO2(40);
      this.ui.showEva("Баллон заправлен у O₂ станции.", 3);
    }
  }

  _findInteractHangar() {
    const range = CONST.HANGAR_INTERACT_RANGE;
    const hits = this._getLookTargets(range);
    for (const h of hits) {
      const obj = this._findGameObject(h.object);
      if (obj?.userData?.buildingId === BuildingId.HANGAR) return obj;
    }
    // Standing inside / near hangar without aiming at a wall
    let best = null;
    let bestD = range;
    for (const b of this.world.buildings || []) {
      if (b.userData?.buildingId !== BuildingId.HANGAR) continue;
      const d = b.position.distanceTo(this.player.position);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  _nearestBuilding(radius) {
    let best = null;
    let bestD = radius;
    for (const b of this.world.buildings || []) {
      if (b.userData?.kind !== "building") continue;
      const d = b.position.distanceTo(this.player.position);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  _assembleShipAtHangar(hangar) {
    if (!this.inventory.removeItem(ItemId.SHIP_KIT, 1)) {
      this.ui.showEva("Нет «Набора корабля» в инвентаре.", 4);
      return;
    }
    const p = hangar.position.clone();
    // Hangar open bay faces +Z
    p.z += 7;
    p.y = this.world.surfaceY(p.x, p.z);
    this.world.addShip(p);
    this.triggers.ship = true;
    this.hasSpacecraft = true;
    this.ui.showEva(EVA_MESSAGES.shipReady, 8);
    this.audio.playMineBreak?.();
    this.saveGame();
  }

  _tryShip() {
    if (this.mode === "space") {
      this._landOnNearestPlanet();
      return;
    }
    if (this.player?.shipFlight) {
      this._tryLandFromShip();
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
    this._boardShip();
  }

  _boardShip() {
    const boarded = this.world.nearestShip(this.player.position, 12);
    if (!boarded) return;
    if (this.buildMode) this._exitBuildMode();
    this.ui.toggleBuild(false);
    this.ui.toggleInventory(false);
    this.ui.toggleCraft(false);

    this.activeShip = boarded;
    boarded.visible = false;
    this.hasSpacecraft = true;
    this.player.flying = true;
    this.player.shipFlight = true;
    this.player.swimming = false;
    this.player.underwater = false;
    this.player.position.copy(boarded.position);
    this.player.position.y = this.world.surfaceY(boarded.position.x, boarded.position.z) + 6;
    this.player.velocity.set(0, 0, 0);
    this._spaceHintShown = false;
    this.ui.showEva(
      "В кабине. WASD — полёт, Space/Ctrl — высота, Shift — ускорение. Наберите высоту для космоса. F у земли — посадка.",
      9
    );
  }

  _tryLandFromShip() {
    if (!this.player?.shipFlight) return;
    const ground = this.world.surfaceY(this.player.position.x, this.player.position.z);
    const agl = this.player.position.y - ground;
    if (agl > CONST.SHIP_LAND_AGL) {
      const toOrbit = Math.max(0, Math.ceil(CONST.SPACE_EXIT_ALTITUDE - agl));
      this.ui.showEva(
        toOrbit > 0
          ? `Слишком высоко для посадки. Снизьтесь (Ctrl) или поднимитесь ещё ~${toOrbit} м до космоса.`
          : "Снизьтесь (Ctrl), чтобы посадить корабль.",
        4
      );
      return;
    }
    this._disembarkShip();
  }

  _disembarkShip() {
    const x = this.player.position.x;
    const z = this.player.position.z;
    const gy = this.world.surfaceY(x, z);
    const ship =
      this.activeShip && this.world.ships.includes(this.activeShip)
        ? this.activeShip
        : this.world.addShip({ x, y: gy, z });
    ship.position.set(x, gy, z);
    ship.visible = true;
    ship.rotation.y = this.player.yaw;
    this.activeShip = null;

    this.player.flying = false;
    this.player.shipFlight = false;
    this.player.position.set(x + Math.sin(this.player.yaw) * -3, gy + 1.6, z + Math.cos(this.player.yaw) * -3);
    this.player.velocity.set(0, 0, 0);
    this.player.targetFov = 75;
    this.ui.showEva("Посадка. Корабль на поверхности.", 4);
    this.saveGame();
  }

  _updateShipFlight() {
    if (!this.player?.shipFlight || this.mode !== "planet") return;

    // Keep craft under the camera for save sync
    if (this.activeShip) {
      this.activeShip.position.set(
        this.player.position.x,
        this.player.position.y - 1.8,
        this.player.position.z
      );
      this.activeShip.rotation.y = this.player.yaw;
      this.activeShip.rotation.x = this.player.pitch * 0.25;
    }

    const ground = this.world.surfaceY(this.player.position.x, this.player.position.z);
    const agl = this.player.position.y - ground;
    if (!this._spaceHintShown && agl > CONST.SPACE_EXIT_ALTITUDE * 0.72) {
      this._spaceHintShown = true;
      this.ui.showEva("Орбита близко — продолжайте подъём для выхода в космос.", 5);
    }

    if (agl >= CONST.SPACE_EXIT_ALTITUDE || this.player.position.y >= CONST.SPACE_EXIT_Y) {
      this._leaveAtmosphere();
    }
  }

  _leaveAtmosphere() {
    if (this.mode !== "planet" || !this.player?.shipFlight) return;
    // Craft leaves the planet with you
    if (this.activeShip) {
      this.world.removeShip(this.activeShip);
      this.activeShip = null;
    }
    this.player.shipFlight = false;
    this.hasSpacecraft = true;
    this.saveGame();
    this.ui.showEva("Выход из атмосферы…", 3);
    this._enterSpace();
  }

  _enterSpace() {
    this.mode = "space";
    this.buildMode = false;
    this.activeShip = null;
    this.player.shipFlight = false;
    this.player.flying = true;
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
    // Park the spacecraft on the surface at the landing site
    this._parkLandedShip();
    this._setLoadProgress(1, "Касание грунта…");
    await new Promise((r) => setTimeout(r, 220));
    this.entering = false;
    this._hideLoading();
  }

  _parkLandedShip() {
    if (!this.world?.addShip || !this.player) return;
    const alreadyNear = this.world.nearestShip?.(this.player.position, 18);
    if (alreadyNear) {
      this.hasSpacecraft = true;
      this.saveGame();
      return;
    }
    const yaw = this.player.yaw || 0;
    const px = this.player.position.x + Math.sin(yaw) * 5;
    const pz = this.player.position.z + Math.cos(yaw) * 5;
    this.world.addShip({ x: px, y: this.world.surfaceY(px, pz), z: pz });
    this.hasSpacecraft = true;
    this.ui.showEva("Корабль на поверхности. Подойдите и нажмите F, чтобы взлететь над местностью.", 6);
    this.saveGame();
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
    const ghost = buildBuildingVisual(this.selectedBuilding);
    ghost.traverse((c) => {
      if (!c.isMesh) return;
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      c.material = mats.map((m) => {
        const g = m.clone();
        g.transparent = true;
        g.opacity = 0.42;
        g.depthWrite = false;
        g.emissive = new THREE.Color(0x3366aa);
        g.emissiveIntensity = 0.25;
        return g;
      });
      if (!Array.isArray(c.material)) c.material = c.material[0];
      c.castShadow = false;
    });
    ghost.userData.preview = true;
    this.preview = ghost;
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
    this.preview.position.set(x, this.world.surfaceY(x, z), z);
  }

  _placeBuilding() {
    const buildingId = this.selectedBuilding;
    if (!this.crafting.canBuild(buildingId) || !this.preview) return;
    this._placingBuilding = true;
    try {
      // Capture id before consume — inventory change can rewrite selectedBuilding
      if (!this.crafting.consumeBuild(buildingId)) return;
      const pos = {
        x: this.preview.position.x,
        y: this.preview.position.y,
        z: this.preview.position.z,
      };
      this.world.addBuilding(buildingId, pos);
      if (!this.triggers.build) {
        this.triggers.build = true;
        this.ui.showEva(EVA_MESSAGES.firstBuild);
      }
      if (buildingId === BuildingId.HANGAR) {
        this.ui.showEva(EVA_MESSAGES.hangar, 8);
      }
      this.saveGame();

      this.ui.refreshBuildList(this.inventory);
      const affordable = this.ui.getAffordableBuildingIds();
      if (!affordable.includes(buildingId)) {
        if (affordable.length) {
          this.selectedBuilding = affordable[0];
          this.ui.setBuildActive(this.selectedBuilding);
          this._refreshPreview();
          this.ui.setPlaceHint(BUILDING_NAMES[this.selectedBuilding]);
        } else {
          this._exitBuildMode();
        }
      } else {
        this.selectedBuilding = buildingId;
        this.ui.setBuildActive(buildingId);
        this._refreshPreview();
        this.ui.setPlaceHint(BUILDING_NAMES[buildingId]);
      }
    } finally {
      this._placingBuilding = false;
    }
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.post) resizePostPipeline(this.post, window.innerWidth, window.innerHeight);
    else this.composer.setSize(window.innerWidth, window.innerHeight);
  }
}
