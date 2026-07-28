import {
  BUILDING_NAMES,
  BUILD_COSTS,
  ITEM_NAMES,
  RECIPES,
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
    this.selectedRecipe = 0;
    this.selectedSlot = -1;
    this.evaTimer = 0;
    this.crosshairFlash = 0;
    this.onPanelChange = null;
    this._bindRecipes();
    this._bindBuildings();
    this._bindPanelClicks();
  }

  _bindPanelClicks() {
    for (const panel of [this.inventoryPanel, this.craftPanel, this.buildPanel, this.completePanel, this.mainMenu]) {
      if (!panel) continue;
      panel.addEventListener("mousedown", (e) => e.stopPropagation());
      panel.addEventListener("mouseup", (e) => e.stopPropagation());
      panel.addEventListener("click", (e) => e.stopPropagation());
    }
  }

  /** Release mouse when UI needs clicks; return true if a panel is open. */
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
        // Prefer live inventory if game attached it
        this.updateCraftStatus(this._inventoryRef);
      });
      this.recipeList.appendChild(el);
    });
  }

  _bindBuildings(onSelect) {
    this.buildList.innerHTML = "";
    Object.entries(BUILDING_NAMES).forEach(([id, name]) => {
      const cost = BUILD_COSTS[id] || {};
      const costText = Object.entries(cost)
        .map(([item, amount]) => `${ITEM_NAMES[item]} x${amount}`)
        .join(", ");
      const el = document.createElement("div");
      el.className = "build-item";
      el.dataset.id = id;
      el.innerHTML = `<strong>${Number(id) + 1}. ${name}</strong><br/><small>${costText}</small>`;
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect?.(Number(id));
      });
      this.buildList.appendChild(el);
    });
  }

  setBuildHandler(fn) {
    this._bindBuildings(fn);
  }

  showMenu() {
    this.mainMenu.classList.remove("hidden");
    this.hud.classList.add("hidden");
    this.inventoryPanel.classList.add("hidden");
    this.craftPanel.classList.add("hidden");
    this.buildPanel.classList.add("hidden");
    this.completePanel.classList.add("hidden");
    this.vignette?.classList.add("hidden");
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
        "Мышь свободна: выберите модуль кликом или 1–5. Клик по миру — снова захват. ЛКМ — поставить";
    } else {
      this.hint.textContent =
        "WASD — движение | Shift — бег | ЛКМ — добыча | E — взаимодействие | Tab — инвентарь | C — крафт | B — строительство";
    }
    this.syncPointerLock();
  }

  isOverlayOpen() {
    return this.isUiBlocking();
  }

  buildModeOpen() {
    return !this.buildPanel.classList.contains("hidden");
  }

  updateStats(stats) {
    document.getElementById("bar-o2").style.transform = `scaleX(${stats.oxygen / 100})`;
    document.getElementById("bar-energy").style.transform = `scaleX(${stats.energy / 100})`;
    document.getElementById("bar-health").style.transform = `scaleX(${stats.health / 100})`;
    document.getElementById("temp-value").textContent = `${Math.round(stats.temperature)}°C`;

    const lowO2 = stats.oxygen < 25;
    const lowEnergy = stats.energy < 20;
    document.getElementById("bar-o2").parentElement.parentElement.classList.toggle("critical", lowO2);
    document.getElementById("bar-energy").parentElement.parentElement.classList.toggle("warn", lowEnergy);

    if (this.vignette) {
      const danger = Math.max(0, 1 - stats.oxygen / 25) * 0.55;
      this.vignette.style.opacity = String(0.35 + danger);
      this.vignette.classList.toggle("critical", lowO2);
    }
  }

  updateInventory(inventory) {
    this._inventoryRef = inventory;
    this.inventorySlots.innerHTML = "";
    inventory.slots.forEach((slot, index) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "slot";
      const empty = slot.itemId === -1 || slot.amount <= 0;
      el.disabled = empty;
      el.textContent = empty ? "—" : `${ITEM_NAMES[slot.itemId]} x${slot.amount}`;
      if (!empty && this.selectedSlot === index) el.classList.add("active");
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (empty) return;
        this.selectedSlot = index;
        this.updateInventory(inventory);
        const name = ITEM_NAMES[slot.itemId];
        this.hint.textContent = `Выбрано: ${name} x${slot.amount}. Откройте крафт (C), чтобы создать предметы.`;
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

