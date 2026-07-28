extends Control

@onready var panel: Panel = $Panel
@onready var list: ItemList = $Panel/Margin/VBox/RecipeList
@onready var craft_btn: Button = $Panel/Margin/VBox/CraftButton
@onready var status_label: Label = $Panel/Margin/VBox/Status

var _recipes: Array = []
var _selected := -1

func _ready() -> void:
	visible = false
	_recipes = CraftingSystem.get_recipes()
	for recipe in _recipes:
		list.add_item(recipe.name)
	list.item_selected.connect(_on_item_selected)
	craft_btn.pressed.connect(_on_craft_pressed)
	EventBus.inventory_changed.connect(_update_status)

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("craft"):
		visible = not visible

func _on_item_selected(index: int) -> void:
	_selected = index
	_update_status()

func _on_craft_pressed() -> void:
	if _selected < 0 or _selected >= _recipes.size():
		return
	var recipe: Dictionary = _recipes[_selected]
	if CraftingSystem.craft(recipe):
		status_label.text = "Создано: %s" % recipe.name
	else:
		status_label.text = "Недостаточно ресурсов"

func _update_status() -> void:
	if _selected < 0 or _selected >= _recipes.size():
		status_label.text = "Выберите рецепт"
		return
	var recipe: Dictionary = _recipes[_selected]
	var parts: PackedStringArray = []
	for item_id in recipe.inputs:
		parts.append("%s x%d" % [GWConstants.item_name(int(item_id)), int(recipe.inputs[item_id])])
	status_label.text = "Нужно: " + ", ".join(parts)
