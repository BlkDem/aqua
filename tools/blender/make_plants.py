"""
Generates aquarium plants as GLB files for the Living Aquarium.

Run headless:
  blender -b -P tools/blender/make_plants.py -- <out_dir> [plant ...]

Each plant is a single mesh whose origin is its root and whose height runs up the
(three.js) Y axis: the game's sway shader bends vertices by their height above the root.
Leaves are UV-mapped individually (u across the leaf, v from base to tip) onto a painted
leaf texture; a per-vertex colour tints each leaf so a clump is never uniform.
Nodes named Sway* sway with the current; everything else is stiff (rhizomes, roots).
"""
import bpy
import bmesh
import math
import os
import random
import sys
import numpy as np
from mathutils import Vector, Matrix, Euler

TAU = math.pi * 2
OUT = None


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def C(*rgb):
    return np.array(rgb, dtype=float)


def H(hexstr):
    h = hexstr.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def mix(a, b, t):
    t = np.clip(t, 0, 1)[..., None]
    return a * (1 - t) + b * t


def vnoise(X, Y, f, seed=0):
    rng = np.random.default_rng(seed)
    g = rng.random((f + 2, f + 2))
    fx, fy = X * f, Y * f
    i, j = np.floor(fx).astype(int) % (f + 1), np.floor(fy).astype(int) % (f + 1)
    ux, uy = fx - np.floor(fx), fy - np.floor(fy)
    ux, uy = ux * ux * (3 - 2 * ux), uy * uy * (3 - 2 * uy)
    a, b, c, d = g[j, i], g[j, i + 1], g[j + 1, i], g[j + 1, i + 1]
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy


