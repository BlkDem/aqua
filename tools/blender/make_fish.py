"""
Generates stylized fish models (GLB) for the Living Aquarium.

Run headless:
  blender -b -P tools/blender/make_fish.py -- <out_dir> [species ...]

Coordinate convention (after glTF export, three.js space):
  +Z = nose, -Z = tail, +Y = up, X = side. Body spans z in [-L/2, L/2].
The game bends the tail in a vertex shader, so no armature is needed.

Each GLB contains:
  Body   - textured body (UV: u = angle around the body, v = 0 tail .. 1 nose)
  Fins   - all fixed fins (UV: u = base->tip, v = across)
  PectL / PectR - pectoral fins, object origin = fin root (the game paddles them)
  EyeL / EyeR   - small marker spheres: the game puts cartoon eyes there
"""
import bpy
import bmesh
import math
import os
import sys
import numpy as np
import json

TAU = math.pi * 2

# ----------------------------------------------------------------------------- species
# Geometry parameters come from src/life/species.js (node tools/blender/export_species.mjs).
HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "species.json"), encoding="utf-8") as fh:
    SPECIES = json.load(fh)
for _sp in SPECIES.values():
    _sp.setdefault("eye", (0.85, 0.3))
    # scale size relative to body length
    _sp["scale"] = _sp["L"] * 0.032
for _k in ("neon", "cory"):  # species with an adipose fin
    SPECIES[_k]["adipose"] = True


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def profile(sp, t):
    """Body radius factor along the body. t: 0 = tail end, 1 = nose (scalar or array)."""
    p = sp["prof"]
    t = np.asarray(t, dtype=float)
    if p.get("disc"):
        u = 2 * t - 1
        r = np.sqrt(np.maximum(0, 1 - np.abs(u) ** 2.2))
        return np.where(t < 0.12, np.maximum(r, p["peduncle"]), r)
    peak = 0.6 if p.get("diamond") else 0.57
    u_head = np.clip((t - peak) / (1 - peak), 0, 1)
    # blend a round (elliptic) head with a tapering snout: cos() ends with a finite slope -> pointed nose
    round_head = np.power(np.maximum(0, 1 - u_head ** 2), 0.5)
    snout = np.cos(u_head * np.pi / 2) * (1 - 0.15 * u_head)
    k = 0.35 + 0.55 * (1 - p["headRound"])
    head = round_head * (1 - k) + snout * k
    u_tail = np.clip((peak - t) / peak, 0, 1)
    e = 0.8 if p.get("diamond") else 1.25 - p["taper"] * 0.5
    tail = 1 - (1 - p["peduncle"]) * np.power(u_tail, e)
    r = np.where(t >= peak, head, tail)
    # gill-cover ridge
    r = r * (1 + 0.025 * np.exp(-((t - 0.76) / 0.018) ** 2))
    return r


def center_y(sp, t):
    # the forehead slopes down to a mouth that sits a little below the body axis
    snout_drop = 0.09 * sp["H"] * smoothstep(0.62, 1.0, t)
    return sp["prof"].get("hump", 0) * sp["H"] * np.sin(np.pi * t) * 0.5 - snout_drop


def body_point(sp, t, th):
    """three.js-space point on the body surface."""
    L, H, W, p = sp["L"], sp["H"], sp["W"], sp["prof"]
    r = float(profile(sp, t))
    side, up = math.sin(th), math.cos(th)
    y = up * r * H * 0.5
    if up < 0:
        y *= 1 + p.get("belly", 0)
    if p.get("flatBelly"):
        y = max(y, -H * 0.32 * r)
    y += float(center_y(sp, t))
    # laterally compressed: the back narrows to a ridge, the belly to a keel, and the
    # caudal peduncle is a thin vertical blade rather than a round tube
    compress = 0.45 + 0.55 * float(smoothstep(0.04, 0.5, t))
    x = side * r * W * 0.5 * compress * (1 - 0.32 * max(0.0, up) ** 2 - 0.12 * max(0.0, -up) ** 2)
    # mouth notch: a small inward crease near the nose, just below the midline
    if t > 0.93:
        k = math.exp(-((up + 0.15) / 0.18) ** 2) * (t - 0.93) / 0.07
        x *= 1 - 0.25 * k
        y -= 0.05 * H * k * 0.2
    return (x, y, (t - 0.5) * L)


