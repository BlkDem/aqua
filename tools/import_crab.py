"""Bring a ready-made crab (one textured mesh, e.g. from Tripo) into the aquarium as the jointed
crab the critter code animates: Body, LegL0_0..LegR3_2 (hip, knee, ankle of four legs a side),
ClawL_0..ClawR_3 (arm, wrist, palm, movable finger) and EyeL/EyeR, each part a node with its
origin at its joint, all sharing one texture set. The same file serves the web version and Unity.

The mesh is cut where it leaves the carapace (an ellipse seen from above): what lies outside
falls apart into the limbs. A limb that reaches the ground is a leg (two legs touching are told
apart by their tips), one that doesn't is a claw, the two high up front are the eyes, anything
small left over stays with the body. Each limb is then cut into segments by the distance along
its surface from where it leaves the body.

    python3 tools/import_crab.py <crab.glb> [--out public/models/critters/crab.glb]

Model axes as glTF: +Y up, +Z forward (claws), the crab's left (L) at +X, standing on y = 0.
"""
import argparse, heapq, io, json, os, struct, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_fish import ROOT, read_glb, simplify, jpeg  # noqa: E402

# carapace outline seen from above (source units) and how far outside it the limbs begin
CARAPACE = dict(cx=0.0, cz=-0.015, rx=0.245, rz=0.225, k=1.15)
WIDTH = 0.42        # overall width in the aquarium, as the Blender-made crab
LEG_CUTS = (0.40, 0.72)          # knee and ankle, as fractions of the leg from its root
CLAW_CUTS = (0.30, 0.50)         # wrist and palm, as fractions of the claw from its root


def read_rm(path):
    """The metallic-roughness image of the source, if any."""
    f = open(path, "rb").read()
    n = struct.unpack("<I", f[12:16])[0]
    j = json.loads(f[20:20 + n])
    b = f[20 + n + 8:]
    t = j["materials"][0]["pbrMetallicRoughness"].get("metallicRoughnessTexture")
    if not t:
        return None
    bv = j["bufferViews"][j["images"][j["textures"][t["index"]]["source"]]["bufferView"]]
    o = bv.get("byteOffset", 0)
    return Image.open(io.BytesIO(b[o:o + bv["byteLength"]]))


class Graph:
    """Vertex adjacency with edge lengths, for distances along the surface."""

    def __init__(self, co, F):
        e = np.unique(np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), 1), axis=0)
        self.edges = e
        w = np.linalg.norm(co[e[:, 0]] - co[e[:, 1]], axis=1)
        self.adj = [[] for _ in range(len(co))]
        for (a, b), l in zip(e, w):
            self.adj[a].append((b, l))
            self.adj[b].append((a, l))

    def dist(self, sources, allowed):
        d = np.full(len(self.adj), np.inf)
        h = [(0.0, s) for s in sources]
        for s in sources:
            d[s] = 0
        while h:
            dv, v = heapq.heappop(h)
            if dv > d[v]:
                continue
            for w, l in self.adj[v]:
                if allowed[w] and dv + l < d[w]:
                    d[w] = dv + l
                    heapq.heappush(h, (d[w], w))
        return d

    def components(self, mask):
        par = np.arange(len(mask))

        def f(a):
            while par[a] != a:
                par[a] = par[par[a]]
                a = par[a]
            return a
        for a, b in self.edges[mask[self.edges[:, 0]] & mask[self.edges[:, 1]]]:
            ra, rb = f(a), f(b)
            if ra != rb:
                par[ra] = rb
        lab = np.array([f(v) if mask[v] else -1 for v in range(len(mask))])
        return [np.flatnonzero(lab == r) for r in np.unique(lab[lab >= 0])]


def ring(co, verts, f, at, width=0.04):
    """Centroid of a limb's cross-section where its fraction f crosses `at`."""
    sel = verts[np.abs(f[verts] - at) < width]
    return co[sel].mean(0) if len(sel) else co[verts].mean(0)


