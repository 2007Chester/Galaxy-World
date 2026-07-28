import {
  BUILDING_NAMES,
  BUILD_COSTS,
  ITEM_NAMES,
  ItemId,
  RECIPES,
  TOOL_ITEMS,
} from "./constants.js";

export class UI {
  constructor() {
    this.mainMenu = document.getElementById("main-menu");
    this.hud = document.getElementById("hud");
    this.inventoryPanel = document.getElementById("inventory-panel");
    this.craftPanel = document.getElementById("craft-panel");
    this.buildPanel = document.getElementById("build-panel");
    this.completePanel = document.getElementById("complete-panel");
    this.evaBox = document.getElementById("eva-box");
    this.evaText = document.getElementById("eva-text");
    this.hint = document.getElementById("hint-label");
    this.recipeList = document.getElementById("recipe-list");
    this.craftStatus = document.getElementById("craft-status");
    this.buildList = document.getElementById("build-list");
    this.inventorySlots = document.getElementById("inventory-slots");
    this.crosshair = document.getElementById("crosshair");
    this.vignette = document.getElementById("vignette");
    this.toolLabel = document.getElementById("tool-value");
    this.modeLabel = document.getElementById("mode-value");
    this.mineProgress = document.getElementById("mine-progress");
    this.mineProgressLabel = document.getElementById("mine-progress-label");
    this.mineBarFill = document.getElementById("mine-bar-fill");
    this.lootToast = document.getElementById("loot-toast");
    this.lootToastTimer = 0;
    this.selectedRecipe = 0;
    this.selectedSlot = -1;
    this.evaTimer = 0;
    this.crosshairFlash = 0;
    this.onPanelChange = null;
    this.onEquipSlot = null;
    this._inventoryRef = null;
    this._bindRecipes();
    this._bindBuildings();
    this._bindPanelClicks();
  }

  _bindPanelClicks() {
    for (const panel of [
      this.inventoryPanel,
      this.craftPanel,
      this.buildPanel,
      this.completePanel,
      this.mainMenu,
    ]) {
      if (!panel) continue;
      panel.addEventListener("mousedown", (e) => e.stopPropagation());
      panel.addEventListener("mouseup", (e) => e.stopPropagation());
      panel.addEventListener("click", (e) => e.stopPropagation());
    }
  }

  syncPointerLock() {
    const open = this.isUiBlocking();
    if (open) document.exitPointerLock?.();
    document.body.classList.toggle("ui-open", open);
    this.crosshair?.classList.toggle("hidden-soft", open);
    this.onPanelChange?.(open);
    return open;
  }

  isUiBlocking() {
    return (
      !this.inventoryPanel.classList.contains("hidden") ||
      !this.craftPanel.classList.contains("hidden") ||
      !this.buildPanel.classList.contains("hidden") ||
      !this.completePanel.classList.contains("hidden") ||
      !this.mainMenu.classList.contains("hidden")
    );
  }