def to_blender(p):
    x, y, z = p
    return (x, -z, y)


def top_at(sp, t):
    return float(profile(sp, t)) * sp["H"] * 0.5 + float(center_y(sp, t))


def bot_at(sp, t):
    return -float(profile(sp, t)) * sp["H"] * 0.5 * (1 + sp["prof"].get("belly", 0)) + float(center_y(sp, t))


# ----------------------------------------------------------------------------- meshes
def make_mesh(name, verts, faces, uvs):
    me = bpy.data.meshes.new(name)
    me.from_pydata([to_blender(v) for v in verts], [], faces)
    me.update()
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            uv.data[li].uv = uvs[vi]
    for poly in me.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def build_body(sp, nt=80, nth=48):
    verts, uvs, faces = [], [], []
    ts = [0.004 + (0.992 - 0.004) * (i / (nt - 1)) for i in range(nt)]
    for t in ts:
        for j in range(nth + 1):  # duplicate seam column so UVs don't wrap
            th = TAU * j / nth
            verts.append(body_point(sp, t, th))
            uvs.append((j / nth, t))
    row = nth + 1
    for i in range(nt - 1):
        for j in range(nth):
            a = i * row + j
            faces.append((a, a + 1, a + row + 1, a + row))
    # nose tip & tail cap
    nose = len(verts)
    verts.append((0.0, float(center_y(sp, 1.0)), sp["L"] / 2))
    uvs.append((0.5, 1.0))
    last = (nt - 1) * row
    for j in range(nth):
        faces.append((last + j, last + j + 1, nose))
    tailc = len(verts)
    verts.append((0.0, float(center_y(sp, 0.0)), (0.004 - 0.5) * sp["L"]))
    uvs.append((0.5, 0.0))
    for j in range(nth):
        faces.append((j + 1, j, tailc))
    ob = make_mesh("Body", verts, faces, uvs)
    # merge the duplicated seam for smooth normals (UVs stay split per loop)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)  # outward winding, otherwise the body renders inside-out
    bm.to_mesh(ob.data)
    bm.free()
    for poly in ob.data.polygons:
        poly.use_smooth = True
    return ob


def grid(fn, nu, nv):
    verts, uvs, faces = [], [], []
    for j in range(nv + 1):
        for i in range(nu + 1):
            u, v = i / nu, j / nv
            verts.append(fn(u, v))
            uvs.append((u, v))
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append((a, a + 1, a + nu + 2, a + nu + 1))
    return verts, faces, uvs


def atlas(part, half):
    """Fin textures are a 2-part atlas: left half = tail fin, right half = all other fins."""
    v, f, uv = part
    return v, f, [(half * 0.5 + u * 0.5, w) for (u, w) in uv]


def merge_parts(parts):
    verts, faces, uvs = [], [], []
    for v, f, uv in parts:
        off = len(verts)
        verts += v
        uvs += uv
        faces += [tuple(i + off for i in face) for face in f]
    return verts, faces, uvs


def tail_len(kind, v):
    av = abs(v)
    return {
        "fork": 0.5 + 0.5 * av ** 0.9,
        "fan": 1 - 0.15 * v * v,
        "round": 1 - 0.35 * v * v,
        "lyre": 0.42 + 0.58 * av ** 2.5,
        "veil": 1 - 0.12 * v * v,
        "double": 0.72 + 0.28 * av,
    }[kind]


