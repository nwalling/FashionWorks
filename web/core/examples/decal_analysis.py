"""What an armour mesh's vertex colour holds, and whether it maps into the
decal atlas. RENDERING.md Phase 6.

Reads a dump from `decal_probe` and the piece's `TexSlot9` atlas as a PNG, and
prints every figure the Phase 6 write-up quotes:

* what the colour is on ordinary geometry -- per-island constants: A against
  the submaterial index, B against the island's V;
* the decal patches -- small islands whose colour varies across them -- their
  count and size, how exactly R*256+G and B are linear over the surface, the
  angle between them and their scales, and how far they sit off the plates;
* every candidate decoding into the atlas, scored as the share of the patches'
  atlas footprint that lands on decal content (alpha > 0.5), against the
  atlas's own coverage and against the same patches placed at random.

    cargo run --example decal_probe --release -- <piece.skinm> mesh.json
    extract/.venv/bin/python web/core/examples/decal_analysis.py mesh.json atlas.png
"""

import json
import sys

import numpy as np
from PIL import Image, ImageDraw


def islands(n: int, tris: np.ndarray) -> np.ndarray:
    parent = np.arange(n)

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, c in tris:
        ra = find(a)
        parent[find(b)] = ra
        parent[find(c)] = ra
    roots = np.array([find(i) for i in range(n)])
    return np.unique(roots, return_inverse=True)[1]


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra = np.argsort(np.argsort(a))
    rb = np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def main() -> None:
    mesh = json.load(open(sys.argv[1]))
    atlas = np.asarray(Image.open(sys.argv[2]).convert("RGBA")).astype(float)
    H, W = atlas.shape[:2]
    content = atlas[..., 3] / 255 > 0.5
    chance = content.mean()

    uv = np.array(mesh["uvs"], float)
    col = np.array(mesh["colors"], int)
    pos = np.array(mesh["positions"], float)
    tris = np.array(mesh["indices"]).reshape(-1, 3)
    R, G, B, A = col.T
    material = np.full(len(col), -1)
    for s in mesh["submeshes"]:
        material[tris[s["first"] // 3 : (s["first"] + s["count"]) // 3].ravel()] = s["material"]
    inv = islands(len(col), tris)
    size = np.bincount(inv)
    K = inv.max() + 1

    print(f"{len(col)} vertices, {len(tris)} triangles, {K} islands; second UV set: {mesh['secondary_uvs']}")

    # Ordinary geometry: what is constant per island, and what it tracks.
    pairs = sorted({(int(m), int(a)) for m, a in zip(material, A) if m >= 0})
    exact = all(a == 255 - m for m, a in pairs)
    print(f"A per submaterial: {pairs} -> A = 255 - index: {exact}")
    patch = np.zeros(K, bool)
    for k in range(K):
        if size[k] <= 40 and (R[inv == k] >= 162).any():
            patch[k] = True
    ordinary = [k for k in range(K) if not patch[k] and size[k] >= 10]
    med = np.array([np.median(col[inv == k], 0) for k in ordinary])
    v_mean = np.array([uv[inv == k, 1].mean() for k in ordinary])
    constant = np.mean([np.ptp(col[inv == k, 3]) == 0 and np.ptp(col[inv == k, 1]) == 0 for k in ordinary])
    print(
        f"ordinary islands (>= 10 vertices): {len(ordinary)}; G and A constant across the island on {constant:.0%}; "
        f"R in 160-161 on {np.mean((med[:, 0] >= 160) & (med[:, 0] <= 161)):.0%}; "
        f"G = 16i + 5 on {np.mean(col[:, 1] % 16 == 5):.1%} of vertices; "
        f"B against island V, Spearman {spearman(med[:, 2], v_mean):.2f}"
    )

    # Decal patches.
    ks = np.where(patch)[0]
    u16 = R * 256 + G
    residual_u, residual_b, angles, ratio, lift = [], [], [], [], []
    others = tris[~patch[inv][tris].any(1)]
    rng = np.random.default_rng(0)
    w = rng.dirichlet([1, 1, 1], size=(len(others), 24))
    surface = (
        w[..., :1] * pos[others[:, 0]][:, None]
        + w[..., 1:2] * pos[others[:, 1]][:, None]
        + w[..., 2:] * pos[others[:, 2]][:, None]
    ).reshape(-1, 3)
    for k in ks:
        m = inv == k
        P = pos[m] - pos[m].mean(0)
        X = np.c_[P, np.ones(m.sum())]
        cu, *_ = np.linalg.lstsq(X, u16[m].astype(float), rcond=None)
        cb, *_ = np.linalg.lstsq(X, B[m].astype(float), rcond=None)
        residual_u.append(np.sqrt(np.mean((u16[m] - X @ cu) ** 2)))
        residual_b.append(np.sqrt(np.mean((B[m] - X @ cb) ** 2)))
        gu, gb = cu[:3], cb[:3]
        if np.linalg.norm(gu) > 0 and np.linalg.norm(gb) > 0:
            angles.append(np.degrees(np.arccos(min(1.0, abs(gu @ gb) / (np.linalg.norm(gu) * np.linalg.norm(gb))))))
            ratio.append((np.linalg.norm(gu) / 65536) / (np.linalg.norm(gb) / 255))
        near = surface[np.linalg.norm(surface - pos[m].mean(0), axis=1) < 0.06]
        if len(near):
            d = np.sqrt(((pos[m][:, None, :] - near[None]) ** 2).sum(-1)).min(1)
            lift.append(np.median(d) * 1000)
    print(
        f"decal patches: {len(ks)}, {sorted(size[ks].tolist())} vertices; "
        f"R*256+G linear to {np.median(residual_u):.1f}/65536 and B to {np.median(residual_b):.2f}/255 (median residual); "
        f"angle between them {np.median(angles):.0f} degrees; scale ratio (R*256+G)/65536 to B/255 {np.median(ratio):.3f}; "
        f"off the plates {np.median(lift):.1f} mm median ({min(lift):.1f}-{max(lift):.1f})"
    )

    # Decodings into the atlas.
    def footprint(u: np.ndarray, v: np.ndarray, patch_tris: list) -> np.ndarray:
        img = Image.new("L", (W, H), 0)
        draw = ImageDraw.Draw(img)
        for t in patch_tris:
            draw.polygon([(u[i] * W, v[i] * H) for i in t], fill=255)
        return np.asarray(img) > 0

    by_patch = [tris[(inv[tris] == k).all(1)] for k in ks]
    u12 = ((R & 15) * 256 + G) / 4096
    decodings = {
        "(R, B)/255": (R / 255, B / 255),
        "(B, R)/255": (B / 255, R / 255),
        "(R, G)/255": (R / 255, G / 255),
        "(G, B)/255": (G / 255, B / 255),
        "(R*256+G)/65536, B/255": (u16 / 65536, B / 255),
        "B/255, (R*256+G)/65536": (B / 255, u16 / 65536),
        "12-bit (R&15)*256+G, B/255": (u12, B / 255),
        "B/255, 12-bit (R&15)*256+G": (B / 255, u12),
    }
    print(f"atlas content (alpha > 0.5): {chance:.3f} of the square")
    for name, (du, dv) in decodings.items():
        for flip in (False, True):
            v = 1 - dv if flip else dv
            real = np.mean([content[fp].mean() if (fp := footprint(du, v, t)).any() else 0 for t in by_patch])
            null = []
            for _ in range(10):
                shifts = rng.random((len(ks), 2))
                null.append(
                    np.mean(
                        [
                            content[fp].mean() if (fp := footprint((du + s[0]) % 1, (v + s[1]) % 1, t)).any() else 0
                            for t, s in zip(by_patch, shifts)
                        ]
                    )
                )
            print(
                f"  {name:30s} {'flipped' if flip else '       '}  content under patches {real:.2f} "
                f"({real / chance:.1f}x chance), randomly placed {np.mean(null):.2f} +- {np.std(null):.2f}"
            )


if __name__ == "__main__":
    main()
