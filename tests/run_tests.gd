extends SceneTree

const SAVE_TEST_PATH := "user://galaxy_world_test_save.json"

const AUTOLOAD_SCRIPTS := {
	"EventBus": "res://scripts/autoload/event_bus.gd",
	"InventorySystem": "res://scripts/autoload/inventory_system.gd",
	"GameManager": "res://scripts/autoload/game_manager.gd",
	"CraftingSystem": "res://scripts/autoload/crafting_system.gd",
	"SaveSystem": "res://scripts/autoload/save_system.gd",
}

func _initialize() -> void:
	_bootstrap_autoloads()
	TestAssert.reset()
	print("=== Galaxy World Tests ===")
	_test_constants()
	_test_inventory()
	_test_crafting()
	_test_build_costs()
	_test_planet_generator()
	_test_game_manager()
	_test_event_bus()
	_test_save_system()
	_test_save_system_api()
	TestAssert.summary()
	var exit_code := 1 if TestAssert.failures > 0 else 0
	if exit_code == 0:
		print("ALL TESTS PASSED")
	else:
		print("SOME TESTS FAILED")
	quit(exit_code)

func _bootstrap_autoloads() -> void:
	for autoload_name in AUTOLOAD_SCRIPTS:
		if root.get_node_or_null(autoload_name):
			continue
		var script: Script = load(AUTOLOAD_SCRIPTS[autoload_name])
		var node: Node = script.new()
		node.name = autoload_name
		root.add_child(node)
	var crafting: Node = root.get_node("CraftingSystem")
	if crafting and crafting.get("recipes") is Array and crafting.recipes.is_empty():
		crafting._setup_recipes()

func _inv() -> Node:
	return root.get_node("InventorySystem")

func _craft() -> Node:
	return root.get_node("CraftingSystem")

func _game() -> Node:
	return root.get_node("GameManager")

func _bus() -> Node:
	return root.get_node("EventBus")

func _test_constants() -> void:
	print("-- constants --")
	TestAssert.eq(GWConstants.item_name(GWTypes.ItemId.STONE), "Stone", "item_name stone")
	TestAssert.eq(GWConstants.building_name(GWTypes.BuildingId.GENERATOR), "Generator", "building_name generator")
	TestAssert.eq(GWConstants.INVENTORY_SLOTS, 20, "inventory slots")

func _test_inventory() -> void:
	print("-- inventory --")
	_inv().reset()
	TestAssert.eq(_inv().get_item_count(GWTypes.ItemId.IRON), 0, "empty iron")
	var added: int = _inv().add_item(GWTypes.ItemId.IRON, 5)
	TestAssert.eq(added, 5, "add iron amount")
	TestAssert.eq(_inv().get_item_count(GWTypes.ItemId.IRON), 5, "iron count")
	TestAssert.true_(_inv().has_items({GWTypes.ItemId.IRON: 3}), "has 3 iron")
	TestAssert.false_(_inv().has_items({GWTypes.ItemId.IRON: 10}), "missing iron")
	TestAssert.true_(_inv().remove_item(GWTypes.ItemId.IRON, 2), "remove iron")
	TestAssert.eq(_inv().get_item_count(GWTypes.ItemId.IRON), 3, "iron after remove")
	TestAssert.true_(_inv().consume_items({GWTypes.ItemId.IRON: 3}), "consume iron")
	TestAssert.eq(_inv().get_item_count(GWTypes.ItemId.IRON), 0, "iron consumed")

func _test_crafting() -> void:
	print("-- crafting --")
	_inv().reset()
	var recipes: Array = _craft().get_recipes()
	TestAssert.gt(recipes.size(), 0, "recipes exist")
	var plate_recipe: Dictionary = {}
	for recipe in recipes:
		if recipe.id == "metal_plate":
			plate_recipe = recipe
			break
	TestAssert.false_(plate_recipe.is_empty(), "metal_plate recipe found")
	TestAssert.false_(_craft().can_craft(plate_recipe), "cannot craft without iron")
	_inv().add_item(GWTypes.ItemId.IRON, 4)
	TestAssert.true_(_craft().can_craft(plate_recipe), "can craft with iron")
	TestAssert.true_(_craft().craft(plate_recipe), "craft metal plate")
	TestAssert.eq(_inv().get_item_count(GWTypes.ItemId.METAL_PLATE), 1, "got metal plate")
	TestAssert.eq(_inv().get_item_count(GWTypes.ItemId.IRON), 2, "iron spent")

func _test_build_costs() -> void:
	print("-- build costs --")
	_inv().reset()
	var foundation_cost: Dictionary = _craft().get_build_cost(GWTypes.BuildingId.FOUNDATION)
	TestAssert.true_(foundation_cost.has(GWTypes.ItemId.STONE), "foundation needs stone")
	_inv().add_item(GWTypes.ItemId.STONE, 2)
	TestAssert.true_(_craft().can_build(GWTypes.BuildingId.FOUNDATION), "can build foundation")
	TestAssert.true_(_craft().consume_build_cost(GWTypes.BuildingId.FOUNDATION), "pay foundation")
	TestAssert.eq(_inv().get_item_count(GWTypes.ItemId.STONE), 0, "stone spent")

