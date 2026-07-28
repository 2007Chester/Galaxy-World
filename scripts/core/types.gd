class_name GWTypes
extends RefCounted

enum ItemId {
	STONE,
	IRON,
	COPPER,
	SILICON,
	ORGANIC,
	METAL_PLATE,
	WIRE,
	CIRCUIT,
	GENERATOR_ITEM,
}

enum BuildingId {
	FOUNDATION,
	HABITAT,
	STORAGE,
	GENERATOR,
	OXYGEN_STATION,
}

enum GameMode {
	SURVIVAL,
	CREATIVE,
	EXPLORER,
	HARDCORE,
}

enum GameState {
	MAIN_MENU,
	PLAYING,
	PAUSED,
	GAME_OVER,
	COMPLETE,
}

class PlanetConfig:
	var seed: int = 42
	var gravity: float = 9.8
	var has_atmosphere: bool = true
	var temperature: float = 22.0
	var planet_name: String = "Unknown Sector-7"


class SuitStats:
	var oxygen: float = 100.0
	var energy: float = 100.0
	var health: float = 100.0
	var temperature: float = 22.0

	func reset() -> void:
		oxygen = 100.0
		energy = 100.0
		health = 100.0
		temperature = 22.0
