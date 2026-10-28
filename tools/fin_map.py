"""Mark the fins of a sculpted fish model (a lone Body with solid fins, from tools/import_fish.py
or the Unity version's Tools/tripo_fish.py), so the swim shader can move each fin its own way.

A fin is a thin plate: at a fin vertex the surface facing the other way lies close behind it,
at a body vertex it is the far side of the trunk. Thin regions are flooded outwards from where
they leave the body; the distance travelled is the fin's u (0 at the root, 1 at the rim) and the
body point it started from tells which fin it is: behind the caudal peduncle the tail, on top
the dorsal fin, on the side up front a pectoral, under the belly a pelvic fin ahead and the
anal fin behind. A model whose pectorals are nodes of their own (Unity) keeps the stumps they
were cut from as body.

The result goes into the Body's TEXCOORD_1.x as type + 0.98 u (one component, as glTFast flips
the second): 0 body, 1 caudal, 2 dorsal, 3 anal, 4 pelvic, 5 pectoral.

    python3 tools/fin_map.py public/models/fish/*.glb
"""
import heapq, json, os, struct, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BODY, CAUDAL, DORSAL, ANAL, PELVIC, PECT = range(6)
THIN = 0.05          # a fin is thinner than this, in body lengths
PEDUNCLE = -0.47     # where the shader hinges the tail, in body lengths from the middle


def species_len(key):
    data = json.load(open(os.path.join(ROOT, "tools/blender/species.json")))
    return data[os.path.basename(key).split(".")[0].split("-")[0]]["L"]


class Glb:
    def __init__(self, path):
        f = open(path, "rb").read()
        n = struct.unpack("<I", f[12:16])[0]
        self.json = json.loads(f[20:20 + n])
        m = 20 + n
        self.bin = bytearray(f[m + 8:m + 8 + struct.unpack("<I", f[m:m + 4])[0]])

    def accessor(self, i):
        j = self.json
        a = j["accessors"][i]
        bv = j["bufferViews"][a["bufferView"]]
        comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
        dt = np.dtype({5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a["componentType"]])
        o = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride", comps * dt.itemsize)
        raw = np.frombuffer(self.bin, np.uint8, (a["count"] - 1) * stride + comps * dt.itemsize, o)
        rows = np.lib.stride_tricks.as_strided(raw, (a["count"], comps * dt.itemsize), (stride, 1))
        return np.ascontiguousarray(rows).view(dt).reshape(a["count"], comps)

    def add_vec2(self, data):
        j = self.json
        self.bin += b"\0" * (-len(self.bin) % 4)
        off = len(self.bin)
        data = data.astype(np.float32)
        self.bin += data.tobytes()
        j["bufferViews"].append({"buffer": 0, "byteOffset": off, "byteLength": data.nbytes, "target": 34962})
        j["accessors"].append({"bufferView": len(j["bufferViews"]) - 1, "componentType": 5126, "count": len(data), "type": "VEC2"})
        j["buffers"][0]["byteLength"] = len(self.bin)
        return len(j["accessors"]) - 1

    def save(self, path):
        js = json.dumps(self.json, separators=(",", ":")).encode()
        js += b" " * (-len(js) % 4)
        self.bin += b"\0" * (-len(self.bin) % 4)
        out = struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(self.bin))
        out += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(self.bin), 0x004E4942) + bytes(self.bin)
        open(path, "wb").write(out)


def thickness(co, nrm, cut):
    """Distance from each vertex to the nearest vertex behind it whose surface faces the other way."""
    order = np.argsort(co[:, 2])
    zs = co[order, 2]
    t = np.full(len(co), np.inf)
    for s in range(0, len(co), 512):
        idx = order[s:s + 512]
        lo, hi = np.searchsorted(zs, co[idx, 2].min() - cut), np.searchsorted(zs, co[idx, 2].max() + cut)
        cand = order[lo:hi]
        d = co[cand][None] - co[idx][:, None]
        dist = np.linalg.norm(d, axis=2)
        behind = np.einsum("cnk,ck->cn", d, nrm[idx]) < -0.3 * dist
        facing = nrm[idx] @ nrm[cand].T < -0.2
        t[idx] = np.where(behind & facing & (dist < cut), dist, np.inf).min(1)
    return t


def body_profile(co, body, L):
    """Half-width, top and bottom of the trunk (fins left out) along its length."""
    z = co[body, 2]
    edges = np.linspace(z.min(), z.max(), 31)
    mids = (edges[:-1] + edges[1:]) / 2
    rows = []
    for a, b in zip(edges[:-1], edges[1:]):
        s = co[body][(z >= a) & (z < b)]
        rows.append((np.quantile(np.abs(s[:, 0]), 0.95), np.quantile(s[:, 1], 0.98), np.quantile(s[:, 1], 0.02)) if len(s) > 5 else (np.nan,) * 3)
    rows = np.array(rows)
    for k in range(3):
        ok = ~np.isnan(rows[:, k])
        rows[~ok, k] = np.interp(mids[~ok], mids[ok], rows[ok, k])
    return lambda q, k: np.interp(q, mids, rows[:, k])