def segment(co, G, limb, body, cuts, claw):
    """Split one limb into its joints' parts: returns (joint positions, vertex lists)."""
    allowed = np.zeros(len(co), bool)
    allowed[limb] = True
    # where it leaves the body: limb vertices with a body neighbour
    rootv = np.array([v for v in limb if any(body[w] for w, _ in G.adj[v])])
    if not len(rootv):
        rootv = limb[np.argsort(np.linalg.norm(co[limb][:, [0, 2]], axis=1))[:10]]
    d = G.dist(list(rootv), allowed)
    f = d / d[limb].max()
    joints = [co[rootv].mean(0)] + [ring(co, limb, f, c) for c in cuts]
    parts = [limb[f[limb] < cuts[0]], limb[(f[limb] >= cuts[0]) & (f[limb] < cuts[1])], limb[f[limb] >= cuts[1]]]
    if claw:
        # the two fingertips: the farthest point, then the one farthest from both it and the root
        a = limb[np.argmax(d[limb])]
        da = G.dist([a], allowed)
        b = limb[np.argmax(np.minimum(da[limb], d[limb]))]
        db = G.dist([b], allowed)
        dac, pol, ddac, dpol = (a, b, da, db) if co[a, 1] > co[b, 1] else (b, a, db, da)
        reach = 0.5 * ddac[pol]   # fingertip to the fork
        finger = limb[(ddac[limb] < reach) & (ddac[limb] < dpol[limb])]
        hinge = finger[np.abs(ddac[finger] - reach) < 0.25 * reach]
        joints.append(co[hinge if len(hinge) else finger].mean(0))
        fin = np.zeros(len(co), bool)
        fin[finger] = True
        parts = [p[~fin[p]] for p in parts] + [finger]
    return joints, parts


