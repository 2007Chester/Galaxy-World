extends Node

var recipes: Array = []

func _ready() -> void:
	_setup_recipes()

func _setup_recipes() -> void:
	recipes = [
		{
			"id": "metal_plate",
			"name": "Metal Plate",
			"output_id": GWTypes.ItemId.METAL_PLATE,
			"output_amount": 1,
			"inputs": {GWTypes.ItemId.IRON: 2},
		},
		{
			"id": "wire",
			"name": "Wire",
			"output_id": GWTypes.ItemId.WIRE,
			"output_amount": 2,
			"inputs": {GWTypes.ItemId.COPPER: 1},
		},
		{
			"id": "circuit",
			"name": "Circuit",
			"output_id": GWTypes.ItemId.CIRCUIT,
			"output_amount": 1,
			"inputs": {GWTypes.ItemId.SILICON: 1, GWTypes.ItemId.WIRE: 1},
		},
		{
			"id": "generator",
			"name": "Generator",
			"output_id": GWTypes.ItemId.GENERATOR_ITEM,
			"output_amount": 1,
			"inputs": {GWTypes.ItemId.METAL_PLATE: 4, GWTypes.ItemId.CIRCUIT: 2},
		},
	]

func get_recipes() -> Array:
	return recipes

func can_craft(recipe: Dictionary) -> bool:
	if recipe.is_empty() or not recipe.has("inputs"):
		return false
	return InventorySystem.has_items(recipe.inputs)

func craft(recipe: Dictionary) -> bool:
	if recipe.is_empty() or not recipe.has("inputs") or not recipe.has("output_id"):
		return false
	if not can_craft(recipe):
		return false
	if not InventorySystem.consume_items(recipe.inputs):
		return false
	InventorySystem.add_item(recipe.output_id, recipe.output_amount)
	EventBus.notify_craft(recipe.output_id, recipe.output_amount)
	return true

func get_build_cost(building_id: int) -> Dictionary:
	match building_id:
		GWTypes.BuildingId.FOUNDATION:
			return {GWTypes.ItemId.STONE: 2}
		GWTypes.BuildingId.HABITAT:
			return {GWTypes.ItemId.METAL_PLATE: 4, GWTypes.ItemId.ORGANIC: 2}
		GWTypes.BuildingId.STORAGE:
			return {GWTypes.ItemId.METAL_PLATE: 3}
		GWTypes.BuildingId.GENERATOR:
			return {GWTypes.ItemId.GENERATOR_ITEM: 1}
		GWTypes.BuildingId.OXYGEN_STATION:
			return {GWTypes.ItemId.METAL_PLATE: 2, GWTypes.ItemId.CIRCUIT: 1}
		_:
			return {}

func can_build(building_id: int) -> bool:
	var cost := get_build_cost(building_id)
	return cost.is_empty() or InventorySystem.has_items(cost)

func consume_build_cost(building_id: int) -> bool:
	var cost := get_build_cost(building_id)
	if cost.is_empty():
		return true
	return InventorySystem.consume_items(cost)
