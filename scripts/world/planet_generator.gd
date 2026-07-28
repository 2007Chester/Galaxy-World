class_name PlanetGenerator
extends RefCounted

static func generate_mesh(seed: int, size: int, scale: float, height_mult: float) -> ArrayMesh:
	var noise := FastNoiseLite.new()
	noise.seed = seed
	noise.frequency = 0.04
	noise.fractal_octaves = 4

	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)

	var verts: Array = []
	for z in range(size + 1):
		var row: Array = []
		for x in range(size + 1):
			var nx := float(x) / float(size) - 0.5
			var nz := float(z) / float(size) - 0.5
			var h := noise.get_noise_2d(x, z) * height_mult
			h += noise.get_noise_2d(x * 2, z * 2) * height_mult * 0.3
			var pos := Vector3(nx * size * scale, h, nz * size * scale)
			row.append(pos)
		verts.append(row)

	for z in range(size):
		for x in range(size):
			var v00: Vector3 = verts[z][x]
			var v10: Vector3 = verts[z][x + 1]
			var v01: Vector3 = verts[z + 1][x]
			var v11: Vector3 = verts[z + 1][x + 1]
			_add_quad(st, v00, v10, v11, v01)

	st.generate_normals()
	return st.commit()

static func get_height_at(seed: int, x: float, z: float, height_mult: float) -> float:
	var noise := FastNoiseLite.new()
	noise.seed = seed
	noise.frequency = 0.04
	noise.fractal_octaves = 4
	var gx := x / GWConstants.PLANET_SCALE
	var gz := z / GWConstants.PLANET_SCALE
	return noise.get_noise_2d(gx, gz) * height_mult + noise.get_noise_2d(gx * 2, gz * 2) * height_mult * 0.3

static func _add_quad(st: SurfaceTool, a: Vector3, b: Vector3, c: Vector3, d: Vector3) -> void:
	st.set_color(Color(0.25, 0.55, 0.28))
	st.add_vertex(a)
	st.set_color(Color(0.22, 0.5, 0.25))
	st.add_vertex(b)
	st.set_color(Color(0.2, 0.48, 0.22))
	st.add_vertex(c)

	st.set_color(Color(0.25, 0.55, 0.28))
	st.add_vertex(a)
	st.set_color(Color(0.2, 0.48, 0.22))
	st.add_vertex(c)
	st.set_color(Color(0.18, 0.45, 0.2))
	st.add_vertex(d)

static func create_collision_shape(mesh: ArrayMesh) -> Shape3D:
	if mesh != null and mesh.get_surface_count() > 0:
		var shape := mesh.create_trimesh_shape()
		if shape != null:
			return shape
	var fallback := BoxShape3D.new()
	var extent := GWConstants.PLANET_SIZE * GWConstants.PLANET_SCALE
	fallback.size = Vector3(extent, GWConstants.TERRAIN_HEIGHT * 2.0, extent)
	return fallback
