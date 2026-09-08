// ---------------------------------------------------------------------------
// Giving a surface a wall
// ---------------------------------------------------------------------------
//
// A lattice is a surface. That is the right thing to edit — you draw the shape
// of a thing, not the shape of its material — and the wrong thing to
// manufacture: a slicer, a mold and a CAM job all want a closed solid, and a
// surface has no inside for them to fill. Until now the panel could only report
// the problem ("surface is not closed") and leave the person to place the
// second half of every wall by hand.
//
// So this offsets the whole surface inwards by a thickness, reverses the copy,
// and stitches the two together around the border. What was a skin becomes a
// shell of a stated wall thickness, closed, and machinable.
//
// It runs on the MESH rather than on the cage, after subdivision, for the same
// reason smoothing does: the offset direction is a vertex normal, which points
// wherever the surface happens to face and almost never along the grid. Keeping
// it out of the cage means the thing being edited stays exactly the integers
// that were placed, and the thickness stays a property that can be changed or
// taken off at any time without the shape remembering it was ever applied.
// ---------------------------------------------------------------------------

import type { PolyMesh } from './subdivide';

const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * Per-vertex normals, area-weighted.
 *
 * Weighted by area because Newell's method hands back a vector whose length is
 * twice the face's area, and using it as it comes means a big face has more say
 * in which way its corner points than a sliver does. Unweighted, a fan of tiny
 * triangles at one corner would swing the offset direction there and pinch the
 * wall.
 */
function vertexNormals(mesh: PolyMesh): number[] {
  const normals = new Array<number>(mesh.positions.length).fill(0);
  const at = (v: number): [number, number, number] => [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];

  for (const face of mesh.faces) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < face.length; i++) {
      const [x1, y1, z1] = at(face[i]);
      const [x2, y2, z2] = at(face[(i + 1) % face.length]);
      nx += (y1 - y2) * (z1 + z2);
      ny += (z1 - z2) * (x1 + x2);
      nz += (x1 - x2) * (y1 + y2);
    }
    for (const v of face) {
      normals[v * 3] += nx;
      normals[v * 3 + 1] += ny;
      normals[v * 3 + 2] += nz;
    }
  }

  for (let v = 0; v < normals.length / 3; v++) {
    const length = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    if (length < 1e-12) continue;
    normals[v * 3] /= length;
    normals[v * 3 + 1] /= length;
    normals[v * 3 + 2] /= length;
  }
  return normals;
}

/** Edges used by exactly one face: the border of an open surface. */
function borderEdges(mesh: PolyMesh): { a: number; b: number }[] {
  const uses = new Map<string, { a: number; b: number; count: number }>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const key = edgeKey(a, b);
      const found = uses.get(key);
      // The direction of the first use is kept: it is the direction the outer
      // surface runs, and the stitched wall has to agree with it or the solid
      // comes out with its rim inside out.
      if (found) found.count++;
      else uses.set(key, { a, b, count: 1 });
    }
  }
  return [...uses.values()].filter((e) => e.count === 1).map(({ a, b }) => ({ a, b }));
}

export function isClosed(mesh: PolyMesh): boolean {
  return mesh.faces.length > 0 && borderEdges(mesh).length === 0;
}

/**
 * Thickens an open surface into a closed shell.
 *
 * `thickness` is in the mesh's own units (metres here) and offsets INWARDS —
 * against the surface normals — so a shape drawn as the outside of a part keeps
 * its outside dimensions and grows its wall inwards, which is what somebody
 * measuring the thing they drew expects.
 *
 * A mesh that is already closed is returned untouched: it is a solid, and what
 * "thickness" would mean for one is hollowing it, which is a different
 * operation with a different question to answer (where does the material get
 * out?).
 */
export function solidify(mesh: PolyMesh, thickness: number): PolyMesh {
  if (thickness <= 0 || mesh.faces.length === 0) return mesh;
  const border = borderEdges(mesh);
  if (border.length === 0) return mesh;

  const normals = vertexNormals(mesh);
  const count = mesh.positions.length / 3;
  const positions = [...mesh.positions];

  // The inner shell's vertices follow the outer ones, so vertex v has its twin
  // at v + count and no lookup is needed anywhere below.
  for (let v = 0; v < count; v++) {
    positions.push(
      mesh.positions[v * 3] - normals[v * 3] * thickness,
      mesh.positions[v * 3 + 1] - normals[v * 3 + 1] * thickness,
      mesh.positions[v * 3 + 2] - normals[v * 3 + 2] * thickness,
    );
  }

  const faces: number[][] = [];
  for (const face of mesh.faces) faces.push([...face]);
  // Reversed, because a copy offset inwards is seen from the other side: left
  // as it was, the shell would have its inner surface facing into the material.
  for (const face of mesh.faces) faces.push([...face].reverse().map((v) => v + count));

  // The rim. The outer surface already runs a→b along this edge and the
  // reversed inner one runs b'→a', so the wall has to take the two directions
  // nobody has used: b→a across the top, a'→b' back along the bottom. Get this
  // the other way round and the mesh is closed, passes an edge count, and is
  // still a solid no slicer will accept.
  for (const { a, b } of border) {
    faces.push([b, a, a + count, b + count]);
  }

  const creases = new Set<string>();
  if (mesh.creases) {
    for (const key of mesh.creases) {
      const [a, b] = key.split(':').map(Number);
      creases.add(edgeKey(a, b));
      creases.add(edgeKey(a + count, b + count));
    }
  }
  // The rim itself is always sharp: a wall meets a face at an edge, and rounding
  // it would eat the wall it was supposed to be the end of.
  for (const { a, b } of border) {
    creases.add(edgeKey(a, b));
    creases.add(edgeKey(a + count, b + count));
  }

  return { positions, faces, creases };
}
