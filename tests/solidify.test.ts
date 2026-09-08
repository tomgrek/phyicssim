import { describe, it, expect } from 'vitest';
import { solidify, isClosed } from '../src/utils/solidify';
import type { PolyMesh } from '../src/utils/subdivide';
import { createLattice, vertexAt, addFace, toPolyMesh, toSceneGeom, boxLattice } from '../src/utils/latticeMesh';

/** A flat 2x2-quad patch on z = 0, wound to face +z. */
function patch(): PolyMesh {
  const l = createLattice(0.01);
  const v = (i: number, j: number) => vertexAt(l, i, j, 0);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      addFace(l, [v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)]);
    }
  }
  return toPolyMesh(l);
}

/**
 * Whether every directed edge is used exactly once, which is what makes a
 * closed mesh consistently wound rather than merely closed — a shell with its
 * inner surface facing the wrong way passes an edge count and still exports as
 * a solid nothing can slice.
 */
function isConsistentlyWound(mesh: PolyMesh): boolean {
  const used = new Set<string>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i++) {
      const key = `${face[i]}->${face[(i + 1) % face.length]}`;
      if (used.has(key)) return false;
      used.add(key);
    }
  }
  for (const key of used) {
    const [a, b] = key.split('->');
    if (!used.has(`${b}->${a}`)) return false;
  }
  return true;
}

describe('solidify', () => {
  it('closes an open patch into a shell', () => {
    const open = patch();
    expect(isClosed(open)).toBe(false);
    const shell = solidify(open, 0.002);
    expect(isClosed(shell)).toBe(true);
    expect(isConsistentlyWound(shell)).toBe(true);
    // Two shells plus a wall around a 2x2 patch's eight border edges.
    expect(shell.faces.length).toBe(4 + 4 + 8);
    expect(shell.positions.length).toBe(open.positions.length * 2);
  });

  it('offsets inwards, so the drawn surface keeps its dimensions', () => {
    const shell = solidify(patch(), 0.002);
    const z = [];
    for (let i = 2; i < shell.positions.length; i += 3) z.push(shell.positions[i]);
    // The patch faces +z, so the wall goes below it and nothing rises above.
    expect(Math.max(...z)).toBeCloseTo(0, 9);
    expect(Math.min(...z)).toBeCloseTo(-0.002, 9);
  });

  it('marks the rim sharp, so smoothing cannot eat the wall', () => {
    const shell = solidify(patch(), 0.002);
    expect(shell.creases!.size).toBe(16); // eight border edges, on both shells
  });

  it('leaves a closed solid alone', () => {
    const cube = toPolyMesh(boxLattice(0.01, 2));
    const same = solidify(cube, 0.002);
    expect(same).toBe(cube);
  });

  it('does nothing without a thickness', () => {
    const open = patch();
    expect(solidify(open, 0)).toBe(open);
  });

  it('comes through toSceneGeom, after smoothing', () => {
    const l = createLattice(0.01);
    const v = (i: number, j: number) => vertexAt(l, i, j, 0);
    addFace(l, [v(0, 0), v(1, 0), v(1, 1), v(0, 1)]);

    const skin = toSceneGeom(l, 0, 0);
    const shell = toSceneGeom(l, 0, 0.002);
    expect(shell.faces.length).toBeGreaterThan(skin.faces.length);

    // Smoothed and thickened: the wall follows the rounded surface, so it is
    // built after subdivision rather than before it.
    const smoothShell = toSceneGeom(l, 2, 0.002);
    expect(smoothShell.faces.length).toBeGreaterThan(shell.faces.length);
  });
});
