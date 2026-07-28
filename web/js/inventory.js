import { CONST, ITEM_NAMES, TOOL_ITEMS, ItemId } from "./constants.js";

export class Inventory {
  constructor() {
    this.slots = [];
    this.equippedTool = -1;
    this.tankLevel = 0;
    this.listeners = new Set();
    this.reset();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  reset() {
    this.slots = Array.from({ length: CONST.INVENTORY_SLOTS }, () => ({
      itemId: -1,
      amount: 0,
    }));
    this.equippedTool = -1;
    this.tankLevel = 0;
    this.emit();
  }

  oxygenCapacity() {
    return CONST.BASE_O2_CAPACITY + this.tankLevel * CONST.TANK_BONUS;
  }

  getCount(itemId) {
    return this.slots.reduce(
      (sum, slot) => (slot.itemId === itemId ? sum + slot.amount : sum),
      0
    );
  }

  hasItems(requirements) {
    return Object.entries(requirements).every(
      ([id, amount]) => this.getCount(Number(id)) >= amount
    );
  }

  addItem(itemId, amount = 1) {
    let remaining = amount;
    for (const slot of this.slots) {
      if (remaining <= 0) break;
      if (slot.itemId === itemId || slot.itemId === -1) {
        if (slot.itemId === -1) slot.itemId = itemId;
        const space = 99 - slot.amount;
        const add = Math.min(remaining, space);
        slot.amount += add;
        remaining -= add;
      }
    }
    if (remaining < amount) this.emit();
    return amount - remaining;
  }

  removeItem(itemId, amount = 1) {
    if (this.getCount(itemId) < amount) return false;
    let remaining = amount;
    for (const slot of this.slots) {
      if (remaining <= 0) break;
      if (slot.itemId === itemId) {
        const remove = Math.min(remaining, slot.amount);
        slot.amount -= remove;
        remaining -= remove;
        if (slot.amount <= 0) {
          slot.itemId = -1;
          slot.amount = 0;
        }
      }
    }
    if (this.equippedTool === itemId && this.getCount(itemId) <= 0) {
      this.equippedTool = -1;
    }
    this.emit();
    return true;
  }

  consume(requirements) {
    if (!this.hasItems(requirements)) return false;
    for (const [id, amount] of Object.entries(requirements)) {
      this.removeItem(Number(id), amount);
    }
    return true;
  }

  equipFromSlot(slotIndex) {
    const slot = this.slots[slotIndex];
    if (!slot || slot.itemId < 0) return false;
    if (TOOL_ITEMS.has(slot.itemId)) {
      this.equippedTool = slot.itemId;
      this.emit();
      return "tool";
    }
    if (slot.itemId === ItemId.O2_TANK) {
      if (this.tankLevel >= CONST.MAX_TANK_LEVEL) return false;
      if (this.removeItem(ItemId.O2_TANK, 1)) {
        this.tankLevel += 1;
        this.emit();
        return "tank";
      }
    }
    if (slot.itemId === ItemId.FOOD) {
      if (this.removeItem(ItemId.FOOD, 1)) return "food";
    }
    if (slot.itemId === ItemId.WATER) {
      if (this.removeItem(ItemId.WATER, 1)) return "water";
    }
    return false;
  }

  filledSlots() {
    return this.slots
      .filter((s) => s.itemId !== -1 && s.amount > 0)
      .map((s) => ({
        name: ITEM_NAMES[s.itemId] || "Unknown",
        amount: s.amount,
        itemId: s.itemId,
      }));
  }
}
