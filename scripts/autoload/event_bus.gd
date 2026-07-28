extends Node

signal player_damaged(amount: float)
signal player_died
signal player_respawned
signal resource_mined(item_id: int, amount: int)
signal item_crafted(item_id: int, amount: int)
signal building_placed(data: Dictionary)
signal eva_message(text: String)
signal suit_stats_changed(stats: Dictionary)
signal inventory_changed
signal build_mode_changed(active: bool)
signal game_started
signal vertical_slice_complete
signal first_mine
signal first_craft
signal first_build
signal aurora_core_reached

var _first_mine_done := false
var _first_craft_done := false
var _first_build_done := false

func notify_mine(item_id: int, amount: int) -> void:
	resource_mined.emit(item_id, amount)
	if not _first_mine_done:
		_first_mine_done = true
		first_mine.emit()

func notify_craft(item_id: int, amount: int) -> void:
	item_crafted.emit(item_id, amount)
	if not _first_craft_done:
		_first_craft_done = true
		first_craft.emit()

func notify_build(data: Dictionary) -> void:
	building_placed.emit(data)
	if not _first_build_done:
		_first_build_done = true
		first_build.emit()

func show_eva(text: String) -> void:
	eva_message.emit(text)

func reset_triggers() -> void:
	_first_mine_done = false
	_first_craft_done = false
	_first_build_done = false