def build_fins(sp):
    L, H = sp["L"], sp["H"]
    tl = sp["tail"]
    tz0 = -L / 2 + L * 0.03
    ped = float(profile(sp, 0.02)) * H * 0.5
    parts = []
    span_pow = 0.55 if tl["type"] in ("fan", "veil", "double") else 0.85

    def tail(xs):
        def f(u, vv):
            v = vv * 2 - 1
            span = ped + (tl["span"] * 0.5 - ped) * u ** span_pow
            soft = tl["type"] in ("veil", "double", "fan")
            ruffle = math.sin(v * 9 + u * 5) * 0.014 * u if soft else math.sin(v * 6) * 0.003 * u
            # ray pleats + a slightly frayed trailing edge
            pleat = math.sin(v * math.pi * 9) * 0.0025 * u * (2.0 if soft else 1.0)
            fray = 1 + (0.035 * math.sin(v * 37) + 0.02 * math.sin(v * 71)) * u ** 4 * (1.5 if soft else 0.6)
            return (xs * u * tl["span"] * 0.35 + ruffle + pleat, v * span - tl.get("droop", 0) * u * u, tz0 - u * tl["len"] * tail_len(tl["type"], v) * fray)
        return atlas(grid(f, 18, 30), 0)

    if tl["type"] == "double":
        parts += [tail(1), tail(-1)]
    else:
        parts.append(tail(0))

    def dorsal_like(cfg, d):
        a, b = cfg["at"]
        ta, tb = (a + 1) / 2, (b + 1) / 2

        def f(u, v):
            t = ta + (tb - ta) * v
            hh = cfg["h"] * math.sin(math.pi * min(1, v * 1.15)) ** 0.6
            if cfg.get("notch"):
                hh *= 0.65 + 0.35 * abs(math.sin(v * math.pi * 2))
            if cfg.get("follow"):
                hh = cfg["h"] * math.sin(math.pi * v) ** 0.3
            if cfg.get("sweep", 0) > 1:  # long trailing filaments (angelfish)
                hh *= 1 + 0.7 * math.exp(-((v - 0.22) / 0.07) ** 2)
            base = top_at(sp, t) if d > 0 else bot_at(sp, t)
            z = (t - 0.5) * L - u * cfg.get("sweep", 0.3) * cfg["h"] * (1 - v * 0.3)
            ruffle = math.sin(v * 14) * 0.004 * u + math.sin(v * math.pi * 12) * 0.0015 * u
            return (ruffle, base - d * 0.006 + d * u * hh, z)
        return atlas(grid(f, 10, 22), 1)

    parts.append(dorsal_like(sp["dorsal"], 1))
    if sp["dorsal"].get("double"):
        parts.append(dorsal_like(dict(at=(0.15, 0.45), h=sp["dorsal"]["h"] * 0.7, sweep=0.3), 1))
    parts.append(dorsal_like(sp["anal"], -1))
    if sp.get("streamers"):  # angelfish ventral streamers
        for s in (-1, 1):
            def f(u, v, s=s):
                return (s * 0.012 + (v - 0.5) * 0.014, bot_at(sp, 0.7) - u * sp["streamers"], L * 0.18 - u * u * 0.15)
            parts.append(atlas(grid(f, 10, 2), 1))
    # pelvic fins: a small pair under the belly
    pv = sp["pect"] * 0.85
    for s in (-1, 1):
        t0 = 0.6

        def f(u, v, s=s):
            base_y = bot_at(sp, t0 - v * 0.06) + 0.004
            return (s * (0.006 + u * pv * 0.35), base_y - u * pv * 0.55, (t0 - 0.5) * L - v * pv * 0.5 - u * pv * 0.9)
        parts.append(atlas(grid(f, 6, 6), 1))
    # adipose fin (tetras, catfish)
    if sp.get("adipose"):
        def f(u, v):
            t = 0.12 + v * 0.07
            return (0, top_at(sp, t) - 0.003 + u * sp["H"] * 0.18 * math.sin(math.pi * v) ** 0.7, (t - 0.5) * L - u * 0.01)
        parts.append(atlas(grid(f, 4, 8), 1))
    v, fcs, uv = merge_parts(parts)
    return make_mesh("Fins", v, fcs, uv)


def build_pect(sp, s):
    W, H, L, P = sp["W"], sp["H"], sp["L"], sp["pect"]
    t = 0.72
    piv = (s * float(profile(sp, t)) * W * 0.45, -H * 0.12 * float(profile(sp, t)), (t - 0.5) * L)

    def f(u, v):
        w = 0.7 + 0.3 * math.sin(math.pi * v)
        return (s * u * P * 0.08, (v - 0.5) * P * 0.8, -u * P * 1.4 * w)
    verts, faces, uvs = atlas(grid(f, 8, 8), 1)
    ob = make_mesh("PectL" if s < 0 else "PectR", verts, faces, uvs)
    ob.location = to_blender(piv)
    return ob


