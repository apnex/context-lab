#!/usr/bin/env python3
"""An independent implementation of Delta-2 section 1's threshold deriver, written from the plan's
text, for criterion F11. It shares no code with packages/core: it reads a table of known outcomes
per cell run as JSON on stdin and writes the thresholds, the two-stage rate and the drift rank.

Input:  {"hash": str, "base": str, "head": str, "population": [str], "properties": [{"scenario", "id"}],
         "cells": [{"scenario", "arm", "member", "run", "values": {property: fraction or null}}]}
        - cells are the present cell runs only; values already fractions of each property's scale.
Output: {"3": float, "9": float, "twoStageRate": float, "drift": {"actual", "below", "of"}}
        or {"refused": reason}.

The generator is the one the blinder uses (mulberry32, its state the first 32 bits of the seed's
SHA-256), seeded "<hash>:<k>", one stream per size, consumed split by split and, within a split,
pool by pool in order of scenario then member; each pool, ordered by arm then run, is shuffled by
Fisher-Yates from the last place down.
"""
import hashlib
import json
import math
import sys

M = 0xFFFFFFFF


def generator(seed):
    state = [int(hashlib.sha256(seed.encode()).hexdigest()[:8], 16)]

    def nxt():
        state[0] = (state[0] + 0x6D2B79F5) & M
        t = state[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & M
        t = (t ^ ((t + (((t ^ (t >> 7)) * (t | 61)) & M)) & M)) & M
        return ((t ^ (t >> 14)) & M) / 4294967296

    return nxt


def shuffled(xs, rand):
    a = list(xs)
    for i in range(len(a) - 1, 0, -1):
        j = math.floor(rand() * (i + 1))
        a[i], a[j] = a[j], a[i]
    return a


def drop(a, b):
    if not a or not b:
        return 0.0
    p = (sum(a) + sum(b)) / (len(a) + len(b))
    if p <= 0 or p >= 1:
        return 0.0
    return (sum(a) / len(a) - sum(b) / len(b)) / math.sqrt(p * (1 - p) * (1 / len(a) + 1 / len(b)))


def vals(cells, prop):
    return [c["values"][prop["id"]] for c in cells if c["scenario"] == prop["scenario"] and c["values"].get(prop["id"]) is not None]


def main():
    d = json.load(sys.stdin)
    props = d["properties"]
    scenarios = sorted({p["scenario"] for p in props})
    pools = []
    for s in scenarios:
        for m in sorted(d["population"]):
            runs = [c for c in d["cells"] if c["scenario"] == s and c["member"] == m and c["arm"] in (d["base"], d["head"])]
            runs.sort(key=lambda c: (c["arm"], c["run"]))
            pools.append(runs)
    if any(len(p) < 12 for p in pools):
        print(json.dumps({"refused": "a pool has fewer than twelve present runs"}))
        return

    def largest(a, b):
        return max(drop(vals(a, p), vals(b, p)) for p in props)

    def draw(k):
        rand = generator(f"{d['hash']}:{k}")
        out = []
        for _ in range(1000):
            A, B, A3, B3 = [], [], [], []
            for pool in pools:
                sh = shuffled(pool, rand)
                kk = min(k, len(pool) // 2)
                a, b = sh[:kk], sh[kk:2 * kk]
                A += a
                B += b
                A3 += a[:min(3, kk)]
                B3 += b[:min(3, kk)]
            out.append((A, B, A3, B3))
        return out

    s3 = sorted(largest(a, b) for a, b, _, _ in draw(3))
    nine = draw(9)
    m9 = [largest(a, b) for a, b, _, _ in nine]
    t3, t9 = s3[899], sorted(m9)[899]
    persisting = sum(1 for a, b, a3, b3 in nine if any(drop(vals(a3, p), vals(b3, p)) > t3 and drop(vals(a, p), vals(b, p)) > t9 for p in props))
    base = [c for c in d["cells"] if c["arm"] == d["base"]]
    head = [c for c in d["cells"] if c["arm"] == d["head"]]
    actual = largest(base, head)
    print(json.dumps({"3": t3, "9": t9, "twoStageRate": persisting / 1000, "drift": {"actual": actual, "below": sum(1 for x in m9 if x < actual), "of": 1000}}))


main()
