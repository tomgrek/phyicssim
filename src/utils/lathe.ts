/**
 * Builds a closed, solid lathe: an outer wall at radiusAt(z, theta), an inner
 * wall at a fraction of that radius (thicknessRatio), and an annulus at each
 * end connecting outer rim to inner rim.
 *
 * Use this instead of hand-writing a lathe mesh. A bust-shaped profile with a
 * genuine concavity (the neck) walked through two wrong approaches before
 * landing here — see src/presets/megaBustStudio.ts's git history for the full
 * story — and both are easy to reach for again if you're generating a lathe
 * mesh from scratch:
 *
 * - A single open-ended wall (no caps at all) lets you see straight through
 *   the opening into the inside of the far wall — reads as "translucent".
 * - Capping each end with a fan to a single center point closes the opening,
 *   but is still a zero-thickness shell: from an angle that grazes past a
 *   concavity, backface culling on the near wall can still open a sightline
 *   through to empty space. A fan of many thin triangles meeting at one
 *   point is also a numerically delicate structure for shadow mapping —
 *   self-shadow acne shows up radiating with the wedges, tracking the mesh's
 *   rotation relative to the light rather than the camera.
 *
 * A true thick shell removes both problems: there's always solid material
 * behind the outer surface, and there's no single-point fan for the shadow
 * map to alias against — the ends are quad strips, built the same way as the
 * side walls.
 *
 * Winding for each of outer wall / inner wall / bottom annulus / top annulus
 * was checked numerically (outward-facing-normal test against the mesh
 * centroid), not guessed: the inner wall's "away from material" direction is
 * the opposite radial sense from the outer wall's, since they bound a thin
 * gap rather than being a continuation of the same surface.
 *
 * thicknessRatio is a fraction of the local radius, not a fixed absolute
 * offset. If radiusAt can get very small anywhere (a tapering crown, say), a
 * fixed offset collides with that same floor from the inside and produces a
 * degenerate, zero-area band of triangles right where the outer wall gets
 * thinnest. A proportional thickness keeps inner strictly less than outer
 * everywhere the outer radius is positive, with no extra clamping needed.
 *
 * Collision note: if this mesh feeds a physics engine that takes a mesh
 * geom's convex hull for collision (MuJoCo does), the inner wall and annuli
 * contribute nothing to that hull — every one of their vertices sits inside
 * the outer wall's hull. They're pure rendering cost for collision purposes,
 * so keep slices/stacks no higher than the visual needs, since it doubles
 * the vertex/triangle count for the same collision shape.
 */
export function buildSolidLathe(
  radiusAt: (z: number, theta: number) => number,
  height: number,
  slices: number,
  stacks: number,
  thicknessRatio: number
): { vertices: number[]; faces: number[] } {
  const vertices: number[] = [];
  const faces: number[] = [];
  const N = slices + 1;

  const pushRing = (z: number, isInner: boolean) => {
    for (let j = 0; j <= slices; ++j) {
      const theta = (j / slices) * Math.PI * 2;
      const outerR = radiusAt(z, theta);
      const r = isInner ? outerR * (1 - thicknessRatio) : outerR;
      const x = r * Math.cos(theta);
      const y = r * Math.sin(theta);
      // Geom vertices are stored Y-up (three.js); the MJCF builder maps
      // (x, y, z) -> (x, -z, y) for MuJoCo. So the lathe's height goes in Y,
      // not Z, or the shape compiles lying on its side. The remaining axis
      // is negated rather than swapped so this stays a rotation about X: a
      // bare swap flips the handedness and turns every face inside out.
      vertices.push(x, z, -y);
    }
  };

  const outerBase = 0;
  for (let i = 0; i <= stacks; ++i) pushRing((i / stacks) * height, false);
  const innerBase = vertices.length / 3;
  for (let i = 0; i <= stacks; ++i) pushRing((i / stacks) * height, true);

  // Outer wall.
  for (let i = 0; i < stacks; ++i) {
    for (let j = 0; j < slices; ++j) {
      const first = outerBase + i * N + j;
      const second = first + N;
      faces.push(first, second, first + 1);
      faces.push(second, second + 1, first + 1);
    }
  }
  // Inner wall — reversed relative to the outer wall's index order.
  for (let i = 0; i < stacks; ++i) {
    for (let j = 0; j < slices; ++j) {
      const first = innerBase + i * N + j;
      const second = first + N;
      faces.push(first, first + 1, second);
      faces.push(second, first + 1, second + 1);
    }
  }
  // Bottom annulus (z = 0 ring).
  for (let j = 0; j < slices; ++j) {
    const oa = outerBase + j, ob = outerBase + j + 1;
    const ia = innerBase + j, ib = innerBase + j + 1;
    faces.push(oa, ob, ia);
    faces.push(ia, ob, ib);
  }
  // Top annulus (z = height ring).
  const topOuter = outerBase + stacks * N;
  const topInner = innerBase + stacks * N;
  for (let j = 0; j < slices; ++j) {
    const oa = topOuter + j, ob = topOuter + j + 1;
    const ia = topInner + j, ib = topInner + j + 1;
    faces.push(oa, ia, ob);
    faces.push(ia, ib, ob);
  }

  return { vertices, faces };
}