  _bindRecipes() {
    this.recipeList.innerHTML = "";
    RECIPES.forEach((recipe, index) => {
      const el = document.createElement("div");
      el.className = "recipe" + (index === 0 ? " active" : "");
      el.textContent = recipe.name;
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectedRecipe = index;
        [...this.recipeList.children].forEach((c, i) =>
          c.classList.toggle("active", i === index)
        );
        this.updateCraftStatus(this._inventoryRef);
      });
      this.recipeList.appendChild(el);
    });
  }

  _bindBuildings(onSelect, inventory = null) {
    this._buildSelectHandler = onSelect || this._buildSelectHandler;
    this.buildList.innerHTML = "";
    let visibleIndex = 0;
    Object.entries(BUILDING_NAMES).forEach(([id, name]) => {
      const buildingId = Number(id);
      const cost = BUILD_COSTS[id] || {};
      // Hangar only appears once the player can afford it
      if (buildingId === 5) {
        const canHangar = inventory?.hasItems?.(cost);
        if (!canHangar) return;
      }
      visibleIndex += 1;
      const costText = Object.entries(cost)
        .map(([item, amount]) => `${ITEM_NAMES[item]} x${amount}`)
        .join(", ");
      const el = document.createElement("div");
      el.className = "build-item";
      el.dataset.id = id;
      el.innerHTML = `<strong>${visibleIndex}. ${name}</strong><br/><small>${costText}</small>`;
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._buildSelectHandler?.(buildingId);
      });
      this.buildList.appendChild(el);
    });
  }

  setBuildHandler(fn) {
    this._buildSelectHandler = fn;
    this._bindBuildings(fn, this._inventoryRef);
  }

  /** Refresh build list (e.g. unlock hangar when resources are ready). */
  refreshBuildList(inventory) {
    this._inventoryRef = inventory || this._inventoryRef;
    this._bindBuildings(this._buildSelectHandler, this._inventoryRef);
  }

  getVisibleBuildingIds() {
    return [...this.buildList.children].map((el) => Number(el.dataset.id));
  }

  showMenu() {
    this.mainMenu.classList.remove("hidden");
    this.hud.classList.add("hidden");
    this.inventoryPanel.classList.add("hidden");
    this.craftPanel.classList.add("hidden");
    this.buildPanel.classList.add("hidden");
    this.completePanel.classList.add("hidden");
    this.vignette?.classList.add("hidden");
    this.refreshSaveMenu?.();
  }

  showGame() {
    this.mainMenu.classList.add("hidden");
    this.hud.classList.remove("hidden");
    this.completePanel.classList.add("hidden");
    this.vignette?.classList.remove("hidden");
  }

  showComplete() {
    this.completePanel.classList.remove("hidden");
    document.exitPointerLock?.();
  }

  toggleInventory(force) {
    this._toggle(this.inventoryPanel, force);
    this.syncPointerLock();
  }

  toggleCraft(force) {
    this._toggle(this.craftPanel, force);
    this.syncPointerLock();
  }

  toggleBuild(force) {
    this._toggle(this.buildPanel, force);
    if (!this.buildPanel.classList.contains("hidden")) {
      this.hint.textContent =
        "Мышь свободна: клик по модулю или 1–8. ЛКМ по миру — поставить. Esc — закрыть";
    } else {
      this.hint.textContent =
        "WASD | Shift бег | E добыча / взаимодействие | F корабль | Esc/M меню | Tab инвентарь | C крафт | B стройка";
    }
    this.syncPointerLock();
  }

  isOverlayOpen() {
    return this.isUiBlocking();
  }

  buildModeOpen() {
    return !this.buildPanel.classList.contains("hidden");
  }

  updateStats(stats, meta = {}) {
    const cap = meta.capacity || 100;
    document.getElementById("bar-o2").style.transform = `scaleX(${Math.min(1, stats.oxygen / cap)})`;
    document.getElementById("bar-energy").style.transform = `scaleX(${stats.energy / 100})`;
    document.getElementById("bar-health").style.transform = `scaleX(${stats.health / 100})`;
    document.getElementById("bar-hunger").style.transform = `scaleX(${(stats.hunger ?? 100) / 100})`;
    document.getElementById("bar-thirst").style.transform = `scaleX(${(stats.thirst ?? 100) / 100})`;
    document.getElementById("temp-value").textContent = `${Math.round(stats.temperature)}°C`;

    if (this.toolLabel) {
      const tool =
        meta.tool >= 0 && TOOL_ITEMS.has(meta.tool)
          ? ITEM_NAMES[meta.tool]
          : "руками";
      const tank = meta.tank > 0 ? ` | O₂ ур.${meta.tank}` : "";
      this.toolLabel.textContent = `${tool}${tank}`;
    }
    if (this.modeLabel) {
      const mode = meta.mode === "space" ? "Космос" : `Планета #${meta.planet ?? 0}`;
      this.modeLabel.textContent = mode;
    }

    const lowO2 = stats.oxygen < cap * 0.25;
    const lowEnergy = stats.energy < 20;
    const lowHunger = (stats.hunger ?? 100) < 25;
    const lowThirst = (stats.thirst ?? 100) < 25;
    document.getElementById("bar-o2").parentElement.parentElement.classList.toggle("critical", lowO2);
    document.getElementById("bar-energy").parentElement.parentElement.classList.toggle("warn", lowEnergy);
    document.getElementById("bar-hunger").parentElement.parentElement.classList.toggle("warn", lowHunger);
    document.getElementById("bar-thirst").parentElement.parentElement.classList.toggle("warn", lowThirst);

    if (this.vignette) {
      const danger = Math.max(0, 1 - stats.oxygen / (cap * 0.25)) * 0.55;
      this.vignette.style.opacity = String(0.35 + danger);
      this.vignette.classList.toggle("critical", lowO2);
    }
  }

  updateInventory(inventory) {
    this._inventoryRef = inventory;
    this.refreshBuildList(inventory);
    this.inventorySlots.innerHTML = "";
    inventory.slots.forEach((slot, index) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "slot";
      const empty = slot.itemId === -1 || slot.amount <= 0;
      el.disabled = empty;
      if (empty) {
        el.textContent = "—";
      } else {
        const equipped =
          TOOL_ITEMS.has(slot.itemId) && inventory.equippedTool === slot.itemId
            ? " ★"
            : "";
        el.textContent = `${ITEM_NAMES[slot.itemId]} x${slot.amount}${equipped}`;
      }
      if (!empty && this.selectedSlot === index) el.classList.add("active");
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (empty) return;
        this.selectedSlot = index;
        this.onEquipSlot?.(index);
        this.updateInventory(inventory);
        const id = slot.itemId;
        if (TOOL_ITEMS.has(id)) {
          this.hint.textContent = `Клик: экипировать ${ITEM_NAMES[id]}`;
        } else if (id === ItemId.FOOD || id === ItemId.WATER) {
          this.hint.textContent = `Клик: съесть/выпить ${ITEM_NAMES[id]}`;
        } else if (id === ItemId.O2_TANK) {
          this.hint.textContent = "Клик: улучшить кислородный баллон";
        } else {
          this.hint.textContent = `Выбрано: ${ITEM_NAMES[id]} x${slot.amount}`;
        }
      });
      this.inventorySlots.appendChild(el);
    });
    this.updateCraftStatus(inventory);
  }

  updateCraftStatus(inventory) {
    const recipe = RECIPES[this.selectedRecipe];
    if (!recipe) {
      this.craftStatus.textContent = "Выберите рецепт";
      return;
    }
    const needs = Object.entries(recipe.inputs)
      .map(([id, amount]) => `${ITEM_NAMES[id]} x${amount}`)
      .join(", ");
    const ok = inventory ? inventory.hasItems(recipe.inputs) : false;
    this.craftStatus.textContent = `Нужно: ${needs}${ok ? " ✓" : ""}`;
  }

  showEva(text, seconds = 7) {
    this.evaText.textContent = "";
    this.evaBox.classList.remove("hidden");
    this.evaBox.classList.add("typing");
    this.evaTimer = seconds;
    let i = 0;
    const tick = () => {
      if (i <= text.length) {
        this.evaText.textContent = text.slice(0, i);
        i++;
        setTimeout(tick, 18);
      } else {
        this.evaBox.classList.remove("typing");
      }
    };
    tick();
  }

  setCrosshairMining(active) {
    this.crosshair?.classList.toggle("mining", active);
    if (!active) this.setMiningProgress(null);
  }

  /**
   * @param {{ progress:number, name:string, amount?:number } | null} info
   * progress 0..1 = how much already mined
   */
  setMiningProgress(info) {
    if (!this.mineProgress) return;
    if (!info) {
      this.mineProgress.classList.add("hidden");
      return;
    }
    const p = Math.max(0, Math.min(1, info.progress));
    this.mineProgress.classList.remove("hidden");
    if (this.mineBarFill) this.mineBarFill.style.transform = `scaleX(${p})`;
    const pct = Math.round(p * 100);
    const left = Math.max(0, 100 - pct);
    if (this.mineProgressLabel) {
      const drop =
        info.amount != null ? ` · добыча ×${info.amount}` : "";
      this.mineProgressLabel.textContent = `${info.name}${drop} · осталось ${left}%`;
    }
  }

  showLootToast(name, amount) {
    if (!this.lootToast) return;
    this.lootToast.textContent = `+${amount} ${name}`;
    this.lootToast.classList.remove("hidden");
    // restart CSS animation
    this.lootToast.style.animation = "none";
    void this.lootToast.offsetWidth;
    this.lootToast.style.animation = "";
    this.lootToastTimer = 0.9;
  }

  flashCrosshair() {
    this.crosshairFlash = 0.12;
    this.crosshair?.classList.add("hit");
  }

  update(delta) {
    if (this.evaTimer > 0) {
      this.evaTimer -= delta;
      if (this.evaTimer <= 0) this.evaBox.classList.add("hidden");
    }
    if (this.crosshairFlash > 0) {
      this.crosshairFlash -= delta;
      if (this.crosshairFlash <= 0) this.crosshair?.classList.remove("hit");
    }
    if (this.lootToastTimer > 0) {
      this.lootToastTimer -= delta;
      if (this.lootToastTimer <= 0) this.lootToast?.classList.add("hidden");
    }
  }

  setBuildActive(id) {
    [...this.buildList.children].forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.id) === id);
    });
  }

  _toggle(el, force) {
    if (typeof force === "boolean") {
      el.classList.toggle("hidden", !force);
      return;
    }
    el.classList.toggle("hidden");
  }
}
