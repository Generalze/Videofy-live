/** @author masterzee001 */
/**
 * The shell's one load-bearing promise: every page is in the markup whatever
 * the active route. The Source page's <video> is the programme itself for
 * uploaded and direct-URL sources; a shell that dropped inactive pages
 * would end a programme on navigation.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsolePage, ConsoleShell } from './ConsoleShell';
import { NOT_YET_PAGES } from './consolePages';
import { OPERATOR_PAGES } from './router';

function render(active: (typeof OPERATOR_PAGES)[number]): string {
  return renderToStaticMarkup(
    <ConsoleShell
      page={active}
      services={[{ label: 'Realtime Gateway', ok: true }]}
      status={{ workflow: 'Ready', viewers: 2, source: 'English', targets: 'ES · FR', warning: null }}
    >
      {OPERATOR_PAGES.map((id) => (
        <ConsolePage key={id} id={id} active={active === id} title={`Page ${id}`}>
          <p>{`body-${id}`}</p>
        </ConsolePage>
      ))}
    </ConsoleShell>,
  );
}

describe('ConsoleShell', () => {
  it('keeps every page mounted whatever the route, hiding the inactive ones', () => {
    for (const active of OPERATOR_PAGES) {
      const html = render(active);
      for (const id of OPERATOR_PAGES) {
        expect(html).toContain(`body-${id}`);
        const section = html.slice(html.indexOf(`id="page-${id}"`) - 60, html.indexOf(`id="page-${id}"`) + 200);
        if (id === active) expect(section).not.toContain('hidden=""');
        else expect(section).toContain('hidden=""');
      }
    }
  });

  it('marks the not-yet pages on the rail and the active page as current', () => {
    const html = render('languages');
    expect(html).toContain('aria-current="page"');
    expect((html.match(/>soon</g) ?? []).length).toBe(NOT_YET_PAGES.size);
    expect(html).toContain('2 viewers');
  });
});
