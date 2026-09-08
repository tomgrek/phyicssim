// ---------------------------------------------------------------------------
// Catmull-Clark subdivision
// ---------------------------------------------------------------------------
//
// The answer to "how do I get a curve out of a grid". The tempting answer is a
// finer grid, and it is the wrong one: a smooth shoulder at a 1 mm step is
// thousands of vertices placed by hand, and the result is still faceted at the
// distance anybody looks at it from.
//
// So the grid stays coarse and the curvature comes from here. A cage of a few
// dozen quads, subdivided twice, reads as smooth from any distance while
// remaining editable as the few dozen quads it actually is — which is why box
// modelling outlived every tool that tried to replace it.
//
// Quads matter. Catmull-Clark on triangles works, but every original triangle
// corner becomes an extraordinary vertex, and a surface full of those ripples
// visibly under a light. utils/latticeMesh.ts keeps quads as quads for exactly
// this step.
//
// Boundaries are subdivided as curves rather than pulled towards the interior,
// so an open cage keeps its outline instead of shrinking away from it — an
// open surface is a normal thing to be halfway through making here.
// ---------------------------------------------------------------------------

export interface PolyMesh {
  /** xyz per vertex. */
  positions: number[];
  /** Vertex indices per face, any number of corners, consistently wound. */
  faces: number[][];
}

const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

interface EdgeRecord {
  a: number;
  b: number;
  faces: number[];
}

function subdivideOnce(mesh: PolyMesh): PolyMesh {
  const { positions, faces } = mesh;
  const at = (v: number): [number, number, number] => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];

  // --- face points -------------------------------------------------------
  const facePoints: [number, number, number][] = faces.map((face) => {
    let x = 0, y = 0, z = 0;
    for (const v of face) {
      const p = at(v);
      x += p[0]; y += p[1]; z += p[2];
    }
    return [x / face.length, y / face.length, z / face.length];
  });

  // --- edges -------------------------------------------------------------
  const edges = new Map<string, EdgeRecord>();
  faces.forEach((face, f) => {
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const k = edgeKey(a, b);
      const found = edges.get(k);
      if (found) found.faces.push(f);
      else edges.set(k, { a, b, faces: [f] });
    }
  });

  const out: number[] = [];
  const push = (p: [number, number, number]) => {
    out.push(p[0], p[1], p[2]);
    return out.length / 3 - 1;
  };

  // --- edge points -------------------------------------------------------
  const edgePointIndex = new Map<string, number>();
  for (const [k, edge] of edges) {
    const pa = at(edge.a);
    const pb = at(edge.b);
    if (edge.faces.length === 2) {
      const f1 = facePoints[edge.faces[0]];
      const f2 = facePoints[edge.faces[1]];
      edgePointIndex.set(k, push([
        (pa[0] + pb[0] + f1[0] + f2[0]) / 4,
        (pa[1] + pb[1] + f1[1] + f2[1]) / 4,
        (pa[2] + pb[2] + f1[2] + f2[2]) / 4,
      ]));
    } else {
      // A boundary edge (or a non-manifold one, treated the same): the midpoint,
      // which is what makes the border behave like a subdivided curve.
      edgePointIndex.set(k, push([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]));
    }
  }

  // --- moved original vertices ------------------------------------------
  const vertexCount = positions.length / 3;
  const incidentFaces: number[][] = Array.from({ length: vertexCount }, () => []);
  faces.forEach((face, f) => {
    for (const v of face) incidentFaces[v].push(f);
  });
  const incidentEdges: EdgeRecord[][] = Array.from({ length: vertexCount }, () => []);
  for (const edge of edges.values()) {
    incidentEdges[edge.a].push(edge);
    incidentEdges[edge.b].push(edge);
  }

  const movedIndex: number[] = new Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const p = at(v);
    const around = incidentEdges[v];
    const boundary = around.filter((e) => e.faces.length !== 2);

    if (around.length === 0) {
      // An orphan. Nothing references it, but dropping it here would shift every
      // index; it is carried through and falls out of the next compaction.
      movedIndex[v] = push(p);
      continue;
    }

    if (boundary.length > 0) {
      if (boundary.length !== 2) {
        // A corner where three or more borders meet has no well-defined crease
        // to run along, so it is pinned. Pinning is the conservative choice:
        // it keeps a sharp corner sharp instead of melting it in an arbitrary
        // direction.
        movedIndex[v] = push(p);
        continue;
      }
      const midpoints = boundary.map((e) => {
        const other = e.a === v ? e.b : e.a;
        const q = at(other);
        return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2] as [number, number, number];
      });
      movedIndex[v] = push([
        (midpoints[0][0] + midpoints[1][0] + 6 * p[0]) / 8,
        (midpoints[0][1] + midpoints[1][1] + 6 * p[1]) / 8,
        (midpoints[0][2] + midpoints[1][2] + 6 * p[2]) / 8,
      ]);
      continue;
    }

    const n = incidentFaces[v].length;
    let fx = 0, fy = 0, fz = 0;
    for (const f of incidentFaces[v]) {
      fx += facePoints[f][0]; fy += facePoints[f][1]; fz += facePoints[f][2];
    }
    fx /= n; fy /= n; fz /= n;

    let rx = 0, ry = 0, rz = 0;
    for (const e of around) {
      const other = e.a === v ? e.b : e.a;
      const q = at(other);
      rx += (p[0] + q[0]) / 2; ry += (p[1] + q[1]) / 2; rz += (p[2] + q[2]) / 2;
    }
    rx /= around.length; ry /= around.length; rz /= around.length;

    movedIndex[v] = push([
      (fx + 2 * rx + (n - 3) * p[0]) / n,
      (fy + 2 * ry + (n - 3) * p[1]) / n,
      (fz + 2 * rz + (n - 3) * p[2]) / n,
    ]);
  }

  // --- new faces ---------------------------------------------------------
  //
  // One quad per original corner, wound the same way round as the face it came
  // from, so a consistently wound cage stays consistently wound however many
  // times it is subdivided.
  const newFaces: number[][] = [];
  faces.forEach((face, f) => {
    const centre = push(facePoints[f]);
    for (let i = 0; i < face.length; i++) {
      const v = face[i];
      const next = face[(i + 1) % face.length];
      const prev = face[(i - 1 + face.length) % face.length];
      newFaces.push([
        movedIndex[v],
        edgePointIndex.get(edgeKey(v, next))!,
        centre,
        edgePointIndex.get(edgeKey(prev, v))!,
      ]);
    }
  });

  return { positions: out, faces: newFaces };
}

/**
 * Subdivides `levels` times.
 *
 * Face count multiplies by four each level, so two levels of a 100-quad cage is
 * 1600 quads — smooth, and still small. Three is 6400 and rarely tells you
 * anything the second level did not; the UI stops at two.
 */
export function subdivide(mesh: PolyMesh, levels: number): PolyMesh {
  let current = mesh;
  for (let i = 0; i < Math.max(0, Math.floor(levels)); i++) current = subdivideOnce(current);
  return current;
}
