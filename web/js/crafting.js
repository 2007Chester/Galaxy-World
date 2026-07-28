import { BUILD_COSTS, RECIPES } from "./constants.js";

export class Crafting {
  constructor(inventory) {
    this.inventory = inventory;
    this.recipes = RECIPES;
  }

  canCraft(recipe) {
    return this.inventory.hasItems(recipe.inputs);
  }

  craft(recipe) {
    if (!this.canCraft(recipe)) return false;
    if (!this.inventory.consume(recipe.inputs)) return false;
    this.inventory.addItem(recipe.outputId, recipe.outputAmount);
    return true;
  }

  canBuild(buildingId) {
    const cost = BUILD_COSTS[buildingId] || {};
    return Object.keys(cost).length === 0 || this.inventory.hasItems(cost);
  }

  consumeBuild(buildingId) {
    const cost = BUILD_COSTS[buildingId] || {};
    if (Object.keys(cost).length === 0) return true;
    return this.inventory.consume(cost);
  }
}
