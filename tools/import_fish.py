"""Bring a ready-made fish model (one textured mesh, e.g. from Tripo) into the aquarium.

The model is turned to swim along +Z with +Y up, scaled so the nose sits at +L/2 and the
caudal peduncle at -0.47 L (where the swim shader hinges the tail), simplified with
meshoptimizer and written as a GLB with a single "Body" mesh: the eyes and fins stay painted
in its own texture, so the aquarium adds no cartoon eyes and no separate fins.

    python3 tools/import_fish.py <model.glb> <species> --nose +x --peduncle 0.564

--nose      which axis of the source model the head points along
--up        which axis is up (-z for a model sculpted belly up, as some Blender exports are)
--variants  colour variants, one GLB each (<species>-<k>.glb): the texture's hue turned so that
            --ref (the model's own colour) becomes each variant's
--peduncle  where the tail starts, as a fraction of the model's length counted from the nose
--tris      triangle budget after simplification (default 20000)
--tex       texture size (default 1024)
--straighten  pull a tail sculpted bent to one side back into line
"""
import argparse, colorsys, io, json, os, struct, subprocess, sys, tempfile
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SIMPLIFY_JS = """
import { readFileSync, writeFileSync } from 'node:fs';
import { MeshoptSimplifier as S } from 'meshoptimizer';
const [pos, idx, out, target] = process.argv.slice(1);
await S.ready;
const P = new Float32Array(readFileSync(pos).buffer.slice(0));
const I = new Uint32Array(readFileSync(idx).buffer.slice(0));
const [res, err] = S.simplify(I, P, 3, +target, 0.01, []);
writeFileSync(out, Buffer.from(res.buffer, res.byteOffset, res.byteLength));
console.log(`simplified ${I.length / 3} -> ${res.length / 3} triangles, error ${err.toFixed(5)}`);
"""


def species_len(sp):
    data = json.load(open(os.path.join(ROOT, "tools/blender/species.json")))
    return data[sp]["L"]


def read_glb(path):
    f = open(path, "rb").read()
    n = struct.unpack("<I", f[12:16])[0]
    j = json.loads(f[20:20 + n])
    b = f[20 + n + 8:]

    def view(i):
        bv = j["bufferViews"][i]
        o = bv.get("byteOffset", 0)
        return b[o:o + bv["byteLength"]]

    def acc(i):
        a = j["accessors"][i]
        comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[a["type"]]
        dt = {5126: np.float32, 5125: np.uint32, 5123: np.uint16}[a["componentType"]]
        bv = j["bufferViews"][a["bufferView"]]
        o = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        arr = np.frombuffer(b, dt, a["count"] * comps, o)
        return arr.reshape(-1, comps) if comps > 1 else arr

    prim = j["meshes"][0]["primitives"][0]
    at = prim["attributes"]
    mat = j["materials"][prim["material"]]
    img = lambda t: Image.open(io.BytesIO(view(j["images"][j["textures"][t["index"]]["source"]]["bufferView"])))
    base = img(mat["pbrMetallicRoughness"]["baseColorTexture"])
    normal = img(mat["normalTexture"]) if "normalTexture" in mat else None
    return (acc(at["POSITION"]).astype(np.float64), acc(at["NORMAL"]).astype(np.float64),
            acc(at["TEXCOORD_0"]).copy(), acc(prim["indices"]).astype(np.uint32), base, normal)


def orient(P, N, nose, up):
    """Stand the model up (+Y), then rotate about Y so the head points along +Z (keeps handedness)."""
    if up == "-z":   # a quarter turn about X: (x, y, z) -> (x, -z, y)
        U = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)
        P, N = P @ U.T, N @ U.T
    sign, axis = (1 if nose[0] == "+" else -1), nose[1]
    if axis == "x":   # (x, y, z) -> (-z, y, x), then flip if the head was on -X
        R = np.array([[0, 0, -1], [0, 1, 0], [1, 0, 0]], float)
    else:
        R = np.eye(3)
    if sign < 0:
        R = np.diag([-1, 1, -1]) @ R
    return P @ R.T, N @ R.T


def simplify(P, I, tris):
    with tempfile.TemporaryDirectory() as d:
        paths = [os.path.join(d, n) for n in ("pos.bin", "idx.bin", "out.bin")]
        P.astype(np.float32).tofile(paths[0])
        I.astype(np.uint32).tofile(paths[1])
        subprocess.run(["node", "--input-type=module", "-e", SIMPLIFY_JS, *paths, str(tris * 3)],
                       check=True, cwd=ROOT)
        return np.fromfile(paths[2], np.uint32)


def hue_turned(rgb, turn):
    """rgb (h, w, 3) floats with every hue turned by `turn` (0..1); greys stay grey."""
    mx, mn = rgb.max(-1), rgb.min(-1)
    d = mx - mn
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    dd = np.maximum(d, 1e-6)
    h = np.where(mx == r, (g - b) / dd % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) / 6
    h = (h + turn) % 1.0
    i = np.floor(h * 6).astype(int) % 6
    f = h * 6 - np.floor(h * 6)
    p, q, t = mx * (1 - s), mx * (1 - s * f), mx * (1 - s * (1 - f))
    sel = [i == k for k in range(6)]
    return np.stack([np.select(sel, c) for c in ((mx, q, p, p, t, mx), (t, mx, mx, q, p, p), (p, p, t, mx, mx, q))], -1)


def hue(hexs):
    return colorsys.rgb_to_hsv(*(int(hexs[i:i + 2], 16) / 255 for i in (1, 3, 5)))[0]


