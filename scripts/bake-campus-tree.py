"""Bake the original authored tree into a transparent far-LOD atlas, with no external model."""
import bpy,sys,math
from pathlib import Path
from mathutils import Vector
root=Path(sys.argv[sys.argv.index('--')+1]).resolve()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.temporary_directory=str(root/'.runtime')
bpy.ops.import_scene.gltf(filepath=str(root/'frontend/assets/campus/campus-design-editable.glb'))
scene=bpy.context.scene
canopy=next(o for o in scene.objects if o.type=='MESH' and o.name.startswith('tree-crown-') and o.get('materialKind')=='foliage')
canopy.hide_render=False
for obj in list(scene.objects):
 if obj!=canopy:bpy.data.objects.remove(obj,do_unlink=True)
bpy.context.view_layer.update()
bounds=[canopy.matrix_world@Vector(v) for v in canopy.bound_box]
mid=Vector(((min(v.x for v in bounds)+max(v.x for v in bounds))/2,(min(v.y for v in bounds)+max(v.y for v in bounds))/2,min(v.z for v in bounds)))
canopy.location+=Vector((0,0,3.1))-mid
bpy.ops.mesh.primitive_cone_add(vertices=8,radius1=.18,radius2=.055,depth=4.7,location=(0,0,2.35))
trunk=bpy.context.object
mat=bpy.data.materials.new('Bark');mat.diffuse_color=(.15,.105,.06,1);trunk.data.materials.append(mat)
world=bpy.data.worlds.new('Diffuse sky');world.use_nodes=True;world.node_tree.nodes['Background'].inputs['Color'].default_value=(.8,.9,1,1);world.node_tree.nodes['Background'].inputs['Strength'].default_value=.8;scene.world=world
sun_data=bpy.data.lights.new('Soft sun','SUN');sun_data.energy=1.4;sun_data.angle=math.radians(12);sun=bpy.data.objects.new('Soft sun',sun_data);scene.collection.objects.link(sun);sun.rotation_euler=(math.radians(25),math.radians(-30),math.radians(-25))
cam_data=bpy.data.cameras.new('Tree atlas camera');cam=bpy.data.objects.new('Tree atlas camera',cam_data);scene.collection.objects.link(cam);cam.location=(0,-18,4.5);cam.rotation_euler=(Vector((0,0,4.5))-cam.location).to_track_quat('-Z','Y').to_euler();cam_data.type='ORTHO';cam_data.ortho_scale=9;scene.camera=cam
scene.render.engine='CYCLES';scene.cycles.samples=32;scene.cycles.use_denoising=True;scene.render.film_transparent=True;scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA';scene.render.resolution_x=512;scene.render.resolution_y=512;scene.render.resolution_percentage=100;scene.view_settings.view_transform='Standard'
scene.render.filepath=str(root/'frontend/assets/campus/materials/forest-tree-atlas.png')
bpy.ops.render.render(write_still=True)
