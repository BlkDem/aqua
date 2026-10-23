"""
Generates the aquarium's crab and snails as GLB files for the Living Aquarium.

Run headless:
  blender -b -P tools/blender/make_critters.py -- <out_dir> [asset ...]

Assets: crab, snail-mystery, snail-nerite, snail-ramshorn, shrimp.

Every critter is a small hierarchy of rigid parts whose origins sit at the joints, so the game
can bend them (src/life/critters.js draws them as one skinned mesh with the parts as bones).
All parts of a critter share one baked texture set (albedo with AO, normal, roughness).

Coordinate convention (three.js space after export): origin = ground under the body,
+Y up, +Z forward (Blender -Y). Units are game units.

Part names (the contract with critters.js):
  crab:  Body > Eye{L,R}, Leg{L,R}{0..3}_0 > _1 > _2 (hip, knee, ankle),
         Claw{L,R}_0 > _1 > _2 (palm with the fixed finger) > _3 (movable finger)
  snail: Body > Shell, Tent{L,R} (tentacles grow along their local +Y)
L is +X (the animal's left), R is -X.
"""
import bpy
import bmesh
import math
import os
import random
import sys
from mathutils import Vector, Matrix, Quaternion

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_decor as D   # noqa: E402  (scene, material and baking helpers)
from make_decor import NT, C, link, from_bmesh, select_only, apply_all, join, mod, set_origin  # noqa: E402

TAU = math.pi * 2
UP = Vector((0, 0, 1))
FWD = Vector((0, -1, 0))    # the animal's forward in Blender space


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def decimate_to(ob, target):
    """Collapse the mesh down to about `target` triangles. The smallest faces go first, so the
    hidden inner whorls of a shell and the inside of a body lose detail before the outside."""
    apply_all(ob)
    n = tris(ob)
    if n > target:
        mod(ob, "DECIMATE", ratio=target / n)
        apply_all(ob)


def parent(child, par):
    child.parent = par
    child.matrix_parent_inverse = par.matrix_world.inverted()


def uv_sphere(name, r, loc, scale=(1, 1, 1), seg=24, rings=14):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    for v in bm.verts:
        v.co = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2])) + Vector(loc)
    return from_bmesh(name, bm)


def tube(name, pts, seg=10, sub=3, flat=1.0, flat_axis=None):
    """D.sweep (round tapered tube with a Grain UV: v = length along) squashed across flat_axis."""
    ob = D.sweep(name, [pts], seg=seg, sub=sub)
    if flat != 1.0 and flat_axis is not None:
        a = Vector(flat_axis).normalized()
        o = Vector(pts[0][0])
        for v in ob.data.vertices:
            rel = v.co - o
            v.co -= a * rel.dot(a) * (1 - flat)
    return ob


# ----------------------------------------------------------------------------- baking
def bake_group(obs, key, size=1024, ao_strength=0.6, ao_dist=0.03):
    """Bake every part's procedural material into ONE texture set shared by all the parts."""
    tmp = os.path.join(D.OUT, "_tex")
    os.makedirs(tmp, exist_ok=True)
    sc = bpy.context.scene
    if sc.world is None:
        sc.world = bpy.data.worlds.new("w")
    sc.world.light_settings.distance = ao_dist   # AO between the parts, not the whole room
    for ob in obs:
        apply_all(ob)
        me = ob.data
        first = next(m for m in me.materials if m)
        for i, m in enumerate(me.materials):
            if m is None:
                me.materials[i] = first   # e.g. a joint knob joined without a material
        uv = me.uv_layers.new(name="BakeUV")
        me.uv_layers.active = uv
        uv.active_render = True
    # one shared UV layout: unwrap all parts together in multi-object edit mode
    select_only(*obs)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.004, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    select_only(*obs)
    bk = sc.render.bake

    def target(img):
        for ob in obs:
            D._set_target(ob, img)

    img = D._img(key + "_c", size)
    target(img)
    bk.use_pass_direct = bk.use_pass_indirect = False
    bk.use_pass_color = True
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_clear=True, margin=4)
    col = D._pixels(img).copy()

    ao_img = D._img(key + "_ao", size, True)
    target(ao_img)
    bpy.ops.object.bake(type="AO", use_clear=True, margin=4)
    ao = D._pixels(ao_img)[..., :1]
    col[..., :3] *= (1 - ao_strength) + ao_strength * ao

    nrm_img = D._img(key + "_n", size, True)
    target(nrm_img)
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", use_clear=True, margin=4)
    nrm = D._pixels(nrm_img).copy()

    r_img = D._img(key + "_r", size, True)
    target(r_img)
    bpy.ops.object.bake(type="ROUGHNESS", use_clear=True, margin=4)
    rough = D._pixels(r_img).copy()
    orm = rough.copy()
    orm[..., 0] = ao[..., 0]
    orm[..., 2] = 0.0

    c_img = D._save(img, col, os.path.join(tmp, key + "_c.png"))
    n_img = D._save(nrm_img, nrm, os.path.join(tmp, key + "_n.png"), True)
    o_img = D._save(r_img, orm, os.path.join(tmp, key + "_orm.png"), True)

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
    bsdf.inputs["Metallic"].default_value = 0.0
    for ob in obs:
        me = ob.data
        me.materials.clear()
        me.materials.append(m)
        for layer in [l for l in me.uv_layers if l.name != "BakeUV"]:
            me.uv_layers.remove(layer)


def export(name, root):
    obs = [root] + list(root.children_recursive)
    D.export(name, obs)
    tris = sum(len(p.vertices) - 2 for o in obs for p in o.data.polygons)
    print("TRIS", name, tris)


# ----------------------------------------------------------------------------- materials
def uvmap(t, name):
    return t.n("ShaderNodeUVMap", uv_map=name).outputs["UV"]


def grain_v(t):
    """Distance along a tube made by tube()/D.sweep (game units)."""
    return t.sep(uvmap(t, "Grain"))[1]