def classify(P, I, L, pivots=()):
    _, weld = np.unique(np.round(P * 1e5).astype(np.int64), axis=0, return_inverse=True)
    weld = weld.ravel()
    co = np.zeros((weld.max() + 1, 3))
    co[weld] = P
    F = weld[I]
    nrm = np.zeros_like(co)
    fn = np.cross(co[F[:, 1]] - co[F[:, 0]], co[F[:, 2]] - co[F[:, 0]])
    for k in range(3):
        np.add.at(nrm, F[:, k], fn)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)

    fin = thickness(co, nrm, 0.2 * L) < THIN * L
    e = np.unique(np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), 1), axis=0)
    w = np.linalg.norm(co[e[:, 0]] - co[e[:, 1]], axis=1)
    adj = [[] for _ in co]
    for (a, b), l in zip(e, w):
        adj[a].append((b, l))
        adj[b].append((a, l))

    # small thin islands on the body (eye rims, gill folds) are body
    seen = np.zeros(len(co), bool)
    for s in np.flatnonzero(fin):
        if seen[s]:
            continue
        comp, k = [s], 0
        seen[s] = True
        while k < len(comp):
            for v, _ in adj[comp[k]]:
                if fin[v] and not seen[v]:
                    seen[v] = True
                    comp.append(v)
            k += 1
        if len(comp) < 0.004 * len(co):
            fin[comp] = False

    # flood the fins from where they leave the body
    d = np.full(len(co), np.inf)
    root = np.full(len(co), -1)
    h = []
    for v in np.flatnonzero(~fin):
        if any(fin[u] for u, _ in adj[v]):
            d[v], root[v] = 0, v
            h.append((0.0, v))
    heapq.heapify(h)
    while h:
        dv, v = heapq.heappop(h)
        if dv > d[v]:
            continue
        for u, l in adj[v]:
            if fin[u] and dv + l < d[u]:
                d[u], root[u] = dv + l, root[v]
                heapq.heappush(h, (d[u], u))

    prof = body_profile(co, ~fin, L)
    f = fin & (root >= 0)
    R = co[root[f]]
    hw, top, bot = prof(R[:, 2], 0), prof(R[:, 2], 1), prof(R[:, 2], 2)
    side = (np.abs(R[:, 0]) > 0.55 * hw) & (R[:, 1] > bot + 0.3 * (top - bot)) & (R[:, 2] > -0.25 * L)
    typ = np.zeros(len(co), int)
    typ[f] = np.where(R[:, 2] < (PEDUNCLE + 0.06) * L, CAUDAL,
                      np.where(side, PECT,
                               np.where(R[:, 1] > (top + bot) / 2, DORSAL,
                                        np.where(R[:, 2] > -0.12 * L, PELVIC, ANAL))))
    # pectorals that are nodes of their own leave a stump on the body: body too
    for pv in pivots:
        near = f.copy()
        near[f] = np.linalg.norm(R - pv, axis=1) < 0.08 * L
        typ[near] = BODY
    if len(pivots):
        typ[typ == PECT] = BODY
    u = np.zeros(len(co))
    for k in (CAUDAL, DORSAL, ANAL, PELVIC, PECT):
        m = typ == k
        if m.any():
            u[m] = d[m] / max(np.quantile(d[m], 0.98), 1e-6)
    return typ[weld], np.clip(u, 0, 1)[weld]


def mark(path):
    g = Glb(path)
    j = g.json
    names = {n.get("name") for n in j["nodes"]}
    if "Fins" in names:
        print(f"{path}: has a fin mesh of its own, left as it is")
        return
    node = next(n for n in j["nodes"] if n.get("name") == "Body")
    prim = j["meshes"][node["mesh"]]["primitives"][0]
    P = g.accessor(prim["attributes"]["POSITION"]).astype(float)
    I = g.accessor(prim["indices"]).reshape(-1, 3).astype(np.int64)
    body_at = np.array(node.get("translation", [0, 0, 0]))
    pivots = [np.array(n.get("translation", [0, 0, 0])) - body_at for n in j["nodes"] if n.get("name") in ("PectL", "PectR")]
    typ, u = classify(P, I, species_len(path), pivots)
    code = np.stack([typ + 0.98 * u, np.zeros(len(u))], 1)
    prim["attributes"]["TEXCOORD_1"] = g.add_vec2(code)
    g.save(path)
    counts = np.bincount(typ, minlength=6)
    print(f"{path}: " + ", ".join(f"{n} {c}" for n, c in zip(("body", "caudal", "dorsal", "anal", "pelvic", "pectoral"), counts)))


if __name__ == "__main__":
    for p in sys.argv[1:]:
        mark(p)
