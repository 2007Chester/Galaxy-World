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
    this.selectedRecipe = 0;
    this.evaTimer = 0;
    this._bindRecipes();
    this._bindBuildings();
  }

  _bindRecipes() {
    this.recipeList.innerHTML = "";
    RECIPES.forEach((recipe, index) => {
      const el = document.createElement("div");
      el.className = "recipe" + (index === 0 ? " active" : "");
      el.textContent = recipe.name;
      el.addEventListener("click", () => {
        this.selectedRecipe = index;
        [...this.recipeList.children].forEach((c, i) =>
          c.classList.toggle("active", i === index)
        );
        this.updateCraftStatus();
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
      el.addEventListener("click", () => onSelect?.(Number(id)));
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
  }

  showGame() {
    this.mainMenu.classList.add("hidden");
    this.hud.classList.remove("hidden");
    this.completePanel.classList.add("hidden");
  }

  showComplete() {
    this.completePanel.classList.remove("hidden");
    document.exitPointerLock?.();
  }

  toggleInventory(force) {
    this._toggle(this.inventoryPanel, force);
  }

  toggleCraft(force) {
    this._toggle(this.craftPanel, force);
  }

  toggleBuild(force) {
    this._toggle(this.buildPanel, force);
    if (!this.buildPanel.classList.contains("hidden")) {
      this.hint.textContent = "B — выход | 1-5 модуль | ЛКМ — поставить";
    } else {
      this.hint.textContent =
        "WASD — движение | ЛКМ — добыча | E — взаимодействие | Tab — инвентарь | C — крафт | B — строительство";
    }
  }

  isOverlayOpen() {
    return (
      !this.inventoryPanel.classList.contains("hidden") ||
      !this.craftPanel.classList.contains("hidden") ||
      !this.buildPanel.classList.contains("hidden") ||
      !this.completePanel.classList.contains("hidden") ||
      !this.mainMenu.classList.contains("hidden")
    );
  }

  buildModeOpen() {
    return !this.buildPanel.classList.contains("hidden");
  }

  updateStats(stats) {
    document.getElementById("bar-o2").style.transform = `scaleX(${stats.oxygen / 100})`;
    document.getElementById("bar-energy").style.transform = `scaleX(${stats.energy / 100})`;
    document.getElementById("bar-health").style.transform = `scaleX(${stats.health / 100})`;
    document.getElementById("temp-value").textContent = `${Math.round(stats.temperature)}°C`;
  }

  updateInventory(inventory) {
    this.inventorySlots.innerHTML = "";
    for (const slot of inventory.slots) {
      const el = document.createElement("div");
      el.className = "slot";
      el.textContent =
        slot.itemId === -1 || slot.amount <= 0
          ? "—"
          : `${ITEM_NAMES[slot.itemId]} x${slot.amount}`;
      this.inventorySlots.appendChild(el);
    }
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

  showEva(text, seconds = 6) {
    this.evaText.textContent = text;
    this.evaBox.classList.remove("hidden");
    this.evaTimer = seconds;
  }

  update(delta) {
    if (this.evaTimer > 0) {
      this.evaTimer -= delta;
      if (this.evaTimer <= 0) this.evaBox.classList.add("hidden");
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
