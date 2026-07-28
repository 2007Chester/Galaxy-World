class_name GWConstants
extends RefCounted

const INVENTORY_SLOTS := 20
const BUILD_GRID_SIZE := 2.0
const GENERATOR_O2_RADIUS := 10.0
const GENERATOR_O2_RATE := 8.0
const PLANET_SIZE := 64
const PLANET_SCALE := 2.0
const TERRAIN_HEIGHT := 12.0

const SUIT_O2_DRAIN_IDLE := 0.5
const SUIT_O2_DRAIN_MOVE := 1.5
const SUIT_O2_DRAIN_MINE := 3.0
const SUIT_ENERGY_DRAIN_MOVE := 0.8
const SUIT_ENERGY_DRAIN_MINE := 2.5

const PLAYER_SPEED := 5.0
const PLAYER_SPRINT_MULT := 1.6
const PLAYER_JUMP_VELOCITY := 4.5
const MOUSE_SENSITIVITY := 0.002

const MINE_RANGE := 4.0
const MINE_DAMAGE := 25.0
const INTERACT_RANGE := 3.0

const LAYER_WORLD := 1
const LAYER_PLAYER := 2
const LAYER_RESOURCE := 4
const LAYER_BUILDING := 8

static func item_name(id: int) -> String:
	match id:
		GWTypes.ItemId.STONE: return "Stone"
		GWTypes.ItemId.IRON: return "Iron"
		GWTypes.ItemId.COPPER: return "Copper"
		GWTypes.ItemId.SILICON: return "Silicon"
		GWTypes.ItemId.ORGANIC: return "Organic"
		GWTypes.ItemId.METAL_PLATE: return "Metal Plate"
		GWTypes.ItemId.WIRE: return "Wire"
		GWTypes.ItemId.CIRCUIT: return "Circuit"
		GWTypes.ItemId.GENERATOR_ITEM: return "Generator"
		_: return "Unknown"

static func building_name(id: int) -> String:
	match id:
		GWTypes.BuildingId.FOUNDATION: return "Foundation"
		GWTypes.BuildingId.HABITAT: return "Habitat"
		GWTypes.BuildingId.STORAGE: return "Storage"
		GWTypes.BuildingId.GENERATOR: return "Generator"
		GWTypes.BuildingId.OXYGEN_STATION: return "Oxygen Station"
		_: return "Unknown"
