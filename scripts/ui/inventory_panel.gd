extends Control

@onready var panel: Panel = $Panel
@onready var slots_grid: GridContainer = $Panel/Margin/VBox/SlotsGrid

func _ready() -> void:
	visible = false
	EventBus.inventory_changed.connect(_refresh)
	_refresh()

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("inventory"):
		visible = not visible
		if visible:
			_refresh()

func _refresh() -> void:
	for child in slots_grid.get_children():
		child.queue_free()
	for slot in InventorySystem.slots:
		var lbl := Label.new()
		if slot.item_id != -1 and slot.amount > 0:
			lbl.text = "%s x%d" % [GWConstants.item_name(slot.item_id), slot.amount]
		else:
			lbl.text = "—"
		lbl.custom_minimum_size = Vector2(120, 28)
		slots_grid.add_child(lbl)