# ----------------------------------------------------------------------------- textures
def leaf_texture(kind, size=512):
    """Returns (rgb, height, alpha) for one leaf; U across (0..1, midrib at 0.5), V base -> tip."""
    x = (np.arange(size) + 0.5) / size
    U, V = np.meshgrid(x, x)
    a = np.abs(U - 0.5) * 2                  # 0 at the midrib, 1 at the edge
    n = vnoise(U, V, 24, 1)
    n2 = vnoise(U, V, 7, 2)
    if kind == "ribbon":                     # vallisneria: parallel veins, sunlit tip
        veins = np.abs(np.sin(U * math.pi * 7)) ** 30 * 0.6
        col = mix(H("#2f5a1c"), H("#7fae3e"), V ** 0.8 + (n - 0.5) * 0.2)
        col = mix(col, H("#a9c95a"), veins * 0.5)
        col = mix(col, H("#5c4a1f"), smoothstep(0.85, 1.0, V) * smoothstep(0.6, 0.9, n2) * 0.6)  # browning tips
        h = veins
    elif kind == "sword":                    # echinodorus: midrib + arched lateral veins
        mid = np.exp(-(a / 0.03) ** 2)
        lat = np.abs(np.sin((V * 9 - a * 2.2) * math.pi)) ** 24 * (a < 0.95)
        arc = np.exp(-((a - 0.7) / 0.03) ** 2)
        col = mix(H("#2c6b22"), H("#5fa63a"), 0.3 + 0.7 * V ** 0.6 + (n - 0.5) * 0.15)
        col = mix(col, H("#b3d88a"), mid * 0.7 + (lat + arc) * 0.3)
        col = mix(col, H("#1e4a17"), smoothstep(0.85, 1.0, a) * 0.5)
        h = mid + (lat + arc) * 0.5
    elif kind == "crypt":                    # cryptocoryne: brownish-green, faint cross veins
        mid = np.exp(-(a / 0.035) ** 2)
        lat = np.abs(np.sin((V * 7 - a * 1.6) * math.pi)) ** 20
        col = mix(H("#3d4a22"), H("#6f7f3a"), V + (n - 0.5) * 0.3)
        col = mix(col, H("#6b3a2a"), smoothstep(0.5, 0.8, n2) * 0.6)
        col = mix(col, H("#a7a46a"), mid * 0.6 + lat * 0.2)
        h = mid + lat * 0.4
    elif kind == "anubias":                  # anubias: dark, glossy, pinnate veins
        mid = np.exp(-(a / 0.04) ** 2)
        lat = np.abs(np.sin((V * 12 - a * 2.0) * math.pi)) ** 30
        col = mix(H("#163f17"), H("#2f6a26"), 0.4 + 0.6 * V + (n - 0.5) * 0.2)
        col = mix(col, H("#5e8f3e"), mid * 0.7 + lat * 0.25)
        h = mid + lat * 0.5
    elif kind == "pistia":                   # water lettuce: pale, velvety, deep parallel ridges
        ridges = np.abs(np.sin(U * math.pi * 9)) ** 3
        col = mix(H("#6f9f43"), H("#b8d98a"), V * 0.6 + ridges * 0.3 + (n - 0.5) * 0.15)
        h = ridges
    elif kind in ("feather", "fan"):         # finely divided leaves (limnophila, cabomba)
        # a central rachis with thin leaflets angled towards the tip; cut out with alpha
        env = np.sin(np.pi * np.clip(V, 0, 1) ** 0.8) * (0.95 if kind == "fan" else 0.85)
        k = 7 if kind == "feather" else 5
        lines = np.abs(((V * k - a * (0.9 if kind == "feather" else 0.4)) % 1.0) - 0.5)
        leaflet = (lines < 0.11) & (a < env)
        rachis = a < 0.06
        alpha = (leaflet | rachis).astype(float)
        col = mix(H("#2f6e1e"), H("#a5d85e"), V ** 0.7 * 0.7 + a * 0.4 + (n - 0.5) * 0.25)
        h = alpha * (1 - a)
        col = col * (0.92 + 0.16 * vnoise(U, V, 60, 9))[..., None]
        return np.clip(col, 0, 1), h, alpha
    elif kind == "moss":                     # fuzzy moss tuft card: a dome of fine strands
        strands = vnoise(U * 3, V, 90, 31) * 0.6 + vnoise(U, V, 40, 32) * 0.4
        dome = 1 - (np.abs(U - 0.5) * 2) ** 2
        alpha = ((strands > 0.45 + 0.5 * (V / np.maximum(dome, 1e-3)) ** 3) & (V < dome)).astype(float)
        col = mix(H("#1f3d12"), H("#7fb83a"), V * 1.3 + (strands - 0.5) * 0.6)
        return np.clip(col, 0, 1), alpha * V, alpha
    elif kind == "red":                      # red stem plant (ludwigia-like)
        mid = np.exp(-(a / 0.05) ** 2)
        col = mix(H("#4a6a24"), H("#c0442c"), smoothstep(0.1, 0.8, V) + (n - 0.5) * 0.2)
        col = mix(col, H("#e07a4a"), mid * 0.4)
        h = mid
    else:                                    # stem
        col = mix(H("#2f4f1e"), H("#55803a"), V)
        h = np.zeros_like(U)
    col = col * (0.92 + 0.16 * vnoise(U, V, 60, 9))[..., None]
    return np.clip(col, 0, 1), h, np.ones_like(h)


def height_to_normal(h, strength):
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5
    nrm = np.stack([-dx * strength, -dy * strength, np.ones_like(h)], axis=-1)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    return nrm * 0.5 + 0.5


def save_image(name, rgb, path, non_color=False, alpha=None):
    hh, ww = rgb.shape[:2]
    a = np.ones((hh, ww, 1)) if alpha is None else alpha[..., None]
    rgba = np.concatenate([rgb, a], axis=-1).astype(np.float32)
    img = bpy.data.images.new(name, ww, hh, alpha=alpha is not None)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    img = bpy.data.images.load(path)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def leaf_material(name, kind, rough=0.55, normal_strength=3.0):
    tmp = os.path.join(OUT, "_tex")
    os.makedirs(tmp, exist_ok=True)
    col, h, alpha = leaf_texture(kind)
    cut = alpha.min() < 0.5
    ci = save_image(name + "_c", col, os.path.join(tmp, name + "_c.png"), alpha=alpha if cut else None)
    ni = save_image(name + "_n", height_to_normal(h, normal_strength), os.path.join(tmp, name + "_n.png"), True)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    tc = nt.nodes.new("ShaderNodeTexImage"); tc.image = ci
    vc = nt.nodes.new("ShaderNodeVertexColor"); vc.layer_name = "Col"
    mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = "RGBA"; mul.blend_type = "MULTIPLY"
    mul.inputs[0].default_value = 1.0
    nt.links.new(tc.outputs["Color"], mul.inputs[6])
    nt.links.new(vc.outputs["Color"], mul.inputs[7])
    nt.links.new(mul.outputs[2], bsdf.inputs["Base Color"])
    tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = ni
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = rough
    if cut:
        nt.links.new(tc.outputs["Alpha"], bsdf.inputs["Alpha"])  # the game renders it as an alpha cutout
    m.use_backface_culling = False
    return m