def jpeg(im, size, quality):
    buf = io.BytesIO()
    im.convert("RGB").resize((size, size), Image.LANCZOS).save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def write_glb(path, P, N, UV, I, base_jpg, normal_jpg):
    idx_type = (np.uint16, 5123) if len(P) < 65536 else (np.uint32, 5125)
    chunks, views, accessors = [], [], []

    def add(data, target=None):
        off = sum(len(c) for c in chunks)
        chunks.append(data + b"\0" * (-len(data) % 4))
        views.append({"buffer": 0, "byteOffset": off, "byteLength": len(data), **({"target": target} if target else {})})
        return len(views) - 1

    def accessor(arr, ctype, typ, target, minmax=False):
        a = {"bufferView": add(arr.tobytes(), target), "componentType": ctype, "count": len(arr), "type": typ}
        if minmax:
            a["min"], a["max"] = arr.min(0).tolist(), arr.max(0).tolist()
        accessors.append(a)
        return len(accessors) - 1

    pos = accessor(P.astype(np.float32), 5126, "VEC3", 34962, True)
    nrm = accessor(N.astype(np.float32), 5126, "VEC3", 34962)
    uv = accessor(UV.astype(np.float32), 5126, "VEC2", 34962)
    ind = accessor(I.astype(idx_type[0]), idx_type[1], "SCALAR", 34963)
    images = [{"bufferView": add(base_jpg), "mimeType": "image/jpeg"}]
    material = {"name": "Body", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0.0, "roughnessFactor": 0.4}}
    if normal_jpg:
        images.append({"bufferView": add(normal_jpg), "mimeType": "image/jpeg"})
        material["normalTexture"] = {"index": 1}
    gltf = {
        "asset": {"version": "2.0", "generator": "aqua tools/import_fish.py"},
        "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "Body", "mesh": 0}],
        "meshes": [{"name": "Body", "primitives": [{"attributes": {"POSITION": pos, "NORMAL": nrm, "TEXCOORD_0": uv}, "indices": ind, "material": 0}]}],
        "materials": [material],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "textures": [{"sampler": 0, "source": k} for k in range(len(images))],
        "images": images,
        "accessors": accessors, "bufferViews": views,
    }
    binary = b"".join(chunks)
    gltf["buffers"] = [{"byteLength": len(binary)}]
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    out = struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(binary))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(binary), 0x004E4942) + binary
    open(path, "wb").write(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("species")
    ap.add_argument("--nose", default="+x", choices=["+x", "-x", "+z", "-z"])
    ap.add_argument("--up", default="+y", choices=["+y", "-z"])
    ap.add_argument("--ref", default=None)
    ap.add_argument("--variants", nargs="*", default=None)
    ap.add_argument("--peduncle", type=float, required=True)
    ap.add_argument("--straighten", action="store_true")
    ap.add_argument("--tris", type=int, default=20000)
    ap.add_argument("--tex", type=int, default=1024)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    P, N, UV, I, base, normal = read_glb(a.src)
    P, N = orient(P, N, a.nose, a.up)
    if a.straighten:
        # a sculpt whose tail is bent to one side: the middle of each slice along the body back onto x = 0
        edges = np.arange(P[:, 2].min(), P[:, 2].max() + 0.02, 0.02)
        mids, centers = [], []
        for z0, z1 in zip(edges[:-1], edges[1:]):
            sl = P[(P[:, 2] >= z0) & (P[:, 2] < z1)]
            if len(sl):
                mids.append((z0 + z1) / 2)
                centers.append(sl[:, 0].mean())
        centers = np.convolve(np.pad(centers, 2, mode="edge"), np.ones(5) / 5, mode="valid")
        P = P.copy()
        P[:, 0] -= np.interp(P[:, 2], mids, centers)
    lo, hi = P.min(0), P.max(0)
    nose_z = hi[2]
    ped_z = hi[2] - a.peduncle * (hi[2] - lo[2])
    L = species_len(a.species)
    s = 0.97 * L / (nose_z - ped_z)
    # centre on the trunk (between peduncle and nose), not on the fins' bounding box
    trunk = P[P[:, 2] > ped_z]
    center = np.array([(lo[0] + hi[0]) / 2, np.median(trunk[:, 1]), nose_z])
    P = (P - center) * s + np.array([0, 0, L / 2])

    I = simplify(P, I, a.tris)
    used, I = np.unique(I, return_inverse=True)
    P, N, UV = P[used], N[used], UV[used]
    N /= np.linalg.norm(N, axis=1, keepdims=True)

    normal_jpg = normal and jpeg(normal, a.tex, 92)
    base = base.convert("RGB").resize((a.tex, a.tex), Image.LANCZOS)
    ext = P.max(0) - P.min(0)
    for k, col in enumerate(a.variants or [None]):
        img = base
        if col and col != a.ref:
            px = hue_turned(np.asarray(base, np.float32) / 255, hue(col) - hue(a.ref))
            img = Image.fromarray((px * 255 + 0.5).clip(0, 255).astype(np.uint8))
        name = f"{a.species}-{k}" if col else a.species
        out = a.out or os.path.join(ROOT, "public/models/fish", name + ".glb")
        write_glb(out, P, N, UV, I, jpeg(img, a.tex, 88), normal_jpg)
        print(f"wrote {out}: {len(P)} vertices, {len(I) // 3} triangles, {os.path.getsize(out) // 1024} KB, "
              f"size {ext[0]:.2f} x {ext[1]:.2f} x {ext[2]:.2f}")


if __name__ == "__main__":
    sys.exit(main())
