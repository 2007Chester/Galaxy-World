import { CONST, ITEM_NAMES } from "./constants.js";

export class Inventory {
  constructor() {
    this.slots = Array.from({ length: CONST.INVENTORY_SLOTS }, () => ({
      itemId: -1,
      amount: 0,
    }));
    this.listeners = new Set();
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
    this.emit();
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
