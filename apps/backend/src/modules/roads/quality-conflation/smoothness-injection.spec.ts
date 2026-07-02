import { Readable, Writable } from 'node:stream';
import { injectSmoothnessTags } from './smoothness-injection.js';
import type { OsmSmoothness } from './quality-smoothness.js';

/** Run the injector over an XML string, returning the rewritten output. */
async function inject(
  xml: string,
  assignments: Record<string, OsmSmoothness>,
): Promise<{ out: string; waysTagged: number }> {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const { waysTagged } = await injectSmoothnessTags(
    Readable.from([xml]),
    output,
    new Map(Object.entries(assignments)),
  );
  output.end();
  return { out: chunks.join(''), waysTagged };
}

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <bounds minlat="0" minlon="0" maxlat="1" maxlon="1"/>
  <node id="1" lat="0.0" lon="0.0"/>
  <node id="2" lat="0.1" lon="0.1"><tag k="barrier" v="gate"/></node>
  <way id="100"><nd ref="1"/><nd ref="2"/><tag k="highway" v="secondary"/></way>
  <way id="200"><nd ref="1"/><nd ref="2"/><tag k="highway" v="track"/></way>
  <relation id="9"><member type="way" ref="100" role=""/></relation>
</osm>`;

describe('injectSmoothnessTags', () => {
  it('injects smoothness onto matched ways only', async () => {
    const { out, waysTagged } = await inject(DOC, { '100': 'good' });
    expect(waysTagged).toBe(1);
    // Way 100 matched → tagged.
    const way100 = out.slice(out.indexOf('<way id="100"'));
    expect(way100).toContain('<tag k="smoothness" v="good"/>');
    // Way 200 unmatched → no smoothness.
    const way200 = out.slice(out.indexOf('<way id="200"'));
    expect(way200.slice(0, way200.indexOf('</way>'))).not.toContain(
      'smoothness',
    );
  });

  it('preserves nodes (incl. their tags), relations, bounds, and way tags', async () => {
    const { out } = await inject(DOC, { '100': 'good' });
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(out).toContain('minlat="0"');
    // Self-closing source elements normalise to open/close form.
    expect(out).toContain('<tag k="barrier" v="gate">');
    expect(out).toContain('<tag k="highway" v="secondary">');
    expect(out).toContain('<member type="way" ref="100" role="">');
    // Both nodes survive.
    expect(out).toContain('<node id="1"');
    expect(out).toContain('<node id="2"');
  });

  it('replaces an existing smoothness on a matched way (idempotent, no dup)', async () => {
    const xml =
      '<osm><way id="100"><nd ref="1"/><tag k="smoothness" v="bad"/>' +
      '<tag k="highway" v="secondary"/></way></osm>';
    const { out, waysTagged } = await inject(xml, { '100': 'excellent' });
    expect(waysTagged).toBe(1);
    expect(out).toContain('v="excellent"');
    expect(out).not.toContain('v="bad"');
    // Exactly one smoothness tag remains.
    expect(out.match(/k="smoothness"/g)).toHaveLength(1);
  });

  it('leaves an existing smoothness on an UNMATCHED way untouched', async () => {
    const xml =
      '<osm><way id="200"><nd ref="1"/><tag k="smoothness" v="bad"/></way></osm>';
    const { out, waysTagged } = await inject(xml, { '100': 'excellent' });
    expect(waysTagged).toBe(0);
    expect(out).toContain('<tag k="smoothness" v="bad">');
  });

  it('running the output through the injector again is a no-op fixpoint', async () => {
    const first = await inject(DOC, { '100': 'good' });
    const second = await inject(first.out, { '100': 'good' });
    expect(second.waysTagged).toBe(1);
    expect(second.out.match(/k="smoothness"/g)).toHaveLength(1);
  });

  it('escapes special characters in preserved attribute values', async () => {
    const xml =
      '<osm><way id="100"><nd ref="1"/>' +
      '<tag k="name" v="A &amp; B &lt;X&gt;"/></way></osm>';
    const { out } = await inject(xml, { '100': 'good' });
    expect(out).toContain('v="A &amp; B &lt;X&gt;"');
  });

  it('propagates a parse error', async () => {
    const output = new Writable({
      write(_c, _e, cb): void {
        cb();
      },
    });
    await expect(
      injectSmoothnessTags(
        Readable.from(['<osm><way id="1"><nd ></osm-broken']),
        output,
        new Map(),
      ),
    ).rejects.toBeDefined();
  });
});