def mat_carapace(name):
    """Red-claw crab shell: olive-brown with dark mottling and pale speckles on top, red rim
    toward the front, a cream belly; granular surface with the H-shaped grooves."""
    t = NT(name)
    x, y, z = t.sep(t.coord)
    nz = t.sep(t.geo("Normal"))[2]
    mott = t.noise(t.vec(scale=(1, 1, 1)), 38, detail=6, rough=0.6)
    col = t.ramp(mott, [(0.35, C("#2e2312")), (0.55, C("#5b4320")), (0.75, C("#7a5a28"))])
    # warmer, redder toward the front edge and the eyes
    front = t.math("MULTIPLY", t.math("SUBTRACT", t.math("MULTIPLY", y, -12.0), 0.2), 1.0, clamp=True)
    col = t.mix(t.math("MULTIPLY", front, 0.7), col, C("#8a2a14"))
    speck = t.voronoi(t.vec(), 160, out="Distance")
    col = t.mix(t.ramp(speck, [(0.05, 0.7), (0.12, 0.0)]), col, C("#c9b07a"))
    belly = t.ramp(nz, [(-0.35, 1.0), (0.05, 0.0)])
    col = t.mix(belly, col, C("#cdb88e"))
    # cervical groove: a shallow arc across the shell, and the midline groove in front of it
    gx = t.math("ABSOLUTE", x)
    arc = t.math("ABSOLUTE", t.math("SUBTRACT", y, t.math("MULTIPLY", t.math("MULTIPLY", gx, gx), 9.0)))
    groove = t.ramp(arc, [(0.0, 1.0), (0.006, 0.0)])
    mid = t.math("MULTIPLY", t.ramp(gx, [(0.0, 1.0), (0.004, 0.0)]), t.ramp(y, [(-0.06, 0.0), (-0.04, 1.0), (0.0, 1.0), (0.01, 0.0)]))
    grooves = t.math("MULTIPLY", t.math("MAXIMUM", groove, mid), t.math("SUBTRACT", 1.0, belly))
    col = t.mix(t.math("MULTIPLY", grooves, 0.6), col, C("#1c140a"))
    gran = t.voronoi(t.vec(), 260, out="Distance")
    h = t.math("SUBTRACT", t.math("MULTIPLY", gran, 0.5), t.math("MULTIPLY", grooves, 0.8))
    rough = t.ramp(belly, [(0.0, 0.38), (1.0, 0.55)])
    return t.finish(col, rough=rough, normal=t.bump(h, 0.5, 0.004))


def mat_crab_leg(name, length):
    """Legs: brown-red with darker joint ends and a pale underside, darker claw-tip points."""
    t = NT(name)
    v = t.math("DIVIDE", grain_v(t), length)
    nz = t.sep(t.geo("Normal"))[2]
    n = t.noise(t.vec(), 90, detail=4)
    col = t.ramp(n, [(0.3, C("#5a2414")), (0.7, C("#8a3a1e"))])
    col = t.mix(t.ramp(nz, [(-0.8, 0.45), (-0.2, 0.0)]), col, C("#b88a5a"))
    ends = t.ramp(v, [(0.0, 1.0), (0.1, 0.0), (0.9, 0.0), (1.0, 1.0)])
    col = t.mix(t.math("MULTIPLY", ends, 0.35), col, C("#3a160c"))
    hair = t.noise(t.vec(scale=(1, 1, 1)), 400, detail=2)
    return t.finish(col, rough=0.42, normal=t.bump(hair, 0.25, 0.002))


def mat_dactyl(name, length):
    t = NT(name)
    v = t.math("DIVIDE", grain_v(t), length)
    col = t.ramp(v, [(0.0, C("#7a3418")), (0.6, C("#4a1a0c")), (1.0, C("#140806"))])
    return t.finish(col, rough=0.35)


def mat_claw(name, along=None, length=1.0):
    """Bright red claws, mottled, with cream fingertips (fingers read the Grain UV)."""
    t = NT(name)
    n = t.noise(t.vec(), 60, detail=5)
    col = t.ramp(n, [(0.3, C("#9a1a0e")), (0.55, C("#d23218")), (0.8, C("#e8562a"))])
    speck = t.voronoi(t.vec(), 200, out="Distance")
    col = t.mix(t.ramp(speck, [(0.04, 0.5), (0.1, 0.0)]), col, C("#3a0a06"))
    if along:
        v = t.math("DIVIDE", grain_v(t), length)
        col = t.mix(t.ramp(v, [(0.55, 0.0), (0.8, 1.0)]), col, C("#f1e2c4"))
    gran = t.voronoi(t.vec(), 300, out="Distance")
    return t.finish(col, rough=0.3, normal=t.bump(gran, 0.35, 0.003))


def mat_eye(name):
    t = NT(name)
    x, y, z = t.sep(t.coord)
    col = t.ramp(t.noise(t.vec(), 300), [(0.4, C("#060403")), (0.6, C("#24180e"))])
    return t.finish(col, rough=0.08)


def mat_stalk(name):
    t = NT(name)
    col = t.ramp(t.noise(t.vec(), 120), [(0.3, C("#5a2a14")), (0.7, C("#8a4a22"))])
    return t.finish(col, rough=0.4)


def mat_snail_body(name, base, dark, sole, speckle=0.6, translucent=0.0):
    """Soft body: speckled skin, a paler sole, wet sheen."""
    t = NT(name)
    nz = t.sep(t.geo("Normal"))[2]
    n = t.noise(t.vec(), 140, detail=4)
    col = t.ramp(n, [(0.35, C(dark)), (0.65, C(base))])
    sp = t.voronoi(t.vec(), 320, out="Distance")
    col = t.mix(t.ramp(sp, [(0.06, speckle), (0.16, 0.0)]), col, C(dark))
    col = t.mix(t.ramp(nz, [(-0.7, 1.0), (-0.3, 0.0)]), col, C(sole))
    wr = t.noise(t.vec(scale=(1, 2.5, 1)), 260, detail=3)
    b = t.finish(col, rough=0.32, normal=t.bump(wr, 0.35, 0.002))
    if translucent:
        t.bsdf.inputs["Subsurface Weight"].default_value = translucent
        t.bsdf.inputs["Subsurface Radius"].default_value = (0.004, 0.002, 0.001)
    return b


