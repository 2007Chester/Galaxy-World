extends Control

func _ready() -> void:
	$VBox/StartButton.pressed.connect(_on_start)
	$VBox/QuitButton.pressed.connect(_on_quit)

func _on_start() -> void:
	EventBus.reset_triggers()
	GameManager.start_new_game()
	get_tree().change_scene_to_file("res://scenes/main/main.tscn")

func _on_quit() -> void:
	get_tree().quit()