# ----------------------------------------------------------------------------- geometry
class Builder:
    """Accumulates leaf grids (with UVs and per-leaf tint) into one bmesh."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.col = self.bm.loops.layers.float_color.new("Col")

    def grid(self, fn, nu, nv, tint=(1, 1, 1), xf=Matrix.Identity(4)):
        """fn(u, v) -> Vector in leaf space (u across 0..1, v along 0..1)."""
        rows = []
        for j in range(nv + 1):
            row = []
            for i in range(nu + 1):
                u, v = i / nu, j / nv
                row.append((self.bm.verts.new(xf @ fn(u, v)), u, v))
            rows.append(row)
        for j in range(nv):
            for i in range(nu):
                q = (rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i])
                f = self.bm.faces.new([a[0] for a in q])
                for loop, (_, u, v) in zip(f.loops, q):
                    loop[self.uv].uv = (u, v)
                    loop[self.col] = (*tint, 1.0)

    def tube(self, pts, radius, seg=6, tint=(1, 1, 1)):
        """Thin stem along points (radius may be a function of t)."""
        rings = []
        n = len(pts)
        for k, p in enumerate(pts):
            d = (pts[min(k + 1, n - 1)] - pts[max(k - 1, 0)]).normalized()
            side = d.cross(Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))).normalized()
            up = side.cross(d)
            r = radius(k / (n - 1)) if callable(radius) else radius
            rings.append([(self.bm.verts.new(p + (side * math.cos(TAU * s / seg) + up * math.sin(TAU * s / seg)) * r), s / seg, k / (n - 1)) for s in range(seg + 1)])
        for k in range(n - 1):
            for s in range(seg):
                q = (rings[k][s], rings[k][s + 1], rings[k + 1][s + 1], rings[k + 1][s])
                f = self.bm.faces.new([a[0] for a in q])
                for loop, (_, u, v) in zip(f.loops, q):
                    loop[self.uv].uv = (0.5 + (u - 0.5) * 0.1, v)  # sample the leaf's midrib strip
                    loop[self.col] = (*tint, 1.0)

    def finish(self, name, mat):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        for p in me.polygons:
            p.use_smooth = True
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        me.materials.append(mat)
        return ob


def arc(v, L, theta0, arch):
    """Point at fraction v along a leaf of length L that leaves the root at theta0 from the
    vertical and keeps bending outward by `arch` radians: returns (out, up)."""
    if abs(arch) < 1e-4:
        return v * L * math.sin(theta0), v * L * math.cos(theta0)
    t1 = theta0 + arch * v
    return L * (math.cos(theta0) - math.cos(t1)) / arch, L * (math.sin(t1) - math.sin(theta0)) / arch


def place(yaw=0.0, tilt=0.0, at=(0, 0, 0)):
    """Leaf frame: leaf space x = across, y = out from the plant, z = up."""
    return Matrix.Translation(Vector(at)) @ Euler((0, 0, yaw)).to_matrix().to_4x4() @ Euler((tilt, 0, 0)).to_matrix().to_4x4()


def tint(rng, base=(1, 1, 1), var=0.12):
    k = 1 + rng.uniform(-var, var)
    return tuple(min(1.0, c * k * (1 + rng.uniform(-var, var) * 0.5)) for c in base)


def export(name, obs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    path = os.path.join(OUT, name + ".glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True,
                              export_apply=True, export_texcoords=True, export_normals=True,
                              export_vertex_color="ACTIVE", export_materials="EXPORT",
                              export_image_format="WEBP", export_image_quality=85)
    print("WROTE", name, os.path.getsize(path))


# ----------------------------------------------------------------------------- plants
def vallisneria(rng, mat, name):
    """Clump of long ribbon blades that lean out and twist as they rise."""
    b = Builder()
    for i in range(rng.randint(12, 18)):
        h = rng.uniform(2.6, 4.6)
        w = rng.uniform(0.06, 0.1)
        lean = rng.uniform(0.25, 0.9)
        twist = rng.uniform(-1.5, 1.5)
        droop = rng.uniform(0.0, 0.35)

        def fn(u, v, h=h, w=w, lean=lean, twist=twist, droop=droop):
            x = (u - 0.5) * w * (1 - v * 0.5)
            a = v * twist
            y = math.sin(v * math.pi * 0.5) * lean + droop * v ** 3
            return Vector((x * math.cos(a), x * math.sin(a) + y, v * h * (1 - droop * v * v * 0.2)))
        xf = place(rng.uniform(0, TAU), 0, (rng.uniform(-0.25, 0.25), rng.uniform(-0.12, 0.12), 0))
        b.grid(fn, 2, 26, tint(rng), xf)
    return b.finish(name, mat)


def sword(rng, mat, name, n=(11, 16), size=1.0):
    """Echinodorus rosette: long petioles carrying broad lanceolate blades, arching outward."""
    b = Builder()
    k = rng.randint(*n)
    for i in range(k):
        L = rng.uniform(0.9, 1.6) * size
        W = rng.uniform(0.24, 0.38) * size
        th = rng.uniform(0.2, 0.65)   # inner leaves stand up, outer ones splay
        arch = rng.uniform(0.5, 1.2)
        pet = 0.3

        def fn(u, v, L=L, W=W, arch=arch, th=th):
            if v < pet:
                half = 0.012 * size
            else:
                t = (v - pet) / (1 - pet)
                half = math.sin(math.pi * t ** 0.85) * W * 0.5 + 0.012 * size * (1 - t)
            x = (u - 0.5) * 2 * half
            out, up = arc(v, L, th, arch)
            fold = abs(u - 0.5) * half * 0.5          # V-shaped midrib fold
            return Vector((x, out, up + fold))
        xf = place(TAU * i / k + rng.uniform(-0.2, 0.2), 0, (0, 0, 0))
        b.grid(fn, 6, 18, tint(rng), xf)
    return b.finish(name, mat)


def crypt(rng, mat, name):
    """Cryptocoryne: a low rosette of wavy-edged lanceolate leaves."""
    b = Builder()
    k = rng.randint(8, 13)
    for i in range(k):
        L = rng.uniform(0.32, 0.6)
        W = rng.uniform(0.1, 0.15)
        th = rng.uniform(0.35, 0.95)
        arch = rng.uniform(0.4, 1.1)
        ph = rng.uniform(0, 6)

        def fn(u, v, L=L, W=W, arch=arch, ph=ph, th=th):
            t = max(0.0, (v - 0.25) / 0.75)
            half = (math.sin(math.pi * t ** 0.8) * W * 0.5) if v > 0.25 else 0.006
            x = (u - 0.5) * 2 * half
            wave = math.sin(v * 22 + ph) * 0.012 * abs(u - 0.5) * 2 * (v > 0.25)
            out, up = arc(v, L, th, arch)
            return Vector((x, out, up + wave))
        xf = place(TAU * i / k + rng.uniform(-0.3, 0.3), 0, (rng.uniform(-0.03, 0.03), rng.uniform(-0.03, 0.03), 0))
        b.grid(fn, 6, 16, tint(rng), xf)
    return b.finish(name, mat)


def anubias(rng, leaf_m, name):
    """Anubias on a creeping rhizome: stiff petioles with broad oval dark leaves."""
    b = Builder()
    rh = [Vector((-0.22 + 0.44 * k / 8, 0.03 * math.sin(k), 0.02)) for k in range(9)]
    b.tube(rh, 0.03, seg=8, tint=(0.75, 0.7, 0.55))
    for i in range(rng.randint(6, 9)):
        base = rh[rng.randint(1, 7)]
        L = rng.uniform(0.28, 0.42)
        W = rng.uniform(0.15, 0.22)
        pet = rng.uniform(0.12, 0.24)
        tilt = rng.uniform(0.3, 0.8)

        def fn(u, v, L=L, W=W, pet=pet):
            # the petiole leans outward from the rhizome, the blade continues and droops a little
            if v < 0.35:
                t = v / 0.35
                return Vector(((u - 0.5) * 0.012, t * pet * 0.55, t * pet * 0.85))
            t = (v - 0.35) / 0.65
            half = math.sin(math.pi * min(1.0, t * 0.95 + 0.05)) ** 0.7 * W * 0.5
            x = (u - 0.5) * 2 * half
            return Vector((x, pet * 0.55 + t * L * 0.85, pet * 0.85 + t * L * 0.35 - t * t * L * 0.25 + abs(u - 0.5) * half * 0.4))
        xf = place(rng.uniform(0, TAU), 0, base)
        b.grid(fn, 6, 16, tint(rng, var=0.08), xf)
    return b.finish(name, leaf_m)


def stem_plant(rng, mat, name, kind="limnophila", stems=(6, 9), hrange=(1.6, 2.8)):
    """Bunch of upright stems with whorls of fine leaves (limnophila, cabomba) or paired
    small oval leaves (red ludwigia)."""
    b = Builder()
    for s in range(rng.randint(*stems)):
        ox, oy = rng.uniform(-0.25, 0.25), rng.uniform(-0.2, 0.2)
        h = rng.uniform(*hrange)
        bend = Vector((ox, oy, 0)).normalized() * rng.uniform(0.15, 0.45) * (h / 2) if (ox or oy) else Vector()
        pts = [Vector((ox, oy, 0)) + bend * (t / 10) ** 2 + Vector((0, 0, h * t / 10)) for t in range(11)]
        b.tube(pts, lambda t: 0.012 * (1 - t * 0.4), seg=5, tint=(0.9, 0.95, 0.85))
        z = 0.12
        k = 0
        step = {"limnophila": 0.1, "cabomba": 0.14, "red": 0.09}[kind]
        while z < h:
            t = z / h
            c = Vector((ox, oy, 0)) + bend * t ** 2 + Vector((0, 0, z))
            if kind == "red":
                for side in (0, math.pi):
                    L = 0.14 * (1 - t * 0.3)

                    def fn(u, v, L=L):
                        half = math.sin(math.pi * v) * 0.035
                        return Vector(((u - 0.5) * 2 * half, v * L * 0.9, v * L * 0.35))
                    b.grid(fn, 2, 4, tint(rng, (1, 1, 1), 0.1), place(k * 1.57 + side, 0, c))
            else:
                n = 6 if kind == "limnophila" else 3
                L = (0.3 if kind == "limnophila" else 0.32) * (1 - t * 0.45)
                W = L * (0.6 if kind == "limnophila" else 1.0)
                lift = 0.15 + 0.5 * t      # lower leaves spread flat, the crown points up
                for j in range(n):
                    def fn(u, v, L=L, W=W, lift=lift):
                        return Vector(((u - 0.5) * W, v * L * 0.9, v * L * lift + v * v * L * 0.2 + abs(u - 0.5) * W * 0.25))
                    b.grid(fn, 2, 3, tint(rng, (1, 1, 1), 0.08), place(TAU * j / n + k * 0.5, 0, c))
            z += step
            k += 1
    return b.finish(name, mat)


def pistia(rng, mat, root_m, name):
    """Water lettuce: a floating rosette of ridged spatulate leaves with hanging roots."""
    b = Builder()
    k = rng.randint(8, 12)
    for i in range(k):
        L = rng.uniform(0.18, 0.3)

        def fn(u, v, L=L):
            half = (0.25 + 0.75 * math.sin(math.pi * 0.5 * min(1, v * 1.4))) * L * 0.32 * (1 - max(0, v - 0.85) * 3)
            x = (u - 0.5) * 2 * half
            cup = abs(u - 0.5) ** 2 * half * 1.2
            return Vector((x, v * L, v * L * 0.35 + cup - v * v * L * 0.12))
        b.grid(fn, 6, 10, tint(rng, var=0.08), place(TAU * i / k + rng.uniform(-0.15, 0.15), 0, (0, 0, 0)))
    leaves = b.finish("Sway" + name, mat)
    r = Builder()
    for i in range(14):
        a = rng.uniform(0, TAU)
        L = rng.uniform(0.12, 0.3)
        pts = [Vector((math.cos(a) * 0.03 + math.sin(t) * 0.01, math.sin(a) * 0.03, -L * t / 6)) for t in range(7)]
        r.tube(pts, 0.004, seg=4, tint=(0.85, 0.8, 0.7))
    roots = r.finish("Roots" + name, root_m)
    return [leaves, roots]


def moss_tuft(mat, name):
    """A small tuft: crossed upright cards plus a cap card, all cut out by the moss texture."""
    b = Builder()
    w, h = 0.12, 0.08
    for k in range(4):
        a = math.pi * k / 4
        b.grid(lambda u, v: Vector(((u - 0.5) * w, 0, v * h)), 1, 1, (1, 1, 1), place(a))
    b.grid(lambda u, v: Vector(((u - 0.5) * w * 0.9, (v - 0.5) * w * 0.9, h * 0.55)), 1, 1, (0.9, 0.95, 0.85))
    return b.finish(name, mat)


PLANTS = {}


def plant(fn):
    PLANTS[fn.__name__.replace("build_", "")] = fn
    return fn


@plant
def build_vallisneria():
    m = leaf_material("Vallis", "ribbon", rough=0.5)
    export("vallisneria", [vallisneria(random.Random(i), m, f"SwayVallis{i}") for i in range(3)])


@plant
def build_sword():
    m = leaf_material("Sword", "sword", rough=0.45)
    export("sword", [sword(random.Random(10 + i), m, f"SwaySword{i}") for i in range(2)])


@plant
def build_crypt():
    m = leaf_material("Crypt", "crypt", rough=0.5)
    export("crypt", [crypt(random.Random(20 + i), m, f"SwayCrypt{i}") for i in range(2)])


@plant
def build_anubias():
    m = leaf_material("Anubias", "anubias", rough=0.3)
    export("anubias", [anubias(random.Random(30 + i), m, f"SwayAnubias{i}") for i in range(2)])


@plant
def build_limnophila():
    m = leaf_material("Limno", "feather", rough=0.55, normal_strength=1.0)
    export("limnophila", [stem_plant(random.Random(40 + i), m, f"SwayLimno{i}", "limnophila", (10, 14), (1.0, 2.0)) for i in range(2)])


@plant
def build_cabomba():
    m = leaf_material("Cabomba", "fan", rough=0.55, normal_strength=1.0)
    export("cabomba", [stem_plant(random.Random(50 + i), m, f"SwayCabomba{i}", "cabomba", (7, 10), (1.8, 3.2)) for i in range(2)])


@plant
def build_ludwigia():
    m = leaf_material("Ludwigia", "red", rough=0.5, normal_strength=1.0)
    export("ludwigia", [stem_plant(random.Random(60 + i), m, f"SwayLudwigia{i}", "red", (7, 11), (1.4, 2.6)) for i in range(2)])


@plant
def build_pistia():
    m = leaf_material("Pistia", "pistia", rough=0.7, normal_strength=4.0)
    rm = leaf_material("PistiaRoot", "stem", rough=0.8)
    obs = []
    for i in range(3):
        obs += pistia(random.Random(70 + i), m, rm, f"Pistia{i}")
    export("pistia", obs)


@plant
def build_moss():
    m = leaf_material("Moss", "moss", rough=0.9, normal_strength=1.0)
    export("moss", [moss_tuft(m, "MossTuft")])


def main():
    global OUT
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    OUT = argv[0] if argv else os.path.abspath("public/models/plants")
    names = argv[1:] or list(PLANTS)
    os.makedirs(OUT, exist_ok=True)
    for n in names:
        reset()
        PLANTS[n]()
    import shutil
    shutil.rmtree(os.path.join(OUT, "_tex"), ignore_errors=True)


main()
