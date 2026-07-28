export const ItemId = {
  WOOD: 0,
  CLAY: 1,
  STONE: 2,
  IRON: 3,
  COPPER: 4,
  SILICON: 5,
  ORGANIC: 6,
  FOOD: 7,
  WATER: 8,
  SEEDS: 9,
  WRECK_PART: 10,
  METAL_PLATE: 11,
  WIRE: 12,
  CIRCUIT: 13,
  AXE: 14,
  SHOVEL: 15,
  KNIFE: 16,
  PICKAXE: 17,
  O2_TANK: 18,
  O2_GENERATOR: 19,
  SHIP_KIT: 20,
  BUCKET: 21,
};

export const BuildingId = {
  FOUNDATION: 0,
  HABITAT: 1,
  STORAGE: 2,
  GENERATOR: 3,
  OXYGEN_STATION: 4,
  HANGAR: 5,
  O2_FILLER: 6,
  FARM_PLOT: 7,
};

export const ToolId = {
  NONE: -1,
  AXE: ItemId.AXE,
  SHOVEL: ItemId.SHOVEL,
  KNIFE: ItemId.KNIFE,
  PICKAXE: ItemId.PICKAXE,
};

export const ITEM_NAMES = {
  [ItemId.WOOD]: "Дерево",
  [ItemId.CLAY]: "Глина",
  [ItemId.STONE]: "Камень",
  [ItemId.IRON]: "Железо",
  [ItemId.COPPER]: "Медь",
  [ItemId.SILICON]: "Кремний",
  [ItemId.ORGANIC]: "Органика",
  [ItemId.FOOD]: "Еда",
  [ItemId.WATER]: "Вода",
  [ItemId.SEEDS]: "Семена",
  [ItemId.WRECK_PART]: "Обломок корабля",
  [ItemId.METAL_PLATE]: "Металл. пластина",
  [ItemId.WIRE]: "Провод",
  [ItemId.CIRCUIT]: "Схема",
  [ItemId.AXE]: "Топор",
  [ItemId.SHOVEL]: "Лопата",
  [ItemId.KNIFE]: "Нож",
  [ItemId.PICKAXE]: "Кирка",
  [ItemId.O2_TANK]: "O₂ баллон+",
  [ItemId.O2_GENERATOR]: "O₂ генератор",
  [ItemId.SHIP_KIT]: "Набор корабля",
  [ItemId.BUCKET]: "Ведро",
};

export const BUILDING_NAMES = {
  [BuildingId.FOUNDATION]: "Фундамент",
  [BuildingId.HABITAT]: "Жилой модуль",
  [BuildingId.STORAGE]: "Склад",
  [BuildingId.GENERATOR]: "Генератор",
  [BuildingId.OXYGEN_STATION]: "O₂ станция",
  [BuildingId.HANGAR]: "Ангар",
  [BuildingId.O2_FILLER]: "Заправка O₂",
  [BuildingId.FARM_PLOT]: "Грядка",
};

export const ITEM_COLORS = {
  [ItemId.WOOD]: 0x8b5a2b,
  [ItemId.CLAY]: 0xb87333,
  [ItemId.STONE]: 0x808080,
  [ItemId.IRON]: 0x8c5a40,
  [ItemId.COPPER]: 0xcc7333,
  [ItemId.SILICON]: 0x4db3e6,
  [ItemId.ORGANIC]: 0x33b34d,
  [ItemId.FOOD]: 0xe07050,
  [ItemId.WATER]: 0x4a9eff,
  [ItemId.SEEDS]: 0xc4a035,
  [ItemId.WRECK_PART]: 0x6a7a8a,
};

