"""
Generates the aquarium scenery (decor + plants) as GLB files for the Living Aquarium.

Run headless:
  blender -b -P tools/blender/make_decor.py -- <out_dir> [asset ...]

Every asset is modelled from primitives + bmesh, shaded with procedural Cycles materials
(stone, wood, metal, ...) and then baked down to textures (albedo with ambient occlusion,
tangent-space normal, roughness/metallic), so the game gets a plain glTF PBR material.

Coordinate convention (after glTF export, three.js space):
  origin = ground contact point, +Y up, +Z faces the front glass (Blender -Y).
Units are game units (the tank is ~11 x 4.6 x 5.6).

Object naming contract with src/world/decorAssets.js:
  Glow*  - emissive parts, brightened at night (material kept unbaked)
  Sway*  - parts bent by the water-current shader (origin at their root)
  Glass* - transparent parts
  Lid / Pivot* - animated parts (object origin = hinge)
"""
import bpy
import bmesh
import math
import os
import random
import sys
import numpy as np
import addon_utils
from mathutils import Vector, Matrix, Euler, noise

TAU = math.pi * 2
OUT = None
TEX = 1024


# ----------------------------------------------------------------------------- scene
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    addon_utils.enable("cycles", default_set=True, persistent=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 24
    sc.cycles.use_denoising = False
    sc.render.bake.margin = 6
    sc.cycles.device = "GPU" if _gpu() else "CPU"


_GPU = None  # detected backend, re-applied after every factory reset


def _gpu():
    """Enable a GPU backend for Cycles if the machine has one (baking is much faster)."""
    global _GPU
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ([_GPU] if _GPU else ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL")):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            if any(d.type == kind for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == kind
                if _GPU is None:
                    print("Cycles device:", kind)
                _GPU = kind
                return True
        except Exception:
            continue
    _GPU = _GPU or ""
    return False


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def from_bmesh(name, bm, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    return link(bpy.data.objects.new(name, me))


def select_only(*obs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]


def apply_all(ob):
    select_only(ob)
    for m in list(ob.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=m.name)
        except RuntimeError:
            ob.modifiers.remove(m)  # disabled (e.g. zero levels): nothing to apply


def join(name, obs):
    obs = [o for o in obs if o]
    select_only(*obs)
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    return ob


def transform_apply(ob):
    select_only(ob)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def set_origin(ob, world_point):
    """Move the object's origin to world_point without moving the geometry."""
    mw = ob.matrix_world.copy()
    local = mw.inverted() @ Vector(world_point)
    ob.data.transform(Matrix.Translation(-local))
    ob.matrix_world = mw @ Matrix.Translation(local)


def mod(ob, kind, **kw):
    m = ob.modifiers.new(kind.lower(), kind)
    for k, v in kw.items():
        setattr(m, k, v)
    return m


def boolean(ob, cutter, op="DIFFERENCE"):
    """Apply a boolean with the exact solver. Cutters must be closed, non-self-intersecting
    meshes (overlapping pieces confuse the solver); an emptied result is a hard error."""
    m = mod(ob, "BOOLEAN", operation=op, object=cutter, solver="EXACT")
    select_only(ob)
    bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    if not ob.data.polygons:
        raise RuntimeError(f"boolean {op} left {ob.name} empty")


def prim(kind, name, **kw):
    getattr(bpy.ops.mesh, "primitive_" + kind + "_add")(**kw)
    ob = bpy.context.active_object
    ob.name = name
    return ob


def shade_smooth(ob, angle=50):
    select_only(ob)
    try:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(angle))
    except Exception:
        bpy.ops.object.shade_smooth()


def displace(ob, strength, scale, seed=0, kind="VORONOI", levels=0):
    """Organic surface break-up with a procedural texture."""
    if levels:
        mod(ob, "SUBSURF", levels=levels, render_levels=levels)
    tex = bpy.data.textures.new(f"d{seed}", kind if kind != "NOISE" else "CLOUDS")
    if kind == "VORONOI":
        tex.noise_scale = scale
        tex.distance_metric = "DISTANCE"
    else:
        tex.noise_scale = scale
        tex.noise_depth = 2
    m = mod(ob, "DISPLACE", texture=tex, strength=strength, texture_coords="OBJECT", mid_level=0.5)
    return m


# ----------------------------------------------------------------------------- materials
class NT:
    """Tiny helper around a material node tree."""

    def __init__(self, name):
        self.mat = bpy.data.materials.new(name)
        self.mat.use_nodes = True
        self.t = self.mat.node_tree
        self.t.nodes.clear()
        self.out = self.n("ShaderNodeOutputMaterial")
        self.bsdf = self.n("ShaderNodeBsdfPrincipled")
        self.l(self.bsdf.outputs["BSDF"], self.out.inputs["Surface"])
        self.coord = self.n("ShaderNodeTexCoord").outputs["Object"]

    def n(self, kind, **kw):
        nd = self.t.nodes.new(kind)
        for k, v in kw.items():
            setattr(nd, k, v)
        return nd

    def l(self, a, b):
        self.t.links.new(a, b)

    def inp(self, nd, key, val):
        s = nd.inputs[key]
        if hasattr(val, "is_linked") or hasattr(val, "links"):
            self.l(val, s)
        else:
            if isinstance(val, (tuple, list)) and len(val) == 3 and len(s.default_value) == 4:
                val = (*val, 1.0)
            s.default_value = val

    # --- building blocks
    def vec(self, scale=(1, 1, 1), loc=(0, 0, 0)):
        m = self.n("ShaderNodeMapping")
        self.l(self.coord, m.inputs["Vector"])
        m.inputs["Scale"].default_value = scale
        m.inputs["Location"].default_value = loc
        return m.outputs["Vector"]

    def noise(self, vec, scale, detail=4, rough=0.55, distortion=0.0, out="Fac"):
        nd = self.n("ShaderNodeTexNoise")
        self.l(vec, nd.inputs["Vector"])
        nd.inputs["Scale"].default_value = scale
        nd.inputs["Detail"].default_value = detail
        nd.inputs["Roughness"].default_value = rough
        nd.inputs["Distortion"].default_value = distortion
        return nd.outputs[out]

    def voronoi(self, vec, scale, feature="F1", rand=1.0, out="Distance"):
        nd = self.n("ShaderNodeTexVoronoi", feature=feature)
        self.l(vec, nd.inputs["Vector"])
        nd.inputs["Scale"].default_value = scale
        nd.inputs["Randomness"].default_value = rand
        return nd.outputs[out]

    def ramp(self, fac, stops):
        """stops: [(pos, (r,g,b)) or (pos, value)]"""
        nd = self.n("ShaderNodeValToRGB")
        self.l(fac, nd.inputs["Fac"])
        els = nd.color_ramp.elements
        while len(els) < len(stops):
            els.new(0.5)
        for e, (p, c) in zip(els, stops):
            e.position = p
            if not isinstance(c, (tuple, list)):
                c = (c, c, c)
            e.color = (*c, 1.0)
        return nd.outputs["Color"]

    def mix(self, fac, a, b, blend="MIX"):
        nd = self.n("ShaderNodeMix", data_type="RGBA", blend_type=blend)
        for key, v in (("Factor_Float", fac), ("A_Color", a), ("B_Color", b)):
            s = next(i for i in nd.inputs if i.identifier == key)
            if isinstance(v, (tuple, list)):
                s.default_value = (*v, 1.0) if len(v) == 3 else v
            elif isinstance(v, (int, float)):
                s.default_value = v
            else:
                self.l(v, s)
        return next(o for o in nd.outputs if o.identifier == "Result_Color")

    def math(self, op, a, b=0.0, clamp=False):
        nd = self.n("ShaderNodeMath", operation=op, use_clamp=clamp)
        for s, v in zip(nd.inputs, (a, b)):
            if isinstance(v, (int, float)):
                s.default_value = v
            else:
                self.l(v, s)
        return nd.outputs[0]

    def sep(self, vec):
        nd = self.n("ShaderNodeSeparateXYZ")
        self.l(vec, nd.inputs["Vector"])
        return nd.outputs

    def comb(self, x, y, z):
        nd = self.n("ShaderNodeCombineXYZ")
        for sock, v in zip(nd.inputs, (x, y, z)):
            if isinstance(v, (int, float)):
                sock.default_value = v
            else:
                self.l(v, sock)
        return nd.outputs[0]

    def geo(self, out):
        return self.n("ShaderNodeNewGeometry").outputs[out]

    def ao(self, dist=0.15):
        nd = self.n("ShaderNodeAmbientOcclusion", samples=16)
        nd.inputs["Distance"].default_value = dist
        return nd.outputs["AO"]

    def bump(self, height, strength=0.6, dist=0.02):
        nd = self.n("ShaderNodeBump")
        self.l(height, nd.inputs["Height"])
        nd.inputs["Strength"].default_value = strength
        nd.inputs["Distance"].default_value = dist
        return nd.outputs["Normal"]

    def finish(self, color, rough=0.8, metal=0.0, normal=None, emission=None, alpha=None):
        b = self.bsdf
        self.inp(b, "Base Color", color)
        self.inp(b, "Roughness", rough)
        self.inp(b, "Metallic", metal)
        if normal is not None:
            self.l(normal, b.inputs["Normal"])
        if emission is not None:
            col, strength = emission
            self.inp(b, "Emission Color", col)
            b.inputs["Emission Strength"].default_value = strength
        if alpha is not None:
            self.inp(b, "Alpha", alpha)
        return self.mat


def C(hexstr):
    h = hexstr.lstrip("#")
    return tuple((int(h[i:i + 2], 16) / 255) ** 2.2 for i in (0, 2, 4))  # sRGB -> linear


def moss_mask(t, amount=0.5, up=0.55, scale=6.0):
    """Moss/algae on upward-facing surfaces, broken up by noise."""
    nz = t.sep(t.geo("Normal"))[2]
    upw = t.math("MULTIPLY", t.math("SUBTRACT", nz, up), 4.0, clamp=True)
    n = t.noise(t.vec(), scale, detail=6, rough=0.6)
    patch = t.ramp(n, [(0.58 - amount * 0.3, 0.0), (0.66 - amount * 0.28, 1.0)])
    return t.math("MULTIPLY", upw, patch)


def mat_stone(name, base="#8d8a83", dark="#4e4b45", light="#b9b4a8", block=6.0, stretch=(1, 1, 1.6),
              mortar=0.06, moss=0.35, dirt=0.6, rough=0.85):
    """Rubble masonry: irregular stones (voronoi cells) with recessed mortar joints."""
    t = NT(name)
    v = t.vec(scale=stretch)
    cell_rand = t.voronoi(v, block, out="Color")
    edge = t.voronoi(v, block, feature="DISTANCE_TO_EDGE")
    joint = t.ramp(edge, [(0.0, 0.0), (mortar, 1.0)])          # 0 in the joints, 1 on the stone
    joint_f = t.math("ADD", joint, 0.0)
    grain = t.noise(t.vec(), 28, detail=8, rough=0.7)
    tint = t.ramp(t.math("ADD", t.sep(cell_rand)[0], t.math("MULTIPLY", grain, 0.35)),
                  [(0.15, C(dark)), (0.55, C(base)), (0.95, C(light))])
    col = t.mix(joint_f, C("#2c2a26"), tint)
    # weathering: darker in crevices
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.25)), dirt), col, C("#1d1b17"))
    if moss > 0:
        m = moss_mask(t, moss)
        mcol = t.ramp(t.noise(t.vec(), 40, detail=6), [(0.3, C("#2f4a1c")), (0.7, C("#5d7d2a"))])
        col = t.mix(m, col, mcol)
    height = t.math("ADD", t.math("MULTIPLY", joint_f, 0.8), t.math("MULTIPLY", grain, 0.2))
    return t.finish(col, rough=rough, normal=t.bump(height, 0.8, 0.03))


def mat_rock(name, base="#7b746a", dark="#3f3a34", light="#a59c8f", moss=0.3, scale=3.0):
    t = NT(name)
    n1 = t.noise(t.vec(), scale, detail=6, rough=0.6, distortion=0.4)
    strata = t.noise(t.vec(scale=(1, 1, 6)), scale * 0.6, detail=3)
    # a few fissures, not a full cell network: voronoi edges masked by noise
    cr = t.voronoi(t.vec(), scale * 1.1, feature="DISTANCE_TO_EDGE")
    fissure = t.ramp(cr, [(0.0, 0.0), (0.018, 1.0)])
    keep = t.ramp(t.noise(t.vec(), scale * 1.5, detail=2), [(0.5, 1.0), (0.58, 0.0)])
    crack = t.math("MAXIMUM", fissure, keep)
    col = t.ramp(t.math("ADD", t.math("MULTIPLY", n1, 0.7), t.math("MULTIPLY", strata, 0.3)),
                 [(0.25, C(dark)), (0.5, C(base)), (0.8, C(light))])
    col = t.mix(t.math("SUBTRACT", 1.0, crack), col, C("#26221d"))
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.3)), 0.7), col, C("#1a1714"))
    if moss > 0:
        mcol = t.ramp(t.noise(t.vec(), 45, detail=6), [(0.3, C("#2d4619")), (0.7, C("#62852b"))])
        col = t.mix(moss_mask(t, moss, up=0.6), col, mcol)
    height = t.math("ADD", t.math("MULTIPLY", crack, 0.4), t.math("MULTIPLY", n1, 0.6))
    return t.finish(col, rough=0.9, normal=t.bump(height, 0.9, 0.05))


def mat_sandstone(name, base="#d9cdb4", dark="#9c8f76", moss=0.35, rough=0.7):
    """Weathered carved stone (columns, statues): smooth with pits, cracks, grime and algae."""
    t = NT(name)
    n = t.noise(t.vec(), 5, detail=8, rough=0.65, distortion=0.3)
    pits = t.voronoi(t.vec(), 60, out="Distance")
    pit = t.ramp(pits, [(0.0, 0.0), (0.12, 1.0)])
    cr = t.voronoi(t.vec(scale=(1, 1, 0.4)), 4, feature="DISTANCE_TO_EDGE")
    crack = t.ramp(cr, [(0.0, 0.0), (0.015, 1.0)])
    col = t.ramp(n, [(0.3, C(dark)), (0.7, C(base))])
    col = t.mix(t.math("SUBTRACT", 1.0, crack), col, C("#3b352b"))
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.2)), 0.8), col, C("#2a2620"))
    # vertical grime streaks
    streak = t.noise(t.vec(scale=(6, 6, 0.3)), 3, detail=3)
    col = t.mix(t.ramp(streak, [(0.5, 0.0), (0.75, 0.45)]), col, C("#5d5442"))
    if moss > 0:
        mcol = t.ramp(t.noise(t.vec(), 45, detail=6), [(0.3, C("#2d4619")), (0.7, C("#62852b"))])
        col = t.mix(moss_mask(t, moss, up=0.4), col, mcol)
    height = t.math("MULTIPLY", t.math("MULTIPLY", pit, crack), t.math("ADD", t.math("MULTIPLY", n, 0.3), 0.7))
    return t.finish(col, rough=rough, normal=t.bump(height, 0.6, 0.015))


def mat_tiles(name, base="#3d4f66", dark="#232e3b", rows=26.0, cols=18.0):
    """Slate roof tiles: rows along Z, staggered columns around the cone."""
    t = NT(name)
    pos = t.vec()
    x, y, z = t.sep(pos)
    ang = t.math("ARCTAN2", y, x)
    row = t.math("FLOOR", t.math("MULTIPLY", z, rows))
    fr = t.math("FRACT", t.math("MULTIPLY", z, rows))
    colf = t.math("FRACT", t.math("ADD", t.math("MULTIPLY", ang, cols / TAU), t.math("MULTIPLY", row, 0.5)))
    edge_r = t.ramp(fr, [(0.0, 0.0), (0.12, 1.0)])
    edge_c = t.ramp(t.math("ABSOLUTE", t.math("SUBTRACT", colf, 0.5)), [(0.42, 1.0), (0.5, 0.0)])
    tile = t.math("MULTIPLY", t.math("ADD", edge_r, 0.0), t.math("ADD", edge_c, 0.0))
    rnd = t.noise(t.vec(), 60, detail=2)
    col = t.ramp(t.math("ADD", t.math("MULTIPLY", rnd, 0.6), t.math("MULTIPLY", fr, 0.4)), [(0.2, C(dark)), (0.8, C(base))])
    col = t.mix(t.math("SUBTRACT", 1.0, tile), col, C("#12171d"))
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.2)), 0.6), col, C("#0b0e12"))
    height = t.math("ADD", tile, t.math("MULTIPLY", fr, 0.6))
    return t.finish(col, rough=0.55, normal=t.bump(height, 0.7, 0.02))


def mat_wood(name, base="#6b4a2e", dark="#3a2716", light="#9a7048", rings=14.0, along="Z", moss=0.0, planks=0.0, rough=0.82,
             seam_axis=None, distortion=1.5, staves=0):
    t = NT(name)
    stretch = {"X": (0.15, 1, 1), "Y": (1, 0.15, 1), "Z": (1, 1, 0.15)}

    def grains(sc):
        return (t.noise(t.vec(scale=sc), rings, detail=8, rough=0.6, distortion=distortion),
                t.noise(t.vec(scale=sc), rings * 6, detail=4))
    if along == "XY":
        # boards on a box: grain runs along X on faces looking along Y, along Y on the ends
        (gx, fx), (gy, fy) = grains(stretch["X"]), grains(stretch["Y"])
        w = t.ramp(t.math("ABSOLUTE", t.sep(t.geo("Normal"))[0]), [(0.5, 0.0), (0.6, 1.0)])

        def blend(a, b):
            return t.math("ADD", t.math("MULTIPLY", a, t.math("SUBTRACT", 1.0, w)), t.math("MULTIPLY", b, w))
        grain, fine = blend(gx, gy), blend(fx, fy)
        along = "X"
    else:
        grain, fine = grains(stretch[along])
    col = t.ramp(t.math("ADD", t.math("MULTIPLY", grain, 0.7), t.math("MULTIPLY", fine, 0.3)),
                 [(0.25, C(dark)), (0.55, C(base)), (0.85, C(light))])
    height = t.math("ADD", t.math("MULTIPLY", grain, 0.6), t.math("MULTIPLY", fine, 0.4))
    if planks > 0:
        # plank seams across the "along" axis
        ax = {"X": 0, "Y": 1, "Z": 2}[seam_axis] if seam_axis else {"X": 1, "Y": 0, "Z": 0}[along]
        p = t.sep(t.vec())[ax]
        seam = t.ramp(t.math("FRACT", t.math("MULTIPLY", p, planks)), [(0.0, 0.0), (0.04, 1.0), (0.96, 1.0), (1.0, 0.0)])
        col = t.mix(t.math("SUBTRACT", 1.0, seam), col, C("#1a120a"))
        height = t.math("MULTIPLY", height, seam)
    if staves:
        # barrel staves: seams at regular angles around the object's Z axis
        x, y, _ = t.sep(t.coord)
        f = t.math("FRACT", t.math("ADD", t.math("MULTIPLY", t.math("ARCTAN2", y, x), staves / TAU), 0.5))
        seam = t.ramp(f, [(0.0, 0.0), (0.05, 1.0), (0.95, 1.0), (1.0, 0.0)])
        col = t.mix(t.math("SUBTRACT", 1.0, seam), col, C("#1a120a"))
        height = t.math("MULTIPLY", height, seam)
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.2)), 0.7), col, C("#120c07"))
    if moss > 0:
        mcol = t.ramp(t.noise(t.vec(), 45, detail=6), [(0.3, C("#2b4317")), (0.7, C("#5b7a27"))])
        col = t.mix(moss_mask(t, moss), col, mcol)
    return t.finish(col, rough=rough, normal=t.bump(height, 0.5, 0.02))