func _test_planet_generator() -> void:
	print("-- planet generator --")
	var mesh: ArrayMesh = PlanetGenerator.generate_mesh(42, 16, 2.0, 12.0)
	TestAssert.true_(mesh != null, "mesh created")
	TestAssert.gt(mesh.get_surface_count(), 0, "mesh has surfaces")
	var h1: float = PlanetGenerator.get_height_at(42, 10.0, 10.0, 12.0)
	var h2: float = PlanetGenerator.get_height_at(42, 10.0, 10.0, 12.0)
	TestAssert.eq(h1, h2, "height deterministic")
	var shape: Shape3D = PlanetGenerator.create_collision_shape(mesh)
	TestAssert.true_(shape != null, "collision shape created")

func _test_game_manager() -> void:
	print("-- game manager --")
	_game().start_new_game()
	TestAssert.true_(_game().game_started, "game started")
	TestAssert.eq(_game().state, GWTypes.GameState.PLAYING, "playing state")
	TestAssert.false_(_game().vertical_slice_complete, "not complete yet")
	_game().register_building({"id": GWTypes.BuildingId.FOUNDATION, "position": Vector3.ZERO})
	TestAssert.eq(_game().built_structures.size(), 1, "building registered")
	_game().complete_vertical_slice()
	TestAssert.true_(_game().vertical_slice_complete, "slice complete")
	TestAssert.eq(_game().state, GWTypes.GameState.COMPLETE, "complete state")

func _test_event_bus() -> void:
	print("-- event bus --")
	_bus().reset_triggers()
	var fired := {"mine": false, "craft": false, "build": false}
	_bus().first_mine.connect(func(): fired.mine = true)
	_bus().first_craft.connect(func(): fired.craft = true)
	_bus().first_build.connect(func(): fired.build = true)
	_bus().notify_mine(GWTypes.ItemId.STONE, 1)
	_bus().notify_craft(GWTypes.ItemId.METAL_PLATE, 1)
	_bus().notify_build({"id": GWTypes.BuildingId.FOUNDATION})
	TestAssert.true_(fired.mine, "first mine trigger")
	TestAssert.true_(fired.craft, "first craft trigger")
	TestAssert.true_(fired.build, "first build trigger")

func _test_save_system() -> void:
	print("-- save system --")
	_inv().reset()
	_inv().add_item(GWTypes.ItemId.COPPER, 7)
	_game().spawn_position = Vector3(1, 2, 3)
	_game().built_structures = [{"id": GWTypes.BuildingId.STORAGE, "position": Vector3(4, 0, 5)}]
	_game().planet_config.seed = 999
	_game().vertical_slice_complete = true
	var file := FileAccess.open(SAVE_TEST_PATH, FileAccess.WRITE)
	TestAssert.true_(file != null, "open test save file")
	if file:
		var data := {
			"planet_seed": _game().planet_config.seed,
			"spawn": {"x": 1.0, "y": 2.0, "z": 3.0},
			"inventory": _inv().slots.duplicate(true),
			"buildings": _game().built_structures.duplicate(true),
			"vertical_slice_complete": true,
		}
		file.store_string(JSON.stringify(data))
		file.close()
	_inv().reset()
	_game().spawn_position = Vector3.ZERO
	_game().built_structures.clear()
	var load_file := FileAccess.open(SAVE_TEST_PATH, FileAccess.READ)
	TestAssert.true_(load_file != null, "read test save file")
	if load_file:
		var parsed = JSON.parse_string(load_file.get_as_text())
		TestAssert.true_(parsed != null and typeof(parsed) == TYPE_DICTIONARY, "parse save json")
		_game().planet_config.seed = parsed.get("planet_seed", 0)
		var spawn: Dictionary = parsed.get("spawn", {})
		_game().spawn_position = Vector3(spawn.get("x", 0.0), spawn.get("y", 0.0), spawn.get("z", 0.0))
		_inv().slots = parsed.get("inventory", [])
		_game().built_structures = parsed.get("buildings", [])
		_game().vertical_slice_complete = parsed.get("vertical_slice_complete", false)
	TestAssert.eq(_game().planet_config.seed, 999, "loaded seed")
	TestAssert.eq(_inv().get_item_count(GWTypes.ItemId.COPPER), 7, "loaded copper")
	TestAssert.eq(_game().built_structures.size(), 1, "loaded buildings")
	TestAssert.true_(_game().vertical_slice_complete, "loaded complete flag")
	if FileAccess.file_exists(SAVE_TEST_PATH):
		DirAccess.remove_absolute(SAVE_TEST_PATH)

func _test_save_system_api() -> void:
	print("-- save system api --")
	var save_system: Node = root.get_node("SaveSystem")
	_inv().reset()
	_inv().add_item(GWTypes.ItemId.SILICON, 4)
	_game().planet_config.seed = 12345
	_game().spawn_position = Vector3(9, 0, 8)
	_game().built_structures = [{"id": GWTypes.BuildingId.HABITAT, "position": Vector3(1, 0, 1)}]
	_game().vertical_slice_complete = false
	TestAssert.true_(save_system.save_game(), "save_game succeeds")
	_inv().reset()
	_game().spawn_position = Vector3.ZERO
	_game().built_structures.clear()
	TestAssert.true_(save_system.has_save(), "save file exists")
	TestAssert.true_(save_system.load_game(), "load_game succeeds")
	TestAssert.eq(_game().planet_config.seed, 12345, "api loaded seed")
	TestAssert.eq(_inv().get_item_count(GWTypes.ItemId.SILICON), 4, "api loaded silicon")
	TestAssert.eq(_game().built_structures.size(), 1, "api loaded buildings")
	if FileAccess.file_exists(save_system.SAVE_PATH):
		DirAccess.remove_absolute(save_system.SAVE_PATH)
