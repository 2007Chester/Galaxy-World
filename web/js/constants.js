export const ItemId = {
  STONE: 0,
  IRON: 1,
  COPPER: 2,
  SILICON: 3,
  ORGANIC: 4,
  METAL_PLATE: 5,
  WIRE: 6,
  CIRCUIT: 7,
  GENERATOR_ITEM: 8,
};

export const BuildingId = {
  FOUNDATION: 0,
  HABITAT: 1,
  STORAGE: 2,
  GENERATOR: 3,
  OXYGEN_STATION: 4,
};

export const ITEM_NAMES = {
  [ItemId.STONE]: "Stone",
  [ItemId.IRON]: "Iron",
  [ItemId.COPPER]: "Copper",
  [ItemId.SILICON]: "Silicon",
  [ItemId.ORGANIC]: "Organic",
  [ItemId.METAL_PLATE]: "Metal Plate",
  [ItemId.WIRE]: "Wire",
  [ItemId.CIRCUIT]: "Circuit",
  [ItemId.GENERATOR_ITEM]: "Generator",
};

export const BUILDING_NAMES = {
  [BuildingId.FOUNDATION]: "Foundation",
  [BuildingId.HABITAT]: "Habitat",
  [BuildingId.STORAGE]: "Storage",
  [BuildingId.GENERATOR]: "Generator",
  [BuildingId.OXYGEN_STATION]: "Oxygen Station",
};

export const ITEM_COLORS = {
  [ItemId.STONE]: 0x808080,
  [ItemId.IRON]: 0x8c5a40,
  [ItemId.COPPER]: 0xcc7333,
  [ItemId.SILICON]: 0x4db3e6,
  [ItemId.ORGANIC]: 0x33b34d,
};

export const CONST = {
  INVENTORY_SLOTS: 20,
  BUILD_GRID: 2,
  GENERATOR_O2_RADIUS: 10,
  GENERATOR_O2_RATE: 8,
  PLANET_SIZE: 64,
  PLANET_SCALE: 2,
  TERRAIN_HEIGHT: 12,
  PLAYER_SPEED: 5,
  PLAYER_SPRINT: 1.6,
  JUMP: 6.5,
  GRAVITY: 18,
  MOUSE_SENS: 0.002,
  MINE_RANGE: 4,
  MINE_DAMAGE: 25,
  INTERACT_RANGE: 3,
  O2_IDLE: 0.5,
  O2_MOVE: 1.5,
  O2_MINE: 3.0,
  ENERGY_MOVE: 0.8,
  ENERGY_MINE: 2.5,
};

export const RECIPES = [
  {
    id: "metal_plate",
    name: "Metal Plate",
    outputId: ItemId.METAL_PLATE,
    outputAmount: 1,
    inputs: { [ItemId.IRON]: 2 },
  },
  {
    id: "wire",
    name: "Wire",
    outputId: ItemId.WIRE,
    outputAmount: 2,
    inputs: { [ItemId.COPPER]: 1 },
  },
  {
    id: "circuit",
    name: "Circuit",
    outputId: ItemId.CIRCUIT,
    outputAmount: 1,
    inputs: { [ItemId.SILICON]: 1, [ItemId.WIRE]: 1 },
  },
  {
    id: "generator",
    name: "Generator",
    outputId: ItemId.GENERATOR_ITEM,
    outputAmount: 1,
    inputs: { [ItemId.METAL_PLATE]: 4, [ItemId.CIRCUIT]: 2 },
  },
];

export const BUILD_COSTS = {
  [BuildingId.FOUNDATION]: { [ItemId.STONE]: 2 },
  [BuildingId.HABITAT]: { [ItemId.METAL_PLATE]: 4, [ItemId.ORGANIC]: 2 },
  [BuildingId.STORAGE]: { [ItemId.METAL_PLATE]: 3 },
  [BuildingId.GENERATOR]: { [ItemId.GENERATOR_ITEM]: 1 },
  [BuildingId.OXYGEN_STATION]: { [ItemId.METAL_PLATE]: 2, [ItemId.CIRCUIT]: 1 },
};

export const EVA_MESSAGES = {
  start:
    "Пилот, критическое повреждение корабля. Связь с Землёй отсутствует. Координаты неизвестны. Рекомендуемая задача: выжить.",
  firstMine: "Отлично. Ресурсы — основа выживания.",
  firstCraft: "Технологии восстанавливаются по одному шагу.",
  firstBuild: "База — ваш дом в этой галактике.",
  auroraCore: "Сигнал от главного ядра Aurora. Мы на верном пути.",
};