def mat_metal(name, base="#b08a3e", patina="#3f7d6a", patina_amt=0.35, rough=0.35, metal_max=1.0):
    """Metal with patina/rust collecting in cavities. metal_max < 1 keeps it readable without
    strong environment reflections (the aquarium has little to reflect)."""
    t = NT(name)
    n = t.noise(t.vec(), 9, detail=6, rough=0.6)
    cav = t.math("SUBTRACT", 1.0, t.ao(0.12))
    p = t.math("ADD", t.math("MULTIPLY", cav, 1.5), t.math("MULTIPLY", n, patina_amt))
    pm = t.ramp(p, [(0.45, 0.0), (0.75, 1.0)])
    col = t.mix(pm, C(base), C(patina))
    metal = t.ramp(p, [(0.45, metal_max), (0.75, 0.0)])
    rgh = t.ramp(p, [(0.45, rough), (0.75, 0.85)])
    return t.finish(col, rough=rgh, metal=metal, normal=t.bump(n, 0.25, 0.01))


def mat_plain(name, color, rough=0.5, metal=0.0, emission=None, alpha=None):
    t = NT(name)
    return t.finish(C(color) if isinstance(color, str) else color, rough=rough, metal=metal,
                    emission=(C(emission[0]), emission[1]) if emission else None, alpha=alpha)


# ----------------------------------------------------------------------------- baking
def uv_unwrap(ob, margin=0.004):
    me = ob.data
    if len(me.uv_layers):   # keep existing layers (materials may read them): unwrap into a new one
        uv = me.uv_layers.new(name="BakeUV")
        me.uv_layers.active = uv
        uv.active_render = True
    select_only(ob)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def _img(name, size, non_color=False):
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def _set_target(ob, img):
    for slot in ob.material_slots:
        nt = slot.material.node_tree
        nd = nt.nodes.get("__bake__") or nt.nodes.new("ShaderNodeTexImage")
        nd.name = "__bake__"
        nd.image = img
        nt.nodes.active = nd


def _pixels(img):
    a = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def _save(img, arr, path, non_color=False):
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    out = bpy.data.images.load(path)
    if non_color:
        out.colorspace_settings.name = "Non-Color"
    return out


def _metal_emit_swap(ob, on):
    """Bake helper: route each material's Metallic input into an emission shader."""
    for slot in ob.material_slots:
        nt = slot.material.node_tree
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
        if on:
            em = nt.nodes.new("ShaderNodeEmission")
            em.name = "__em__"
            src = bsdf.inputs["Metallic"]
            if src.is_linked:
                nt.links.new(src.links[0].from_socket, em.inputs["Color"])
            else:
                v = src.default_value
                em.inputs["Color"].default_value = (v, v, v, 1)
            nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
        else:
            nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
            em = nt.nodes.get("__em__")
            if em:
                nt.nodes.remove(em)


def bake(ob, size=TEX, ao_strength=0.55, metal=True):
    """Bake the object's procedural materials into one PBR material with textures."""
    key = ob.name
    tmp = os.path.join(OUT, "_tex")
    os.makedirs(tmp, exist_ok=True)
    apply_all(ob)
    first = next(s.material for s in ob.material_slots if s.material)
    for slot in ob.material_slots:
        if slot.material is None:
            slot.material = first  # e.g. faces left by a boolean cutter
    uv_unwrap(ob)
    select_only(ob)
    bk = bpy.context.scene.render.bake

    img = _img(key + "_c", size)
    _set_target(ob, img)
    bk.use_pass_direct = bk.use_pass_indirect = False
    bk.use_pass_color = True
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_clear=True, margin=6)
    col = _pixels(img).copy()

    ao_img = _img(key + "_ao", size, True)
    _set_target(ob, ao_img)
    bpy.ops.object.bake(type="AO", use_clear=True, margin=6)
    ao = _pixels(ao_img)[..., :1]
    col[..., :3] *= (1 - ao_strength) + ao_strength * ao

    nrm_img = _img(key + "_n", size, True)
    _set_target(ob, nrm_img)
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", use_clear=True, margin=6)
    nrm = _pixels(nrm_img).copy()

    r_img = _img(key + "_r", size, True)
    _set_target(ob, r_img)
    bpy.ops.object.bake(type="ROUGHNESS", use_clear=True, margin=6)
    rough = _pixels(r_img).copy()

    met = None
    if metal:
        m_img = _img(key + "_m", size, True)
        _set_target(ob, m_img)
        _metal_emit_swap(ob, True)
        bpy.ops.object.bake(type="EMIT", use_clear=True, margin=6)
        _metal_emit_swap(ob, False)
        met = _pixels(m_img).copy()
        if met[..., 0].max() < 0.02:
            met = None

    # glTF wants metallic/roughness in one texture (G = roughness, B = metallic)
    orm = np.ones_like(rough)
    orm[..., 0] = ao[..., 0]
    orm[..., 1] = rough[..., 0]
    orm[..., 2] = met[..., 0] if met is not None else 0.0

    c_img = _save(img, col, os.path.join(tmp, key + "_c.png"))
    n_img = _save(nrm_img, nrm, os.path.join(tmp, key + "_n.png"), True)
    o_img = _save(r_img, orm, os.path.join(tmp, key + "_orm.png"), True)

    m = bpy.data.materials.new(key)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    tc = nt.nodes.new("ShaderNodeTexImage"); tc.image = c_img
    nt.links.new(tc.outputs["Color"], bsdf.inputs["Base Color"])
    tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = n_img
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    to = nt.nodes.new("ShaderNodeTexImage"); to.image = o_img
    sp = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(to.outputs["Color"], sp.inputs["Color"])
    nt.links.new(sp.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sp.outputs["Blue"], bsdf.inputs["Metallic"])
    ob.data.materials.clear()
    ob.data.materials.append(m)
    me = ob.data
    for layer in [l for l in me.uv_layers if l.name != me.uv_layers.active.name]:
        me.uv_layers.remove(layer)   # the game only needs the baked layout
    return ob


def export(name, obs):
    select_only(*obs)
    path = os.path.join(OUT, name + ".glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True,
                              export_apply=True, export_texcoords=True, export_normals=True,
                              export_materials="EXPORT", export_image_format="WEBP", export_image_quality=86)
    print("WROTE", name, os.path.getsize(path))


# ----------------------------------------------------------------------------- shapes
def blob(name, r=1.0, seed=0, squash=(1, 1, 0.7), rough=0.25, sub=5, flat_bottom=0.15):
    """A natural rock: subdivided ico-sphere pushed around by layered noise, faceted a bit."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    off = Vector((seed * 3.1, seed * 1.7, seed * 2.3))
    for v in bm.verts:
        n = v.co.normalized()
        d = 1 + noise.noise(n * 1.6 + off) * rough + noise.noise(n * 4.5 + off) * rough * 0.3
        # chiselled facets
        d += abs(noise.noise(n * 2.5 + off * 2)) * -rough * 0.5
        v.co = Vector((n.x * squash[0], n.y * squash[1], n.z * squash[2])) * r * d
        if v.co.z < -r * flat_bottom:
            v.co.z = -r * flat_bottom + (v.co.z + r * flat_bottom) * 0.15
    ob = from_bmesh(name, bm)
    return ob


def mat_ashlar(name, base="#b39a76", dark="#7a664b", light="#d8c6a2", mortar="#4f4334", rows=8.0, cols=4.5,
               moss=0.3, rough=0.85):
    """Coursed ashlar masonry for any wall shape: courses follow Z and every course gets its own
    voronoi pattern in the XY plane, so vertical joints stay straight on round towers too."""
    t = NT(name)
    x, y, z = t.sep(t.coord)
    zr = t.math("MULTIPLY", z, rows)
    row = t.math("FLOOR", zr)
    frac = t.math("FRACT", zr)
    cv = t.comb(t.math("MULTIPLY", x, cols), t.math("MULTIPLY", y, cols), t.math("MULTIPLY", row, 3.17))
    edge = t.voronoi(cv, 1.0, feature="DISTANCE_TO_EDGE", rand=0.8)
    cell = t.voronoi(cv, 1.0, out="Color", rand=0.8)
    hj = t.ramp(frac, [(0.0, 0.0), (0.08, 1.0), (0.92, 1.0), (1.0, 0.0)])
    vj = t.ramp(edge, [(0.0, 0.0), (0.05, 1.0)])
    joint = t.math("MINIMUM", hj, vj)
    chips = t.noise(t.vec(), 40, detail=6, rough=0.7)
    tone = t.math("ADD", t.math("MULTIPLY", t.sep(cell)[0], 0.75), t.math("MULTIPLY", chips, 0.25))
    col = t.ramp(tone, [(0.2, C(dark)), (0.55, C(base)), (0.9, C(light))])
    col = t.mix(joint, C(mortar), col)
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.2)), 0.75), col, C("#2a2219"))
    streak = t.noise(t.vec(scale=(7, 7, 0.35)), 2.5, detail=3)
    col = t.mix(t.ramp(streak, [(0.5, 0.0), (0.78, 0.4)]), col, C("#4a3f2e"))
    if moss > 0:
        mcol = t.ramp(t.noise(t.vec(), 45, detail=6), [(0.3, C("#2d4619")), (0.7, C("#62852b"))])
        col = t.mix(moss_mask(t, moss, up=0.5), col, mcol)
        # algae creeping up from the ground
        low = t.ramp(t.math("ADD", z, t.math("MULTIPLY", chips, 0.3)), [(0.3, 0.85), (0.6, 0.0)])
        col = t.mix(t.math("MULTIPLY", low, moss * 1.5), col, mcol)
    height = t.math("ADD", t.math("MULTIPLY", joint, 0.75), t.math("MULTIPLY", chips, 0.25))
    return t.finish(col, rough=rough, normal=t.bump(height, 0.7, 0.012))


def mat_shingles(name, base="#323e4e", dark="#141a22", light="#55677e", rows=24.0, cols=10.0):
    """Slate shingles for roofs of any shape: rows along Z, staggered per row, each shingle
    darker where the one above overlaps it."""
    t = NT(name)
    x, y, z = t.sep(t.coord)
    zr = t.math("MULTIPLY", z, rows)
    row = t.math("FLOOR", zr)
    frac = t.math("FRACT", zr)
    cv = t.comb(t.math("MULTIPLY", x, cols), t.math("MULTIPLY", y, cols), t.math("MULTIPLY", row, 2.71))
    edge = t.voronoi(cv, 1.0, feature="DISTANCE_TO_EDGE", rand=0.6)
    cell = t.voronoi(cv, 1.0, out="Color", rand=0.6)
    vj = t.ramp(edge, [(0.0, 0.0), (0.06, 1.0)])
    lap = t.ramp(frac, [(0.0, 0.15), (0.15, 0.6), (1.0, 1.0)])
    n = t.noise(t.vec(), 50, detail=4)
    tone = t.math("ADD", t.math("MULTIPLY", t.sep(cell)[0], 0.6), t.math("MULTIPLY", n, 0.4))
    col = t.ramp(tone, [(0.2, C(dark)), (0.55, C(base)), (0.9, C(light))])
    col = t.mix(t.math("MULTIPLY", vj, lap), C("#07090c"), col)
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.15)), 0.6), col, C("#050608"))
    height = t.math("MULTIPLY", vj, lap)
    return t.finish(col, rough=0.5, normal=t.bump(height, 0.8, 0.012))


def mat_banner(name, cx, cz, half_w, top, red="#9e1b22", gold="#d9a63a"):
    """Heraldic banner: red cloth with a gold border and a gold roundel, laid out around the
    banner's centre line x = cx (object coordinates; the banner hangs in the XZ plane)."""
    t = NT(name)
    x, _, z = t.sep(t.coord)
    dx = t.math("ABSOLUTE", t.math("SUBTRACT", x, cx))
    border = t.math("MAXIMUM", t.math("GREATER_THAN", dx, half_w - 0.012), t.math("GREATER_THAN", z, top - 0.014))
    dz = t.math("SUBTRACT", z, cz)
    r2 = t.math("ADD", t.math("MULTIPLY", dx, dx), t.math("MULTIPLY", dz, dz))
    roundel = t.math("LESS_THAN", r2, 0.032 ** 2)
    ring = t.math("LESS_THAN", r2, 0.04 ** 2)
    weave = t.noise(t.vec(), 300, detail=2)
    col = t.mix(t.math("MAXIMUM", border, roundel), C(red), C(gold))
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", ring, roundel), 0.85), col, C("#3a0a0c"))
    col = t.mix(t.math("MULTIPLY", weave, 0.15), col, C("#000000"))
    return t.finish(col, rough=0.8)


# ----------------------------------------------------------------------------- architecture
def part(kind, mat=None, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), bevel=0.0, **kw):
    """A primitive with its transform applied, so joins and booleans see the real geometry.
    Cubes are unit-sized, so `scale` is their size."""
    if kind == "cube":
        kw.setdefault("size", 1)
    getattr(bpy.ops.mesh, "primitive_" + kind + "_add")(location=loc, rotation=rot, **kw)
    ob = bpy.context.active_object
    ob.scale = scale
    transform_apply(ob)
    if mat is not None:
        ob.data.materials.append(mat)
    if bevel:
        mod(ob, "BEVEL", width=bevel, segments=2, limit_method="ANGLE")
    return ob


def place_local(obs, M):
    """Move objects built in a local frame into place with matrix M (and bake the transform)."""
    for o in obs:
        o.matrix_world = M @ o.matrix_world
        transform_apply(o)


def frame_at(x, y, z, facing):
    """Local frame on a wall: origin at (x, y, z), local -Y pointing along `facing` (radians)."""
    return Matrix.Translation(Vector((x, y, z))) @ Matrix.Rotation(facing + math.pi / 2, 4, "Z")


