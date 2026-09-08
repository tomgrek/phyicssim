import { describe, it, expect } from 'vitest';
import {
  createLattice, vertexAt, findVertex, addFace, findFace, removeFace, flipFace,
  moveVertex, removeVertex, faceNormal, dominantAxis, extrudeFace, mirrorFace,
  isWatertight, latticeStats, latticeBounds, toSceneGeom, toPolyMesh, cageEdges,
  serializeCage, deserializeCage, cloneLattice, restoreLattice, faceCount,
  type Lattice,
} from '../src/utils/latticeMesh';
import { subdivide } from '../src/utils/subdivide';

/** The unit cube as six outward-wound quads, corners on 0/1 in each axis. */
function unitCube(unit = 0.01): Lattice {
  const l = createLattice(unit);
  const v = (i: number, j: number, k: number) => vertexAt(l, i, j, k);
  addFace(l, [v(0,0,0), v(0,1,0), v(1,1,0), v(1,0,0)]); // -z
  addFace(l, [v(0,0,1), v(1,0,1), v(1,1,1), v(0,1,1)]); // +z
  addFace(l, [v(0,0,0), v(1,0,0), v(1,0,1), v(0,0,1)]); // -y
  addFace(l, [v(0,1,0), v(0,1,1), v(1,1,1), v(1,1,0)]); // +y
  addFace(l, [v(0,0,0), v(0,0,1), v(0,1,1), v(0,1,0)]); // -x
  addFace(l, [v(1,0,0), v(1,1,0), v(1,1,1), v(1,0,1)]); // +x
  return l;
}

describe('lattice vertices', () => {
  it('gives the same vertex back for the same grid coordinates', () => {
    const l = createLattice();
    const a = vertexAt(l, 2, -3, 4);
    const b = vertexAt(l, 2, -3, 4);
    expect(b).toBe(a);
    expect(l.coords.length).toBe(3);
  });

  it('reports nothing at an unplaced node', () => {
    const l = createLattice();
    expect(findVertex(l, 0, 0, 0)).toBe(-1);
  });
});

describe('lattice faces', () => {
  it('refuses degenerate and duplicate faces', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0), c = vertexAt(l, 1, 1, 0);
    expect(addFace(l, [a, b])).toBe(-1);
    expect(addFace(l, [a, b, a])).toBe(-1);
    expect(addFace(l, [a, b, c])).toBe(0);
    expect(addFace(l, [b, c, a])).toBe(-1); // same cycle, rotated
  });

  it('lets a face be re-drawn the other way round, as the flip', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0), c = vertexAt(l, 1, 1, 0);
    addFace(l, [a, b, c]);
    expect(addFace(l, [c, b, a])).toBe(1);
  });

  it('finds a face however it is rotated', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0), c = vertexAt(l, 1, 1, 0);
    const f = addFace(l, [a, b, c]);
    expect(findFace(l, [c, a, b])).toBe(f);
  });

  it('keeps face indices stable when one is removed', () => {
    const l = unitCube();
    removeFace(l, 2);
    expect(faceCount(l)).toBe(5);
    expect(l.faces[5]).not.toBeNull(); // the last face did not slide down
  });
});

describe('face geometry', () => {
  it('normals point out of a correctly wound cube', () => {
    const l = unitCube();
    expect(dominantAxis(faceNormal(l, 0)!)).toEqual({ axis: 'z', sign: -1 });
    expect(dominantAxis(faceNormal(l, 1)!)).toEqual({ axis: 'z', sign: 1 });
    expect(dominantAxis(faceNormal(l, 2)!)).toEqual({ axis: 'y', sign: -1 });
    expect(dominantAxis(faceNormal(l, 3)!)).toEqual({ axis: 'y', sign: 1 });
    expect(dominantAxis(faceNormal(l, 4)!)).toEqual({ axis: 'x', sign: -1 });
    expect(dominantAxis(faceNormal(l, 5)!)).toEqual({ axis: 'x', sign: 1 });
  });

  it('flipping reverses the normal', () => {
    const l = unitCube();
    const before = faceNormal(l, 1)!;
    flipFace(l, 1);
    const after = faceNormal(l, 1)!;
    after.forEach((n, i) => expect(-n).toBeCloseTo(before[i]));
  });
});

