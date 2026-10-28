"""Bring a ready-made snail or shrimp (one textured mesh, e.g. from Tripo) into the aquarium as the
jointed critter the critter code animates, like tools/import_crab.py does for the crab.

  snail   Body (foot and head), Shell, TentL/TentR (feelers)
  shrimp  Body (head and carapace), Seg0..Seg5 (the abdomen, a chain), Tail (the fan), AntL/AntR,
          CheliL/CheliR (the front pair of legs), LegL0..LegR3 (walking legs)

A snail's feelers are told from the body as fin_map.py tells fins (the surface facing the other
way lies close behind), a shrimp's limbs by the trunk's outline. The rest is cut by the numbers
in PRESETS, measured on each model (axes after `forward`: +Y up, +Z ahead, the critter's left at +X, standing on y = 0).

    python3 tools/import_critter.py <preset> <model.glb> [--out path] [--skins dir]

--skins writes the shrimp's pattern recoloured for each of the game's shrimp colours (SKINS), as
shrimp_<hex>.jpg: the hue of its red turned to the colour's, a grey colour washing it out.
"""
import argparse, json, os, struct, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_fish import ROOT, read_glb, simplify, jpeg, hue_turned  # noqa: E402
import colorsys  # noqa: E402
from PIL import Image  # noqa: E402
from import_crab import Graph, read_rm, write  # noqa: E402
from fin_map import thickness  # noqa: E402

PRESETS = {
    # "47f4c938fbe39cd68c779bede3581c77.glb": a golden apple snail
    "snail-mystery": dict(kind="snail", forward="+z", length=0.21, foot=0.045, aperture=0.27, head_top=0.24, thin=0.05, tent_z=0.3),
    # "snail 3d model.glb": a ramshorn
    "snail-ramshorn": dict(kind="snail", forward="+x", length=0.133, foot=0.045, aperture=0.26, head_top=0.3, thin=0.05, tent_z=0.28),
    # "449d2b8e561a3b6fc2591e9c8cd8443d.glb": a red and white banded shrimp
    # its shell is modelled in thin layers, so its limbs are told by the trunk's outline instead: below
    # the belly line, wider than the body, or ahead of the head
    "shrimp": dict(kind="shrimp", forward="+x", length=0.37, thin=0.05, carapace=-0.05, tail=-0.42, antenna_z=0.3,
                   belly=[(-0.42, 0.07), (-0.3, 0.11), (0.1, 0.11), (0.2, 0.14), (0.3, 0.16)], half_width=0.11, head=0.3),
}
SKINS = ["ff2a2a", "ff3b30", "e8101e", "ff5a36", "2f7dff", "ffd400", "ff2a6a", "c9d6d9"]   # Critters.cs shrimpCols
SEG_LENGTHS = np.array([21, 19, 18, 15, 13, 11], float)   # the abdomen's segments, front to back (as the Blender shrimp)


def node_rotation(path):
    f = open(path, "rb").read()
    n = struct.unpack("<I", f[12:16])[0]
    q = json.loads(f[20:20 + n])["nodes"][0].get("rotation")
    if not q:
        return np.eye(3)
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def root_of(co, G, part, rest):
    """Centroid of a part's vertices that touch the rest."""
    r = [v for v in part if any(rest[w] for w, _ in G.adj[v])]
    return co[r].mean(0) if r else co[part].mean(0)


def snail(c, co, G, thin):
    y, z = co[:, 1], co[:, 2]
    body = (y < c["foot"]) | ((z > c["aperture"]) & (y < c["head_top"]))
    tent = thin & (z > c["tent_z"]) & (y > c["foot"])
    label = np.where(tent, -1, np.where(body, 0, 1))   # -1 feeler, 0 body, 1 shell
    parts = {"Body": np.flatnonzero(label == 0), "Shell": np.flatnonzero(label == 1)}
    for side, name in ((1, "TentL"), (-1, "TentR")):
        parts[name] = np.flatnonzero((label == -1) & (np.sign(co[:, 0]) == side))
    rest = label != -1
    joints = {"Shell": root_of(co, G, parts["Shell"], label == 0)}
    for n in ("TentL", "TentR"):
        joints[n] = root_of(co, G, parts[n], rest)
    return parts, joints, {n: "Body" for n in ("Shell", "TentL", "TentR")}