def half(ob, axis=2, keep_above=0.0):
    """Delete vertices below `keep_above` along an axis (e.g. keep the top half of a torus)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co[axis] < keep_above - 1e-5], context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def arch_outline(w, hr, z0=0.0, n=14):
    """Outline (x, z) of an arched opening: a rectangle of height hr topped by a semicircle."""
    pts = [(-w / 2, z0), (w / 2, z0), (w / 2, z0 + hr)]
    pts += [(math.cos(math.pi * i / n) * w / 2, z0 + hr + math.sin(math.pi * i / n) * w / 2) for i in range(1, n)]
    pts.append((-w / 2, z0 + hr))
    return pts


def prism(name, pts, y0, y1, mat):
    """Extrude an outline in the XZ plane between depths y0 and y1."""
    bm = bmesh.new()
    a = [bm.verts.new((x, y0, z)) for x, z in pts]
    b = [bm.verts.new((x, y1, z)) for x, z in pts]
    bm.faces.new(a)
    bm.faces.new(list(reversed(b)))
    n = len(pts)
    for i in range(n):
        bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = from_bmesh(name, bm, smooth=False)
    if mat is not None:
        ob.data.materials.append(mat)
    return ob


def arched_window(M, w, h, trim, bars, glass, out, slit=False):
    """Arched window recessed into a wall. Local frame (see frame_at): origin at the window's
    centre on the wall surface, -Y out of the wall. Appends boolean cutters to out["cut"],
    frame pieces to out["parts"] and the glass pane to out["glow"]."""
    hr = h - w / 2
    z0 = -h / 2
    cut = prism("Cut", arch_outline(w, hr, z0, 10), -0.06, 0.18, None)   # one closed solid
    place_local([cut], M)
    out["cut"].append(cut)
    if slit:
        return
    fr = [part("cube", trim, loc=(0, -0.02, z0 - 0.013), scale=(w + 0.07, 0.07, 0.026), bevel=0.005)]  # sill
    fr += [part("cube", trim, loc=(sx * (w / 2 + 0.014), -0.008, z0 + hr / 2), scale=(0.028, 0.045, hr)) for sx in (-1, 1)]
    fr.append(half(part("torus", trim, loc=(0, -0.008, z0 + hr), rot=(math.pi / 2, 0, 0), major_radius=w / 2 + 0.014,
                        minor_radius=0.016, major_segments=20, minor_segments=6), 2, z0 + hr))
    fr.append(part("cube", trim, loc=(0, -0.012, z0 + h + 0.016), scale=(0.034, 0.05, 0.048), bevel=0.004))  # keystone
    fr.append(part("cube", bars, loc=(0, 0.1, z0 + h / 2), scale=(0.011, 0.012, h)))                        # mullion
    fr.append(part("cube", bars, loc=(0, 0.1, z0 + hr * 0.62), scale=(w, 0.012, 0.011)))                    # transom
    place_local(fr, M)
    out["parts"] += fr
    pane = prism("Pane", arch_outline(w, hr, z0), 0.105, 0.11, glass)
    place_local([pane], M)
    out["glow"].append(pane)


def round_tower(cx, cy, r, z0, top, roof_h, stone, trim, roofm, out):
    """Round tower with a battered foot, a moulding ring, machicolation corbels carrying an
    overhanging crenellated parapet, and a steep cone roof standing inside the battlements."""
    t = part("cylinder", stone, loc=(cx, cy, (z0 + top) / 2), radius=r, depth=top - z0, vertices=48)
    for v in t.data.vertices:
        k = (v.co.z - z0) / (top - z0)
        sc = 1 + 0.08 * max(0.0, 0.22 - k) / 0.22
        v.co.x = cx + (v.co.x - cx) * sc
        v.co.y = cy + (v.co.y - cy) * sc
    ps = [part("torus", trim, loc=(cx, cy, z0 + (top - z0) * 0.45), major_radius=r + 0.004, minor_radius=0.017,
               major_segments=48, minor_segments=6)]
    n = max(12, int(TAU * r / 0.1))
    for k in range(n):
        a = TAU * k / n
        ps.append(part("cube", stone, loc=(cx + math.cos(a) * (r + 0.025), cy + math.sin(a) * (r + 0.025), top - 0.05),
                       rot=(0, 0, a), scale=(0.06, 0.045, 0.1), bevel=0.006))
    ps.append(part("cylinder", stone, loc=(cx, cy, top + 0.06), radius=r + 0.07, depth=0.16, vertices=48))
    for k in range(0, n, 2):
        a = TAU * (k + 0.5) / n
        ps.append(part("cube", stone, loc=(cx + math.cos(a) * (r + 0.045), cy + math.sin(a) * (r + 0.045), top + 0.2),
                       rot=(0, 0, a), scale=(0.05, TAU * (r + 0.05) / n * 0.95, 0.12), bevel=0.006))
    roof = part("cone", roofm, loc=(cx, cy, top + 0.12 + roof_h / 2), radius1=r + 0.03, radius2=0.0, depth=roof_h, vertices=48)
    for v in roof.data.vertices:  # eaves flare
        k = (v.co.z - (top + 0.12)) / roof_h
        f = 1 + 0.14 * (1 - k) ** 3
        v.co.x = cx + (v.co.x - cx) * f
        v.co.y = cy + (v.co.y - cy) * f
    ps.append(roof)
    peak = top + 0.12 + roof_h
    ps.append(part("uv_sphere", trim, loc=(cx, cy, peak + 0.01), radius=0.03, segments=12, ring_count=8))
    out["parts"] += [t] + ps
    out["flags"].append((cx, cy, peak + 0.03))
    return t


# ----------------------------------------------------------------------------- assets
def build_castle():
    """Sandstone castle on a rocky mound: a stone terrace with steps, a square keep with a
    studded double door, two flanking round towers and a tall rear tower with steep slate roofs,
    machicolations and battlements; recessed arched windows glow at night, torches by the door,
    flags on the roofs."""
    stone = mat_ashlar("Ashlar", moss=0.3)
    trim = mat_sandstone("Trim", base="#e2d4b6", dark="#a8977a", moss=0.2, rough=0.65)
    roofm = mat_shingles("Slate")
    wood = mat_wood("Door", base="#5a3a1f", dark="#2a190b", light="#7e5530", rings=18, along="Z", planks=30, seam_axis="X")
    iron = mat_metal("Iron", base="#2f2e2c", patina="#5a3418", patina_amt=0.6, rough=0.55, metal_max=0.6)
    out = {"parts": [], "cut": [], "glow": [], "flags": []}

    # rocky mound with a flattened top, the stone terrace on it and steps down at the front
    mound = blob("Mound", 1.0, seed=3, squash=(1.5, 1.0, 0.42), rough=0.2, sub=5, flat_bottom=0.05)
    for v in mound.data.vertices:
        if v.co.z > 0.2:
            v.co.z = 0.2 + (v.co.z - 0.2) * 0.12
    mound.location = (0, 0.08, -0.04)
    transform_apply(mound)
    mound.data.materials.append(mat_rock("MoundRock", moss=0.5))
    zt = 0.3  # terrace top
    out["parts"].append(part("cylinder", stone, loc=(0, 0.06, (0.12 + zt) / 2), radius=1.0, depth=zt - 0.12, vertices=10,
                             scale=(1.12, 0.78, 1), bevel=0.02))
    for i in range(3):
        out["parts"].append(part("cube", stone, loc=(0, -0.76 - i * 0.1, zt - 0.045 - i * 0.075),
                                 scale=(0.42 + i * 0.06, 0.12, 0.09), bevel=0.012))

    # towers: two flanking the keep, a tall one behind it
    z0 = zt - 0.02
    left = round_tower(-0.62, -0.08, 0.3, z0, 1.85, 0.95, stone, trim, roofm, out)
    right = round_tower(0.62, -0.08, 0.3, z0, 1.75, 0.9, stone, trim, roofm, out)
    rear = round_tower(0.0, 0.34, 0.3, z0, 2.35, 1.05, stone, trim, roofm, out)

    # square keep between the towers with a corbelled, crenellated parapet and a string course
    kf, kb, kt = -0.36, 0.24, 1.3      # front face y, back face y, top
    keep = part("cube", stone, loc=(0, (kf + kb) / 2, (z0 + kt) / 2), scale=(0.72, kb - kf, kt - z0))
    for i in range(9):
        out["parts"].append(part("cube", stone, loc=(-0.32 + i * 0.08, kf - 0.025, kt - 0.06), scale=(0.045, 0.05, 0.1), bevel=0.005))
    out["parts"].append(part("cube", stone, loc=(0, (kf + kb) / 2 - 0.02, kt + 0.05), scale=(0.8, kb - kf + 0.1, 0.14), bevel=0.01))
    for i in range(6):
        out["parts"].append(part("cube", stone, loc=(-0.33 + i * 0.132, kf - 0.03, kt + 0.18), scale=(0.075, 0.07, 0.13), bevel=0.006))
    out["parts"].append(part("cube", trim, loc=(0, kf - 0.012, z0 + 0.62), scale=(0.72, 0.024, 0.03)))

    # arched double door with a voussoir surround and studded iron straps
    dw, dhr = 0.27, 0.27
    boolean(keep, prism("DoorCut", arch_outline(dw, dhr, z0 - 0.002, 16), kf - 0.03, kf + 0.17, None))
    leaf = prism("Door", arch_outline(dw, dhr, z0), kf + 0.09, kf + 0.12, wood)
    out["parts"].append(leaf)
    out["parts"].append(part("cube", iron, loc=(0, kf + 0.086, z0 + (dhr + dw / 2) / 2), scale=(0.012, 0.01, dhr + dw / 2)))
    for zz in (0.06, 0.17, 0.28):
        w_at = dw if zz < dhr else 2 * math.sqrt(max(0.0, (dw / 2) ** 2 - (zz - dhr) ** 2))
        out["parts"].append(part("cube", iron, loc=(0, kf + 0.084, z0 + zz), scale=(w_at - 0.01, 0.01, 0.026)))
        for k in range(7):
            xx = -w_at / 2 + 0.02 + k * (w_at - 0.04) / 6
            out["parts"].append(part("uv_sphere", iron, loc=(xx, kf + 0.078, z0 + zz), radius=0.007, segments=8, ring_count=5))
    for sx in (-1, 1):
        out["parts"].append(part("torus", iron, loc=(sx * 0.045, kf + 0.072, z0 + 0.19), rot=(math.pi / 2, 0, 0),
                                 major_radius=0.022, minor_radius=0.005, major_segments=16, minor_segments=5))
    nv = 9
    for i in range(nv):
        a0, a1 = math.pi * i / nv, math.pi * (i + 1) / nv
        r0, r1 = dw / 2 + 0.005, dw / 2 + 0.075 + (0.02 if i == nv // 2 else 0)
        bm = bmesh.new()
        vs = [bm.verts.new((math.cos(a) * rr, y, z0 + dhr + math.sin(a) * rr))
              for a in (a0 + 0.012, a1 - 0.012) for rr in (r0, r1) for y in (kf - 0.03, kf + 0.01)]
        bmesh.ops.convex_hull(bm, input=vs)
        vb = from_bmesh(f"Vous{i}", bm, smooth=False)
        vb.data.materials.append(trim)
        mod(vb, "BEVEL", width=0.004, segments=1)
        out["parts"].append(vb)
    for sx in (-1, 1):
        for k in range(3):
            out["parts"].append(part("cube", trim, loc=(sx * (dw / 2 + 0.04), kf - 0.01, z0 + 0.045 + k * 0.09),
                                     scale=(0.07 if k % 2 else 0.09, 0.04, 0.085), bevel=0.004))
    # torches beside the door
    flame = mat_plain("GlowTorch", "#ffb347", rough=0.4, emission=("#ff9a2a", 1.0))
    for sx in (-1, 1):
        x = sx * 0.25
        out["parts"].append(part("cube", iron, loc=(x, kf - 0.03, z0 + 0.33), scale=(0.03, 0.06, 0.02)))
        out["parts"].append(part("cylinder", wood, loc=(x, kf - 0.06, z0 + 0.37), radius=0.012, depth=0.11, vertices=8))
        out["parts"].append(part("cylinder", iron, loc=(x, kf - 0.06, z0 + 0.43), radius=0.02, depth=0.03, vertices=8))
        out["glow"].append(part("uv_sphere", flame, loc=(x, kf - 0.06, z0 + 0.47), radius=0.025, segments=10,
                                ring_count=6, scale=(1, 1, 1.7)))

    # heraldic banner between the keep windows, hanging from an iron rod under the corbels
    bt, bb, bw = 1.17, 0.9, 0.13
    bm = bmesh.new()
    rows = []
    for j in range(9):
        v = j / 8
        z = bt - (bt - bb) * v
        row = []
        for i in range(5):
            u = i / 4
            xx = (u - 0.5) * bw
            if j == 8:
                z = bb - 0.05 * (1 - abs(u - 0.5) * 2)   # pointed tail
            row.append(bm.verts.new((xx, kf - 0.032 - 0.004 * math.sin(u * 9 + v * 4), z)))   # in front of the string course
        rows.append(row)
    for j in range(8):
        for i in range(4):
            bm.faces.new((rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]))
    banner = from_bmesh("Banner", bm)
    mod(banner, "SOLIDIFY", thickness=0.004)
    banner.data.materials.append(mat_banner("BannerCloth", 0.0, 1.06, bw / 2, bt))
    out["parts"].append(banner)
    out["parts"].append(part("cylinder", iron, loc=(0, kf - 0.034, bt + 0.008), rot=(0, math.pi / 2, 0), radius=0.006, depth=bw + 0.04, vertices=8))
    for sx in (-1, 1):   # the rod's wall brackets
        out["parts"].append(part("cube", iron, loc=(sx * (bw / 2 + 0.012), kf - 0.018, bt + 0.008), scale=(0.008, 0.036, 0.012)))

    # windows: keep front, tower fronts, arrow slits on the sides
    kw = dict(trim=trim, bars=iron, glass=mat_plain("GlowWindow", "#2a1a08", rough=0.5, emission=("#ffb347", 1.0)), out=out)
    for x in (-0.19, 0.19):
        arched_window(frame_at(x, kf, 1.0, -math.pi / 2), 0.09, 0.17, **kw)
    boolean(keep, join("KeepCuts", out["cut"][:]))
    out["parts"].append(keep)
    for tw, (cx, cy, r), zs, faces in ((left, (-0.62, -0.08, 0.3), (1.05, 1.45), (-2.1, -1.9)),
                                       (right, (0.62, -0.08, 0.3), (1.0, 1.4), (-1.05, -1.25)),
                                       (rear, (0.0, 0.34, 0.3), (1.6, 2.0), (-1.4, -1.75))):
        out["cut"] = []
        for z, a in zip(zs, faces):
            arched_window(frame_at(cx + math.cos(a) * r, cy + math.sin(a) * r, z, a), 0.1, 0.19, **kw)
        for a, z in ((faces[0] + 1.2, 0.8), (faces[1] - 1.3, 1.2)):
            arched_window(frame_at(cx + math.cos(a) * r, cy + math.sin(a) * r, z, a), 0.03, 0.13, slit=True, **kw)
        boolean(tw, join("Cuts", out["cut"]))

    for p in out["parts"]:
        apply_all(p)
    body = join("Castle", out["parts"])
    shade_smooth(body, 35)
    bake(body, size=2048)
    shade_smooth(mound, 50)
    bake(mound, size=1024, metal=False)
    win = join("GlowWindows", out["glow"])

    # cloth flags on poles above the roof finials (sway shader)
    flagm = mat_plain("SwayFlag", "#c63a35", rough=0.8)
    flags = []
    for i, (x, y, top) in enumerate(out["flags"]):
        pole = part("cylinder", mat_plain(f"Pole{i}", "#3a2f25"), loc=(x, y, top + 0.16), radius=0.008, depth=0.32, vertices=6)
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=8, y_segments=3, size=0.5)
        for v in bm.verts:
            u = v.co.x + 0.5
            notch = 0.04 * max(0.0, u - 0.75) / 0.25 * (1 - abs(v.co.y) * 2)   # swallowtail
            v.co = Vector((u * (0.2 - notch), math.sin(u * 5) * 0.012, v.co.y * 0.12))
        fl = from_bmesh(f"Flag{i}", bm)
        fl.location = (x + 0.005, y, top + 0.26)
        fl.data.materials.append(flagm)
        flags.append(join(f"SwayFlag{i}", [fl, pole]))
        set_origin(flags[-1], (x, y, top))
    export("castle", [body, mound, win] + flags)


def decimate(ob, ratio):
    mod(ob, "DECIMATE", ratio=ratio)
    apply_all(ob)


def rock_obj(name, r, seed, squash, rough, mat, sub=5, detail=0.06):
    ob = blob(name, r, seed=seed, squash=squash, rough=rough, sub=sub)
    displace(ob, detail * r, 0.45 * r, seed)
    apply_all(ob)
    ob.data.materials.append(mat)
    return ob


def build_rocks():
    """Six boulder variants (unit size, the game scales them)."""
    kinds = [
        ((1.0, 0.9, 0.62), 0.28, "#7b746a", "#3f3a34", "#a59c8f", 0.45),
        ((1.2, 0.8, 0.5), 0.22, "#6f7378", "#33363b", "#9da3a9", 0.35),
        ((0.9, 0.85, 0.8), 0.32, "#857560", "#463b2e", "#b3a088", 0.4),
        ((1.1, 1.0, 0.45), 0.2, "#5f625f", "#2b2d2b", "#8c908b", 0.55),
        ((1.0, 0.7, 0.7), 0.35, "#8a8174", "#4a443b", "#b9ad9b", 0.3),
        ((1.3, 0.9, 0.55), 0.25, "#6e665c", "#36312b", "#9b917f", 0.5),
    ]
    obs = []
    for i, (sq, rough, base, dark, light, moss) in enumerate(kinds):
        ob = rock_obj(f"Rock{i}", 1.0, 11 + i * 7, sq, rough, mat_rock(f"RockM{i}", base, dark, light, moss=moss))
        decimate(ob, 0.35)
        shade_smooth(ob, 40)
        bake(ob, 1024, metal=False)
        obs.append(ob)
    export("rocks", obs)


def build_arch():
    """A natural arch of stacked boulders (fish swim through it)."""
    mat = mat_rock("ArchRock", "#7a7368", "#3c3731", "#a39a8c", moss=0.5, scale=3.5)
    parts = []
    rng = random.Random(5)
    for i in range(13):
        a = math.pi * i / 12
        r = 0.27 + math.sin(a) * 0.04
        ob = rock_obj(f"A{i}", r, 300 + i, (1.0, 0.9, 0.85), 0.25, mat, sub=4)
        ob.location = (math.cos(a) * 0.85, rng.uniform(-0.04, 0.04), math.sin(a) * 1.0)
        ob.rotation_euler = (rng.uniform(0, 3), rng.uniform(0, 3), rng.uniform(0, 3))
        parts.append(ob)
    for x in (-0.95, 0.95):  # footing boulders
        ob = rock_obj("F", 0.4, int(500 + x * 10), (1.1, 0.9, 0.6), 0.25, mat, sub=4)
        ob.location = (x, 0.05, -0.05)
        parts.append(ob)
    for p in parts:
        transform_apply(p)
    arch = join("Arch", parts)
    decimate(arch, 0.4)
    shade_smooth(arch, 40)
    bake(arch, 2048, metal=False)
    export("arch", [arch])


def build_cave():
    """Hollow rock with a dark mouth facing the front and glowing crystals inside."""
    mat = mat_rock("CaveRock", "#716b62", "#37332e", "#9a9285", moss=0.45, scale=2.5)
    outer = rock_obj("Cave", 1.0, 404, (1.2, 1.0, 0.78), 0.22, mat, sub=5)
    inner = blob("Inner", 0.78, seed=405, squash=(1.15, 0.95, 0.75), rough=0.18, sub=4, flat_bottom=0.0)
    inner.location = (0.0, -0.05, 0.02)
    transform_apply(inner)
    boolean(outer, inner)
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.42, depth=1.2, location=(0.05, -0.8, 0.25), rotation=(math.pi / 2, 0, 0))
    mouth = bpy.context.active_object
    mouth.scale = (1.0, 0.75, 1.0)
    displace(mouth, 0.08, 0.3, 9, levels=2)
    apply_all(mouth)
    boolean(outer, mouth)
    decimate(outer, 0.45)
    shade_smooth(outer, 45)
    bake(outer, 2048, metal=False)
    # crystals
    cm = mat_plain("GlowCrystal", "#7ef0ff", rough=0.08, emission=("#38d6ff", 1.0))
    rng = random.Random(3)
    cr = []
    for i in range(7):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=0.05, radius2=0.0, depth=rng.uniform(0.18, 0.34))
        o = from_bmesh(f"C{i}", bm, smooth=False)
        o.location = (0.15 + rng.uniform(-0.15, 0.15), 0.0 + rng.uniform(-0.1, 0.1), 0.1)
        o.rotation_euler = (rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5), rng.uniform(0, 3))
        o.data.materials.append(cm)
        cr.append(o)
    crystals = join("GlowCrystals", cr)
    export("cave", [outer, crystals])


def column(name, h, r, mat, broken=False, seed=0):
    """Fluted column with base and capital."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=r, depth=h, location=(0, 0, h / 2 + 0.12))
    c = bpy.context.active_object
    c.name = name
    bm = bmesh.new()
    bm.from_mesh(c.data)
    bmesh.ops.subdivide_edges(bm, edges=[e for e in bm.edges if abs(e.verts[0].co.z - e.verts[1].co.z) > 1e-4], cuts=12)
    rng = random.Random(seed)
    for v in bm.verts:
        a = math.atan2(v.co.y, v.co.x)
        k = 1 - 0.05 * max(0.0, math.cos(a * 20)) ** 0.5   # flutes
        z = (v.co.z + h / 2) / h
        k *= 1 - 0.06 * z                                 # entasis taper
        v.co.x *= k
        v.co.y *= k
        if broken and z > 0.97:                           # jagged break
            v.co.z -= abs(noise.noise(Vector((v.co.x * 9, v.co.y * 9, seed)))) * 0.25
    bm.to_mesh(c.data)
    bm.free()
    c.data.materials.append(mat)
    parts = [c]
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.06))
    b = bpy.context.active_object
    b.scale = (r * 2.6, r * 2.6, 0.12)
    mod(b, "BEVEL", width=0.02, segments=3)
    b.data.materials.append(mat)
    parts.append(b)
    bpy.ops.mesh.primitive_torus_add(major_radius=r * 1.05, minor_radius=r * 0.18, location=(0, 0, 0.14))
    torus = bpy.context.active_object
    torus.data.materials.append(mat)
    parts.append(torus)
    if not broken:
        bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=r * 0.95, radius2=r * 1.4, depth=0.14, location=(0, 0, h + 0.19))
        cap = bpy.context.active_object
        cap.data.materials.append(mat)
        parts.append(cap)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, h + 0.31))
        ab = bpy.context.active_object
        ab.scale = (r * 3.0, r * 3.0, 0.1)
        mod(ab, "BEVEL", width=0.015, segments=2)
        ab.data.materials.append(mat)
        parts.append(ab)
    for p in parts:
        apply_all(p)
        transform_apply(p)  # origin at the column's foot
    return join(name, parts)