def mat_shell(name, kind):
    """Shell patterns along the spiral (u = growth, from apex to lip) and across the whorl (v)."""
    t = NT(name)
    u, v, _ = t.sep(uvmap(t, "Shell"))
    turns = SHELLS[kind]["turns"]
    th = t.math("MULTIPLY", u, turns)              # whorl count from the apex
    growth = t.math("SINE", t.math("MULTIPLY", th, 260.0 / turns))
    gl = t.noise(t.comb(t.math("MULTIPLY", u, 400.0), t.math("MULTIPLY", v, 6.0), 0.0), 1.0, detail=3)
    if kind == "nerite":
        # zebra: dark zig-zag stripes running from the suture to the lip
        zig = t.math("MULTIPLY", t.math("ABSOLUTE", t.math("SUBTRACT", t.math("FRACT", t.math("MULTIPLY", v, 4.0)), 0.5)), 0.22)
        wav = t.math("MULTIPLY", t.noise(t.comb(t.math("MULTIPLY", u, 30.0), v, 0.0), 2.0, detail=2), 0.25)
        st = t.math("FRACT", t.math("ADD", t.math("ADD", t.math("MULTIPLY", th, 24.0), zig), wav))
        stripe = t.ramp(st, [(0.0, 1.0), (0.18, 1.0), (0.3, 0.0), (0.9, 0.0), (1.0, 1.0)])
        col = t.ramp(gl, [(0.3, C("#8e6c1c")), (0.7, C("#c49a32"))])
        col = t.mix(stripe, col, C("#17110a"))
        rough = 0.22
    elif kind == "mystery":
        col = t.ramp(gl, [(0.3, C("#c98a1c")), (0.7, C("#eab23a"))])
        band = t.ramp(t.math("ABSOLUTE", t.math("SUBTRACT", t.math("FRACT", t.math("MULTIPLY", v, 3.0)), 0.5)), [(0.0, 0.0), (0.06, 0.0), (0.12, 1.0), (0.5, 1.0)])
        col = t.mix(t.math("MULTIPLY", t.math("SUBTRACT", 1.0, band), 0.35), col, C("#6a3a10"))
        col = t.mix(t.math("MULTIPLY", t.ramp(growth, [(0.6, 0.0), (1.0, 1.0)]), 0.25), col, C("#8a5214"))
        # the oldest whorls are worn pale
        col = t.mix(t.ramp(u, [(0.0, 0.9), (0.22, 0.0)]), col, C("#e9dcc0"))
        rough = 0.28
    else:   # ramshorn: translucent red-brown with pale growth bands
        col = t.ramp(gl, [(0.3, C("#3a1608")), (0.7, C("#5e2a12"))])
        col = t.mix(t.math("MULTIPLY", t.ramp(growth, [(0.75, 0.0), (1.0, 1.0)]), 0.3), col, C("#8a5032"))
        rough = 0.3
    # a pale, worn lip inside the aperture
    lip = t.ramp(u, [(0.993, 0.0), (1.0, 1.0)])
    col = t.mix(t.math("MULTIPLY", lip, 0.4), col, C("#efe2c8"))
    h = t.math("ADD", t.math("MULTIPLY", growth, 0.3), t.math("MULTIPLY", gl, 0.5))
    return t.finish(col, rough=rough, normal=t.bump(h, 0.3, 0.002))


