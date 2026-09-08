import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

function bodyWith(geom: Partial<SceneGeom> & { type: SceneGeom['type']; size: number[] }): SceneGraph {
  return {
    nodes: [{
      id: 'b1',
      name: 'part',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [{ name: 'g1', ...geom } as SceneGeom],
      joints: [],
      children: [],
    }],
  };
}

const dome = bodyWith({ type: 'sphere', size: [0.05] });

const BASE = {
  ...DEFAULT_RELIEF_OPTIONS,
  carveDepthMm: 10,
  stockWidthMm: 120,
  stockDepthMm: 120,
  roughingEnabled: true,
  finishingToolType: 'ball' as const,
  finishingToolDiaMm: 3.175,
};

/** Every cutting move's Z. */
function cutZs(gcode: string): number[] {
  return gcode
    .split('\n')
    .filter((l) => l.startsWith('G1 ') && l.includes('Z'))
    .map((l) => parseFloat(/Z(-?[\d.]+)/.exec(l)![1]));
}

describe('entering the cut after a roughing pass', () => {
  /*
   * The lead-in used to be told the material stood at Z0 whatever roughing had
   * already taken off. With a 10 mm relief that turned a half-millimetre drop
   * into a 10 mm one, and the ramp spent tens of millimetres descending through
   * open air at the plunge rate before it touched anything — then retraced the
   * same distance on the way back, once per raster line.
   */
  it('does not ramp down from the stock face through air roughing already cleared', () => {
    // A flat-topped disc, so a pass over the carved-away background is at one
    // depth all the way along. Any Z range within such a pass is the lead-in
    // ramp and nothing else — on a dome the same measurement cannot tell a ramp
    // apart from the curve the pass is tracing.
    const disc = bodyWith({ type: 'cylinder', size: [0.03, 0.02] });
    const r = generateReliefCarveGcode(disc, BASE);
    expect(r.success).toBe(true);
    expect(r.toolChange).toBe(true);

    /*
     * The approach height is what gives it away.
     *
     * Each pass drops to `entryZ + 0.5` before it starts ramping, so the `G0 Z`
     * ahead of a pass is a direct readout of where the exporter believes the
     * material is. Told the stock face, every finishing approach in the program
     * was `G0 Z0.500` — including the ones over ground roughing had already
     * taken to the floor 10 mm down.
     *
     * Only the finishing pass is checked. Roughing's first layer really does
     * start at the top face, because at that point nothing has been cut yet.
     */
    const finishing = r.gcode.slice(r.gcode.indexOf('T2 M6'));
    const approaches = [...finishing.matchAll(/^G0 Z(-?[\d.]+)$/gm)].map((m) => parseFloat(m[1]));
    expect(approaches.length).toBeGreaterThan(0);
    expect(Math.min(...approaches)).toBeLessThan(-5);
  });

  /*
   * The traverse height is the one thing here that can wreck a workpiece.
   *
   * Passes no longer retract to `safeZ` between them — they lift only as far as
   * it takes to clear what stands on the way to the next pass, which on a
   * raster of closely spaced lines is a millimetre rather than the full retract
   * height. That is worth several metres of Z rapid a job, and it is only safe
   * if the clearance is measured against the material rather than assumed from
   * how close the next pass happens to be.
   */
  it('never flies a rapid through material it has not cut yet', () => {
    const r = generateReliefCarveGcode(dome, BASE);
    expect(r.success).toBe(true);

    /*
     * The finishing pass only, for a reason worth stating.
     *
     * It cuts each point once, to its final height, so its own toolpath is a
     * faithful model of what is standing while it runs — a rapid lower than any
     * of those points is a collision, full stop. Roughing cuts the same ground
     * repeatedly at descending depths, so the same test there would flag a ring
     * flying over the shallower bite it has itself already removed. Roughing's
     * traverses are safe by construction instead: they clear the top of the
     * layer being cut, and nothing in a layer's region stands above that.
     */
    const finishing = r.gcode.slice(r.gcode.indexOf('T2 M6'));
    const solid = r.segments.filter((s) => s.type === 'finishing').flatMap((s) => s.points);
    expect(solid.length).toBeGreaterThan(100);

    let x = 0, y = 0, z = BASE.safeZ;
    let rapids = 0;
    for (const line of finishing.split('\n')) {
      const mx = /X(-?[\d.]+)/.exec(line);
      const my = /Y(-?[\d.]+)/.exec(line);
      const mz = /Z(-?[\d.]+)/.exec(line);
      if (!line.startsWith('G0') && !line.startsWith('G1')) continue;

      const nx = mx ? parseFloat(mx[1]) : x;
      const ny = my ? parseFloat(my[1]) : y;
      const nz = mz ? parseFloat(mz[1]) : z;

      // Only rapid moves that travel in XY are a hazard; a plunge is meant to
      // go into the work, and a cutting move is doing its job.
      if (line.startsWith('G0') && (mx || my)) {
        rapids++;
        const len = Math.hypot(nx - x, ny - y);
        for (const p of solid) {
          // Distance from the point to the traverse segment, in plan.
          const t = len < 1e-9 ? 0
            : Math.max(0, Math.min(1, ((p.x - x) * (nx - x) + (p.y - y) * (ny - y)) / (len * len)));
          const dx = p.x - (x + (nx - x) * t);
          const dy = p.y - (y + (ny - y) * t);
          if (dx * dx + dy * dy > 0.25) continue; // not under the tool's line
          // The move happens at the lower of its ends' heights.
          expect(p.z).toBeLessThanOrEqual(Math.min(z, nz) + 1e-3);
        }
      }
      x = nx; y = ny; z = nz;
    }
    expect(rapids).toBeGreaterThan(10);
  });

  it('still reaches the full depth of the relief', () => {
    const r = generateReliefCarveGcode(dome, BASE);
    const deepest = Math.min(...cutZs(r.gcode));
    // Shortening the ramp must not shorten the cut: the floor is still cut.
    expect(deepest).toBeLessThan(-9.5);
  });

  /*
   * The layer stepdown is boosted well past the baseline — a 3.4x gain at a 20%
   * stepover — and that boost is bought entirely by the small radial bite. The
   * first ring of each layer has no small radial bite: it is a full-width slot.
   * It was taking the whole boosted depth anyway, which made it the heaviest
   * cut in the program by a distance.
   */
  it('does not slot the first ring at the depth a light radial bite earned', () => {
    const r = generateReliefCarveGcode(dome, { ...BASE, roughingStrategy: 'adaptive' });
    expect(r.success).toBe(true);

    // Depths at which roughing walks a ring, before the tool change. A ring's
    // own moves carry no Z — it is set on the way in and held — so these are
    // the cutting depths proper, with the lead-in ramps left out.
    const roughing = r.gcode.slice(0, r.gcode.indexOf('T2 M6'));
    const depths = new Set<number>();
    let z = 0;
    for (const line of roughing.split('\n')) {
      if (!line.startsWith('G0') && !line.startsWith('G1')) continue;
      const mz = /Z(-?[\d.]+)/.exec(line);
      if (mz) z = parseFloat(mz[1]);
      else if (line.startsWith('G1') && /[XY]/.test(line)) depths.add(z);
    }

    // The slotting ring is now taken in several bites, so it cuts at depths
    // between the layers rather than only at the layer floors. With every ring
    // slotting the full layer there were exactly as many depths as layers.
    expect(depths.size).toBeGreaterThan(r.roughingPassCount);
  });

  it('ramps from the stock face when there is no roughing pass to have cleared it', () => {
    // With roughing off the material really is at Z0, and the ramp has to start
    // there — the entry height is read from what has been cut, not assumed.
    const r = generateReliefCarveGcode(dome, { ...BASE, roughingEnabled: false });
    expect(r.success).toBe(true);
    expect(cutZs(r.gcode).some((z) => z > -1)).toBe(true);
  });

  it('drives the ramp back out at the cutting feed, not the plunge rate', () => {
    const r = generateReliefCarveGcode(dome, {
      ...BASE,
      finishingFeedrate: 1234,
      finishingPlungeRate: 321,
    });
    // GRBL holds the last F it was given, so a return leg with no F word of its
    // own crawls back out of the ramp at the plunge rate it went in at. Every
    // move of the ramp states the plunge rate, so the line straight after the
    // last of them is the first of the return leg — and that is where the
    // cutting feed has to be restated.
    const lines = r.gcode.split('\n');
    let lastRamp = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].includes('F321')) lastRamp = i;
    expect(lastRamp).toBeGreaterThan(-1);
    expect(lines[lastRamp + 1]).toContain('F1234');
  });
});