def build_ruins():
    """Overgrown ruined gateway: two columns carrying a stone arch (one side broken),
    a third broken column, a fallen drum and scattered blocks."""
    mat = mat_sandstone("Ruin", moss=0.45)
    parts = []
    h = 1.55
    for x, s in ((-0.62, 1), (0.62, 2)):
        c = column(f"Col{s}", h, 0.16, mat, seed=s)
        c.location = (x, 0, 0)
        parts.append(c)
    # arch of voussoirs resting on the abaci; the right end has lost two stones
    top = h + 0.36
    n = 11
    for i in range(n):
        if i >= n - 2:
            continue
        a0, a1 = math.pi * i / n, math.pi * (i + 1) / n
        bm = bmesh.new()
        ri, ro = 0.5, 0.74
        vs = []
        for a in (a0, a1):
            for rr in (ri, ro):
                for y in (-0.17, 0.17):
                    vs.append(bm.verts.new((math.cos(a) * rr * 1.24, y, top + math.sin(a) * rr)))
        bmesh.ops.convex_hull(bm, input=vs)
        v = from_bmesh(f"V{i}", bm, smooth=False)
        mod(v, "BEVEL", width=0.018, segments=2)
        v.data.materials.append(mat)
        apply_all(v)
        parts.append(v)
    c3 = column("Col3", 0.95, 0.15, mat, broken=True, seed=3)
    c3.location = (1.35, -0.25, 0)
    parts.append(c3)
    # fallen drum and blocks
    bpy.ops.mesh.primitive_cylinder_add(vertices=40, radius=0.15, depth=0.62, location=(1.25, 0.35, 0.12), rotation=(0, math.pi / 2, 0.5))
    d = bpy.context.active_object
    d.data.materials.append(mat)
    parts.append(d)
    rng = random.Random(7)
    for i in range(5):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(rng.uniform(-1.3, 1.0), rng.uniform(-0.6, 0.5), 0.07))
        b = bpy.context.active_object
        b.scale = (rng.uniform(0.18, 0.34), rng.uniform(0.15, 0.25), rng.uniform(0.12, 0.2))
        b.rotation_euler = (rng.uniform(-0.2, 0.2), rng.uniform(-0.2, 0.2), rng.uniform(0, 3))
        mod(b, "BEVEL", width=0.025, segments=2)
        b.data.materials.append(mat)
        parts.append(b)
    for p in parts:
        apply_all(p)
        transform_apply(p)
    ruins = join("Ruins", parts)
    shade_smooth(ruins, 35)
    bake(ruins, 2048, metal=False)
    export("ruins", [ruins])



