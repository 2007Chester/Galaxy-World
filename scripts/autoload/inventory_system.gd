extends Node

var slots: Array = []

func _ready() -> void:
	reset()

func reset() -> void:
	slots.clear()
	for i in GWConstants.INVENTORY_SLOTS:
		slots.append({"item_id": -1, "amount": 0})

func get_item_count(item_id: int) -> int:
	var total := 0
	for slot in slots:
		if slot.item_id == item_id:
			total += slot.amount
	return total

func has_items(requirements: Dictionary) -> bool:
	for item_id in requirements:
		if get_item_count(int(item_id)) < int(requirements[item_id]):
			return false
	return true

func add_item(item_id: int, amount: int = 1) -> int:
	var remaining := amount
	for slot in slots:
		if remaining <= 0:
			break
		if slot.item_id == item_id or slot.item_id == -1:
			if slot.item_id == -1:
				slot.item_id = item_id
			var space: int = 99 - int(slot.amount)
			var add: int = mini(remaining, space)
			slot.amount += add
			remaining -= add
	if remaining < amount:
		EventBus.inventory_changed.emit()
	return amount - remaining

func remove_item(item_id: int, amount: int = 1) -> bool:
	if get_item_count(item_id) < amount:
		return false
	var remaining := amount
	for slot in slots:
		if remaining <= 0:
			break
		if slot.item_id == item_id:
			var remove_amt: int = mini(remaining, int(slot.amount))
			slot.amount -= remove_amt
			remaining -= remove_amt
			if slot.amount <= 0:
				slot.item_id = -1
				slot.amount = 0
	EventBus.inventory_changed.emit()
	return true

func consume_items(requirements: Dictionary) -> bool:
	if not has_items(requirements):
		return false
	for item_id in requirements:
		remove_item(int(item_id), int(requirements[item_id]))
	return true

func get_filled_slots() -> Array:
	var result: Array = []
	for slot in slots:
		if slot.item_id != -1 and slot.amount > 0:
			result.append(slot.duplicate())
	return result