describe('moving and welding', () => {
  it('moves a vertex to a free node', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0);
    expect(moveVertex(l, a, 5, 0, 0)).toBe(true);
    expect(findVertex(l, 0, 0, 0)).toBe(-1);
    expect(findVertex(l, 5, 0, 0)).toBe(a);
  });

  it('welds onto an occupied node, collapsing the quad it shared', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    addFace(l, [a, b, c, d]);
    moveVertex(l, b, 1, 1, 0); // b onto c
    expect(l.faces[0]).toEqual([a, c, d]);
    expect(l.vertexFaces.get(b)?.size ?? 0).toBe(0);
  });

  it('drops a face that welds down to a line', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0), c = vertexAt(l, 2, 0, 0);
    addFace(l, [a, b, c]);
    moveVertex(l, c, 1, 0, 0); // c onto b
    expect(faceCount(l)).toBe(0);
  });

  it('removing a vertex takes its faces with it', () => {
    const l = unitCube();
    removeVertex(l, findVertex(l, 0, 0, 0));
    expect(faceCount(l)).toBe(3); // the three faces meeting at that corner are gone
  });
});

describe('extrude', () => {
  it('walls in the gap and caps it', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    const f = addFace(l, [a, b, c, d]); // faces +z
    const result = extrudeFace(l, f, 2)!;
    expect(result.sides.length).toBe(4);
    expect(faceCount(l)).toBe(5); // four sides plus the cap, base consumed
    // The face pointed at +z, so two steps "out" is two steps up.
    expect(findVertex(l, 0, 0, 2)).toBeGreaterThan(-1);
  });

  it('keeps the cap facing the way the original did', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    const f = addFace(l, [a, b, c, d]); // faces +z
    const { cap } = extrudeFace(l, f, 3)!;
    expect(dominantAxis(faceNormal(l, cap)!)).toEqual({ axis: 'z', sign: 1 });
    expect(findVertex(l, 0, 0, 3)).toBeGreaterThan(-1);
  });

  it('makes a closed solid out of an open quad plus its flip', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    const f = addFace(l, [a, b, c, d]); // +z
    extrudeFace(l, f, 1);
    expect(isWatertight(l)).toBe(false); // open where the base was
    addFace(l, [a, d, c, b]);            // close it, wound the other way
    expect(isWatertight(l)).toBe(true);
  });

  it('extrudes along a named axis when one is given', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    const f = addFace(l, [a, b, c, d]);
    extrudeFace(l, f, 2, 'x');
    expect(findVertex(l, 3, 1, 0)).toBeGreaterThan(-1);
  });
});

describe('mirror', () => {
  it('reflects a face and reverses its winding', () => {
    const l = createLattice();
    const a = vertexAt(l, 1, 0, 0), b = vertexAt(l, 2, 0, 0), c = vertexAt(l, 2, 1, 0);
    const f = addFace(l, [a, b, c]);
    const m = mirrorFace(l, f, 'x');
    expect(m).toBeGreaterThan(-1);
    const normal = faceNormal(l, f)!;
    const mirrored = faceNormal(l, m)!;
    // Reflected across x, a normal along z stays along z and keeps its sign;
    // that only holds if the winding was reversed too.
    expect(dominantAxis(mirrored)).toEqual(dominantAxis(normal));
    expect(findVertex(l, -2, 1, 0)).toBeGreaterThan(-1);
  });
});

describe('health and stats', () => {
  it('a cube is watertight, a cube missing a face is not', () => {
    const l = unitCube();
    expect(isWatertight(l)).toBe(true);
    removeFace(l, 0);
    expect(isWatertight(l)).toBe(false);
  });

  it('nothing at all is not watertight', () => {
    expect(isWatertight(createLattice())).toBe(false);
  });

  it('counts only vertices some face still uses', () => {
    const l = unitCube();
    vertexAt(l, 9, 9, 9); // placed and never joined to anything
    expect(latticeStats(l)).toMatchObject({ vertices: 8, faces: 6, quads: 6, tris: 0, watertight: true });
  });

  it('reports bounds in grid steps', () => {
    const l = unitCube();
    expect(latticeBounds(l)).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
  });

  it('lists each cage edge once', () => {
    expect(cageEdges(unitCube()).length / 2).toBe(12);
  });
});