def tube_curve(name, paths, res=5, bevel_res=4):
    """paths: list of [(co, radius), ...] -> one mesh object of round tapered tubes."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = 1.0
    cu.bevel_resolution = bevel_res
    cu.resolution_u = res
    cu.use_fill_caps = True
    for pts in paths:
        sp = cu.splines.new("NURBS")
        sp.points.add(len(pts) - 1)
        for p, (co, r) in zip(sp.points, pts):
            p.co = (*co, 1.0)
            p.radius = r
        sp.order_u = 3
        sp.use_endpoint_u = True
    ob = link(bpy.data.objects.new(name, cu))
    select_only(ob)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.view_layer.objects.active


def catmull(pts, sub):
    """Catmull-Rom resampling of [(Vector, radius), ...] with `sub` steps per segment."""
    out = []
    n = len(pts)
    for i in range(n - 1):
        p0, p1, p2, p3 = (pts[max(i - 1, 0)], pts[i], pts[i + 1], pts[min(i + 2, n - 1)])
        for k in range(sub):
            t = k / sub
            t2, t3 = t * t, t * t * t
            w = (-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2)
            co = p0[0] * w[0] + p1[0] * w[1] + p2[0] * w[2] + p3[0] * w[3]
            r = p1[1] + (p2[1] - p1[1]) * t
            out.append((co, r))
    out.append(pts[-1])
    return out


def sweep(name, paths, seg=12, sub=4):
    """Round tubes along paths [(Vector, radius), ...] with a "Grain" UV layer: u around the
    tube, v = distance along it, so a material can run fibres along every branch."""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("Grain")
    for pts in paths:
        P = catmull([(Vector(c), r) for c, r in pts], sub)
        rings, along, prev = [], 0.0, None
        for i, (co, r) in enumerate(P):
            t = (P[min(i + 1, len(P) - 1)][0] - P[max(i - 1, 0)][0]).normalized()
            nrm = t.orthogonal().normalized() if prev is None else (prev - t * prev.dot(t)).normalized()
            prev = nrm
            bi = t.cross(nrm)
            if i:
                along += (P[i][0] - P[i - 1][0]).length
            rings.append(([bm.verts.new(co + (nrm * math.cos(TAU * j / seg) + bi * math.sin(TAU * j / seg)) * r)
                           for j in range(seg)], along))
        for (a, va), (b, vb) in zip(rings, rings[1:]):
            for j in range(seg):
                j2 = (j + 1) % seg
                f = bm.faces.new((a[j], a[j2], b[j2], b[j]))
                for loop, uv in zip(f.loops, ((j / seg, va), ((j + 1) / seg, va), ((j + 1) / seg, vb), (j / seg, vb))):
                    loop[uvl].uv = uv
        for ring, v in (rings[0], rings[-1]):   # caps
            c = bm.verts.new(sum((x.co for x in ring), Vector()) / seg)
            for j in range(seg):
                f = bm.faces.new((ring[j], ring[(j + 1) % seg], c))
                for loop in f.loops:
                    loop[uvl].uv = (0.5, v)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return from_bmesh(name, bm)


def mat_driftwood(name, base="#8a5a3a", dark="#341f12", light="#c09a72", moss=0.2):
    """Weathered driftwood: deep fibres running along each branch (read from the Grain UV)."""
    t = NT(name)
    uv = t.n("ShaderNodeUVMap", uv_map="Grain").outputs["UV"]
    m = t.n("ShaderNodeMapping")
    t.l(uv, m.inputs["Vector"])
    m.inputs["Scale"].default_value = (14, 0.9, 1)
    fib = t.noise(m.outputs["Vector"], 3.0, detail=8, rough=0.65, distortion=0.6)
    grooves = t.ramp(fib, [(0.35, 0.0), (0.55, 1.0)])
    fine = t.noise(t.vec(), 90, detail=3)
    col = t.ramp(t.math("ADD", t.math("MULTIPLY", fib, 0.8), t.math("MULTIPLY", fine, 0.2)), [(0.3, C(dark)), (0.55, C(base)), (0.8, C(light))])
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.12)), 0.8), col, C("#140b05"))
    if moss > 0:
        mcol = t.ramp(t.noise(t.vec(), 45, detail=6), [(0.3, C("#2b4317")), (0.7, C("#5b7a27"))])
        col = t.mix(moss_mask(t, moss), col, mcol)
    return t.finish(col, rough=0.85, normal=t.bump(t.math("ADD", grooves, t.math("MULTIPLY", fine, 0.15)), 0.9, 0.02))


def mat_basalt(name, moss=0.2):
    """Dark craggy volcanic rock with pale mineral flecks."""
    t = NT(name)
    n = t.noise(t.vec(), 4, detail=8, rough=0.7, distortion=0.5)
    fleck = t.ramp(t.voronoi(t.vec(), 70, out="Distance"), [(0.0, 1.0), (0.08, 0.0)])
    pits = t.ramp(t.noise(t.vec(), 25, detail=4), [(0.35, 1.0), (0.45, 0.0)])
    col = t.ramp(n, [(0.25, C("#17181a")), (0.55, C("#35373a")), (0.85, C("#5f6266"))])
    col = t.mix(t.math("MULTIPLY", fleck, 0.6), col, C("#b8b2a6"))
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.25)), 0.85), col, C("#08090a"))
    if moss > 0:
        mcol = t.ramp(t.noise(t.vec(), 45, detail=6), [(0.3, C("#2d4619")), (0.7, C("#62852b"))])
        col = t.mix(moss_mask(t, moss, up=0.65), col, mcol)
    height = t.math("ADD", n, t.math("MULTIPLY", pits, -0.3))
    return t.finish(col, rough=0.8, normal=t.bump(height, 1.0, 0.04))


def craggy(name, r, seed, squash, mat):
    """Angular rock: a blob broken up by cell-shaped facets."""
    ob = blob(name, r, seed=seed, squash=squash, rough=0.3, sub=5)
    displace(ob, 0.16 * r, 0.55 * r, seed)
    displace(ob, 0.05 * r, 0.18 * r, seed + 1)
    apply_all(ob)
    ob.data.materials.append(mat)
    return ob


def build_rockpile():
    """Two heaps of dark craggy rocks, stacked and leaning on each other, with a little moss."""
    obs = []
    layouts = [
        [((0, 0, 0.18), 0.5, (1.1, 1.0, 0.7)), ((0.42, -0.1, 0.12), 0.34, (1, 0.9, 0.8)), ((-0.38, 0.12, 0.1), 0.3, (1, 1, 0.75)),
         ((0.08, 0.05, 0.62), 0.32, (1, 0.9, 0.85)), ((0.3, -0.38, 0.06), 0.16, (1, 1, 0.8)), ((-0.25, -0.35, 0.05), 0.13, (1, 1, 0.8))],
        [((0, 0, 0.14), 0.42, (1.2, 0.9, 0.65)), ((0.3, 0.2, 0.42), 0.28, (1, 1, 0.9)), ((-0.36, -0.1, 0.1), 0.26, (1, 0.9, 0.8)),
         ((0.45, -0.28, 0.07), 0.15, (1, 1, 0.8))],
    ]
    for i, lay in enumerate(layouts):
        mat = mat_basalt(f"Basalt{i}", moss=0.25)
        rocks = []
        for k, (loc, r, sq) in enumerate(lay):
            ob = craggy(f"R{i}{k}", r, 200 + i * 10 + k, sq, mat)
            ob.location = loc
            ob.rotation_euler = (0.2 * math.sin(k * 3), 0.2 * math.cos(k * 2), k * 1.3)
            transform_apply(ob)
            rocks.append(ob)
        pile = join(f"Pile{i}", rocks)
        decimate(pile, 0.35)
        shade_smooth(pile, 35)
        bake(pile, 1024, metal=False)
        obs.append(pile)
    export("rockpile", obs)



def build_driftwood():
    """Gnarled driftwood: a thick twisted log lying on the sand with a split second log across
    it, a few rising limbs and broken stubs; deep fibres run along every branch."""
    rng = random.Random(777)
    paths = []

    def limb(start, d, length, rad, depth, n=7):
        pts = [(start.copy(), rad)]
        p = start.copy()
        for i in range(n):
            d = (d + Vector((rng.uniform(-0.45, 0.45), rng.uniform(-0.45, 0.45), rng.uniform(-0.3, 0.35))) * 0.35).normalized()
            p = p + d * (length / n)
            pts.append((p.copy(), rad * (1 - 0.7 * (i + 1) / n) * rng.uniform(0.85, 1.15)))
        paths.append(pts)
        if depth > 0:
            for _ in range(1 + rng.randrange(2)):
                k = rng.randint(2, n - 2)
                nd = (d + Vector((rng.uniform(-0.7, 0.7), rng.uniform(-0.7, 0.7), rng.uniform(0.0, 0.7)))).normalized()
                limb(pts[k][0], nd, length * 0.5, pts[k][1] * 0.7, depth - 1, 5)

    def log(x0, x1, y, rad, rise, twist):
        pts = []
        for i in range(11):
            u = i / 10
            x = x0 + (x1 - x0) * u
            pts.append((Vector((x, y + 0.18 * math.sin(u * 4 + twist), 0.08 + rad * 0.6 + rise * u ** 1.5 + 0.05 * math.sin(u * 9))),
                        rad * (1.15 - 0.55 * u) * (1 + 0.15 * math.sin(u * 13 + twist))))
        paths.append(pts)
        return pts

    main = log(-1.7, 1.6, 0.0, 0.3, 0.45, 0.0)
    second = log(-0.9, 1.4, -0.35, 0.18, 0.15, 2.0)
    limb(main[3][0], Vector((0.4, -0.3, 0.8)).normalized(), 1.25, 0.15, 1)
    limb(main[6][0], Vector((-0.6, 0.4, 0.8)).normalized(), 1.5, 0.13, 1)
    limb(main[9][0], Vector((0.9, 0.1, 0.6)).normalized(), 1.1, 0.1, 0)
    limb(second[8][0], Vector((0.6, -0.6, 0.5)).normalized(), 0.7, 0.08, 0)
    for v in ((-1, -0.3, 0.2), (-0.6, 0.9, 0.15), (-0.8, -0.8, 0.0)):   # root stubs at the thick end
        limb(main[0][0], Vector(v).normalized(), 0.75, 0.13, 0, 4)
    ob = sweep("Driftwood", paths, seg=14, sub=4)
    displace(ob, 0.025, 0.09, 21)
    apply_all(ob)
    ob.data.materials.append(mat_driftwood("Drift"))
    shade_smooth(ob, 50)
    bake(ob, 2048, metal=False)
    export("driftwood", [ob])

HULL = dict(length=4.0, beam=1.5, depth=0.9)


def hull_section(x):
    """Half-width, keel depth and sheer (gunwale rise) of the hull at position x."""
    u = x / HULL["length"] + 0.5
    bow = max(0.0, (u - 0.55) / 0.45)
    stern = max(0.0, (0.12 - u) / 0.12)
    w = HULL["beam"] * 0.5 * (1 - bow ** 1.6) * (1 - 0.25 * stern)
    keel = -HULL["depth"] * (1 - 0.35 * bow ** 2 - 0.2 * stern)
    sheer = 0.12 * (bow ** 2 + stern * 0.8)
    return w, keel, sheer


def hull_mesh(name, nl=40, nh=14, broken=True):
    """Half-shell hull: sections along X from stern to a pointed bow, open at the top."""
    bm = bmesh.new()
    rows = []
    for i in range(nl + 1):
        x = (i / nl - 0.5) * HULL["length"]
        w, keel, sheer = hull_section(x)
        row = []
        for j in range(-nh, nh + 1):
            a = j / nh * math.pi / 2
            y = math.sin(a) * w
            z = keel * math.cos(a) ** 0.8 + sheer * abs(math.sin(a))
            row.append(bm.verts.new((x, y, z)))
        rows.append(row)
    for i in range(nl):
        for j in range(2 * nh):
            bm.faces.new((rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]))
    bm.faces.new(rows[0])   # flat transom closing the stern
    if broken:
        # a jagged hole torn in the starboard (front-facing, -Y) side
        dead = [f for f in bm.faces
                if (c := f.calc_center_median()).y < -0.25 and -0.35 < c.x + 0.05 * math.sin(c.z * 17) < 0.55
                and c.z > -0.5 + 0.1 * math.sin(c.x * 9) + 0.07 * math.sin(c.x * 23)]
        bmesh.ops.delete(bm, geom=dead, context="FACES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return from_bmesh(name, bm)


# ----------------------------------------------------------------------------- ship's cloth and weed
def _cloth_uv(t, layer):
    u, v, _ = t.sep(t.n("ShaderNodeUVMap", uv_map=layer).outputs["UV"])
    return u, v


def mat_sail(name):
    """Old sailcloth, laid out by the cloth's own (u along the yard, v down) "Cloth" UV and its "Hem" UV
    (x: 1 at a torn edge or a hole): panels sewn side by side, a row of reef points, a patch, stains and
    tide marks, algae creeping in from the torn hem, which is frayed darker."""
    t = NT(name)
    u, v = _cloth_uv(t, "Cloth")
    hem, _ = _cloth_uv(t, "Hem")
    weave = t.noise(t.vec(), 260, detail=2)
    stains = t.noise(t.vec(), 5, detail=6, distortion=0.8)
    col = t.ramp(t.math("ADD", t.math("MULTIPLY", stains, 0.85), t.math("MULTIPLY", weave, 0.15)),
                 [(0.3, C("#8e7f60")), (0.55, C("#c9bc98")), (0.75, C("#ddd2b4"))])
    # tide marks: faint wavy bands where the cloth dried and soaked again
    tide = t.math("SINE", t.math("ADD", t.math("MULTIPLY", v, 26.0), t.math("MULTIPLY", stains, 5.0)))
    col = t.mix(t.ramp(tide, [(0.85, 0.0), (1.0, 0.25)]), col, C("#7c6c4e"))
    # panels sewn side by side: a double seam every seventh of the width
    seam = t.ramp(t.math("FRACT", t.math("MULTIPLY", u, 7.0)), [(0.0, 1.0), (0.025, 0.0), (0.975, 0.0), (1.0, 1.0)])
    col = t.mix(t.math("MULTIPLY", seam, 0.6), col, C("#6d5f43"))
    # reef points: a row of little rope ends across the upper part
    du = t.math("SUBTRACT", t.math("FRACT", t.math("MULTIPLY", u, 22.0)), 0.5)
    dv = t.math("MULTIPLY", t.math("SUBTRACT", v, 0.16), 22.0)
    r2 = t.math("ADD", t.math("MULTIPLY", du, du), t.math("MULTIPLY", dv, dv))
    col = t.mix(t.math("LESS_THAN", r2, 0.04), col, C("#4a3b26"))
    # a patch sewn over an old tear, with its stitched border
    inside = t.math("MULTIPLY", t.math("MULTIPLY", t.math("GREATER_THAN", u, 0.42), t.math("LESS_THAN", u, 0.55)),
                    t.math("MULTIPLY", t.math("GREATER_THAN", v, 0.17), t.math("LESS_THAN", v, 0.29)))
    inner = t.math("MULTIPLY", t.math("MULTIPLY", t.math("GREATER_THAN", u, 0.43), t.math("LESS_THAN", u, 0.54)),
                   t.math("MULTIPLY", t.math("GREATER_THAN", v, 0.18), t.math("LESS_THAN", v, 0.28)))
    col = t.mix(inside, col, t.mix(stains, C("#a59874"), C("#b9a77c")))
    col = t.mix(t.math("SUBTRACT", inside, inner), col, C("#5a4a32"))
    # algae and a dark fray along the torn hem and round the holes
    mcol = t.ramp(t.noise(t.vec(), 40, detail=6), [(0.3, C("#33461c")), (0.7, C("#6a7f2f"))])
    algae = t.ramp(t.math("ADD", hem, t.math("MULTIPLY", t.math("SUBTRACT", stains, 0.5), 0.5)), [(0.45, 0.0), (0.8, 0.85)])
    col = t.mix(algae, col, mcol)
    col = t.mix(t.ramp(hem, [(0.85, 0.0), (1.0, 0.7)]), col, C("#3b2f1f"))
    return t.finish(col, rough=0.92, normal=t.bump(t.math("ADD", t.math("MULTIPLY", weave, 0.4), seam), 0.35, 0.01))


def mat_weed(name, root="#3b3a1c", tip="#7c9a3a"):
    """Weed ribbon: darker towards where it is fixed, light and yellowish at the tip, with fine veins."""
    t = NT(name)
    _, v = _cloth_uv(t, "Cloth")
    vein = t.noise(t.vec(scale=(1, 1, 0.2)), 60, detail=3)
    col = t.ramp(t.math("ADD", v, t.math("MULTIPLY", t.math("SUBTRACT", vein, 0.5), 0.3)), [(0.0, C(root)), (0.7, C(tip)), (1.0, C("#a8a854"))])
    return t.finish(col, rough=0.7, normal=t.bump(vein, 0.3, 0.005))


def mat_pennant(name):
    """A faded red pennant with two pale stripes near the hoist, stained and bleached."""
    t = NT(name)
    u, v = _cloth_uv(t, "Cloth")
    stains = t.noise(t.vec(), 7, detail=5)
    stripe = t.math("MULTIPLY", t.math("GREATER_THAN", u, 0.1), t.math("LESS_THAN", u, 0.2))
    stripe = t.math("MAXIMUM", stripe, t.math("MULTIPLY", t.math("GREATER_THAN", u, 0.26), t.math("LESS_THAN", u, 0.3)))
    col = t.mix(stripe, t.ramp(stains, [(0.3, C("#5e1f18")), (0.7, C("#a3402e"))]), C("#cdbb93"))
    col = t.mix(t.ramp(u, [(0.6, 0.0), (1.0, 0.5)]), col, C("#3a3018"))
    return t.finish(col, rough=0.85)


def cloth_grid(name, point, nu, nv, keep, hem):
    """A sheet of cloth from point(u, v) on a grid, keeping the quads where keep(u, v); UV layers "Cloth" (u, v)
    and "Hem" (hem(u, v), 0) for the material."""
    bm = bmesh.new()
    cl, hl = bm.loops.layers.uv.new("Cloth"), bm.loops.layers.uv.new("Hem")
    verts = {}

    def vert(i, j):
        if (i, j) not in verts:
            verts[i, j] = bm.verts.new(point(i / nu, j / nv))
        return verts[i, j]
    for i in range(nu):
        for j in range(nv):
            uc, vc = (i + 0.5) / nu, (j + 0.5) / nv
            if not keep(uc, vc):
                continue
            f = bm.faces.new((vert(i, j), vert(i + 1, j), vert(i + 1, j + 1), vert(i, j + 1)))
            for loop, (a, b) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                loop[cl].uv = (a / nu, b / nv)
                loop[hl].uv = (hem(a / nu, b / nv), 0)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return from_bmesh(name, bm)


def torn_sail(name, a, b, length, mat, seed=7):
    """A square sail hanging from a yard between a and b: tied on at four points (sagging between), bellied
    a little by the current, in long folds that deepen downwards; one lower corner torn away, a ragged hem,
    two holes and a few strips hanging below the tear. Origin at its highest point on the yard."""
    rng = random.Random(seed)
    along = (b - a)
    down = Vector((0.04, -0.12, -1)).normalized()
    out = along.cross(down).normalized()
    if out.y > 0:
        out = -out   # bellies towards the front glass
    ph = [rng.uniform(0, TAU) for _ in range(4)]

    def hem_len(u):   # how far down the cloth reaches: one lower corner gone, a ragged edge
        tear = 0.45 * max(0.0, min(1.0, (u - 0.55) / 0.4)) ** 1.5
        rag = 0.05 * math.sin(u * 41 + ph[0]) + 0.035 * math.sin(u * 97 + ph[1]) + 0.02 * math.sin(u * 173)
        return length * (1 - tear) + rag
    holes = [(0.3, 0.55, 0.085), (0.72, 0.33, 0.06)]
    strips = [(0.6, 0.035, 0.28), (0.76, 0.03, 0.38), (0.9, 0.025, 0.24)]

    def edge_dist(u, v):
        d = (hem_len(u) - v * length * 1.5) / length
        for hu, hv, hr in holes:
            ang = math.atan2(v * 1.5 - hv, (u - hu) * 1.3)
            rim = hr * (1 + 0.25 * math.sin(ang * 5 + hu * 9) + 0.12 * math.sin(ang * 13 + hv * 7))   # ragged, not round
            d = min(d, (math.hypot((u - hu) * 1.3, v * 1.5 - hv) - rim) * 1.2)
        return d

    def keep(u, v):
        if edge_dist(u, v) > 0:
            return True
        vv = v * length * 1.5
        return any(abs(u - su - 0.01 * math.sin(vv * 30)) < w / 2 and vv < hem_len(su) + sl * (1 - abs(u - su) / w)
                   for su, w, sl in strips)

    def hem(u, v):
        return max(0.0, 1 - max(edge_dist(u, v), 0) / 0.12)

    def point(u, v):
        vv = v * length * 1.5
        top = a.lerp(b, 0.05 + 0.9 * u)
        sag = 0.04 * math.sin(math.pi * ((u * 3) % 1.0))           # between the four ties
        belly = 0.2 * math.sin(math.pi * u) * math.sin(math.pi * min(vv / length, 1) * 0.85)
        # long folds hanging from the ties, wandering a little on the way down; finer creases between
        folds = (0.05 * math.sin(TAU * (3 * u + 0.3 * math.sin(vv * 2.2 + ph[2]))) + 0.018 * math.sin(TAU * 9 * u + vv * 3 + ph[3])) * (0.3 + vv / length)
        # gathered where it is tied on
        tie = 0.02 * math.exp(-(((u * 3) % 1.0) - 0.5) ** 2 * 60) * max(0, 1 - vv * 4)
        return top + down * (vv + sag) + out * (belly + folds + tie)
    ob = cloth_grid(name, point, 96, 110, keep, hem)
    ob.data.materials.append(mat)
    top = max((v.co for v in ob.data.vertices), key=lambda c: c.z)
    set_origin(ob, top)
    return ob


def weed_strand(name, root, length, width, seed, mat, hang=True):
    """A strand of weed: a crinkled, twisting ribbon with a midrib, hanging from `root` (or growing up from
    it), drifting a little; origin at the root, where it is fixed. "Cloth" UV: v from the root to the tip."""
    rng = random.Random(seed)
    n = max(8, int(length / 0.025))
    up = -1 if hang else 1
    a0, ph = rng.uniform(0, TAU), rng.uniform(0, TAU)
    bm = bmesh.new()
    cl = bm.loops.layers.uv.new("Cloth")
    rows = []
    for i in range(n + 1):
        s = i / n
        drift = Vector((0.06 * s * math.sin(s * 6 + ph) + 0.05 * s * s, 0.05 * s * math.cos(s * 4.5 + ph * 1.3), 0))
        c = Vector(root) + Vector((0, 0, up * s * length)) + drift
        a = a0 + s * 2.2
        side = Vector((math.cos(a), math.sin(a), 0))
        nrm = Vector((-math.sin(a), math.cos(a), 0))
        w = width * (0.45 + 0.55 * math.sin(math.pi * min(1.0, 0.15 + s * 0.95))) * (0.85 + 0.15 * math.sin(s * 23 + ph))
        crinkle = nrm * (0.006 * math.sin(s * 47 + ph))
        rows.append([bm.verts.new(c - side * w / 2 + crinkle), bm.verts.new(c + nrm * 0.005), bm.verts.new(c + side * w / 2 - crinkle)])
    for i in range(n):
        for k in range(2):
            f = bm.faces.new((rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]))
            for loop, uv in zip(f.loops, ((k / 2, i / n), ((k + 1) / 2, i / n), ((k + 1) / 2, (i + 1) / n), (k / 2, (i + 1) / n))):
                loop[cl].uv = uv
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = from_bmesh(name, bm)
    ob.data.materials.append(mat)
    set_origin(ob, root)
    return ob


def pennant(name, at, length, width, mat):
    """A long pennant hanging from the mast head and streaming in the current, its fly end forked and torn;
    origin at the hoist."""
    flow = Vector((0.55, 0.12, -0.83)).normalized()
    side = Vector((0, 0, 1)).cross(flow).normalized()
    if side.length < 0.1:
        side = Vector((0, 1, 0))
    hoist = side.cross(flow).normalized()

    def point(u, v):   # u along the fly, v across the hoist
        w = width * (1 - 0.75 * u)
        wave = 0.04 * math.sin(u * 9 + v * 1.5) * u
        return Vector(at) + flow * (u * length) + hoist * ((v - 0.5) * w) + side * wave

    def keep(u, v):
        fork = u > 0.8 and abs(v - 0.5) < 0.18 * (u - 0.8) / 0.2
        return not fork and u < 0.97 - 0.05 * math.sin(v * 31)
    ob = cloth_grid(name, point, 30, 6, keep, lambda u, v: 0.0)
    ob.data.materials.append(mat)
    top = max((v.co for v in ob.data.vertices), key=lambda c: c.z)
    set_origin(ob, top)
    return ob


def build_ship():
    """Wooden shipwreck lying half-buried: planked hull with a torn side and ribs showing,
    broken deck, snapped mast with a yard, a torn sail (sway), anchor and portholes."""
    planks = mat_wood("Hull", base="#5d4128", dark="#2b1d10", light="#87643f", rings=10, along="X", planks=11, seam_axis="Z", moss=0.15)
    dark = mat_wood("Timber", base="#4a3320", dark="#21160c", light="#6b4a2c", rings=8, along="Z", moss=0.2)
    iron = mat_metal("Iron", base="#5a5550", patina="#6e3b1e", patina_amt=0.7, rough=0.6)
    brass = mat_metal("Brass", base="#d9a24e", patina="#3f7d6a", rough=0.4, metal_max=0.55)
    parts = []
    hull = hull_mesh("HullShell")
    mod(hull, "SOLIDIFY", thickness=0.05, offset=1)
    hull.data.materials.append(planks)
    parts.append(hull)
    # ribs inside the hull (visible through the hole), each fitted to its section
    for i in range(9):
        x = -1.6 + i * 0.38
        w, keel, _ = hull_section(x)
        bpy.ops.mesh.primitive_torus_add(major_radius=1.0, minor_radius=0.04, major_segments=24, minor_segments=6, location=(x, 0, 0))
        rb = bpy.context.active_object
        bm = bmesh.new(); bm.from_mesh(rb.data)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.y > 0.05], context="VERTS")  # keep one half hoop
        for v in bm.verts:   # hoop in the YZ plane hugging the planking from the inside
            a = math.atan2(v.co.y, v.co.x)
            r = math.hypot(v.co.x, v.co.y)
            v.co = Vector((v.co.z, math.cos(a) * (w - 0.05) * r, math.sin(a) * (-keel - 0.05) * r))
        bm.to_mesh(rb.data); bm.free()
        rb.data.materials.append(dark)
        parts.append(rb)
    # deck planks: gone above the hole, one fallen into it, the rest with gaps
    rng = random.Random(4)
    for i in range(-6, 5):
        if i in (0, 1) or (i == -2 and rng.random() < 0.5):
            continue
        w, _, _ = hull_section(i * 0.3)
        fallen = i == 2
        bpy.ops.mesh.primitive_cube_add(size=1, location=(i * 0.3 - (0.12 if fallen else 0), -0.15 if fallen else 0, -0.25 if fallen else -0.06))
        p = bpy.context.active_object
        p.scale = (0.27, (2 * w - 0.08) * (0.7 if fallen else 1), 0.04)
        p.rotation_euler = (0.5 if fallen else rng.uniform(-0.05, 0.05), 0.3 if fallen else 0, 0)
        mod(p, "BEVEL", width=0.01, segments=1)
        p.data.materials.append(planks)
        parts.append(p)
    # snapped mast, yard
    bpy.ops.mesh.primitive_cone_add(vertices=16, radius1=0.08, radius2=0.055, depth=2.4, location=(-0.75, 0, 1.05), rotation=(0, 0.35, 0))
    mast = bpy.context.active_object
    mast.data.materials.append(dark)
    parts.append(mast)
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.042, depth=1.5, location=(-1.05, 0.05, 1.85), rotation=(0.3, 1.45, 0))
    yard = bpy.context.active_object
    yard.data.materials.append(dark)
    parts.append(yard)
    yard_a, yard_b = yard.matrix_world @ Vector((0, 0, -0.75)), yard.matrix_world @ Vector((0, 0, 0.75))
    ydir = (yard_b - yard_a).normalized()
    # portholes (brass rings) along the intact side
    for i in range(4):
        x = -1.3 + i * 0.55
        bpy.ops.mesh.primitive_torus_add(major_radius=0.08, minor_radius=0.02, location=(x, 0.7 - max(0, x / 2) ** 2 * 0.5, -0.35), rotation=(math.pi / 2, 0, 0))
        r = bpy.context.active_object
        r.data.materials.append(brass)
        parts.append(r)
    # raised stern castle: planked cabin with windows and a door, a railed deck on top
    sx0, sx1 = -1.92, -1.3
    parts.append(part("cube", planks, loc=((sx0 + sx1) / 2, 0, 0.16), scale=(sx1 - sx0, 1.04, 0.44), bevel=0.01))
    parts.append(part("cube", planks, loc=((sx0 + sx1) / 2 - 0.02, 0, 0.4), scale=(sx1 - sx0 + 0.14, 1.2, 0.04), bevel=0.006))
    glass = mat_plain("ShipGlass", "#0b1a20", rough=0.1)
    for k in (-1, 0, 1):    # stern windows
        parts.append(part("cube", dark, loc=(sx0 - 0.005, k * 0.28, 0.2), scale=(0.03, 0.17, 0.15)))
        parts.append(part("cube", glass, loc=(sx0 - 0.016, k * 0.28, 0.2), scale=(0.01, 0.12, 0.1)))
        parts.append(part("cube", dark, loc=(sx0 - 0.022, k * 0.28, 0.2), scale=(0.01, 0.012, 0.11)))
    parts.append(part("cube", dark, loc=(sx1 + 0.006, 0, 0.13), scale=(0.02, 0.2, 0.3)))     # cabin door frame
    parts.append(part("cube", glass, loc=(sx1 + 0.012, 0, 0.12), scale=(0.01, 0.15, 0.26)))  # dark doorway
    for k in range(11):     # balusters and rails around the stern deck
        parts.append(part("cylinder", dark, loc=(sx0 - 0.04, -0.56 + k * 0.112, 0.5), radius=0.012, depth=0.16, vertices=8))
    for k in range(6):
        x = sx0 - 0.04 + k * 0.13
        for y in (-0.57, 0.57):
            parts.append(part("cylinder", dark, loc=(x, y, 0.5), radius=0.012, depth=0.16, vertices=8))
    parts.append(part("cube", dark, loc=(sx0 - 0.04, 0, 0.585), scale=(0.035, 1.18, 0.025)))
    for y in (-0.57, 0.57):
        parts.append(part("cube", dark, loc=(sx0 + 0.3, y, 0.585), scale=(0.68, 0.035, 0.025)))
    # bowsprit and a broken foremast
    bow = Vector((1.95, 0, 0.1))
    bdir = Vector((math.cos(0.55), 0, math.sin(0.55)))   # short and steep: the tank glass is close
    parts.append(part("cylinder", dark, loc=bow + bdir * 0.2, rot=(0, math.pi / 2 - 0.55, 0), radius=0.04, depth=0.4, vertices=12))
    parts.append(part("cone", dark, loc=(0.9, 0, 0.27), radius1=0.07, radius2=0.055, depth=0.66, vertices=14))
    # rigging: sagging ropes from the mast head to the bowsprit and down to both sides
    rope = mat_wood("Rope", base="#a08660", dark="#5e4a30", light="#c4ad85", rings=40, along="Z")
    head = Vector((-0.34, 0, 2.18))
    ends = [bow + bdir * 0.38, Vector((-0.95, 0.7, 0.02)), Vector((-0.45, 0.72, 0.02)), Vector((-0.95, -0.7, 0.02)),
            Vector((0.05, -0.7, 0.02)), Vector((0.9, 0.0, 0.58))]
    lines = []
    for e in ends:
        mid = head.lerp(e, 0.5) + Vector((0, 0, -0.09 * (head - e).length))
        lines.append([(head, 0.009), (mid, 0.009), (e, 0.009)])
    rig = tube_curve("Rigging", lines, res=6, bevel_res=1)
    rig.data.materials.append(rope)
    parts.append(rig)

    # anchor
    an = []
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.03, depth=0.6, location=(0, 0, 0))
    an.append(bpy.context.active_object)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.22, minor_radius=0.03, location=(0, 0, -0.2), rotation=(math.pi / 2, 0, 0))
    arm = bpy.context.active_object
    bm = bmesh.new(); bm.from_mesh(arm.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.y > 0.0], context="VERTS")
    bm.to_mesh(arm.data); bm.free()
    an.append(arm)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.07, minor_radius=0.02, location=(0, 0, 0.33), rotation=(math.pi / 2, 0, 0))
    an.append(bpy.context.active_object)
    for o in an:
        o.data.materials.append(iron)
        apply_all(o)
    anchor = join("Anchor", an)
    anchor.location = (1.9, -0.75, -0.25)
    anchor.rotation_euler = (0.4, 1.1, 0.3)
    parts.append(anchor)
    # --- what makes it a ship that sailed: bulwarks along the deck (broken in places), the helm on the stern
    # deck, shrouds with ratlines up to the mast, cargo left on deck, gun ports, barnacles on the hull
    rng = random.Random(11)
    for side in (-1, 1):
        x = -1.22
        while x < 1.75:
            w, _, sheer = hull_section(x)
            in_hole = side < 0 and -0.45 < x < 0.62
            if not in_hole and rng.random() > 0.12:
                parts.append(part("cube", dark, loc=(x, side * (w - 0.025), sheer + 0.07), scale=(0.035, 0.03, 0.15)))
                nx = x + 0.27
                w2, _, sh2 = hull_section(nx)
                if rng.random() > 0.3 and not (side < 0 and -0.45 < nx < 0.62):
                    a_, b_ = Vector((x, side * (w - 0.025), sheer + 0.15)), Vector((nx, side * (w2 - 0.025), sh2 + 0.15))
                    if rng.random() < 0.25:   # snapped rail hanging down
                        b_ = a_.lerp(b_, 0.6) + Vector((0, 0, -0.12))
                    mid = (a_ + b_) / 2
                    parts.append(part("cylinder", dark, loc=mid, rot=Vector((0, 0, 1)).rotation_difference(b_ - a_).to_euler(),
                                      radius=0.018, depth=(b_ - a_).length, vertices=8))
            x += 0.27
    # the helm: a spoked wheel on a post at the front of the stern deck
    wx, wz = sx1 - 0.14, 0.42 + 0.24
    parts.append(part("cube", dark, loc=(wx - 0.06, 0, 0.42 + 0.13), scale=(0.07, 0.11, 0.26), bevel=0.01))
    parts.append(part("torus", dark, loc=(wx, 0, wz), rot=(0, math.pi / 2, 0), major_radius=0.15, minor_radius=0.014, major_segments=32, minor_segments=6))
    parts.append(part("cylinder", brass, loc=(wx, 0, wz), rot=(0, math.pi / 2, 0), radius=0.032, depth=0.06, vertices=12))
    for k in range(8):
        a = k * TAU / 8 + 0.2
        d = Vector((0, math.cos(a), math.sin(a)))
        parts.append(part("cylinder", dark, loc=Vector((wx, 0, wz)) + d * 0.09, rot=Vector((0, 0, 1)).rotation_difference(d).to_euler(),
                          radius=0.008, depth=0.2, vertices=6))
        parts.append(part("cylinder", dark, loc=Vector((wx, 0, wz)) + d * 0.2, rot=Vector((0, 0, 1)).rotation_difference(d).to_euler(),
                          radius=0.012, depth=0.06, vertices=6))
    # shrouds from the mast down to both sides, with ratlines across them
    mbot, mtop = Vector((-1.16, 0, -0.08)), Vector((-0.34, 0, 2.18))
    mhead = mbot.lerp(mtop, 0.72)
    lines = []
    for side in (-1, 1):
        feet = [Vector((x, side * (hull_section(x)[0] - 0.02), hull_section(x)[2] + 0.02)) for x in (-1.3, -1.02, -0.74)]
        for f in feet:
            lines.append([(mhead, 0.007), (mhead.lerp(f, 0.5) + Vector((0, 0, -0.02)), 0.007), (f, 0.007)])
        for k in range(1, 9):
            t_ = k / 9
            pts = [mhead.lerp(f, t_) for f in feet]
            if t_ > 0.15:
                lines.append([(pts[0], 0.005), (pts[1] + Vector((0, 0, -0.008)), 0.005), (pts[2], 0.005)])
    shrouds = tube_curve("Shrouds", lines, res=4, bevel_res=1)
    shrouds.data.materials.append(rope)
    parts.append(shrouds)
    # rope ties holding the sail to the yard
    for k in range(4):
        c = yard_a.lerp(yard_b, 0.05 + 0.9 * k / 3)
        parts.append(part("torus", rope, loc=c, rot=Vector((0, 0, 1)).rotation_difference(ydir).to_euler(), major_radius=0.05, minor_radius=0.011,
                          major_segments=12, minor_segments=5))
    # cargo left on deck: a barrel standing, one on its side, a crate
    hoop = mat_metal("Hoop", base="#4b4640", patina="#6e3b1e", patina_amt=0.8, rough=0.7)
    staves = mat_wood("Staves", base="#6a4a2c", dark="#2e1f12", light="#8c6a44", rings=10, along="Z", staves=14, moss=0.25)
    for loc, rot in (((0.9, 0.34, 0.05), (0, 0, 0)), ((1.25, -0.22, 0.03), (math.pi / 2, 0, 0.7))):
        parts.append(part("cylinder", staves, loc=loc, rot=rot, radius=0.085, depth=0.22, vertices=16, bevel=0.01))
        for dz in (-0.07, 0.07):
            off = Matrix.Rotation(rot[2], 4, "Z") @ Matrix.Rotation(rot[0], 4, "X") @ Vector((0, 0, dz))
            parts.append(part("torus", hoop, loc=Vector(loc) + off, rot=rot, major_radius=0.087, minor_radius=0.008, major_segments=20, minor_segments=4))
    crate = mat_wood("Crate", base="#7a5a38", dark="#3a2716", light="#a07a50", rings=9, along="XY", planks=4, seam_axis="Z", moss=0.3)
    parts.append(part("cube", crate, loc=(-0.95, 0.38, 0.04), rot=(0.08, -0.1, 0.4), scale=(0.2, 0.18, 0.17), bevel=0.012))
    # gun ports with the muzzles showing, on the side towards the glass
    for x in (-1.05, 1.05, 1.4):
        w, keel, sheer = hull_section(x)
        a = -1.2
        y, z = math.sin(a) * w, keel * math.cos(a) ** 0.8 + sheer * abs(math.sin(a)) + 0.06
        parts.append(part("cube", dark, loc=(x, y - 0.015, z), scale=(0.17, 0.03, 0.13), bevel=0.008))
        parts.append(part("cube", glass, loc=(x, y - 0.03, z), scale=(0.12, 0.01, 0.09)))
        parts.append(part("cylinder", iron, loc=(x, y - 0.06, z), rot=(math.pi / 2, 0, 0), radius=0.035, depth=0.09, vertices=12))
    # barnacles in colonies on the hull, mostly low where the water stood longest
    shell = mat_plain("Barnacle", "#c9c2ae", rough=0.9)
    for c in range(9):
        cx, ca = rng.uniform(-1.6, 1.7), rng.choice((-1, 1)) * rng.uniform(0.7, 1.3)
        for k in range(rng.randint(6, 12)):
            x = cx + rng.gauss(0, 0.08)
            a = ca + rng.gauss(0, 0.1)
            w, keel, sheer = hull_section(x)
            pos = Vector((x, math.sin(a) * w, keel * abs(math.cos(a)) ** 0.8 + sheer * abs(math.sin(a))))
            if pos.z < -0.5 or (pos.y < -0.25 and -0.35 < x < 0.55):
                continue
            nrm = Vector((0, math.sin(a), -math.cos(a) * 0.8)).normalized()
            r = rng.uniform(0.012, 0.028)
            parts.append(part("cone", shell, loc=pos + nrm * r * 0.4, rot=Vector((0, 0, 1)).rotation_difference(nrm).to_euler(),
                              radius1=r, radius2=r * 0.45, depth=r * 1.1, vertices=8))
    # the stern lantern: a caged lamp hanging from an iron bracket over the transom
    lx = sx0 - 0.17
    bracket = tube_curve("Bracket", [[(Vector((sx0 - 0.005, 0, 0.5)), 0.013), (Vector((sx0 - 0.09, 0, 0.62)), 0.012), (Vector((lx + 0.03, 0, 0.95)), 0.011),
                                      (Vector((lx, 0, 0.96)), 0.01), (Vector((lx, 0, 0.9)), 0.009)]], res=6, bevel_res=2)
    bracket.data.materials.append(iron)
    parts.append(bracket)
    parts.append(part("torus", iron, loc=(lx, 0, 0.885), rot=(math.pi / 2, 0, 0), major_radius=0.018, minor_radius=0.005, major_segments=12, minor_segments=4))
    parts.append(part("cone", brass, loc=(lx, 0, 0.835), radius1=0.068, radius2=0.012, depth=0.07, vertices=6))
    parts.append(part("cylinder", brass, loc=(lx, 0, 0.8), radius=0.062, depth=0.014, vertices=6))
    parts.append(part("cylinder", brass, loc=(lx, 0, 0.665), radius=0.058, depth=0.026, vertices=6))
    parts.append(part("cone", brass, loc=(lx, 0, 0.64), radius1=0.02, radius2=0.05, depth=0.03, vertices=6))
    for k in range(6):
        a = k * TAU / 6
        parts.append(part("cylinder", iron, loc=(lx + math.cos(a) * 0.056, math.sin(a) * 0.056, 0.733), radius=0.006, depth=0.13, vertices=5))
    for p in parts:
        apply_all(p)
        transform_apply(p)
    ship = join("Ship", parts)
    shade_smooth(ship, 40)
    bake(ship, 2048)
    # the torn sail hanging from the yard, swaying in the current
    sail = torn_sail("SwaySail", yard_a + Vector((0, 0, -0.035)), yard_b + Vector((0, 0, -0.035)), 0.95, mat_sail("SailCloth"))
    bake(sail, 1024)
    living = [sail]
    # a faded pennant from the mast head, weed hanging from the yard, the rail and the bowsprit, and a few
    # strands growing up from the deck
    flag = pennant("SwayPennant", mtop + Vector((0.01, 0, -0.06)), 0.55, 0.13, mat_pennant("PennantCloth"))
    bake(flag, 256)
    living.append(flag)
    weed = mat_weed("Weed")
    hangs = [(yard_a.lerp(yard_b, 0.12) + Vector((0, 0.03, -0.04)), 0.5, 0.05), (yard_a.lerp(yard_b, 0.82) + Vector((0, 0.03, -0.04)), 0.34, 0.04),
             (bow + bdir * 0.32 + Vector((0, 0, -0.03)), 0.42, 0.045)]
    for x, ln in ((0.85, 0.26), (1.3, 0.32), (-0.95, 0.22), (1.6, 0.2)):
        w, _, sheer = hull_section(x)
        hangs.append((Vector((x, -(w + 0.01), sheer + 0.14)), ln, 0.035))
    for k, (root, ln, wd) in enumerate(hangs):
        st = weed_strand(f"SwayWeed{k}", root, ln, wd, 30 + k, weed)
        bake(st, 256)
        living.append(st)
    for k, (root, ln) in enumerate((((0.55, 0.3, -0.04), 0.75), ((0.62, 0.22, -0.04), 0.55), ((-0.35, -0.28, -0.04), 0.9))):
        st = weed_strand(f"SwayKelp{k}", Vector(root), ln, 0.06, 60 + k, weed, hang=False)
        bake(st, 256)
        living.append(st)
    # stern lantern on its bracket
    lam = mat_plain("GlowShipLantern", "#ffd28a", rough=0.2, emission=("#ffb04a", 1.0))
    lantern = part("cylinder", lam, loc=(lx, 0, 0.733), radius=0.048, depth=0.12, vertices=6)
    lantern.name = "GlowLantern"
    export("ship", [ship, lantern] + living)


def build_wreckage():
    """Things fallen from the wreck: a standing barrel, a barrel on its side and a cannon on a
    broken carriage."""
    obs = []
    for i in range(2):
        wood = mat_wood(f"Stave{i}", base="#6a4527", dark="#2f1d0e", light="#94673c", rings=10, along="Z", staves=16, moss=0.3)
        iron = mat_metal(f"Hoop{i}", base="#3b3936", patina="#6e3b1e", patina_amt=0.7, rough=0.6, metal_max=0.4)
        b = lathe(f"Barrel{i}", [(0.0, 0.0), (0.125, 0.0), (0.145, 0.09), (0.155, 0.18), (0.145, 0.27), (0.125, 0.36), (0.0, 0.36)], steps=32)
        b.data.materials.append(wood)
        hoops = [part("torus", iron, loc=(0, 0, z), major_radius=r, minor_radius=0.008, major_segments=32, minor_segments=5)
                 for z, r in ((0.03, 0.13), (0.11, 0.15), (0.25, 0.15), (0.33, 0.13))]
        b = join(f"Barrel{i}", [b] + hoops)
        if i == 1:
            b.rotation_euler = (math.pi / 2, 0, 0.4)
            b.location = (0, 0, 0.145)
            transform_apply(b)
        shade_smooth(b, 40)
        bake(b, 512)
        obs.append(b)
    iron = mat_metal("CannonIron", base="#3d3a36", patina="#7a3f1c", patina_amt=0.85, rough=0.6, metal_max=0.4)
    wood = mat_wood("Carriage", base="#5a3d22", dark="#26180b", light="#7a5634", rings=10, along="X", moss=0.35)
    gun = lathe("Gun", [(0.0, -0.02), (0.06, -0.02), (0.08, 0.02), (0.082, 0.1), (0.072, 0.13), (0.064, 0.5), (0.056, 0.66),
                        (0.068, 0.68), (0.068, 0.72), (0.032, 0.72), (0.032, 0.45), (0.0, 0.45)], steps=32)
    gun.data.materials.append(iron)
    knob = part("uv_sphere", iron, loc=(0, 0, -0.05), radius=0.035, segments=12, ring_count=8)
    trun = part("cylinder", iron, loc=(0, 0, 0.3), rot=(0, math.pi / 2, 0), radius=0.025, depth=0.24, vertices=12)
    gun = join("Gun", [gun, knob, trun])
    gun.rotation_euler = (0, math.pi / 2 - 0.12, 0)
    gun.location = (-0.2, 0, 0.24)
    transform_apply(gun)
    car = [part("cube", wood, loc=(0, sy * 0.1, 0.13), scale=(0.5, 0.04, 0.16), bevel=0.01) for sy in (-1, 1)]
    car.append(part("cube", wood, loc=(0, 0, 0.07), scale=(0.5, 0.2, 0.04), bevel=0.008))
    for sx in (-0.18, 0.16):
        for sy in (-1, 1):
            car.append(part("cylinder", wood, loc=(sx, sy * 0.145, 0.07), rot=(math.pi / 2, 0, 0), radius=0.07, depth=0.04, vertices=16))
    for p in car:
        apply_all(p)
    cannon = join("Cannon", [gun] + car)
    cannon.rotation_euler = (0.12, 0, 0)
    transform_apply(cannon)
    shade_smooth(cannon, 40)
    bake(cannon, 1024)
    obs.append(cannon)
    export("wreckage", obs)


def build_chest():
    """Treasure chest: planked box framed with brass-capped edges and riveted iron straps,
    a shield lock plate with a keyhole and a heavy ring, side handles and feet; a barrel lid
    (separate, hinged at the back) with matching bands, a hasp and a jewelled rosette.
    Gold coins, gems, a goblet and a pearl necklace spill around it."""
    wood = mat_wood("ChestWood", base="#6e4424", dark="#331d0c", light="#9a6634", rings=12, along="XY", planks=6,
                    seam_axis="Z", moss=0.35)
    iron = mat_metal("ChestIron", base="#3b3936", patina="#5a3418", patina_amt=0.6, rough=0.55, metal_max=0.6)
    brass = mat_metal("ChestBrass", base="#c9953f", patina="#3f7d6a", patina_amt=0.45, rough=0.4, metal_max=0.6)
    dark = mat_plain("Keyhole", "#050403", rough=0.9)
    W, D, Z0, Z1 = 0.6, 0.4, 0.03, 0.35
    H = Z1 - Z0
    zc = (Z0 + Z1) / 2
    parts = [part("cube", wood, loc=(0, 0, zc), scale=(W, D, H), bevel=0.008)]
    rivets = []

    def rivet_line(p0, p1, n, outward):
        for k in range(n):
            t = (k + 0.5) / n
            p = Vector(p0).lerp(Vector(p1), t) + Vector(outward)
            rivets.append(part("uv_sphere", brass, loc=p, radius=0.0065, segments=8, ring_count=5))

    # brass edge frames: corner posts, bottom and top rims
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(part("cube", brass, loc=(sx * (W / 2 - 0.008), sy * (D / 2 - 0.008), zc), scale=(0.045, 0.045, H + 0.01), bevel=0.006))
    for z in (Z0 + 0.022, Z1 - 0.02):
        for sy in (-1, 1):
            parts.append(part("cube", brass, loc=(0, sy * (D / 2 - 0.006), z), scale=(W, 0.036, 0.04), bevel=0.005))
            rivet_line((-W / 2 + 0.05, sy * D / 2, z), (W / 2 - 0.05, sy * D / 2, z), 9, (0, sy * 0.014, 0))
        for sx in (-1, 1):
            parts.append(part("cube", brass, loc=(sx * (W / 2 - 0.006), 0, z), scale=(0.036, D, 0.04), bevel=0.005))
    # riveted iron straps on front and back
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(part("cube", iron, loc=(sx * 0.17, sy * (D / 2 + 0.004), zc), scale=(0.05, 0.012, H - 0.06)))
            rivet_line((sx * 0.17, sy * D / 2, Z0 + 0.05), (sx * 0.17, sy * D / 2, Z1 - 0.05), 4, (0, sy * 0.012, 0))
    # lock: shield plate, keyhole, hanging ring
    shield = [(-0.055, 0.33), (0.055, 0.33), (0.055, 0.26)] + \
             [(math.cos(a) * 0.055, 0.26 - math.sin(a) * 0.065) for a in (math.pi * i / 10 for i in range(1, 10))] + [(-0.055, 0.26)]
    parts.append(prism("Lock", shield, -D / 2 - 0.016, -D / 2 - 0.004, brass))
    hole = [(math.cos(a) * 0.012, 0.29 + math.sin(a) * 0.012) for a in (TAU * i / 12 for i in range(12))]
    parts.append(prism("Keyhole", hole, -D / 2 - 0.018, -D / 2 - 0.015, dark))
    parts.append(prism("Slot", [(-0.006, 0.255), (0.006, 0.255), (0.004, 0.285), (-0.004, 0.285)], -D / 2 - 0.018, -D / 2 - 0.015, dark))
    parts.append(part("torus", iron, loc=(0, -D / 2 - 0.022, 0.2), rot=(math.pi / 2 - 0.25, 0, 0), major_radius=0.04, minor_radius=0.008,
                      major_segments=20, minor_segments=6))
    parts.append(part("cylinder", iron, loc=(0, -D / 2 - 0.018, 0.24), rot=(math.pi / 2, 0, 0), radius=0.012, depth=0.02, vertices=10))
    # side handles
    for sx in (-1, 1):
        parts.append(part("cube", iron, loc=(sx * (W / 2 + 0.008), 0, 0.27), scale=(0.012, 0.1, 0.05), bevel=0.004))
        parts.append(part("torus", iron, loc=(sx * (W / 2 + 0.018), 0, 0.225), rot=(0, math.pi / 2, 0), major_radius=0.04, minor_radius=0.008,
                          major_segments=20, minor_segments=6))
    # bracket feet
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(part("cube", brass, loc=(sx * (W / 2 - 0.03), sy * (D / 2 - 0.03), Z0 / 2 + 0.002), scale=(0.075, 0.075, Z0 + 0.004), bevel=0.008))
    for p in parts + rivets:
        apply_all(p)
    body = join("Chest", parts + rivets)
    shade_smooth(body, 30)
    bake(body, 1024)

    # lid: closed half cylinder with brass rims, iron bands, rivets, a hasp and a rosette
    lp = []
    lid = part("cylinder", wood, loc=(0, 0, Z1), rot=(0, math.pi / 2, 0), radius=D / 2, depth=W, vertices=40)
    bm = bmesh.new()
    bm.from_mesh(lid.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, Z1), plane_no=(0, 0, 1), clear_inner=True)
    bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary])
    bm.to_mesh(lid.data)
    bm.free()
    mod(lid, "BEVEL", width=0.006, segments=2)
    lp.append(lid)
    for x, m, minor in ((-W / 2 + 0.008, brass, 0.016), (W / 2 - 0.008, brass, 0.016), (-0.17, iron, 0.012), (0.17, iron, 0.012)):
        lp.append(half(part("torus", m, loc=(x, 0, Z1), rot=(0, math.pi / 2, 0), major_radius=D / 2 + 0.004, minor_radius=minor,
                            major_segments=40, minor_segments=6), 2, Z1))
        for k in range(1, 8):
            a = math.pi * k / 8
            lp.append(part("uv_sphere", brass, loc=(x, math.cos(a) * (D / 2 + 0.014), Z1 + math.sin(a) * (D / 2 + 0.014)),
                           radius=0.0065, segments=8, ring_count=5))
    for sy in (-1, 1):
        lp.append(part("cube", brass, loc=(0, sy * (D / 2 - 0.004), Z1 + 0.018), scale=(W, 0.03, 0.036), bevel=0.005))
    lp.append(part("cube", iron, loc=(0, -D / 2 - 0.012, Z1 - 0.03), scale=(0.045, 0.01, 0.1), bevel=0.003))   # hasp
    lp.append(part("torus", iron, loc=(0, -D / 2 - 0.018, Z1 - 0.075), rot=(math.pi / 2, 0, 0), major_radius=0.014,
                   minor_radius=0.004, major_segments=12, minor_segments=4))
    a = math.pi / 4
    lp.append(part("cylinder", brass, loc=(0, -math.cos(a) * (D / 2 + 0.008), Z1 + math.sin(a) * (D / 2 + 0.008)),
                   rot=(a, 0, 0), radius=0.045, depth=0.012, vertices=24, bevel=0.003))
    for p in lp:
        apply_all(p)
    lid = join("Lid", lp)
    shade_smooth(lid, 30)
    bake(lid, 1024)
    set_origin(lid, (0, D / 2, Z1))

    # treasure: coins (inside and spilled on the sand), a goblet, gems, a pearl necklace
    gold = mat_plain("GlowGold", "#ffcf4a", rough=0.25, metal=1.0, emission=("#ffaa00", 1.0))
    rng = random.Random(9)
    coins = []
    for i in range(30):   # heap inside, peeking over the rim
        coins.append(part("cylinder", gold, loc=(rng.uniform(-0.24, 0.24), rng.uniform(-0.15, 0.15), Z1 - 0.03 + rng.uniform(0, 0.04)),
                          rot=(rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6), 0), radius=0.035, depth=0.01, vertices=12))
    for i in range(9):    # spilled in front
        a, r = rng.uniform(-2.6, -0.5), rng.uniform(0.3, 0.55)
        coins.append(part("cylinder", gold, loc=(math.cos(a) * r, math.sin(a) * r, 0.005 + 0.012 * (i % 3)),
                          rot=(rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 0), radius=0.035, depth=0.01, vertices=12))
    cup = lathe("Goblet", [(0.0, 0.0), (0.05, 0.0), (0.05, 0.008), (0.012, 0.02), (0.01, 0.09), (0.045, 0.11), (0.055, 0.17),
                           (0.05, 0.17), (0.04, 0.115), (0.0, 0.11)], steps=24)
    cup.data.materials.append(gold)
    cup.rotation_euler = (math.pi / 2 - 0.05, 0, 0.6)
    cup.location = (0.42, -0.25, 0.05)
    transform_apply(cup)
    treasure = join("GlowGold", coins + [cup])
    gems = []
    for i, (col, glow) in enumerate((("#e0203a", "#ff2a4a"), ("#20c060", "#2aff7a"), ("#2a5ae0", "#3a7aff"))):
        gm = mat_plain(f"Gem{i}", col, rough=0.05, emission=(glow, 0.6))
        for k in range(2):
            o = part("cube", gm, loc=(rng.uniform(-0.2, 0.2), rng.uniform(-0.12, 0.12), Z1 + 0.005), scale=(0.03, 0.03, 0.03))
            o.rotation_euler = (0.6, 0.6, rng.uniform(0, 3))
            transform_apply(o)
            gems.append(o)
    a = math.pi / 4   # the rosette's jewel
    gems.append(part("uv_sphere", gems[0].data.materials[0], loc=(0, -math.cos(a) * (D / 2 + 0.02), Z1 + math.sin(a) * (D / 2 + 0.02)),
                     radius=0.018, segments=10, ring_count=6))
    jewels = join("GlowGems", gems)
    pearl_m = mat_plain("Pearl", "#fbf6ee", rough=0.15)
    path = [Vector((-0.14, -0.1, Z1 - 0.01)), Vector((-0.09, -0.205, Z1 + 0.005)), Vector((-0.06, -0.225, Z1 - 0.06)),
            Vector((-0.01, -0.228, Z1 - 0.1)), Vector((0.04, -0.224, Z1 - 0.07)), Vector((0.07, -0.205, Z1 + 0.003)),
            Vector((0.12, -0.1, Z1 - 0.01))]
    pearls = []
    for k in range(len(path) - 1):
        n = max(1, int((path[k + 1] - path[k]).length / 0.018))
        for j in range(n):
            pearls.append(part("uv_sphere", pearl_m, loc=path[k].lerp(path[k + 1], j / n), radius=0.009, segments=8, ring_count=6))
    necklace = join("Pearls", pearls)
    export("chest", [body, lid, treasure, jewels, necklace])

def build_bottle():
    """Green glass bottle with a cork and a rolled message inside, lying on the sand."""
    bm = bmesh.new()
    prof = [(0.0, 0.0), (0.075, 0.0), (0.08, 0.02), (0.08, 0.3), (0.06, 0.36), (0.03, 0.42), (0.028, 0.5), (0.034, 0.51), (0.0, 0.51)]
    verts = [bm.verts.new((r, 0, z)) for r, z in prof]
    for a, b in zip(verts, verts[1:]):
        bm.edges.new((a, b))
    bmesh.ops.spin(bm, geom=bm.verts[:] + bm.edges[:], cent=(0, 0, 0), axis=(0, 0, 1), steps=32, angle=TAU)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    glass = from_bmesh("GlassBottle", bm)
    glass.data.materials.append(mat_plain("GlassGreen", "#3fa36b", rough=0.08, alpha=0.6))
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.031, depth=0.06, location=(0, 0, 0.52))
    cork = bpy.context.active_object
    cork.data.materials.append(mat_wood("Cork", base="#a77b4f", dark="#7a5532", light="#c49a6a", rings=30))
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.035, depth=0.24, location=(0, 0, 0.17))
    scroll = bpy.context.active_object
    scroll.data.materials.append(mat_sandstone("Paper", base="#efe0b8", dark="#c9b27e", moss=0.0, rough=0.9))
    for p in (cork, scroll):
        apply_all(p)
    inner = join("Message", [cork, scroll])
    bake(inner, 512, metal=False)
    export("bottle", [glass, inner])



def lathe(name, prof, steps=48):
    """Surface of revolution around Z from a (radius, z) profile."""
    bm = bmesh.new()
    verts = [bm.verts.new((r, 0, z)) for r, z in prof]
    for a, b in zip(verts, verts[1:]):
        bm.edges.new((a, b))
    bmesh.ops.spin(bm, geom=bm.verts[:] + bm.edges[:], cent=(0, 0, 0), axis=(0, 0, 1), steps=steps, angle=TAU)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return from_bmesh(name, bm)


def mat_cap(name, base="#c8322c", dark="#7d1512", spot="#fff4e2"):
    """Fly-agaric cap: glossy red with raised cream warts."""
    t = NT(name)
    sp = t.voronoi(t.vec(), 7, out="Distance")
    dots = t.ramp(sp, [(0.16, 1.0), (0.22, 0.0)])
    n = t.noise(t.vec(), 6, detail=4)
    col = t.ramp(n, [(0.3, C(dark)), (0.7, C(base))])
    col = t.mix(dots, col, C(spot))
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.15)), 0.6), col, C("#2a0806"))
    return t.finish(col, rough=0.35, normal=t.bump(t.math("ADD", dots, 0.0), 0.6, 0.02))


def build_mushroom():
    """Mushroom cottage: a creamy stem with a door and round windows under a spotted cap."""
    stem_m = mat_sandstone("Stem", base="#efe3c8", dark="#c2b18f", moss=0.25, rough=0.75)
    parts = []
    stem = lathe("Stem", [(0.0, 0.0), (0.38, 0.0), (0.36, 0.05), (0.31, 0.3), (0.3, 0.5), (0.33, 0.6), (0.0, 0.6)])
    stem.data.materials.append(stem_m)
    parts.append(stem)
    cap = lathe("CapG", [(0.0, 0.92), (0.15, 0.9), (0.33, 0.83), (0.47, 0.7), (0.56, 0.56), (0.58, 0.5), (0.52, 0.49), (0.3, 0.55), (0.0, 0.56)])
    cap.data.materials.append(mat_cap("Cap"))
    parts.append(cap)
    # door: arched wooden slab sunk into the stem, front (-Y)
    door_m = mat_wood("Door", base="#5a3a20", dark="#2c1b0d", light="#7c5530", rings=16, along="Z", planks=18, seam_axis="X")
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.11, depth=0.08, location=(0, -0.31, 0.2), rotation=(math.pi / 2, 0, 0))
    top = bpy.context.active_object
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -0.31, 0.1))
    low = bpy.context.active_object
    low.scale = (0.22, 0.08, 0.2)
    door = join("Door", [top, low])
    door.data.materials.clear()
    door.data.materials.append(door_m)
    parts.append(door)
    # step stones
    for i, (x, y) in enumerate(((0.0, -0.46), (0.12, -0.6))):
        st = rock_obj(f"Step{i}", 0.09, 40 + i, (1.2, 1.0, 0.35), 0.2, mat_rock(f"StepM{i}", moss=0.2), sub=3)
        st.location = (x, y, 0.0)
        parts.append(st)
    for p in parts:
        apply_all(p)
        transform_apply(p)
    house = join("Mushroom", parts)
    shade_smooth(house, 40)
    bake(house, 1024, metal=False)
    glow = mat_plain("GlowWindow", "#332211", rough=0.5, emission=("#ffcf7a", 1.0))
    wins = []
    for a, z in ((-1.1, 0.36), (-2.1, 0.3)):
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.055, depth=0.03, location=(math.cos(a) * 0.31, math.sin(a) * 0.31, z), rotation=(math.pi / 2, 0, a + math.pi / 2))
        w = bpy.context.active_object
        w.data.materials.append(glow)
        wins.append(w)
    win = join("GlowWindows", wins)
    export("mushroom", [house, win])


def build_lantern():
    """Old wrought-iron ship lantern lying tilted in the sand; the glass glows at night."""
    iron = mat_metal("LanternIron", base="#2e2f2c", patina="#5a3418", patina_amt=0.6, rough=0.5)
    parts = []
    base = lathe("Base", [(0.0, 0.0), (0.18, 0.0), (0.18, 0.04), (0.14, 0.06), (0.0, 0.06)], steps=6)
    parts.append(base)
    for i in range(6):
        a = TAU * i / 6
        bpy.ops.mesh.primitive_cube_add(size=1, location=(math.cos(a) * 0.125, math.sin(a) * 0.125, 0.21))
        b = bpy.context.active_object
        b.scale = (0.022, 0.022, 0.32)
        b.rotation_euler = (0, 0, a)
        parts.append(b)
    top = lathe("Top", [(0.0, 0.5), (0.04, 0.48), (0.17, 0.38), (0.19, 0.36), (0.0, 0.36)], steps=6)
    parts.append(top)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.05, minor_radius=0.012, location=(0, 0, 0.55), rotation=(math.pi / 2, 0, 0))
    parts.append(bpy.context.active_object)
    for p in parts:
        p.data.materials.clear()
        p.data.materials.append(iron)
        apply_all(p)
        transform_apply(p)
    frame = join("Lantern", parts)
    shade_smooth(frame, 30)
    bake(frame, 512)
    glass = lathe("GlowLantern", [(0.0, 0.06), (0.115, 0.06), (0.115, 0.36), (0.0, 0.36)], steps=6)
    glass.data.materials.append(mat_plain("GlowLanternGlass", "#ffd28a", rough=0.2, emission=("#ffb04a", 1.0)))
    export("lantern", [frame, glass])


def mat_canvas(name, base="#8a8774", dark="#4f4d40", moss=0.35):
    """Weathered rubberised canvas: fine weave, stains, algae towards the feet."""
    t = NT(name)
    weave = t.noise(t.vec(scale=(1, 1, 6)), 220, detail=2)
    stains = t.noise(t.vec(), 6, detail=5, distortion=0.6)
    col = t.ramp(t.math("ADD", t.math("MULTIPLY", stains, 0.8), t.math("MULTIPLY", weave, 0.2)), [(0.3, C(dark)), (0.7, C(base))])
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.1)), 0.8), col, C("#1d1c16"))
    if moss > 0:
        z = t.sep(t.coord)[2]
        mcol = t.ramp(t.noise(t.vec(), 45, detail=6), [(0.3, C("#2d4619")), (0.7, C("#62852b"))])
        low = t.ramp(t.math("ADD", z, t.math("MULTIPLY", stains, 0.25)), [(0.1, 0.9), (0.45, 0.0)])
        col = t.mix(t.math("MULTIPLY", t.math("ADD", low, moss_mask(t, moss, up=0.6)), moss * 1.4), col, mcol)
    return t.finish(col, rough=0.85, normal=t.bump(t.math("ADD", t.math("MULTIPLY", weave, 0.3), stains), 0.4, 0.01))


def mat_leather(name, base="#4a3322", dark="#22160d"):
    t = NT(name)
    n = t.noise(t.vec(), 30, detail=6)
    col = t.ramp(n, [(0.3, C(dark)), (0.7, C(base))])
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.08)), 0.7), col, C("#0d0905"))
    return t.finish(col, rough=0.6, normal=t.bump(n, 0.3, 0.005))


def build_diver():
    """Old standard-dress diver on a rock plinth: a Mark V style brass helmet with grilled ports,
    top light and exhaust valve on a bolted breastplate; a canvas suit with folds, chest and back
    weights, belt and knife, gloves, lead-soled boots; an air hose snaking from the helmet to the
    sand; holding an open clam with a pearl. A brass plaque on the plinth."""
    brass = mat_metal("DiverBrass", base="#e0a650", patina="#3f7d6a", patina_amt=0.5, rough=0.4, metal_max=0.55)
    copper = mat_metal("Copper", base="#b8673a", patina="#3f7d6a", patina_amt=0.6, rough=0.45, metal_max=0.5)
    lead = mat_metal("Lead", base="#4a4c4f", patina="#2f3a2c", patina_amt=0.5, rough=0.7, metal_max=0.3)
    canvas = mat_canvas("Suit")
    leather = mat_leather("Leather")
    rubber = mat_leather("Hose", base="#2c2620", dark="#110e0b")
    stone = mat_rock("Plinth", moss=0.4)
    parts = []

    def add(ob, m=None):
        if m is not None:
            ob.data.materials.clear()
            ob.data.materials.append(m)
        parts.append(ob)
        return ob

    def folds(ob, strength=0.012):
        displace(ob, strength, 0.05, 77, kind="NOISE")
        apply_all(ob)
        return ob

    # helmet: bonnet, neck ring, ports with guards, top light, exhaust valve, air inlet
    hz = 1.0
    add(part("uv_sphere", copper, loc=(0, 0, hz), radius=0.22, segments=40, ring_count=24))
    add(part("cylinder", brass, loc=(0, 0, 0.8), radius=0.2, depth=0.1, vertices=32))
    ports = []
    for az, el, r in ((-math.pi / 2, 0.0, 0.09), (-math.pi / 2 + 1.45, 0.0, 0.06), (-math.pi / 2 - 1.45, 0.0, 0.06), (-math.pi / 2, 0.85, 0.045)):
        d = Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)))
        c = Vector((0, 0, hz)) + d * 0.205
        rot = d.to_track_quat("Z", "Y").to_euler()
        add(part("torus", brass, loc=c, rot=rot, major_radius=r, minor_radius=0.018, major_segments=28, minor_segments=8))
        add(part("cylinder", brass, loc=c - d * 0.01, rot=rot, radius=r + 0.02, depth=0.02, vertices=28))
        ports.append((c, d, r, rot))
        # guard bars across the port
        side = d.cross(Vector((0, 0, 1))).normalized() if abs(d.z) < 0.9 else Vector((1, 0, 0))
        up = side.cross(d).normalized()
        bars = (-0.5, 0.0, 0.5) if r > 0.07 else (-0.35, 0.35)
        for k in bars:
            p = c + d * 0.03 + side * (k * r)
            q = up.to_track_quat("Z", "Y").to_euler()
            add(part("cylinder", brass, loc=p, rot=q, radius=0.006, depth=2 * r * math.sqrt(max(0.05, 1 - k * k)), vertices=8))
        if r > 0.07:
            q = side.to_track_quat("Z", "Y").to_euler()
            add(part("cylinder", brass, loc=c + d * 0.03, rot=q, radius=0.006, depth=2 * r, vertices=8))
    d = Vector((math.cos(0.4), math.sin(0.4), 0.15)).normalized()   # exhaust valve on the right
    add(part("cylinder", brass, loc=Vector((0, 0, hz)) + d * 0.23, rot=d.to_track_quat("Z", "Y").to_euler(), radius=0.022, depth=0.07, vertices=12))
    add(part("cylinder", brass, loc=Vector((0, 0, hz)) + d * 0.27, rot=d.to_track_quat("Z", "Y").to_euler(), radius=0.03, depth=0.02, vertices=12))
    # breastplate with wing nuts and brails
    add(lathe("Corselet", [(0.0, 0.84), (0.2, 0.84), (0.3, 0.76), (0.31, 0.7), (0.0, 0.7)], steps=40), brass)
    for i in range(12):
        a = TAU * i / 12
        p = (math.cos(a) * 0.295, math.sin(a) * 0.295, 0.735)
        add(part("cylinder", brass, loc=p, radius=0.016, depth=0.025, vertices=6))
        add(part("cube", brass, loc=(p[0], p[1], p[2] + 0.02), rot=(0, 0, a), scale=(0.008, 0.045, 0.014)))
    # suit: torso, legs, arms with folds; gloves, cuffs
    add(folds(lathe("Torso", [(0.0, 0.3), (0.2, 0.3), (0.25, 0.42), (0.25, 0.6), (0.27, 0.72), (0.0, 0.72)], steps=40)), canvas)
    for sx in (-1, 1):
        add(folds(tube_curve(f"Leg{sx}", [[((sx * 0.1, 0, 0.36), 0.085), ((sx * 0.11, -0.01, 0.24), 0.08), ((sx * 0.11, 0, 0.12), 0.075)]])), canvas)
        arm = [((sx * 0.25, 0, 0.67), 0.07), ((sx * 0.31, -0.06, 0.52), 0.065), ((sx * 0.14, -0.2, 0.45), 0.058)]
        add(folds(tube_curve(f"Arm{sx}", [arm])), canvas)
        add(part("torus", leather, loc=(sx * 0.15, -0.19, 0.452), rot=(0.3, sx * 1.1, 0), major_radius=0.05, minor_radius=0.014,
                 major_segments=16, minor_segments=6))
        add(part("uv_sphere", leather, loc=(sx * 0.1, -0.25, 0.44), radius=0.05, segments=16, ring_count=10, scale=(0.9, 1.2, 0.8)))
        # lead-soled boots with brass toe caps and straps
        add(part("cube", lead, loc=(sx * 0.11, -0.04, 0.025), scale=(0.14, 0.27, 0.05), bevel=0.012))
        add(part("cube", leather, loc=(sx * 0.11, -0.03, 0.09), scale=(0.13, 0.2, 0.09), bevel=0.03))
        add(part("uv_sphere", brass, loc=(sx * 0.11, -0.14, 0.07), radius=0.06, segments=16, ring_count=8, scale=(1, 0.8, 0.7)))
        add(part("cube", leather, loc=(sx * 0.11, -0.02, 0.12), scale=(0.14, 0.04, 0.02)))
    # weights front and back, belt, buckle, knife
    for sy in (-1, 1):   # lead weights hung on the breastplate studs
        add(part("cube", lead, loc=(0, sy * 0.262, 0.6), scale=(0.24, 0.05, 0.13), bevel=0.03))
        for sx in (-1, 1):
            add(part("torus", brass, loc=(sx * 0.08, sy * 0.262, 0.68), rot=(math.pi / 2, 0, 0), major_radius=0.018,
                     minor_radius=0.005, major_segments=12, minor_segments=4))
    add(part("torus", leather, loc=(0, 0, 0.4), major_radius=0.235, minor_radius=0.025, major_segments=40, minor_segments=6, scale=(1, 1, 1.4)))
    add(part("cube", brass, loc=(0, -0.255, 0.4), scale=(0.06, 0.02, 0.05), bevel=0.006))
    add(part("cube", leather, loc=(0.2, -0.13, 0.3), rot=(0, 0.15, 0.6), scale=(0.035, 0.02, 0.17), bevel=0.008))
    add(part("cylinder", brass, loc=(0.205, -0.135, 0.42), rot=(0, 0.15, 0.6), radius=0.014, depth=0.07, vertices=10))
    # an open clam in the hands (the pearl is a separate glossy object): a lower bowl and a
    # lid valve hinged at the back, both thin shells
    shell_m = mat_sandstone("ShellM", base="#efd9c8", dark="#c49a86", moss=0.1, rough=0.4)
    for k, ang in ((0, 0.0), (1, -0.9)):
        sh = part("uv_sphere", None, radius=0.075, segments=24, ring_count=12, scale=(1, 0.8, 0.45))
        bm = bmesh.new(); bm.from_mesh(sh.data)
        keep_top = k == 1
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if (v.co.z < -1e-5) == keep_top], context="VERTS")
        bm.to_mesh(sh.data); bm.free()
        mod(sh, "SOLIDIFY", thickness=0.006)
        apply_all(sh)
        sh.matrix_world = Matrix.Translation((0, -0.21, 0.43)) @ Matrix.Rotation(ang, 4, "X") @ Matrix.Translation((0, -0.06, 0))
        transform_apply(sh)
        add(sh, shell_m)
    # air hose from the helmet's back down to the plinth and away across the sand
    hose = [((-0.08, 0.21, 1.05), 0.03), ((-0.13, 0.34, 1.0), 0.026), ((-0.16, 0.42, 0.72), 0.026), ((-0.12, 0.43, 0.36), 0.026),
            ((-0.04, 0.42, 0.1), 0.026), ((0.12, 0.5, 0.03), 0.026)]
    for k in range(1, 8):   # snaking away across the sand
        hose.append(((0.12 + k * 0.17, 0.5 + k * 0.1 + 0.12 * math.sin(k * 1.7), -0.03), 0.026))
    add(tube_curve("Hose", [[(Vector(p), r) for p, r in hose]], res=8, bevel_res=3), rubber)
    add(part("cylinder", brass, loc=(-0.09, 0.24, 1.04), rot=(-1.2, 0, 0), radius=0.032, depth=0.05, vertices=12))
    # plinth with a brass plaque
    add(lathe("Plinth", [(0.0, -0.1), (0.38, -0.1), (0.36, 0.0), (0.32, 0.04), (0.0, 0.04)], steps=40), stone)
    add(part("cube", brass, loc=(0, -0.355, -0.035), rot=(0.25, 0, 0), scale=(0.18, 0.01, 0.07), bevel=0.004))
    for p in parts:
        apply_all(p)
        transform_apply(p)
    diver = join("Diver", parts)
    shade_smooth(diver, 40)
    bake(diver, 2048)
    # dark glass in the ports, the pearl
    glass_m = mat_plain("PortGlass", "#0e2a33", rough=0.05)
    panes = [part("cylinder", glass_m, loc=c - d * 0.004, rot=rot, radius=r, depth=0.006, vertices=24) for c, d, r, rot in ports]
    faceplate = join("Faceplate", panes)
    pearl = part("uv_sphere", mat_plain("PearlM", "#fbf6ee", rough=0.12), loc=(0, -0.28, 0.455), radius=0.03, segments=20, ring_count=12)
    pearl.name = "Pearl"
    export("diver", [diver, faceplate, pearl])

def build_duck():
    """Classic rubber duck (floats on the surface as a rare easter egg). Front = -Y."""
    y = mat_plain("DuckYellow", "#ffd23a", rough=0.35)
    body = lathe("DuckBody", [(0.0, -0.1), (0.12, -0.09), (0.19, -0.03), (0.2, 0.03), (0.16, 0.09), (0.0, 0.11)], steps=40)
    body.scale = (1.0, 1.25, 1.0)
    body.data.materials.append(y)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=0.11, location=(0, -0.13, 0.17))
    head = bpy.context.active_object
    head.data.materials.append(y)
    bpy.ops.mesh.primitive_cone_add(vertices=16, radius1=0.045, radius2=0.02, depth=0.09, location=(0, -0.26, 0.15), rotation=(math.pi / 2, 0, 0))
    beak = bpy.context.active_object
    beak.scale = (1.0, 1.0, 0.55)
    beak.data.materials.append(mat_plain("DuckBeak", "#ff7a1a", rough=0.4))
    eyes = []
    for sx in (-1, 1):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=0.018, location=(sx * 0.06, -0.21, 0.21))
        e = bpy.context.active_object
        e.data.materials.append(mat_plain(f"DuckEye{sx}", "#111111", rough=0.2))
        eyes.append(e)
    for p in (body, head, beak, *eyes):
        transform_apply(p)
    duck = join("Duck", [body, head, beak, *eyes])
    shade_smooth(duck, 60)
    export("duck", [duck])


def build_shells():
    """Two seashells: a ribbed scallop and a spiral conch."""
    obs = []
    # scallop: fan of ribs
    bm = bmesh.new()
    nr, na = 14, 40
    grid = []
    for i in range(nr + 1):
        r = 0.02 + 0.09 * i / nr
        row = []
        for j in range(na + 1):
            a = math.pi * (0.1 + 0.8 * j / na)
            rib = 1 + 0.08 * abs(math.sin(a * 9)) * (i / nr)
            z = 0.035 * math.sin(math.pi * j / na) * (1 - (i / nr) ** 2 * 0.6) + 0.006 * math.sin(a * 18) * i / nr
            row.append(bm.verts.new((math.cos(a) * r * rib, math.sin(a) * r * rib - 0.05, z)))
        grid.append(row)
    for i in range(nr):
        for j in range(na):
            bm.faces.new((grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]))
    sc = from_bmesh("Shell0", bm)
    mod(sc, "SOLIDIFY", thickness=0.006)
    t = NT("Scallop")
    n = t.noise(t.vec(), 30, detail=4)
    band = t.math("FRACT", t.math("MULTIPLY", t.sep(t.vec())[1], 60.0))
    col = t.ramp(t.math("ADD", t.math("MULTIPLY", n, 0.5), t.math("MULTIPLY", band, 0.5)), [(0.3, C("#e8b9a0")), (0.7, C("#fff1e6"))])
    sc.data.materials.append(t.finish(col, rough=0.35))
    obs.append(sc)
    # conch: spiral cone
    bm = bmesh.new()
    rings = []
    turns, steps, seg = 4.5, 90, 14
    for i in range(steps + 1):
        u = i / steps
        a = u * turns * TAU
        R = 0.05 * (1 - u) ** 1.2 + 0.004
        cr = 0.032 * (1 - u) ** 1.1 + 0.002
        cz = u * 0.12
        c = Vector((math.cos(a) * R, math.sin(a) * R, cz))
        ring = []
        for k in range(seg):
            b = TAU * k / seg
            off = Vector((math.cos(a) * math.cos(b), math.sin(a) * math.cos(b), math.sin(b))) * cr
            ring.append(bm.verts.new(c + off))
        rings.append(ring)
    for i in range(steps):
        for k in range(seg):
            bm.faces.new((rings[i][k], rings[i][(k + 1) % seg], rings[i + 1][(k + 1) % seg], rings[i + 1][k]))
    co = from_bmesh("Shell1", bm)
    co.rotation_euler = (math.pi / 2 - 0.3, 0, 0)
    t = NT("Conch")
    n = t.noise(t.vec(), 12, detail=5, distortion=2)
    col = t.ramp(n, [(0.35, C("#8a5a3a")), (0.5, C("#e9d2b4")), (0.65, C("#c58b5e"))])
    co.data.materials.append(t.finish(col, rough=0.3))
    obs.append(co)
    for o in obs:
        apply_all(o)
        transform_apply(o)
        shade_smooth(o, 60)
        bake(o, 512, metal=False)
    export("shells", obs)



def mat_coral(name, base, tip, polyp="#fff2f0"):
    """Living coral: colour deepening towards the base, pale tips, tiny polyp pores."""
    t = NT(name)
    z = t.sep(t.vec())[2]
    grad = t.math("MULTIPLY", z, 1.6, clamp=True)
    col = t.mix(grad, C(base), C(tip))
    pores = t.voronoi(t.vec(), 160, out="Distance")
    pore = t.ramp(pores, [(0.1, 1.0), (0.25, 0.0)])
    col = t.mix(t.math("MULTIPLY", pore, 0.5), col, C(polyp))
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.06)), 0.45), col, C("#1a0a10"))
    return t.finish(col, rough=0.55, normal=t.bump(t.math("SUBTRACT", 1.0, pore), 0.5, 0.004))


def build_corals():
    """Four branching corals (different growth habits and colours), a brain coral and a sea
    anemone with swaying tentacles."""
    obs = []
    kinds = [
        ("#d23a7a", "#ffb3d2", 3, 0.2, 0.045, 1.1),    # pink antler
        ("#6a2fc9", "#c9a6ff", 4, 0.17, 0.045, 1.0),   # purple antler, tall
        ("#e2541c", "#ffc08a", 0, 0.0, 0.0, 0.0),      # orange pom-pom
        ("#0f9fc7", "#9ff0ff", 3, 0.16, 0.04, 1.3),    # cyan, wide
    ]
    for i, (base, tip, depth, length, rad, spread) in enumerate(kinds):
        rng = random.Random(99 + i)
        paths, tips = [], []
        if i == 2:
            # pom-pom coral: a cushion of short knobbly branches on a domed core
            core = part("uv_sphere", None, loc=(0, 0, 0.06), radius=0.17, segments=24, ring_count=12, scale=(1, 1, 0.75))
            tips.append((None, core))
            for k in range(130):
                d = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.1, 1))).normalized()
                p0 = Vector((0, 0, 0.06)) + Vector((d.x * 0.15, d.y * 0.15, d.z * 0.11))
                p1 = p0 + d * rng.uniform(0.05, 0.1)
                paths.append([(p0, 0.016), (p1, 0.013)])
                tips.append((p1, 0.018))
        else:
            # antler coral: every branch forks in two, the pair splaying apart in a random plane
            def branch(start, d, L, r, k):
                end = start + d * L
                mid = start.lerp(end, 0.5) + Vector((rng.uniform(-0.02, 0.02), rng.uniform(-0.02, 0.02), 0))
                paths.append([(start, r), (mid, r * 0.93), (end, r * 0.86)])
                if k == 0:
                    tips.append((end, r * 0.92))
                    return
                axis = d.orthogonal().normalized()
                axis.rotate(Matrix.Rotation(rng.uniform(0, math.pi), 3, d))
                for sgn in (-1, 1):
                    nd = d.copy()
                    nd.rotate(Matrix.Rotation(sgn * rng.uniform(0.4, 0.62) * spread, 3, axis))
                    nd = (nd + Vector((0, 0, 0.18))).normalized()   # keep growing towards the light
                    branch(end, nd, L * rng.uniform(0.78, 0.92), r * 0.8, k - 1)

            for k in range(3):
                a = TAU * k / 3 + rng.uniform(-0.4, 0.4)
                branch(Vector((math.cos(a) * 0.04, math.sin(a) * 0.04, -0.02)),
                       Vector((math.cos(a) * 0.45, math.sin(a) * 0.45, 1)).normalized(), length, rad * 1.25, depth)
        ob = sweep(f"Coral{i}", paths, seg=8, sub=2)
        caps = []
        for p, r in tips:
            caps.append(r if p is None else part("uv_sphere", None, loc=p, radius=r, segments=8, ring_count=5))
        ob = join(f"Coral{i}", [ob] + caps)
        displace(ob, 0.006, 0.04, 60 + i)
        apply_all(ob)
        ob.data.materials.clear()
        ob.data.materials.append(mat_coral(f"CoralM{i}", base, tip))
        shade_smooth(ob, 60)
        bake(ob, 512, ao_strength=0.3, metal=False)
        obs.append(ob)
    # brain coral: a dome with meandering ridges
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=0.35)
    br = bpy.context.active_object
    br.name = "Brain"
    bm = bmesh.new(); bm.from_mesh(br.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.08], context="VERTS")
    for v in bm.verts:
        n = v.co.normalized()
        ridge = abs(math.sin(n.x * 22 + math.sin(n.y * 14) * 2) * math.sin(n.y * 20 + math.sin(n.x * 12) * 2))
        v.co = v.co * (1 + ridge * 0.06)
        v.co.z = v.co.z * 0.75 + 0.06
    bm.to_mesh(br.data); bm.free()
    t = NT("BrainM")
    nrm = t.sep(t.vec())
    grooves = t.math("ABSOLUTE", t.math("SINE", t.math("ADD", t.math("MULTIPLY", nrm[0], 63), t.math("MULTIPLY", t.math("SINE", t.math("MULTIPLY", nrm[1], 40)), 2))))
    col = t.ramp(grooves, [(0.2, C("#6f8a2a")), (0.7, C("#d4ef7a"))])
    col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, t.ao(0.06)), 0.8), col, C("#1d2608"))
    br.data.materials.append(t.finish(col, rough=0.6))
    shade_smooth(br, 60)
    bake(br, 512, metal=False)
    obs.append(br)
    # anemone: fleshy column + many tentacles (sway)
    base = lathe("AnemoneBase", [(0.0, 0.0), (0.3, 0.0), (0.27, 0.06), (0.24, 0.12), (0.26, 0.15), (0.0, 0.15)], steps=32)
    base.data.materials.append(mat_coral("AnemoneBaseM", "#a83a6a", "#e07aa8"))
    bake(base, 512, metal=False)
    obs.append(base)
    rng = random.Random(7)
    paths = []
    for i in range(70):
        a, r = rng.uniform(0, TAU), math.sqrt(rng.random()) * 0.22
        h = rng.uniform(0.3, 0.55)
        lean = Vector((math.cos(a), math.sin(a), 0)) * rng.uniform(0.05, 0.25)
        b0 = Vector((math.cos(a) * r, math.sin(a) * r, 0.13))
        paths.append([(b0 + lean * (k / 4) ** 2 + Vector((0, 0, h * k / 4)), 0.022 * (1 - k * 0.12)) for k in range(5)])
    tent = tube_curve("SwayAnemone", paths, res=2, bevel_res=1)
    tent.data.materials.append(mat_coral("Tentacle", "#e5559a", "#ffd2f0", polyp="#ffffff"))
    bake(tent, 512, metal=False)
    obs.append(tent)
    export("corals", obs)


def build_pebbles():
    """Small smooth river pebbles for the gravel scatter (instanced by the game)."""
    obs = []
    for i in range(4):
        ob = blob(f"Pebble{i}", 1.0, seed=70 + i, squash=(1.0, 0.8, 0.55), rough=0.12, sub=2, flat_bottom=0.3)
        t = NT(f"PebbleM{i}")
        n = t.noise(t.vec(), 3, detail=4)
        col = t.ramp(n, [(0.3, C("#8a8070")), (0.7, C("#d6cdbd"))])
        ob.data.materials.append(t.finish(col, rough=0.5))
        shade_smooth(ob, 70)
        bake(ob, 256, metal=False)
        obs.append(ob)
    export("pebbles", obs)


ASSETS = {
    "castle": build_castle,
    "rocks": build_rocks,
    "arch": build_arch,
    "cave": build_cave,
    "ruins": build_ruins,
    "driftwood": build_driftwood,
    "ship": build_ship,
    "chest": build_chest,
    "bottle": build_bottle,
    "mushroom": build_mushroom,
    "lantern": build_lantern,
    "diver": build_diver,
    "duck": build_duck,
    "shells": build_shells,
    "corals": build_corals,
    "pebbles": build_pebbles,
    "rockpile": build_rockpile,
    "wreckage": build_wreckage,
}


def main():
    global OUT
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    OUT = argv[0] if argv else os.path.abspath("public/models/decor")
    names = argv[1:] or list(ASSETS)
    os.makedirs(OUT, exist_ok=True)
    for n in names:
        reset()
        random.seed(n)
        ASSETS[n]()
    import shutil
    shutil.rmtree(os.path.join(OUT, "_tex"), ignore_errors=True)


if __name__ == "__main__":   # make_critters.py imports the helpers above
    main()