/** Preferred tool + bare-hand multiplier (0–1). With preferred tool = 1.0 */
export const GATHER_RULES = {
  [ItemId.WOOD]: { tool: ItemId.AXE, bare: 0.65 },
  [ItemId.CLAY]: { tool: ItemId.SHOVEL, bare: 0.65 },
  [ItemId.STONE]: { tool: ItemId.PICKAXE, bare: 0.3 },
  [ItemId.IRON]: { tool: ItemId.PICKAXE, bare: 0.25 },
  [ItemId.COPPER]: { tool: ItemId.PICKAXE, bare: 0.25 },
  [ItemId.SILICON]: { tool: ItemId.PICKAXE, bare: 0.25 },
  [ItemId.ORGANIC]: { tool: ItemId.KNIFE, bare: 0.5 },
  [ItemId.FOOD]: { tool: ItemId.KNIFE, bare: 0.4 },
  [ItemId.WATER]: { tool: ItemId.BUCKET, bare: 0 },
  [ItemId.SEEDS]: { tool: -1, bare: 1.0 },
  [ItemId.WRECK_PART]: { tool: -1, bare: 1.0 },
};

export const TOOL_ITEMS = new Set([
  ItemId.AXE,
  ItemId.SHOVEL,
  ItemId.KNIFE,
  ItemId.PICKAXE,
  ItemId.BUCKET,
]);

export const CONST = {
  INVENTORY_SLOTS: 28,
  BUILD_GRID: 2,
  GENERATOR_O2_RADIUS: 10,
  GENERATOR_O2_RATE: 8,
  O2_FILLER_RADIUS: 8,
  O2_FILLER_RATE: 18,
  CHUNK_SIZE: 32,
  CHUNK_RES: 16,
  CHUNK_LOAD_RADIUS: 2,
  TERRAIN_HEIGHT: 10,
  WATER_LEVEL: -1.2,
  PLAYER_SPEED: 5,
  PLAYER_SPRINT: 1.6,
  JUMP: 6.5,
  GRAVITY: 18,
  MOUSE_SENS: 0.002,
  MINE_RANGE: 4.5,
  MINE_DAMAGE: 22,
  INTERACT_RANGE: 3.5,
  O2_IDLE: 0.45,
  O2_MOVE: 1.2,
  O2_MINE: 2.2,
  ENERGY_MOVE: 0.7,
  ENERGY_MINE: 2.0,
  HUNGER_DRAIN: 0.15,
  THIRST_DRAIN: 0.22,
  FOOD_RESTORE: 35,
  WATER_RESTORE: 40,
  BASE_O2_CAPACITY: 100,
  TANK_BONUS: 40,
  SHIP_PARTS_NEEDED: 8,
  MAX_TANK_LEVEL: 5,
};

export const RECIPES = [
  {
    id: "axe",
    name: "Топор",
    outputId: ItemId.AXE,
    outputAmount: 1,
    inputs: { [ItemId.WOOD]: 5, [ItemId.STONE]: 2 },
  },
  {
    id: "shovel",
    name: "Лопата",
    outputId: ItemId.SHOVEL,
    outputAmount: 1,
    inputs: { [ItemId.WOOD]: 4, [ItemId.STONE]: 1 },
  },
  {
    id: "knife",
    name: "Нож",
    outputId: ItemId.KNIFE,
    outputAmount: 1,
    inputs: { [ItemId.WOOD]: 2, [ItemId.STONE]: 2 },
  },
  {
    id: "pickaxe",
    name: "Кирка",
    outputId: ItemId.PICKAXE,
    outputAmount: 1,
    inputs: { [ItemId.WOOD]: 3, [ItemId.STONE]: 4 },
  },
  {
    id: "bucket",
    name: "Ведро",
    outputId: ItemId.BUCKET,
    outputAmount: 1,
    inputs: { [ItemId.WOOD]: 3, [ItemId.CLAY]: 4 },
  },
  {
    id: "metal_plate",
    name: "Металл. пластина",
    outputId: ItemId.METAL_PLATE,
    outputAmount: 1,
    inputs: { [ItemId.IRON]: 2 },
  },
  {
    id: "wire",
    name: "Провод",
    outputId: ItemId.WIRE,
    outputAmount: 2,
    inputs: { [ItemId.COPPER]: 1 },
  },
  {
    id: "circuit",
    name: "Схема",
    outputId: ItemId.CIRCUIT,
    outputAmount: 1,
    inputs: { [ItemId.SILICON]: 1, [ItemId.WIRE]: 1 },
  },
  {
    id: "o2_generator",
    name: "O₂ генератор",
    outputId: ItemId.O2_GENERATOR,
    outputAmount: 1,
    inputs: { [ItemId.METAL_PLATE]: 3, [ItemId.CIRCUIT]: 1, [ItemId.ORGANIC]: 4 },
  },
  {
    id: "o2_tank",
    name: "Улучшение баллона O₂",
    outputId: ItemId.O2_TANK,
    outputAmount: 1,
    inputs: { [ItemId.METAL_PLATE]: 2, [ItemId.SILICON]: 1, [ItemId.CIRCUIT]: 1 },
  },
  {
    id: "ship_kit",
    name: "Набор корабля",
    outputId: ItemId.SHIP_KIT,
    outputAmount: 1,
    inputs: {
      [ItemId.WRECK_PART]: CONST.SHIP_PARTS_NEEDED,
      [ItemId.METAL_PLATE]: 6,
      [ItemId.CIRCUIT]: 3,
    },
  },
];