describe('out to a mesh', () => {
  it('scales grid steps by the unit and drops orphans', () => {
    const l = unitCube(0.02);
    vertexAt(l, 9, 9, 9);
    const poly = toPolyMesh(l);
    expect(poly.positions.length / 3).toBe(8);
    expect(Math.max(...poly.positions)).toBeCloseTo(0.02);
  });

  it('triangulates quads and emits the Y-up copy the renderer wants', () => {
    const geom = toSceneGeom(unitCube(0.01));
    expect(geom.faces.length).toBe(6 * 2 * 3);
    const n = geom.renderVertices.length / 3;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = geom.renderVertices.slice(i * 3, i * 3 + 3);
      expect(geom.vertices.slice(i * 3, i * 3 + 3)).toEqual([x, z, -y]);
    }
  });

  it('subdivision quadruples the faces and shrinks towards a sphere', () => {
    const cube = toPolyMesh(unitCube(0.01));
    const once = subdivide(cube, 1);
    const twice = subdivide(cube, 2);
    expect(once.faces.length).toBe(24);
    expect(twice.faces.length).toBe(96);
    for (const face of twice.faces) expect(face.length).toBe(4);

    // Every subdivided point lies inside the cage, and the corner has pulled in
    // most: that is the cube on its way to a rounded solid.
    const centre = 0.005;
    const radius = (p: number[], i: number) =>
      Math.hypot(p[i * 3] - centre, p[i * 3 + 1] - centre, p[i * 3 + 2] - centre);
    let maxRadius = 0;
    for (let i = 0; i < twice.positions.length / 3; i++) maxRadius = Math.max(maxRadius, radius(twice.positions, i));
    expect(maxRadius).toBeLessThan(Math.hypot(centre, centre, centre));
  });

  it('leaves an open cage its outline', () => {
    const l = createLattice(0.01);
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 2, 0, 0);
    const c = vertexAt(l, 2, 2, 0), d = vertexAt(l, 0, 2, 0);
    addFace(l, [a, b, c, d]);
    const once = subdivide(toPolyMesh(l), 1);
    // The four corners are pinned (three boundary edges meet at none of them,
    // but each has exactly two, so they move only along the border) and the
    // patch stays flat at z = 0.
    for (let i = 0; i < once.positions.length / 3; i++) expect(once.positions[i * 3 + 2]).toBe(0);
  });

  it('subdivides through toSceneGeom when asked', () => {
    const flat = toSceneGeom(unitCube(0.01), 0);
    const smooth = toSceneGeom(unitCube(0.01), 2);
    expect(smooth.faces.length).toBeGreaterThan(flat.faces.length);
    expect(smooth.faces.length).toBe(96 * 2 * 3);
  });
});

describe('persistence and history', () => {
  it('round-trips a cage through serialisation', () => {
    const l = unitCube(0.02);
    removeFace(l, 3);
    vertexAt(l, 9, 9, 9);
    const back = deserializeCage(serializeCage(l));
    expect(back.unit).toBe(0.02);
    expect(latticeStats(back)).toMatchObject(latticeStats(l));
    expect(toSceneGeom(back).renderVertices).toEqual(toSceneGeom(l).renderVertices);
  });

  it('restores a snapshot in place', () => {
    const l = unitCube();
    const snapshot = cloneLattice(l);
    removeFace(l, 0);
    removeFace(l, 1);
    expect(isWatertight(l)).toBe(false);
    restoreLattice(l, snapshot);
    expect(isWatertight(l)).toBe(true);
    expect(faceCount(l)).toBe(6);
  });

  it('a snapshot is not a view of the live cage', () => {
    const l = unitCube();
    const snapshot = cloneLattice(l);
    extrudeFace(l, 1, 4);
    expect(faceCount(snapshot)).toBe(6);
  });
});