def build_eye_marker(sp, s):
    t, k = sp["eye"]
    x = s * (float(profile(sp, t)) * sp["W"] * 0.5 * 0.82 + (sp["eyeR"] * 0.4 if sp.get("bulgeEye") else 0))
    y = top_at(sp, t) * k
    z = (t - 0.5) * sp["L"]
    me = bpy.data.meshes.new("Eye")
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=6, radius=sp["eyeR"])
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("EyeL" if s < 0 else "EyeR", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = to_blender((x, y, z))
    return ob


# ----------------------------------------------------------------------------- textures
def tex_grid(w, h):
    x = (np.arange(w) + 0.5) / w
    y = (np.arange(h) + 0.5) / h
    X, Y = np.meshgrid(x, y)  # row 0 = v 0 (bottom in Blender image space)
    th = X * TAU
    return X, Y, np.sin(th), np.cos(th), Y * 2 - 1


def vnoise(X, Y, f, seed=0):
    rng = np.random.default_rng(seed)
    g = rng.random((f + 2, f + 2))
    fx, fy = X * f, Y * f
    i, j = np.floor(fx).astype(int) % (f + 1), np.floor(fy).astype(int) % (f + 1)
    ux, uy = fx - np.floor(fx), fy - np.floor(fy)
    ux, uy = ux * ux * (3 - 2 * ux), uy * uy * (3 - 2 * uy)
    a, b, c, d = g[j, i], g[j, i + 1], g[j + 1, i], g[j + 1, i + 1]
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy


def scales_height(sp, X, Y):
    """Overlapping rounded scales in body UV space, fading out on the head."""
    circ = math.pi * (sp["H"] + sp["W"]) * 0.5
    a = X * circ / sp["scale"]
    s = Y * sp["L"] / sp["scale"]
    row = np.floor(s)
    a = a + (row % 2) * 0.5
    fx, fy = a - np.floor(a), s - row
    # each scale: a dome whose free edge faces the tail (low v)
    d = np.sqrt(((fx - 0.5) * 2) ** 2 + (fy * 1.15) ** 2)
    h = np.clip(1 - d, 0, 1) ** 0.6
    fade = smoothstep(0.8, 0.7, Y) * smoothstep(0.02, 0.08, Y)
    return h * fade


def height_to_normal(h, strength, wrap_x=True):
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(h)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def mix(a, b, t):
    t = np.clip(t, 0, 1)[..., None]
    return a * (1 - t) + b * t


def C(*rgb):
    return np.array(rgb, dtype=float)


def H2C(hexstr):
    h = hexstr.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def band(v, a, b, soft=0.05):
    return np.clip((v - a) / soft, 0, 1) * np.clip((b - v) / soft, 0, 1)


def body_colors(name, sp, X, Y, S, U, Z, h, variant=None):
    n1 = vnoise(X, Y, 24, 1)
    n2 = vnoise(X, Y, 7, 2)
    var = H2C(variant) if variant else None
    shade = 0.12  # how much the scale relief shows in the colour
    if name == "goldfish":
        orange, belly, gold, red = C(1.0, 0.42, 0.0), C(1.0, 0.7, 0.3), C(1.0, 0.72, 0.12), C(0.95, 0.22, 0.0)
        col = mix(belly, orange, smoothstep(-0.9, -0.2, U))
        col = mix(col, gold, np.clip(Z - 0.3, 0, 1) * 1.2 * (0.5 + U * 0.5))
        col = mix(col, red, smoothstep(0.6, 0.8, n2) * smoothstep(-0.2, 0.6, U) * 0.45)
    elif name == "angelfish":
        silver, back, dark, gold = C(0.9, 0.9, 0.86), C(0.62, 0.6, 0.5), C(0.06, 0.06, 0.07), C(1.0, 0.82, 0.45)
        col = mix(silver, back, (U + 1) * 0.3)
        col = mix(col, gold, np.clip(U - 0.4, 0, 1) * 0.9 * np.clip(Z, 0, 1))
        col = mix(col, dark, smoothstep(0.78, 0.9, np.sin((Z + 0.12) * 11.0) + (n1 - 0.5) * 0.25) * (Z < 0.88) * 0.92)
        col = mix(col, C(0.75, 0.75, 0.7), (n1 - 0.5) * 0.25)
    elif name == "neon":
        silver, back, blue, red = C(0.85, 0.89, 0.92), C(0.28, 0.3, 0.2), C(0.15, 0.9, 1.0), C(1.0, 0.1, 0.18)
        col = mix(silver, back, (U + 0.2) * 1.5)
        col = mix(col, blue * (0.95 + n1[..., None] * 0.1), smoothstep(0.02, 0.1, U) * smoothstep(0.42, 0.33, U) * (Z > -0.62))
        col = mix(col, red, smoothstep(0.0, -0.08, U) * smoothstep(-0.95, -0.85, U) * smoothstep(0.2, 0.1, Z))
        shade = 0.06
    elif name == "guppy":
        col = mix(C(0.79, 0.78, 0.72), C(0.44, 0.46, 0.39), (U + 0.1) * 0.8)
        col = mix(col, var, np.clip(-Z - 0.05, 0, 1) * 1.5)
        second = np.roll(var, 1) * 0.6 + C(0.4, 0.35, 0.1)
        col = mix(col, np.clip(second, 0, 1), smoothstep(0.55, 0.75, vnoise(X, Y, 12, 17)) * np.clip(-Z, 0, 1) * 0.8)
        spots = smoothstep(0.66, 0.74, vnoise(X, Y, 30, 11)) * np.clip(-Z, 0, 1)
        col = mix(col, C(0.05, 0.05, 0.06), spots * 0.8)
        col = mix(col, C(0.6, 0.85, 1.0), band(U, 0.1, 0.35, 0.08) * np.clip(Z + 0.2, 0, 1) * 0.35)
    elif name == "clown":
        o, w, k = C(1.0, 0.42, 0.0), C(1, 1, 1), C(0.06, 0.06, 0.06)
        col = np.broadcast_to(o, Z.shape + (3,)).copy() * (0.85 + 0.15 * smoothstep(-1, 1, U))[..., None]
        for b0 in (0.55, 0.0, -0.62):
            d = np.abs(Z - b0 - np.sin(U * 2.5) * 0.04)
            col = mix(col, k, smoothstep(0.155, 0.135, d))
            col = mix(col, w, smoothstep(0.115, 0.1, d))
    elif name == "cory":
        b, d, belly = C(0.78, 0.7, 0.57), C(0.29, 0.23, 0.17), C(0.94, 0.89, 0.81)
        col = mix(belly, b, (U + 0.7) * 1.2)
        spots = smoothstep(0.6, 0.7, vnoise(X, Y, 34, 21)) * (U > -0.3)
        col = mix(col, d, spots * 0.85)
        col = mix(col, d, band(np.abs(U - 0.1), -0.01, 0.06, 0.03) * (Z < 0.5) * 0.6)
        col = mix(col, C(0.55, 0.62, 0.55), smoothstep(0.5, 0.9, U) * 0.25)
    elif name == "cichlid":
        if variant and variant.lower() == "#2f6dff":
            col = mix(C(0.12, 0.3, 0.95), C(0.35, 0.6, 1.0), (U + 1) * 0.5)
            col = mix(col, C(0.03, 0.07, 0.3), smoothstep(0.55, 0.75, np.sin(Z * 18) + (n1 - 0.5) * 0.3) * 0.7)
        else:
            col = mix(C(1.0, 0.97, 0.6), C(1.0, 0.85, 0.0), (U + 0.6) * 0.9)
            col = mix(col, C(0.05, 0.05, 0.05), band(U, 0.78, 0.98, 0.05) * (Z < 0.7) * 0.8)
    elif name == "discus":
        a = var
        b = C(0.22, 0.78, 0.85) if variant.lower() == "#ff4a2a" else C(1.0, 0.48, 0.23)
        w = np.sin(U * 22 + np.sin(Z * 9) * 2.0 + (n1 - 0.5) * 1.5)
        col = mix(a, b, smoothstep(0.2, 0.7, w))
        col = mix(col, C(0.23, 0.11, 0.06), smoothstep(0.9, 0.98, np.sin(Z * 9.5)) * 0.5)
        shade = 0.06
    elif name == "barb":
        col = mix(C(1.0, 0.95, 0.76), C(0.96, 0.78, 0.29), (U + 0.6))
        for b0 in (0.62, 0.22, -0.2, -0.68):
            col = mix(col, C(0.06, 0.06, 0.06), smoothstep(0.085, 0.07, np.abs(Z - b0 - np.sin(U * 3) * 0.02)))
        col = mix(col, C(1.0, 0.23, 0.16), smoothstep(0.9, 0.96, Z) * 0.7)
        col = mix(col, C(1.0, 0.23, 0.16), band(U, 0.85, 1.1, 0.05) * band(Z, 0.0, 0.3, 0.05) * 0.5)
    elif name == "betta":
        red, blue, deep = C(0.83, 0.08, 0.18), C(0.17, 0.33, 1.0), C(0.1, 0.12, 0.5)
        col = mix(blue, red, smoothstep(0.25, -0.65, Z + (n1 - 0.5) * 0.3))
        col = mix(col, deep, smoothstep(0.4, 1.0, U) * 0.5)
        col = mix(col, C(0.4, 0.7, 1.0), smoothstep(0.75, 0.9, vnoise(X, Y, 50, 3)) * 0.35 * (Z > -0.3))
        shade = 0.16
    elif name == "rainbow":
        col = mix(C(1.0, 0.82, 0.4), C(0.23, 0.61, 1.0), Z * 0.6 + 0.5)
        col = mix(col, C(1.0, 0.44, 0.7), np.clip(-U - 0.2, 0, 1) * 0.8)
        col = mix(col, C(1, 1, 1), band(np.sin(U * 30), 0.88, 1.2, 0.08) * 0.3)
    else:  # moonfish
        col = mix(C(0.48, 0.49, 1.0), C(0.79, 0.96, 1.0), (U + 1) * 0.5 + np.sin(Z * 12) * 0.15)
        col = mix(col, C(1, 1, 1), smoothstep(0.8, 0.9, vnoise(X, Y, 40, 31)) * 0.6)
    col = col * (1 - shade + h[..., None] * shade * 2)
    # --- natural details shared by all species
    col *= (1 - 0.2 * smoothstep(0.55, 1.0, U))[..., None]                      # darker dorsal ridge
    col = mix(col, col * 0.45 + 0.55, smoothstep(-0.55, -0.95, U) * 0.22)       # paler belly
    lat = np.exp(-((U - 0.05) / 0.03) ** 2) * (np.sin(Y * sp["L"] / sp["scale"] * math.pi) > 0.3) * band(Y, 0.12, 0.74, 0.03)
    col *= (1 - 0.14 * lat)[..., None]                                          # lateral line pores
    col *= (0.93 + 0.14 * vnoise(X, Y, 64, 9))[..., None]                       # fine mottling
    edge = Y - (0.775 - 0.035 * (1 - U * U))                                    # gill cover outline
    opc = (np.abs(U) < 0.85)
    col *= (1 - 0.3 * np.exp(-((edge + 0.006) / 0.006) ** 2) * opc)[..., None]
    col += (0.07 * np.exp(-((edge - 0.02) / 0.015) ** 2) * opc)[..., None]
    mouth = np.exp(-((U + 0.15) / 0.1) ** 2) * smoothstep(0.955, 0.985, Y)     # lips
    col *= (1 - 0.6 * mouth)[..., None]
    col = mix(col, col * 0.7 + 0.3, smoothstep(0.975, 0.995, Y) * 0.3)
    return np.clip(col, 0, 1)


def fin_paint(name, tail, Uu, Vv, variant):
    """Uu: 0 at the fin root .. 1 at the tip, Vv: across the fin."""
    n = vnoise(Uu, Vv, 9, 5 + tail)
    nr = 16 if tail else 10
    rays = np.abs(np.sin(Vv * math.pi * nr + n * 0.8)) ** 8          # bony rays
    sub_ = np.abs(np.sin(Vv * math.pi * nr * 2 + 1.3)) ** 10 * 0.5   # branching
    var = H2C(variant) if variant else None
    tip = Uu ** 0.8
    if name == "neon":
        col = mix(C(0.75, 0.85, 0.95), C(0.9, 0.95, 1.0), tip)
        if tail:
            col = mix(col, C(1.0, 0.3, 0.35), smoothstep(0.3, 0.0, Uu) * 0.6)
        alpha = 0.3 - Uu * 0.12
    elif name == "guppy":
        second = np.clip(np.roll(var, 1) * 0.6 + C(0.4, 0.35, 0.1), 0, 1)
        col = mix(var, second, smoothstep(0.45, 0.7, vnoise(Uu, Vv, 7, 13)))
        col = mix(col, np.clip(var * 1.3, 0, 1), smoothstep(0.75, 1.0, Uu))
        dots = smoothstep(0.62, 0.7, vnoise(Uu * 2.0, Vv, 26, 41))
        col = mix(col, C(0.05, 0.05, 0.07), dots * 0.85)
        alpha = 0.9 - Uu * 0.15
    elif name == "goldfish":
        col = mix(C(1.0, 0.45, 0.06), C(1.0, 0.9, 0.78), tip)
        alpha = 0.85 - Uu * 0.45
    elif name == "angelfish":
        col = mix(C(0.82, 0.86, 0.9), C(0.6, 0.7, 0.9), tip)
        st = smoothstep(0.72, 0.88, np.sin((Uu * 9 if tail else Vv * 7) + n))
        col = mix(col, C(0.07, 0.07, 0.09), st * 0.9)
        alpha = 0.3 - Uu * 0.1 + st * 0.45
    elif name == "clown":
        col = np.broadcast_to(C(1.0, 0.45, 0.0), Uu.shape + (3,)).copy()
        col = mix(col, C(0.05, 0.05, 0.05), smoothstep(0.72, 0.84, Uu))
        col = mix(col, C(1, 1, 1), smoothstep(0.93, 0.99, Uu) * 0.7)
        alpha = 0.95 - smoothstep(0.85, 1.0, Uu) * 0.3
    elif name == "cory":
        col = mix(C(0.82, 0.74, 0.6), C(0.92, 0.88, 0.8), tip)
        dots = smoothstep(0.55, 0.65, np.sin(Uu * 30) * 0.5 + 0.5) * rays * 2
        col = mix(col, C(0.2, 0.15, 0.1), np.clip(dots, 0, 1) * 0.8)
        alpha = 0.5 - Uu * 0.15 + np.clip(dots, 0, 1) * 0.3
    elif name == "cichlid":
        if variant.lower() == "#2f6dff":
            col = mix(C(0.1, 0.25, 0.8), C(0.3, 0.6, 1.0), tip)
            col = mix(col, C(0.02, 0.02, 0.05), smoothstep(0.7, 0.85, Uu))
            col = mix(col, C(0.6, 0.85, 1.0), smoothstep(0.93, 0.99, Uu))
        else:
            col = mix(C(1.0, 0.82, 0.1), C(1.0, 0.9, 0.4), tip)
            col = mix(col, C(0.03, 0.03, 0.03), smoothstep(0.55, 0.75, Uu) * (0 if tail else 1))
        alpha = 0.9 - Uu * 0.1
    elif name == "discus":
        b2 = C(0.22, 0.78, 0.85) if variant.lower() == "#ff4a2a" else C(1.0, 0.48, 0.23)
        col = mix(var, b2, smoothstep(0.3, 0.7, np.sin(Vv * 40 + Uu * 6 + n * 2)))
        col = mix(col, C(0.3, 0.6, 1.0), smoothstep(0.82, 0.95, Uu))
        alpha = 0.85 - Uu * 0.1
    elif name == "barb":
        if tail:
            col = mix(C(1.0, 0.75, 0.3), C(1.0, 0.25, 0.15), smoothstep(0.5, 1.0, Uu))
            alpha = 0.6 - Uu * 0.1 + smoothstep(0.6, 1.0, Uu) * 0.3
        else:
            col = mix(C(0.05, 0.05, 0.05), C(1.0, 0.2, 0.12), smoothstep(0.45, 0.75, Uu))
            alpha = 0.9 - Uu * 0.1
    elif name == "betta":
        col = mix(C(0.8, 0.05, 0.15), C(0.55, 0.1, 0.6), smoothstep(0.2, 0.6, Uu))
        col = mix(col, C(0.15, 0.35, 1.0), smoothstep(0.5, 1.0, Uu + (n - 0.5) * 0.3))
        alpha = 0.88 - Uu * 0.12
    elif name == "rainbow":
        col = mix(C(1.0, 0.75, 0.25), C(1.0, 0.85, 0.4), tip)
        if tail:
            col = mix(col, C(0.25, 0.5, 1.0), smoothstep(0.35, 0.0, np.abs(Vv - 0.5)) * 0.5 * (1 - Uu))
        col = mix(col, C(1.0, 0.22, 0.35), smoothstep(0.78, 0.92, Uu))
        alpha = 0.75 - Uu * 0.1
    else:  # moonfish
        col = mix(C(0.66, 0.78, 1.0), C(0.92, 0.97, 1.0), tip)
        alpha = 0.5 - Uu * 0.2 + smoothstep(0.9, 1.0, Uu) * 0.3
    col = col * (1 - 0.16 * rays - 0.06 * sub_)[..., None]
    alpha = alpha + rays * 0.08
    alpha = alpha * (0.88 + n * 0.24)
    alpha *= smoothstep(1.0, 0.92 - n * 0.06, Uu)          # frayed, soft tip
    alpha *= smoothstep(0.0, 0.04, Vv) * smoothstep(1.0, 0.96, Vv)
    return np.clip(col, 0, 1), np.clip(alpha, 0, 1)


def fin_colors(name, w, h, variant=None):
    x = (np.arange(w // 2) + 0.5) / (w // 2)
    y = (np.arange(h) + 0.5) / h
    Uu, Vv = np.meshgrid(x, y)
    tc, ta = fin_paint(name, 1, Uu, Vv, variant)
    oc, oa = fin_paint(name, 0, Uu, Vv, variant)
    return np.concatenate([tc, oc], axis=1), np.concatenate([ta, oa], axis=1)


def save_image(name, rgb, alpha, path, non_color=False):
    h, w = rgb.shape[:2]
    rgba = np.concatenate([rgb, alpha[..., None]], axis=-1).astype(np.float32)
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    img = bpy.data.images.load(path)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def material(name, color_img, normal_img=None, blend=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = color_img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if blend:
        nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            m.blend_method = "BLEND"
    if normal_img is not None:
        nt2 = nt.nodes.new("ShaderNodeTexImage")
        nt2.image = normal_img
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(nt2.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = 0.35
    return m


# ----------------------------------------------------------------------------- main
def build(name, out_dir, variant=None, key=None):
    key = key or name
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sp = SPECIES[name]
    tmp = os.path.join(out_dir, "_tex")
    os.makedirs(tmp, exist_ok=True)

    body = build_body(sp)
    fins = build_fins(sp)
    pl, pr = build_pect(sp, -1), build_pect(sp, 1)
    build_eye_marker(sp, -1), build_eye_marker(sp, 1)

    W, Hh = 1024, 512
    X, Y, S, U, Z = tex_grid(W, Hh)
    hgt = scales_height(sp, X, Y)
    col = body_colors(name, sp, X, Y, S, U, Z, hgt, variant)
    alpha = np.ones(col.shape[:2])
    # reserve a white, flat texel block in the top-right corner (eyes use it)
    col[-4:, -4:] = 1.0
    hgt[-4:, -4:] = 0.0
    nrm = height_to_normal(hgt, 2.5)
    body_img = save_image(f"{key}_body", col, alpha, os.path.join(tmp, f"{key}_body.png"))
    nrm_img = save_image(f"{key}_body_n", nrm, alpha, os.path.join(tmp, f"{key}_body_n.png"), non_color=True)
    fcol, falpha = fin_colors(name, 512, 256, variant)
    fin_img = save_image(f"{key}_fin", fcol, falpha, os.path.join(tmp, f"{key}_fin.png"))

    body.data.materials.append(material(f"{key}_body", body_img, nrm_img))
    fin_mat = material(f"{key}_fin", fin_img, blend=True)
    for ob in (fins, pl, pr):
        ob.data.materials.append(fin_mat)

    path = os.path.join(out_dir, f"{key}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_yup=True, export_apply=True,
                              export_texcoords=True, export_normals=True, export_materials="EXPORT",
                              export_image_format="WEBP", export_image_quality=88)
    print("WROTE", key, os.path.getsize(path))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out_dir = argv[0] if argv else os.path.abspath("public/models/fish")
    # these come ready-made through tools/import_fish.py; name one explicitly to rebuild it here
    imported = {"goldfish", "betta", "cichlid", "angelfish", "barb", "cory", "rainbow", "discus", "clown", "guppy", "neon"}
    names = argv[1:] or [n for n in SPECIES if n not in imported]
    os.makedirs(out_dir, exist_ok=True)
    for n in names:
        variants = SPECIES[n].get("variants")
        if variants:
            for k, v in enumerate(variants):
                build(n, out_dir, v, f"{n}-{k}")
        else:
            build(n, out_dir)
    import shutil
    shutil.rmtree(os.path.join(out_dir, "_tex"), ignore_errors=True)


main()
