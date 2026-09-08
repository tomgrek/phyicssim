import { describe, it, expect } from 'vitest';
import {
  addFacesMm, removeFacesMm, extrudeMm, findFaceMm, coordFromMm, mmFromCoord,
  describeLattice, latticeSummary,
} from '../src/utils/latticeCommands';
import { boxLattice, createLattice, DEFAULT_UNIT, faceCount, findVertex, isWatertight } from '../src/utils/latticeMesh';

const square = (z = 0) => [[0, 0, z], [10, 0, z], [10, 10, z], [0, 10, z]];

describe('millimetres in, millimetres out', () => {
  it('converts both ways on a 0.1 mm grid', () => {
    expect(coordFromMm([1, -2.5, 0.3], DEFAULT_UNIT)).toEqual([10, -25, 3]);
    expect(mmFromCoord([10, -25, 3], DEFAULT_UNIT)).toEqual([1, -2.5, 0.3]);
  });

  it('snaps a point that is off the grid, and says how far', () => {
    const l = createLattice();
    const { added, snappedBy } = addFacesMm(l, [[[0, 0, 0], [10, 0, 0], [10, 10.04, 0]]]);
    expect(added).toBe(1);
    expect(snappedBy).toBeCloseTo(0.04, 5);
    expect(findVertex(l, 100, 100, 0)).toBeGreaterThan(-1);
  });
});

describe('adding faces', () => {
  it('adds and reports what it refused', () => {
    const l = createLattice();
    const result = addFacesMm(l, [
      square(),
      square(),                              // the same face again
      [[0, 0, 0], [1, 1, 1]],                // too few corners
      [[0, 0, 0], [0, 0, 0], [5, 0, 0]],     // a repeated corner
    ]);
    expect(result.added).toBe(1);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped[0].reason).toMatch(/already exists/);
    expect(result.skipped[2].reason).toMatch(/same point/);
  });

  it('mirrors when asked', () => {
    const l = createLattice();
    addFacesMm(l, [[[10, 0, 0], [20, 0, 0], [20, 10, 0], [10, 10, 0]]], 'x');
    expect(faceCount(l)).toBe(2);
    expect(findVertex(l, -200, 100, 0)).toBeGreaterThan(-1);
  });

  it('refuses a request that is not a list of faces', () => {
    expect(() => addFacesMm(createLattice(), [])).toThrow(/list of faces/);
  });
});

describe('finding a face again', () => {
  it('matches whatever order the corners are given in', () => {
    const l = createLattice();
    addFacesMm(l, [square()]);
    expect(findFaceMm(l, square())).toBe(0);
    expect(findFaceMm(l, [...square()].reverse())).toBe(0);
    expect(findFaceMm(l, [square()[2], square()[3], square()[0], square()[1]])).toBe(0);
    expect(findFaceMm(l, square(5))).toBe(-1);
  });
});

describe('extruding', () => {
  it('pushes a face out in whole steps and reports the new cap', () => {
    const l = createLattice();
    addFacesMm(l, [square()]);
    const result = extrudeMm(l, square(), 5);
    expect(result.steps).toBe(50);
    expect(result.distanceMm).toBe(5);
    expect(result.sides).toBe(4);
    expect(result.cap.every((corner) => corner[2] === 5)).toBe(true);
    // The cap it reports is a face that can be extruded again.
    expect(findFaceMm(l, result.cap)).toBeGreaterThan(-1);
  });

  it('refuses a distance that rounds to nothing', () => {
    const l = createLattice();
    addFacesMm(l, [square()]);
    expect(() => extrudeMm(l, square(), 0.04)).toThrow(/less than half a grid step/);
  });

  it('refuses a face that is not there', () => {
    const l = createLattice();
    expect(() => extrudeMm(l, square(), 5)).toThrow(/No face has those corners/);
  });
});

describe('removing faces', () => {
  it('removes by corners and reports the ones it could not find', () => {
    const l = boxLattice(DEFAULT_UNIT, 100); // 20 mm cube, corners at +/-10
    expect(isWatertight(l)).toBe(true);
    const top = [[-10, -10, 10], [10, -10, 10], [10, 10, 10], [-10, 10, 10]];
    const result = removeFacesMm(l, [top, square(999)]);
    expect(result.removed).toBe(1);
    expect(result.missing).toHaveLength(1);
    expect(isWatertight(l)).toBe(false);
  });
});

describe('reading a shape back', () => {
  it('reports faces as corners that can be fed straight back in', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    const described = describeLattice(l);
    expect(described.faces).toHaveLength(6);
    expect(described.watertight).toBe(true);
    expect(described.sizeMm).toEqual([20, 20, 20]);
    expect(described.stepMm).toBeCloseTo(0.1);
    // Every face it describes is a face it can find again.
    for (const face of described.faces) expect(findFaceMm(l, face.corners)).toBeGreaterThan(-1);
    // And the normals are outward, as the six axis directions.
    expect(described.faces.map((f) => f.normal).sort()).toEqual(['+x', '+y', '+z', '-x', '-y', '-z']);
  });

  it('summarises an empty cage without falling over', () => {
    expect(latticeSummary(createLattice())).toMatchObject({ faces: 0, bounds: null, sizeMm: null });
  });
});