# ----------------------------------------------------------------------------- crab
def carapace(H):
    """A sesarmid crab's shell: nearly square from above, flat on top with steep sides and a
    crisp rim, raised gastric and branchial regions with the H-shaped groove between them,
    eye sockets at the front corners, the front margin bent down between them, two small
    teeth behind each eye; a flat belly."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=96, v_segments=48, radius=1.0)
    p = 4.0
    for v in bm.verts:
        x, y, z = v.co
        r = math.hypot(x, y)
        if r > 1e-6:
            sq = r / ((abs(x) ** p + abs(y) ** p) ** (1 / p))   # circle -> squircle
            x, y = x * sq, y * sq
        ax = abs(x)
        X = x * 0.1 * (1 - 0.1 * max(0.0, y))                 # a little narrower at the back
        Y = y * 0.084
        if y < -0.5:   # eye sockets
            Y += 0.012 * math.exp(-((ax - 0.7) / 0.13) ** 2) * smoothstep(-0.5, -0.97, y)
        eq = math.exp(-(z / 0.18) ** 2)
        if ax > 0.85 and -0.75 < y < -0.15:   # teeth on the front of the side margin
            tooth = max(0.0, math.sin((y + 0.75) / 0.6 * TAU)) ** 4
            X += math.copysign(0.0055 * tooth * eq, x)
        if z >= 0:
            top = z ** 0.4
            g = math.exp(-((x / 0.3) ** 2 + ((y + 0.22) / 0.32) ** 2))                 # gastric
            br = math.exp(-(((ax - 0.55) / 0.3) ** 2 + ((y - 0.2) / 0.42) ** 2))       # branchial
            groove = math.exp(-((y - 0.08 - 0.55 * x * x) / 0.05) ** 2) * (1 - 0.6 * ax)
            mid = math.exp(-(x / 0.04) ** 2) * smoothstep(0.05, -0.45, y) * smoothstep(-0.8, -0.5, y)
            Z = 0.028 * top + top * (0.0045 * g + 0.004 * br - 0.0028 * groove - 0.0015 * mid)
            Z -= 0.007 * smoothstep(-0.72, -1.0, y) * smoothstep(0.6, 0.25, ax) * top  # bent-down front
        else:
            Z = 0.015 * z
        v.co = Vector((X, Y, Z + H))
    ob = from_bmesh("Body", bm)
    decimate_to(ob, 3600)
    return ob


def leg_chain(side, name, base, out_dir, slopes, lengths, radii, mats, flat=0.55):
    """Three segments (hip -> knee -> ankle -> tip). out_dir: horizontal direction of the leg;
    slopes: elevation of each segment (radians, + is up)."""
    obs, p = [], base.copy()
    flat_axis = out_dir.cross(UP).normalized()
    for i, (sl, L, (r0, r1), m) in enumerate(zip(slopes, lengths, radii, mats)):
        d = (out_dir * math.cos(sl) + UP * math.sin(sl)).normalized()
        q = p + d * L
        if i < 2:
            pts = [(p, r0 * 0.85), (p + d * (L * 0.12), r0), (p + d * (L * 0.5), (r0 + r1) * 0.56), (p + d * (L * 0.9), r1), (q, r1 * 0.8)]
        else:   # the claw-like tip curves down a little
            pts = [(p, r0 * 0.85), (p + d * (L * 0.3), r0), (p + d * (L * 0.7) - UP * (L * 0.04), r0 * 0.55), (q, r1)]
        ob = tube(f"{name}_{i}", pts, seg=8, sub=2, flat=flat, flat_axis=flat_axis)
        knob = uv_sphere("k", r0 * 0.9, p, seg=8, rings=5)
        ob = join(f"{name}_{i}", [ob, knob])
        ob.data.materials.clear()
        ob.data.materials.append(m)
        set_origin(ob, p)
        if obs:
            parent(ob, obs[-1])
        obs.append(ob)
        p = q
    return obs


def claw(side, name, base, mats, s=1.0):
    """Cheliped: merus -> carpus -> palm with the fixed finger -> movable finger. Held folded
    in front of the face, palms turned in, fingers pointing forward and in."""
    sx = 1 if side == "L" else -1
    m_arm, m_palm, m_finger = mats
    p0 = base.copy()
    p1 = p0 + Vector((sx * 0.02, -0.03, -0.008)) * s          # merus: out and forward
    p2 = p1 + Vector((-sx * 0.009, -0.018, 0.002)) * s           # carpus (wrist): turns forward-in
    mside = (p1 - p0).cross(UP).normalized()
    merus = tube(f"{name}_0", [(p0, 0.0072 * s), (p0 + (p1 - p0) * 0.35, 0.0092 * s), (p0 + (p1 - p0) * 0.75, 0.0094 * s), (p1, 0.0078 * s)],
                 seg=10, sub=2, flat=0.62, flat_axis=UP)
    merus = join(f"{name}_0", [merus, uv_sphere("k", 0.0072 * s, p0, seg=10, rings=6)])
    carpus = tube(f"{name}_1", [(p1, 0.0074 * s), (p1 + (p2 - p1) * 0.45, 0.0098 * s), (p2, 0.0082 * s)], seg=10, sub=2,
                  flat=0.75, flat_axis=UP)
    carpus = join(f"{name}_1", [carpus, uv_sphere("k", 0.0076 * s, p1, seg=10, rings=6)])
    # palm: an inflated oval, taller than wide, narrowing toward the fingers
    pd = Vector((-sx * 0.55, -1, -0.1)).normalized()
    pc = p2 + pd * 0.02 * s
    palm = uv_sphere("palm", 1.0, (0, 0, 0), seg=22, rings=14)
    for v in palm.data.vertices:
        co = v.co
        fl = 1 - 0.22 * max(0.0, -co.y)                    # narrower toward the fingers (-Y)
        v.co = Vector((co.x * 0.0115 * fl, co.y * 0.022, co.z * 0.016 * fl + 0.002 * co.x * co.x)) * s
    rot = FWD.rotation_difference(pd).to_matrix().to_4x4()
    palm.data.transform(Matrix.Translation(pc) @ rot)
    f0 = pc + pd * 0.016 * s + Vector((0, 0, -0.0065)) * s
    fd = (pd + Vector((sx * 0.2, 0, -0.06))).normalized()
    fixed = tube("fixed", [(f0, 0.0058 * s), (f0 + fd * 0.013 * s, 0.0048 * s), (f0 + fd * 0.024 * s + Vector((0, 0, 0.0028)) * s, 0.0028 * s),
                           (f0 + fd * 0.032 * s + Vector((0, 0, 0.0058)) * s, 0.0007 * s)], seg=10, sub=2, flat=0.62, flat_axis=fd.cross(UP))
    fixed.data.materials.append(m_finger)
    palm.data.materials.append(m_palm)
    palm_ob = join(f"{name}_2", [palm, fixed, uv_sphere("k", 0.0078 * s, p2, seg=10, rings=6)])
    # movable finger, hinged on top of the palm's front
    h = pc + pd * 0.015 * s + Vector((0, 0, 0.0062)) * s
    dd = (pd + Vector((sx * 0.2, 0, 0.03))).normalized()
    dactyl = tube(f"{name}_3", [(h, 0.0054 * s), (h + dd * 0.014 * s, 0.0047 * s), (h + dd * 0.026 * s - Vector((0, 0, 0.0035)) * s, 0.0027 * s),
                               (h + dd * 0.034 * s - Vector((0, 0, 0.0078)) * s, 0.0007 * s)], seg=10, sub=2, flat=0.62, flat_axis=dd.cross(UP))
    dactyl = join(f"{name}_3", [dactyl, uv_sphere("k", 0.0048 * s, h, seg=8, rings=6)])
    for ob, m in ((merus, m_arm), (carpus, m_arm), (dactyl, m_finger)):
        ob.data.materials.clear()
        ob.data.materials.append(m)
    set_origin(merus, p0)
    set_origin(carpus, p1)
    set_origin(palm_ob, p2)
    set_origin(dactyl, h)
    parent(carpus, merus)
    parent(palm_ob, carpus)
    parent(dactyl, palm_ob)
    return [merus, carpus, palm_ob, dactyl]


def build_crab():
    H = 0.062                       # height of the shell's rim above the ground
    body = carapace(H)
    m_shell = mat_carapace("crab_shell")
    body.data.materials.append(m_shell)
    D.shade_smooth(body, 70)
    # mouthparts, tucked under the front edge
    mouth = []
    for sx in (-1, 1):
        mp = uv_sphere("mx", 1.0, (0, 0, 0), seg=14, rings=10)
        for v in mp.data.vertices:
            v.co = Vector((v.co.x * 0.011, v.co.y * 0.012, v.co.z * 0.004))
        mp.data.transform(Matrix.Translation((sx * 0.012, -0.074, H - 0.004)) @ Matrix.Rotation(-0.7, 4, "X"))
        mp.data.materials.append(m_shell)
        mouth.append(mp)
    # antennae and antennules: thin whips between the eyes
    whips = []
    for sx in (-1, 1):
        a0 = Vector((sx * 0.007, -0.08, H + 0.006))
        whips.append(tube("ant", [(a0, 0.0014), (a0 + Vector((sx * 0.01, -0.012, 0.006)), 0.001),
                                  (a0 + Vector((sx * 0.026, -0.02, 0.004)), 0.0006)], seg=6, sub=3))
        a1 = Vector((sx * 0.003, -0.081, H + 0.002))
        whips.append(tube("ant", [(a1, 0.0016), (a1 + Vector((sx * 0.003, -0.008, 0.004)), 0.0012),
                                  (a1 + Vector((sx * 0.006, -0.012, 0.0085)), 0.0007)], seg=6, sub=3))
    for w in whips:
        w.data.materials.append(m_shell)
    body = join("Body", [body] + mouth + whips)
    set_origin(body, (0, 0, 0))
    parts = [body]

    # eyes on short stalks, sitting in the notches of the front edge
    m_eye, m_stalk = mat_eye("crab_eye"), mat_stalk("crab_stalk")
    for side, sx in (("L", 1), ("R", -1)):
        b = Vector((sx * 0.066, -0.07, H + 0.014))
        tip = b + Vector((sx * 0.004, -0.007, 0.008))
        st = tube("stalk", [(b, 0.0058), ((b + tip) / 2, 0.0052), (tip, 0.005)], seg=8, sub=2)
        st.data.materials.append(m_stalk)
        eye = uv_sphere("eye", 0.0074, tip + Vector((sx * 0.0005, -0.0015, 0.0025)), scale=(1, 1, 1.15), seg=14, rings=10)
        eye.data.materials.append(m_eye)
        ob = join("Eye" + side, [st, eye])
        set_origin(ob, b)
        parent(ob, body)
        parts.append(ob)

    # walking legs: four pairs, front ones angled forward, back ones backward
    m_leg = mat_crab_leg("crab_leg", 0.07)
    m_leg2 = mat_crab_leg("crab_leg2", 0.066)
    m_tip = mat_dactyl("crab_tip", 0.045)
    for side, sx in (("L", 1), ("R", -1)):
        for i, (y, ang, k) in enumerate(((-0.03, 0.62, 1.0), (-0.004, 0.2, 1.06), (0.024, -0.2, 1.04), (0.046, -0.62, 0.92))):
            base = Vector((sx * 0.09 * (1 - 0.1 * max(0, y) / 0.05), y, H - 0.002))
            out_dir = Vector((sx * math.cos(ang), -math.sin(ang), 0)).normalized()
            obs = leg_chain(side, f"Leg{side}{i}", base, out_dir,
                            slopes=(math.radians(28), math.radians(-48), math.radians(-72)),
                            lengths=(0.068 * k, 0.062 * k, 0.04 * k),
                            radii=((0.0095, 0.0085), (0.0078, 0.0064), (0.0055, 0.0007)),
                            mats=(m_leg, m_leg2, m_tip))
            parent(obs[0], body)
            parts += obs

    # claws
    m_arm, m_palm, m_finger = mat_claw("claw_arm"), mat_claw("claw_palm"), mat_claw("claw_finger", along=True, length=0.044)
    for side, sx in (("L", 1), ("R", -1)):
        obs = claw(side, "Claw" + side, Vector((sx * 0.07, -0.06, H - 0.006)), (m_arm, m_palm, m_finger), s=1.3)
        parent(obs[0], body)
        parts += obs

    for ob in parts:
        if ob is not body:
            D.shade_smooth(ob, 60)
    bake_group(parts, "crab", size=1024, ao_dist=0.02)
    export("crab", body)


# ----------------------------------------------------------------------------- snails
# Raup's shell model: a generating ellipse (radii a, b at distance R0 from the coiling axis,
# height z0) sweeps around the axis and grows by W per whorl.
SHELLS = {
    "mystery": dict(turns=3.9, W=3.1, R0=1.0, a=1.0, b=1.08, z0=-1.45, flare=1.12, size=0.13, ring=24, per=44),
    "nerite": dict(turns=2.4, W=9.0, R0=1.0, a=1.0, b=0.95, z0=-0.78, flare=1.05, size=0.076, ring=22, per=44),
    "ramshorn": dict(turns=4.2, W=1.85, R0=2.95, a=1.0, b=1.1, z0=0.0, flare=1.1, size=0.088, ring=20, per=36),
}


def shell_mesh(kind):
    P = SHELLS[kind]
    k = math.log(P["W"]) / TAU
    Theta = P["turns"] * TAU
    N = int(P["turns"] * P["per"])
    R = P["ring"]
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("Shell")
    rings = []
    for i in range(N + 1):
        u = i / N
        th = u * Theta
        s = math.exp(k * (th - Theta))
        f = 1 + (P["flare"] - 1) * smoothstep(0.93, 1.0, u)
        ring = []
        for j in range(R):
            ph = j / R * TAU
            rr = s * (P["R0"] + P["a"] * f * math.cos(ph))
            z = s * (P["z0"] + P["b"] * f * math.sin(ph))
            ring.append(bm.verts.new((rr * math.cos(th), rr * math.sin(th), z)))
        rings.append(ring)
    for i in range(N):
        a, b = rings[i], rings[i + 1]
        for j in range(R):
            j2 = (j + 1) % R
            f = bm.faces.new((a[j], a[j2], b[j2], b[j]))
            for loop, uv in zip(f.loops, ((i / N, j / R), (i / N, (j + 1) / R), ((i + 1) / N, (j + 1) / R), ((i + 1) / N, j / R))):
                loop[uvl].uv = uv
    apex = bm.verts.new(sum((v.co for v in rings[0]), Vector()) / R)
    for j in range(R):
        f = bm.faces.new((rings[0][(j + 1) % R], rings[0][j], apex))
        for loop in f.loops:
            loop[uvl].uv = (0.0, 0.5)
    # faces point out of the tube
    bm.normal_update()
    c = sum((v.co for v in rings[N // 2]), Vector()) / R
    f0 = next(f for f in rings[N // 2][0].link_faces)
    if f0.normal.dot(f0.calc_center_median() - c) < 0:
        for f in bm.faces:
            f.normal_flip()
    lip = rings[-1]
    lc = sum((v.co for v in lip), Vector()) / R
    ln = (lc - sum((v.co for v in rings[-2]), Vector()) / R).normalized()   # the aperture faces along the growth
    ob = from_bmesh("Shell", bm)
    # normalise the size, keep the aperture frame
    dims = ob.dimensions
    sc = P["size"] / max(dims.x, dims.y)
    ob.data.transform(Matrix.Scale(sc, 4))
    return ob, lc * sc, ln


def place_shell(ob, lc, ln, aperture_dir, axis_dir, at):
    """Turn the shell so the aperture faces aperture_dir, roll it so the coiling axis (+Z of the
    model, toward the apex) leans toward axis_dir, and move the aperture centre to `at`."""
    r1 = ln.rotation_difference(aperture_dir.normalized())
    ax = r1 @ UP
    n = aperture_dir.normalized()
    a_p = (ax - n * ax.dot(n)).normalized()
    t_p = (axis_dir - n * axis_dir.dot(n)).normalized()
    ang = math.atan2(a_p.cross(t_p).dot(n), a_p.dot(t_p))
    r = Quaternion(n, ang) @ r1
    M = Matrix.Translation(at) @ r.to_matrix().to_4x4() @ Matrix.Translation(-lc)
    ob.data.transform(M)


def snail_body(sc):
    """Head-foot as metaballs: a long flat foot reaching past the shell at both ends, a neck
    rising into the aperture, a broad snout. (A metaball's surface sits at about 2/3 of its
    radius at this threshold, hence the 1.45.)"""
    mb = bpy.data.metaballs.new("body")
    mb.resolution = 0.0025 * sc
    mb.render_resolution = mb.resolution
    mb.threshold = 0.6
    els = (
        # centre, half-size
        ((0, 0.0, 0.012), (0.03, 0.062, 0.011)),      # foot
        ((0, -0.05, 0.014), (0.032, 0.026, 0.012)),   # broad front of the foot
        ((0, 0.064, 0.009), (0.014, 0.028, 0.007)),   # tapering tail
        ((0, -0.038, 0.034), (0.019, 0.024, 0.018)),  # neck
        ((0, -0.066, 0.028), (0.018, 0.02, 0.013)),   # head and snout
        ((0, 0.0, 0.04), (0.026, 0.032, 0.022)),      # into the shell
    )
    for c, size in els:
        e = mb.elements.new(type="ELLIPSOID")
        e.co = Vector(c) * sc
        big = max(size) * 1.45
        e.radius = big * sc
        e.size_x, e.size_y, e.size_z = (x * 1.45 / big for x in size)
    ob = link(bpy.data.objects.new("body", mb))
    select_only(ob)
    bpy.ops.object.convert(target="MESH")
    ob = bpy.context.view_layer.objects.active
    mod(ob, "REMESH", mode="SMOOTH", octree_depth=7, use_smooth_shade=True)
    mod(ob, "SMOOTH", factor=0.6, iterations=4)
    apply_all(ob)
    # stand on the ground with a flat, slightly flared sole
    z0 = min(v.co.z for v in ob.data.vertices)
    band = 0.006 * sc
    for v in ob.data.vertices:
        v.co.z -= z0 - 0.0008
        if v.co.z < band:
            k = 1 - v.co.z / band
            v.co.z *= 0.35 + 0.65 * (1 - k)
            v.co.x *= 1 + 0.08 * k
    decimate_to(ob, 3400)   # mostly hidden under the shell
    return ob


def build_snail(kind):
    sc = {"mystery": 1.15, "nerite": 0.7, "ramshorn": 0.74}[kind]
    shell, lc, ln = shell_mesh(kind)
    m_shell = mat_shell("shell_" + kind, kind)
    # the aperture rests on the back of the foot, the spire leaning back
    if kind == "ramshorn":
        # a flat coil carried upright, its axis across the body
        place_shell(shell, lc, ln, Vector((0, -0.8, -1)), Vector((1, 0, 0)), Vector((0, 0.0, 0.05)) * sc)
    elif kind == "nerite":
        place_shell(shell, lc, ln, Vector((0, -0.2, -1)), Vector((0, 1, 0.6)), Vector((0, 0.006, 0.036)) * sc)
    else:
        place_shell(shell, lc, ln, Vector((0, -0.35, -1)), Vector((0.25, 1, 0.9)), Vector((0, 0.008, 0.042)) * sc)
    mod(shell, "SOLIDIFY", thickness=0.0022 * sc, offset=-1)
    decimate_to(shell, {"mystery": 5200, "nerite": 3800, "ramshorn": 4400}[kind])
    shell.data.materials.append(m_shell)

    look = {
        "mystery": ("#d8c08a", "#86683e", "#efe0bc", 0.45),
        "nerite": ("#5a564c", "#26241f", "#8f887a", 0.5),
        "ramshorn": ("#d2483a", "#8a2418", "#ec8a74", 0.25),
    }[kind]
    m_body = mat_snail_body("body_" + kind, *look[:3], speckle=look[3], translucent=0.3 if kind == "ramshorn" else 0.0)
    body = snail_body(sc)
    extra = []
    if kind in ("mystery", "nerite"):
        # operculum: the horny lid lying on the back of the foot
        op = uv_sphere("oper", 1.0, (0, 0, 0), seg=24, rings=10)
        for v in op.data.vertices:
            v.co = Vector((v.co.x * 0.02, v.co.y * 0.026, v.co.z * 0.0025)) * sc
        op.data.transform(Matrix.Translation(Vector((0, 0.05, 0.024)) * sc) @ Matrix.Rotation(-0.22, 4, "X"))
        t = NT("oper_" + kind)
        ox, oy, _ = t.sep(t.coord)
        r = t.math("SQRT", t.math("ADD", t.math("MULTIPLY", ox, ox), t.math("MULTIPLY", oy, oy)))
        rings = t.math("SINE", t.math("MULTIPLY", r, 1400.0))   # growth rings around the nucleus
        op.data.materials.append(t.finish(t.ramp(rings, [(-1, C("#3a2410")), (1, C("#6a4420"))]), rough=0.4,
                                          normal=t.bump(rings, 0.3, 0.001)))
        extra.append(op)
    if kind == "mystery":
        # the breathing siphon, rolled up on the left side of the neck
        s0 = Vector((0.014, -0.036, 0.04)) * sc
        sip = tube("siphon", [(s0, 0.0062 * sc), (s0 + Vector((0.008, -0.006, 0.01)) * sc, 0.0058 * sc),
                              (s0 + Vector((0.012, -0.004, 0.02)) * sc, 0.005 * sc)], seg=12, sub=3)
        sip.data.materials.append(m_body)
        extra.append(sip)
        # labial palps: two short feelers at the front of the snout
        for sx in (-1, 1):
            p0 = Vector((sx * 0.008, -0.078, 0.022)) * sc
            pp = tube("palp", [(p0, 0.0036 * sc), (p0 + Vector((sx * 0.009, -0.01, -0.004)) * sc, 0.0026 * sc),
                               (p0 + Vector((sx * 0.015, -0.017, -0.009)) * sc, 0.0012 * sc)], seg=10, sub=3)
            pp = join("palp", [pp, uv_sphere("k", 0.0013 * sc, p0 + Vector((sx * 0.015, -0.017, -0.009)) * sc, seg=8, rings=6)])
            pp.data.materials.clear()
            pp.data.materials.append(m_body)
            extra.append(pp)
    # eyes at the base of the tentacles (on short stalks for the apple snail)
    m_eye = mat_eye("snail_eye")
    for sx in (-1, 1):
        e = Vector((sx * 0.018, -0.06, 0.038)) * sc
        if kind == "mystery":
            st = tube("estalk", [(e - Vector((sx * 0.003, -0.002, 0.005)) * sc, 0.0036 * sc), (e, 0.003 * sc)], seg=8, sub=2)
            st.data.materials.append(m_body)
            extra.append(st)
        eye = uv_sphere("eye", 0.0028 * sc, e + Vector((0, 0, 0.0015)) * sc, seg=12, rings=8)
        eye.data.materials.append(m_eye)
        extra.append(eye)
    body.data.materials.append(m_body)
    body = join("Body", [body] + extra)
    set_origin(body, (0, 0, 0))
    D.shade_smooth(body, 80)
    D.shade_smooth(shell, 80)
    set_origin(shell, Vector((0, 0.0, 0.03)) * sc)
    parent(shell, body)

    # tentacles: slender, curving up, with a rounded tip; built along +Z and turned so that
    # their length runs along the local up axis (+Y in the game) and they bend toward local +Y
    tl = {"mystery": 0.062, "nerite": 0.032, "ramshorn": 0.05}[kind]
    tents = []
    for side, sx in (("L", 1), ("R", -1)):
        pts = [(Vector((0, 0, 0)), 0.0034 * sc), (Vector((0, tl * 0.04, tl * 0.35)), 0.0027 * sc),
               (Vector((0, tl * 0.12, tl * 0.7)), 0.0019 * sc), (Vector((0, tl * 0.24, tl)), 0.0011 * sc)]
        tt = tube("Tent" + side, pts, seg=12, sub=4)
        tt = join("Tent" + side, [tt, uv_sphere("k", 0.0012 * sc, pts[-1][0], seg=8, rings=6)])
        tt.data.materials.clear()
        tt.data.materials.append(m_body)
        base = Vector((sx * 0.012, -0.066, 0.036)) * sc
        zax = Vector((sx * 0.55, -1.0, 0.3)).normalized()
        yax = (UP - zax * UP.dot(zax)).normalized()
        xax = yax.cross(zax)
        R = Matrix((xax, yax, zax)).transposed().to_4x4()
        tt.matrix_world = Matrix.Translation(base) @ R
        D.shade_smooth(tt, 80)
        parent(tt, body)
        tents.append(tt)
    bake_group([body, shell] + tents, "snail-" + kind, size=1024, ao_dist=0.03)
    export("snail-" + kind, body)


# ----------------------------------------------------------------------------- shrimp
def mat_shrimp_shell(name):
    """Pale translucent shell with fine darker speckles; the colour (cherry, blue, yellow...) is
    multiplied over it in the game, so it is kept light."""
    t = NT(name)
    n = t.noise(t.vec(), 160, detail=4)
    col = t.ramp(n, [(0.35, C("#d9cbc0")), (0.7, C("#f3ece6"))])
    sp = t.voronoi(t.vec(), 420, out="Distance")
    col = t.mix(t.ramp(sp, [(0.05, 0.75), (0.13, 0.0)]), col, C("#8a6a5c"))
    band = t.noise(t.vec(scale=(1, 8, 1)), 30, detail=2)
    col = t.mix(t.math("MULTIPLY", t.ramp(band, [(0.45, 0.0), (0.6, 1.0)]), 0.25), col, C("#fbf7f2"))
    gloss = t.noise(t.vec(), 500, detail=2)
    return t.finish(col, rough=0.22, normal=t.bump(gloss, 0.15, 0.001))


def mat_shrimp_leg(name):
    t = NT(name)
    col = t.ramp(t.noise(t.vec(), 300), [(0.3, C("#e6dcd2")), (0.7, C("#fbf8f4"))])
    return t.finish(col, rough=0.3)


def build_shrimp():
    """Cherry shrimp: cephalothorax with rostrum, eyes on stalks and antennules; two long antennae;
    six abdominal segments bending as a chain, with swimmerets; the tail fan; four pairs of
    walking legs and a pair of tiny claws. Front is -Y, the feet touch z = 0."""
    m_shell, m_leg, m_eye = mat_shrimp_shell("shrimp_shell"), mat_shrimp_leg("shrimp_leg"), mat_eye("shrimp_eye")
    H = 0.05
    # cephalothorax: a smooth elongated shell, flatter below
    head = uv_sphere("head", 1.0, (0, 0, 0), seg=28, rings=18)
    for v in head.data.vertices:
        x, y, z = v.co
        hump = 1 + 0.12 * max(0.0, z) * (1 - abs(y))
        v.co = Vector((x * 0.022, y * 0.056, (z * 0.026 if z > 0 else z * 0.018) * hump)) + Vector((0, -0.062, H))
    rostrum = tube("rostrum", [(Vector((0, -0.112, H + 0.008)), 0.004), (Vector((0, -0.128, H + 0.012)), 0.0026), (Vector((0, -0.145, H + 0.016)), 0.0007)], seg=8, sub=2)
    parts = [head, rostrum]
    for sx in (-1, 1):
        b = Vector((sx * 0.011, -0.104, H + 0.01))
        tip = b + Vector((sx * 0.007, -0.008, 0.003))
        parts.append(tube("estalk", [(b, 0.0032), (tip, 0.0028)], seg=8, sub=2))
        eye = uv_sphere("eye", 0.0052, tip + Vector((sx * 0.001, -0.002, 0.001)), seg=12, rings=8)
        eye.data.materials.append(m_eye)
        parts.append(eye)
        a0 = Vector((sx * 0.006, -0.108, H + 0.004))
        for k in (0, 1):   # forked antennules
            parts.append(tube("antennule", [(a0, 0.0014), (a0 + Vector((sx * (0.008 + k * 0.006), -0.02, 0.008 + k * 0.004)), 0.001),
                                            (a0 + Vector((sx * (0.014 + k * 0.012), -0.038, 0.012 + k * 0.01)), 0.0004)], seg=6, sub=3))
        # mouthparts: small paddles under the head
        mp = uv_sphere("mp", 1.0, (0, 0, 0), seg=10, rings=6)
        for v in mp.data.vertices:
            v.co = Vector((v.co.x * 0.004, v.co.y * 0.008, v.co.z * 0.0025)) + Vector((sx * 0.005, -0.1, H - 0.016))
        parts.append(mp)
    for o in parts:
        if not o.data.materials:
            o.data.materials.append(m_shell)
    body = join("Body", parts)
    set_origin(body, (0, 0, 0))
    D.shade_smooth(body, 70)
    allp = [body]

    # long antennae, sweeping forward and out (origins at their bases)
    for side, sx in (("L", 1), ("R", -1)):
        b = Vector((sx * 0.01, -0.104, H + 0.002))
        ant = tube("Ant" + side, [(b, 0.0013), (b + Vector((sx * 0.03, -0.06, 0.03)), 0.001), (b + Vector((sx * 0.07, -0.11, 0.022)), 0.0008),
                                  (b + Vector((sx * 0.1, -0.14, -0.002)), 0.0005), (b + Vector((sx * 0.12, -0.15, -0.025)), 0.0003)], seg=6, sub=4)
        ant.data.materials.append(m_leg)
        set_origin(ant, b)
        parent(ant, body)
        allp.append(ant)

    # abdomen: six segments in a chain, curving down towards the tail
    # the segments overlap like plates and the abdomen arches: up a little, then down to the tail
    prev, p, ang = body, Vector((0, -0.012, H + 0.002)), 0.22
    segs = []
    for i in range(6):
        L = 0.021 - i * 0.0016
        r = 0.023 * (1 - i * 0.1)
        ang -= 0.13
        d = Vector((0, math.cos(ang), math.sin(ang)))
        q = p + d * L
        seg = uv_sphere("Seg%d" % i, 1.0, (0, 0, 0), seg=22, rings=14)
        for v in seg.data.vertices:
            x, y, z = v.co
            # a plate: rounded on top, longer than the step so neighbours overlap, front end tucked in
            taper = 1 - 0.12 * max(0.0, y)
            v.co = Vector((x * r * 0.86 * taper, y * L * 0.85 + L * 0.12, z * r * (1.0 if z > 0 else 0.72) * taper))
        rot = Vector((0, 1, 0)).rotation_difference(d).to_matrix().to_4x4()
        seg.data.transform(Matrix.Translation((p + q) / 2) @ rot)
        seg.data.materials.append(m_shell)
        bits = [seg]
        if 1 <= i <= 4:   # swimmerets
            for sx in (-1, 1):
                s0 = (p + q) / 2 + Vector((sx * r * 0.45, 0, -r * 0.55))
                sw = tube("pleopod", [(s0, 0.0016), (s0 + Vector((sx * 0.002, 0.004, -0.012)), 0.0011), (s0 + Vector((sx * 0.003, 0.006, -0.018)), 0.0005)], seg=6, sub=2)
                sw.data.materials.append(m_leg)
                bits.append(sw)
        seg = join("Seg%d" % i, bits)
        set_origin(seg, p)
        parent(seg, prev)
        segs.append(seg)
        allp.append(seg)
        prev, p = seg, q
    # tail fan: telson and four uropods, hinged at the last segment
    fan = []
    dt_ = Vector((0, math.cos(ang - 0.15), math.sin(ang - 0.15)))
    tel = uv_sphere("telson", 1.0, (0, 0, 0), seg=16, rings=8)
    for v in tel.data.vertices:
        v.co = Vector((v.co.x * 0.007 * (1 - 0.5 * max(0, v.co.y)), v.co.y * 0.021, v.co.z * 0.003))
    tel.data.transform(Matrix.Translation(p + dt_ * 0.018) @ Vector((0, 1, 0)).rotation_difference(dt_).to_matrix().to_4x4())
    fan.append(tel)
    for sx in (-1, 1):
        for k, spread in ((0, 0.35), (1, 0.75)):
            dd = (dt_ + Vector((sx * spread, 0, 0))).normalized()
            u = uv_sphere("uropod", 1.0, (0, 0, 0), seg=14, rings=8)
            for v in u.data.vertices:
                v.co = Vector((v.co.x * 0.008, v.co.y * (0.021 - k * 0.003), v.co.z * 0.0025))
            u.data.transform(Matrix.Translation(p + dd * 0.017) @ Vector((0, 1, 0)).rotation_difference(dd).to_matrix().to_4x4())
            fan.append(u)
    for o in fan:
        o.data.materials.append(m_shell)
    tail = join("Tail", fan)
    set_origin(tail, p)
    parent(tail, prev)
    allp.append(tail)

    # legs: four walking pairs and a pair of little claws, rigid, origins at the hips
    for side, sx in (("L", 1), ("R", -1)):
        for i, y in enumerate((-0.088, -0.07, -0.052, -0.034)):
            hip = Vector((sx * 0.011, y, H - 0.014))
            knee = hip + Vector((sx * 0.024, -0.004 + i * 0.003, 0.012))
            foot = Vector((sx * (0.042 + i * 0.002), y + 0.004 + i * 0.006, 0.0))
            leg = tube("Leg%s%d" % (side, i), [(hip, 0.0019), (knee, 0.0015), ((knee + foot) / 2 + Vector((sx * 0.003, 0, 0.004)), 0.0012), (foot, 0.0005)], seg=6, sub=3)
            leg.data.materials.append(m_leg)
            set_origin(leg, hip)
            parent(leg, body)
            allp.append(leg)
        hip = Vector((sx * 0.008, -0.1, H - 0.016))
        elbow = hip + Vector((sx * 0.012, -0.012, -0.012))
        tip = elbow + Vector((sx * 0.004, -0.016, -0.012))
        claw = tube("Cheli" + side, [(hip, 0.0017), (elbow, 0.0014), (tip, 0.0012)], seg=6, sub=3)
        pin = uv_sphere("k", 0.0024, tip, scale=(0.8, 1.4, 0.8), seg=8, rings=6)
        claw = join("Cheli" + side, [claw, pin])
        claw.data.materials.clear()
        claw.data.materials.append(m_leg)
        set_origin(claw, hip)
        parent(claw, body)
        allp.append(claw)

    for ob in allp:
        if ob is not body:
            D.shade_smooth(ob, 60)
    bake_group(allp, "shrimp", size=1024, ao_dist=0.015)
    export("shrimp", body)


ASSETS = {
    "crab": build_crab,
    "snail-mystery": lambda: build_snail("mystery"),
    "snail-nerite": lambda: build_snail("nerite"),
    "snail-ramshorn": lambda: build_snail("ramshorn"),
    "shrimp": build_shrimp,
}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    D.OUT = argv[0] if argv else os.path.abspath("public/models/critters")
    names = argv[1:] or list(ASSETS)
    os.makedirs(D.OUT, exist_ok=True)
    for n in names:
        D.reset()
        random.seed(n)
        ASSETS[n]()
    import shutil
    shutil.rmtree(os.path.join(D.OUT, "_tex"), ignore_errors=True)


if __name__ == "__main__":
    main()