def tips(co, G, limb, ground):
    """Groups of a limb's vertices touching the ground, biggest first."""
    low = np.zeros(len(co), bool)
    low[limb[co[limb, 1] < ground]] = True
    groups = sorted(G.components(low), key=len, reverse=True)
    return [g[np.argmin(co[g, 1])] for g in groups if len(g) >= 3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", default=os.path.join(ROOT, "public/models/critters/crab.glb"))
    ap.add_argument("--tris", type=int, default=24000)
    ap.add_argument("--tex", type=int, default=1024)
    a = ap.parse_args()

    P, N, UV, I, base, normal = read_glb(a.src)
    rm = read_rm(a.src)
    I = simplify(P, I, a.tris)
    used, I = np.unique(I, return_inverse=True)
    P, N, UV, I = P[used], N[used], UV[used], I.reshape(-1, 3)
    N /= np.linalg.norm(N, axis=1, keepdims=True)

    # weld texture seams so the cuts follow the surface, not the UV islands
    _, weld = np.unique(np.round(P * 1e5).astype(np.int64), axis=0, return_inverse=True)
    weld = weld.ravel()
    co = np.zeros((weld.max() + 1, 3))
    co[weld] = P
    F = weld[I]
    G = Graph(co, F)

    c = CARAPACE
    out = np.hypot((co[:, 0] - c["cx"]) / c["rx"], (co[:, 2] - c["cz"]) / c["rz"]) > c["k"]
    limbs = G.components(out)
    body = ~out
    ground = co[:, 1].min() + 0.12 * (co[:, 1].max() - co[:, 1].min())
    total = sum(len(l) for l in limbs)
    legs, claws, eyes = [], [], []
    for limb in limbs:
        t = tips(co, G, limb, ground)
        if co[limb, 1].min() > co[:, 1].min() + 0.8 * (co[:, 1].max() - co[:, 1].min()):
            eyes.append(limb)
        elif t:
            if len(t) == 1:
                legs.append(limb)
                continue
            # legs touching each other: each vertex to the nearer tip
            allowed = np.zeros(len(co), bool)
            allowed[limb] = True
            ds = np.stack([G.dist([v], allowed)[limb] for v in t[:2]])
            for k in range(2):
                legs.append(limb[np.argmin(ds, 0) == k])
        elif len(limb) > 0.05 * total:
            claws.append(limb)
        else:
            body[limb] = True   # a knob on the shell
    print(f"limbs: {len(legs)} legs, {len(claws)} claws, {len(eyes)} eyes")
    if (len(legs), len(claws), len(eyes)) != (8, 2, 2):
        sys.exit("expected 8 legs, 2 claws and 2 eyes; adjust CARAPACE")

    label = {}          # part name -> welded vertices
    joint = {"Body": np.zeros(3)}
    parent = {}
    side = lambda limb: "L" if co[limb, 0].mean() > 0 else "R"
    for sd in "LR":
        mine = [l for l in legs if side(l) == sd]
        segs = [segment(co, G, l, body, LEG_CUTS, False) for l in mine]
        segs.sort(key=lambda s: -s[0][0][2])   # front to back
        for i, (js, ps) in enumerate(segs):
            for k in range(3):
                name = f"Leg{sd}{i}_{k}"
                label[name], joint[name] = ps[k], js[k]
                parent[name] = "Body" if k == 0 else f"Leg{sd}{i}_{k - 1}"
        claw = [l for l in claws if side(l) == sd][0]
        js, ps = segment(co, G, claw, body, CLAW_CUTS, True)
        for k in range(4):
            name = f"Claw{sd}_{k}"
            label[name], joint[name] = ps[k], js[k]
            parent[name] = "Body" if k == 0 else f"Claw{sd}_{k - 1}"
        eye = [e for e in eyes if side(e) == sd][0]
        name = f"Eye{sd}"
        label[name], parent[name] = eye, "Body"
        joint[name] = co[eye[np.argsort(co[eye, 1])[:max(3, len(eye) // 10)]]].mean(0)

    names = ["Body"] + list(label)
    part = np.zeros(len(co), int)        # 0 = body
    for k, n in enumerate(names[1:], 1):
        part[label[n]] = k
    # a triangle goes to the part most of its corners belong to
    tp = part[F]
    tri_part = np.where(tp[:, 1] == tp[:, 2], tp[:, 1], tp[:, 0])

    # to the aquarium: centred on the carapace, feet on y = 0, as wide as the old crab
    lo, hi = P.min(0), P.max(0)
    S = WIDTH / (hi[0] - lo[0])
    origin = np.array([c["cx"], lo[1], c["cz"]])
    P = (P - origin) * S
    joint = {n: (v - origin) * S for n, v in joint.items()}
    joint["Body"] = np.zeros(3)

    meshes = {}
    for k, n in enumerate(names):
        tris = I[tri_part == k]
        if not len(tris):
            sys.exit(f"part {n} came out empty")
        v, t = np.unique(tris, return_inverse=True)
        meshes[n] = (P[v] - joint[n], N[v], UV[v], t.reshape(-1, 3))
        print(f"  {n:9s} {len(tris):5d} triangles, joint {np.round(joint[n], 3)}")

    tex = [jpeg(base, a.tex, 88), normal and jpeg(normal, a.tex, 92), rm and jpeg(rm, a.tex // 2, 90)]
    write(a.out, names, parent, joint, meshes, tex)
    print(f"wrote {a.out}: {os.path.getsize(a.out) // 1024} KB")


def write(path, names, parent, joint, meshes, tex, material="crab", image_prefix="crab"):
    chunks, views, accessors = [], [], []

    def add(data, target=None):
        off = sum(len(c) for c in chunks)
        chunks.append(data + b"\0" * (-len(data) % 4))
        views.append({"buffer": 0, "byteOffset": off, "byteLength": len(data), **({"target": target} if target else {})})
        return len(views) - 1

    def accessor(arr, ctype, typ, target, minmax=False):
        acc = {"bufferView": add(arr.tobytes(), target), "componentType": ctype, "count": len(arr), "type": typ}
        if minmax:
            acc["min"], acc["max"] = arr.min(0).tolist(), arr.max(0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    gl_meshes, nodes = [], []
    for n in names:
        p, nr, uv, t = meshes[n]
        it = (np.uint16, 5123) if len(p) < 65536 else (np.uint32, 5125)
        gl_meshes.append({"name": n, "primitives": [{"attributes": {
            "POSITION": accessor(p.astype(np.float32), 5126, "VEC3", 34962, True),
            "NORMAL": accessor(nr.astype(np.float32), 5126, "VEC3", 34962),
            "TEXCOORD_0": accessor(uv.astype(np.float32), 5126, "VEC2", 34962)},
            "indices": accessor(t.ravel().astype(it[0]), it[1], "SCALAR", 34963), "material": 0}]})
        nodes.append({"name": n, "mesh": len(gl_meshes) - 1})
    index = {n: k for k, n in enumerate(names)}
    for n in names[1:]:
        nodes[index[n]]["translation"] = (joint[n] - joint[parent[n]]).tolist()
        nodes[index[parent[n]]].setdefault("children", []).append(index[n])

    images, texs = [], []
    for name, data in zip((f"{image_prefix}_base", f"{image_prefix}_normal", f"{image_prefix}_rm"), tex):
        if data:
            images.append({"name": name, "bufferView": add(data), "mimeType": "image/jpeg"})
            texs.append({"sampler": 0, "source": len(images) - 1})
    pbr = {"baseColorTexture": {"index": 0}, "metallicFactor": 0.0, "roughnessFactor": 1.0}
    material = {"name": material, "pbrMetallicRoughness": pbr}
    k = 1
    if tex[1]:
        material["normalTexture"] = {"index": k}
        k += 1
    if tex[2]:
        pbr["metallicRoughnessTexture"] = {"index": k}
    gltf = {
        "asset": {"version": "2.0", "generator": "aqua tools/import_crab.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": nodes, "meshes": gl_meshes, "materials": [material],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "textures": texs, "images": images, "accessors": accessors, "bufferViews": views,
    }
    binary = b"".join(chunks)
    gltf["buffers"] = [{"byteLength": len(binary)}]
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    data = struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(binary))
    data += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(binary), 0x004E4942) + binary
    open(path, "wb").write(data)


if __name__ == "__main__":
    main()