def shrimp(c, co, G, thin):
    z = co[:, 2]
    tail = z < c["tail"]
    bz, by = np.array(c["belly"]).T
    thin = (co[:, 1] < np.interp(z, bz, by) - 0.005) | (np.abs(co[:, 0]) > c["half_width"]) | (z > c["head"])
    limbs = G.components(thin & ~tail)
    thick = ~thin | tail
    parts = {k: [] for k in ["Body", "Tail", "AntL", "AntR", "CheliL", "CheliR"] + [f"Leg{s}{i}" for s in "LR" for i in range(4)] + [f"Seg{i}" for i in range(6)]}
    # the abdomen: cut along its length, the segments shorter towards the tail
    cuts = c["carapace"] - (c["carapace"] - c["tail"]) * np.concatenate([[0], np.cumsum(SEG_LENGTHS) / SEG_LENGTHS.sum()])
    seg_of = lambda q: int(np.clip(np.searchsorted(-cuts, -q) - 1, 0, 5))
    for v in np.flatnonzero(thick & ~tail):
        parts["Body" if z[v] >= c["carapace"] else f"Seg{seg_of(z[v])}"].append(v)
    parts["Tail"] = list(np.flatnonzero(tail))
    legs = {"L": [], "R": []}
    for limb in limbs:
        r = root_of(co, G, limb, thick)
        side = "L" if co[limb, 0].mean() > 0 else "R"
        if co[limb, 2].max() > c["antenna_z"] and r[2] > 0:
            # the two antennae may meet at their roots: each vertex to its own side
            parts["AntL"] += list(limb[co[limb, 0] > 0])
            parts["AntR"] += list(limb[co[limb, 0] <= 0])
        elif r[2] < c["carapace"]:
            parts[f"Seg{seg_of(r[2])}"] += list(limb)   # swimmerets ride on their segment
        elif len(limb) < 12:
            parts["Body"] += list(limb)
        else:
            legs[side].append((r, limb))
    joints = {}
    for side, ls in legs.items():
        ls.sort(key=lambda t: -t[0][2])
        names = ["Cheli" + side] + [f"Leg{side}{i}" for i in range(4)]
        for k, (r, limb) in enumerate(ls):
            name = names[min(k, len(names) - 1)] if k < len(names) else min(names[1:], key=lambda n: np.linalg.norm(joints[n] - r))
            parts[name] += list(limb)
            joints.setdefault(name, r)
    parts = {n: np.array(v, int) for n, v in parts.items()}
    for n in ("AntL", "AntR"):
        joints[n] = root_of(co, G, parts[n], thick)
    for i in range(6):
        ring = parts[f"Seg{i}"]
        ring = ring[np.abs(z[ring] - cuts[i]) < 0.03] if len(ring) else ring
        joints[f"Seg{i}"] = co[ring].mean(0) if len(ring) else np.array([0, co[:, 1].mean(), cuts[i]])
    tring = np.flatnonzero(tail & (z > c["tail"] - 0.03))
    joints["Tail"] = co[tring].mean(0)
    parent = {n: "Body" for n in parts if n != "Body"}
    for i in range(1, 6):
        parent[f"Seg{i}"] = f"Seg{i - 1}"
    parent["Tail"] = "Seg5"
    return parts, joints, parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("preset", choices=list(PRESETS))
    ap.add_argument("src")
    ap.add_argument("--out", default=None)
    ap.add_argument("--tris", type=int, default=14000)
    ap.add_argument("--tex", type=int, default=1024)
    ap.add_argument("--skins", default=None)
    a = ap.parse_args()
    c = PRESETS[a.preset]

    P, N, UV, I, base, normal = read_glb(a.src)
    R = node_rotation(a.src)
    if c["forward"] == "+x":   # a quarter turn about y: the head from +x to +z
        R = np.array([[0, 0, -1], [0, 1, 0], [1, 0, 0]], float) @ R
    P, N = P @ R.T, N @ R.T
    rm = read_rm(a.src)
    I = simplify(P, I, a.tris)
    used, I = np.unique(I, return_inverse=True)
    P, N, UV, I = P[used], N[used], UV[used], I.reshape(-1, 3)
    N /= np.linalg.norm(N, axis=1, keepdims=True)

    _, weld = np.unique(np.round(P * 1e5).astype(np.int64), axis=0, return_inverse=True)
    weld = weld.ravel()
    co = np.zeros((weld.max() + 1, 3))
    co[weld] = P
    F = weld[I]
    G = Graph(co, F)
    nrm = np.zeros_like(co)
    fn = np.cross(co[F[:, 1]] - co[F[:, 0]], co[F[:, 2]] - co[F[:, 0]])
    for k in range(3):
        np.add.at(nrm, F[:, k], fn)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    thin = thickness(co, nrm, 4 * c["thin"]) < c["thin"]

    parts, joints, parent = (snail if c["kind"] == "snail" else shrimp)(c, co, G, thin)
    for n, v in parts.items():
        if not len(v):
            sys.exit(f"{a.preset}: part {n} came out empty; adjust the preset")
    names = ["Body"] + [n for n in parts if n != "Body"]
    part = np.zeros(len(co), int)
    for k, n in enumerate(names):
        part[parts[n]] = k
    tp = part[F]
    tri_part = np.where(tp[:, 1] == tp[:, 2], tp[:, 1], tp[:, 0])

    # to the aquarium: centred, standing on y = 0, as long as the critter it replaces
    lo, hi = P.min(0), P.max(0)
    S = c["length"] / (hi[2] - lo[2])
    origin = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
    P = (P - origin) * S
    joint = {n: (v - origin) * S for n, v in joints.items()}
    joint["Body"] = np.zeros(3)
    meshes = {}
    for k, n in enumerate(names):
        tris = I[tri_part == k]
        v, t = np.unique(tris, return_inverse=True)
        meshes[n] = (P[v] - joint[n], N[v], UV[v], t.reshape(-1, 3))
        print(f"  {n:7s} {len(tris):5d} triangles, joint {np.round(joint[n], 3)}")
    out = a.out or os.path.join(ROOT, "public/models/critters", a.preset + ".glb")
    write(out, names, parent, joint, meshes, [jpeg(base, a.tex, 88), normal and jpeg(normal, a.tex, 92), rm and jpeg(rm, a.tex // 2, 90)],
          material=a.preset, image_prefix=a.preset)
    print(f"wrote {out}: {os.path.getsize(out) // 1024} KB")
    if a.skins:
        write_skins(base, a.skins, a.tex)


def write_skins(base, out_dir, size):
    rgb = np.asarray(base.convert("RGB").resize((size, size), Image.LANCZOS), np.float32) / 255
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    # the pattern's own colour: the hue of its strongly coloured texels
    h = np.array([colorsys.rgb_to_hsv(*p)[0] for p in rgb[(sat > 0.5) & (mx > 0.3)][::97]])
    ref = float(np.angle(np.exp(2j * np.pi * h).mean()) / (2 * np.pi)) % 1
    os.makedirs(out_dir, exist_ok=True)
    for hexs in SKINS:
        hh, ss, _ = colorsys.rgb_to_hsv(*(int(hexs[i:i + 2], 16) / 255 for i in (0, 2, 4)))
        if ss < 0.25:   # a ghost shrimp: the colour washed out of the pattern
            grey = rgb.mean(-1, keepdims=True)
            px = np.clip(grey + (rgb - grey) * 0.15 + 0.08, 0, 1)
        else:
            px = hue_turned(rgb, hh - ref)
        Image.fromarray((px * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, f"shrimp_{hexs}.jpg"), quality=88)
    print(f"wrote {len(SKINS)} skins to {out_dir} (pattern hue {ref * 360:.0f} deg)")


if __name__ == "__main__":
    main()
