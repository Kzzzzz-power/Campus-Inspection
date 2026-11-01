"""Prepare an editable campus scene from the canonical local GLB; run using Blender -b."""
import bpy, sys, json, math
from pathlib import Path
from mathutils import Vector
root = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
out = root / '.runtime' / 'environment-render'
out.mkdir(parents=True, exist_ok=True)
art = root / 'art' / 'campus'
art.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.temporary_directory = str(out)
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.import_scene.gltf(filepath=str(root/'frontend/assets/campus/campus-design-editable.glb'))
scene=bpy.context.scene
collections={}
for obj in list(scene.objects):
    if obj.type!='MESH': continue
    if obj.get('role')=='forest': obj.visible_shadow=False
    category=obj.get('buildingId') or ('Landscape' if obj.get('role') in ('tree','planting','landscape','site','sport') else 'Site and details')
    if category not in collections:
        col=bpy.data.collections.new(category);scene.collection.children.link(col);collections[category]=col
    for col in list(obj.users_collection):col.objects.unlink(obj)
    collections[category].objects.link(obj)
    # Architectural edges retain a small bevel in the editable design scene.
    if obj.get('role') in ('wall','trim','plinth'):
        mod=obj.modifiers.new('Edge highlight · offline design','BEVEL');mod.width=.018;mod.segments=2
world=bpy.data.worlds.new('Natural daylight');world.use_nodes=True
world.node_tree.nodes['Background'].inputs['Color'].default_value=(.64,.75,.88,1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value=.6
scene.world=world
sun_data=bpy.data.lights.new('Afternoon sun','SUN');sun_data.energy=3;sun_data.angle=math.radians(3)
sun=bpy.data.objects.new('Afternoon sun',sun_data);scene.collection.objects.link(sun)
sun.rotation_euler=Vector((35,-30,-45)).to_track_quat('-Z','Y').to_euler()
cam_data=bpy.data.cameras.new('Campus overview');cam=bpy.data.objects.new('Campus overview',cam_data);scene.collection.objects.link(cam)
# glTF Y-up is converted to Blender Z-up on import.
cam.location=(-75,-99,91);target=Vector((-4,-3,6));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler()
cam_data.type='ORTHO';cam_data.ortho_scale=160;scene.camera=cam
scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True
scene.render.resolution_x=1440;scene.render.resolution_y=1100;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
scene.render.image_settings.file_format='PNG';scene.render.filepath=str(out/'blender-overview.png')
scene['basis']='Original campus design; estimated dimensions, not a survey or inspection evidence.'
scene['runtime_source']='frontend/assets/campus/campus-design.meshopt.glb; browser rendering remains authoritative for interaction.'
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(art/'campus-environment.blend'))
bpy.ops.render.render(write_still=True)
(out/'blender-report.json').write_text(json.dumps({'blender':bpy.app.version_string,'objects':len(scene.objects),'collections':list(collections),'blend':str(art/'campus-environment.blend'),'render':scene.render.filepath},ensure_ascii=False,indent=2),encoding='utf-8')