export const BUILD_COSTS = {
  [BuildingId.FOUNDATION]: { [ItemId.STONE]: 2, [ItemId.CLAY]: 1 },
  [BuildingId.HABITAT]: { [ItemId.WOOD]: 6, [ItemId.CLAY]: 4 },
  [BuildingId.STORAGE]: { [ItemId.WOOD]: 4, [ItemId.STONE]: 2 },
  [BuildingId.GENERATOR]: { [ItemId.METAL_PLATE]: 4, [ItemId.CIRCUIT]: 2 },
  [BuildingId.OXYGEN_STATION]: { [ItemId.METAL_PLATE]: 2, [ItemId.CIRCUIT]: 1 },
  [BuildingId.HANGAR]: { [ItemId.WOOD]: 20, [ItemId.CLAY]: 16, [ItemId.STONE]: 8 },
  [BuildingId.O2_FILLER]: { [ItemId.O2_GENERATOR]: 1, [ItemId.METAL_PLATE]: 2 },
  [BuildingId.FARM_PLOT]: { [ItemId.WOOD]: 3, [ItemId.CLAY]: 3, [ItemId.SEEDS]: 1 },
};

export const EVA_MESSAGES = {
  start:
    "Пилот, Aurora разбита. Соберите дерево (E) и сделайте топор. Для воды скрафтите ведро из дерева и глины, экипируйте и наберите из озера/реки/моря.",
  firstMine: "Ресурсы есть. Крафтите инструменты — с ними добыча быстрее.",
  firstCraft: "Инструмент готов. Экипируйте его в инвентаре (клик по предмету).",
  needBucket: "Чтобы набрать воду, скрафтите ведро (дерево + глина) и экипируйте его в инвентаре.",
  firstBuild: "База растёт. Для космолёта нужен ангар из дерева и глины.",
  hangar:
    "Ангар готов. Соберите обломки Aurora и скрафтите «Набор корабля», затем установите корабль у ангара (E).",
  shipReady:
    "Корабль собран. Подойдите к нему и нажмите F — выход в космос и новые планеты.",
  newPlanet: "Новая планета. Кислород, еда и вода — ваш лимит выживания. Исследуйте.",
  auroraCore:
    "Ядро Aurora найдено. Продолжайте: инструменты → ангар → корабль → новые миры.",
  auroraCoreRepeat: "Ядро уже просканировано.",
};

export function gatherMultiplier(itemId, equippedTool) {
  const rule = GATHER_RULES[itemId];
  if (!rule) return 1;
  if (rule.tool < 0) return 1;
  if (equippedTool === rule.tool) return 1;
  return rule.bare;
}
