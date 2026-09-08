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

  it('still reaches the full depth of the relief', () => {
    const r = generateReliefCarveGcode(dome, BASE);
    const deepest = Math.min(...cutZs(r.gcode));
    // Shortening the ramp must not shorten the cut: the floor is still cut.
    expect(deepest).toBeLessThan(-9.5);
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
