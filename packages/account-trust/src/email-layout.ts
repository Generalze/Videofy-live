/**
 * The look of a C7 transactional email.
 *
 * WRITTEN FOR INBOXES, NOT FOR BROWSERS, which is most of why it looks like
 * markup from 2004. Every choice below is a client bug worked around:
 *
 *   - TABLES, with width/cellpadding/cellspacing/border attributes. Outlook on
 *     Windows renders through Word, which ignores modern layout entirely.
 *   - INLINE STYLES only. Gmail strips <style> blocks when it clips a message
 *     or when it is forwarded, and a stylesheet that vanishes takes the whole
 *     design with it.
 *   - A SOLID COLOUR UNDER EVERY GRADIENT. Word has no gradient support, so
 *     bgcolor carries the brand and background-image is the enhancement. The
 *     result degrades to flat violet rather than to white-on-white.
 *   - A VML BUTTON for Outlook beside a padded anchor for everyone else. A
 *     styled <a> alone collapses to bare underlined text there, which on a
 *     verification email is the difference between a button and a dead end.
 *   - NO IMAGES AT ALL. Remote images are blocked by default in most clients,
 *     so a design that needs them arrives broken -- and a tracking pixel is
 *     not something to put in front of somebody who has not yet consented to
 *     anything.
 *   - A PREHEADER, hidden but present. Without one the inbox preview line
 *     shows whatever text comes first, which is usually a fragment of a URL.
 *
 * AND IT STAYS ANONYMOUS. No name, no account id, no organisation, no email
 * address in the body. This message is read by whoever controls that inbox and
 * at this point nobody has proven that is the right person -- so the design got
 * better and the disclosure did not.
 */

const VIOLET_600 = '#7c3aed';
const VIOLET_400 = '#916bf8';
const VIOLET_300 = '#a78bfa';
const INK = '#05070c';
const CARD = '#0b0f18';
const HAIRLINE = 'rgba(160,180,220,.16)';
const TEXT = '#eef2f8';
const TEXT_MUTED = '#aab5c9';
const TEXT_FAINT = '#74809a';

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface BrandedEmail {
  /** Shown in the inbox preview line, never rendered in the body. */
  readonly preheader: string;
  readonly heading: string;
  readonly intro: string;
  /** Omitted for a message with nothing to act on -- a warning, for instance. */
  readonly action?: { readonly label: string; readonly href: string };
  /** Lines under the action. Each is its own muted paragraph. */
  readonly notes: readonly string[];
  /** Set for a warning: the accent turns amber and the heading rule with it. */
  readonly tone?: 'brand' | 'alert';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The gradient band, and the flat colour Outlook falls back to. */
function accentFor(tone: 'brand' | 'alert'): { solid: string; gradient: string } {
  return tone === 'alert'
    ? {
        solid: '#b45309',
        gradient: 'linear-gradient(135deg,#f59e0b 0%,#b45309 55%,#7c2d12 100%)',
      }
    : {
        solid: VIOLET_600,
        gradient: `linear-gradient(135deg,${VIOLET_300} 0%,${VIOLET_400} 45%,${VIOLET_600} 100%)`,
      };
}

export function renderBrandedEmail(email: BrandedEmail): string {
  const tone = email.tone ?? 'brand';
  const accent = accentFor(tone);
  const notes = email.notes
    .map(
      (note) =>
        `<p style="margin:0 0 10px;font-size:13px;line-height:1.65;color:${TEXT_FAINT};font-family:${FONT}">${note}</p>`,
    )
    .join('');

  /*
   * The action, twice. The VML block is invisible to every client except
   * Outlook on Windows, and the anchor is hidden FROM that client by the
   * conditional comment around it -- so exactly one of them ever renders.
   */
  const action = email.action
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="left" style="padding:6px 0 26px">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${escapeHtml(email.action.href)}" style="height:48px;v-text-anchor:middle;width:232px;" arcsize="50%" stroke="f" fillcolor="${accent.solid}">
        <w:anchorlock/>
        <center style="color:#ffffff;font-family:${FONT};font-size:15px;font-weight:600;">${escapeHtml(email.action.label)}</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-- -->
      <a href="${escapeHtml(email.action.href)}" style="display:inline-block;background-color:${accent.solid};background-image:${accent.gradient};color:#ffffff;text-decoration:none;font-family:${FONT};font-size:15px;font-weight:600;line-height:48px;padding:0 30px;border-radius:999px;mso-hide:all">${escapeHtml(email.action.label)}</a>
      <!--<![endif]-->
    </td></tr></table>`
    : '';

  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<title>${escapeHtml(email.heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${INK};">
<div style="display:none;font-size:1px;color:${INK};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${escapeHtml(email.preheader)}</div>
<!-- Some clients ignore an empty preheader and pull body text in; the spacer stops the next line leaking into the preview. -->
<div style="display:none;max-height:0;overflow:hidden">&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${INK};">
  <tr>
    <td align="center" style="padding:32px 16px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;border-collapse:separate;">

        <!-- The gradient band. bgcolor carries Outlook; the image is the enhancement. -->
        <tr>
          <td bgcolor="${accent.solid}" style="background-color:${accent.solid};background-image:${accent.gradient};border-radius:18px 18px 0 0;padding:22px 30px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td align="left" style="font-family:${FONT};font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:#ffffff;font-weight:600;">Consummate&nbsp;7</td>
            </tr></table>
          </td>
        </tr>

        <tr>
          <td bgcolor="${CARD}" style="background-color:${CARD};border-left:1px solid ${HAIRLINE};border-right:1px solid ${HAIRLINE};border-bottom:1px solid ${HAIRLINE};border-radius:0 0 18px 18px;padding:34px 30px 30px;">

            <h1 style="margin:0 0 14px;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:600;color:${TEXT};">${escapeHtml(email.heading)}</h1>
            <p style="margin:0 0 24px;font-family:${FONT};font-size:15px;line-height:1.65;color:${TEXT_MUTED};">${escapeHtml(email.intro)}</p>

            ${action}

            ${notes}
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:22px 20px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${TEXT_FAINT};">
            Consummate&nbsp;7 &middot; live translated video
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
