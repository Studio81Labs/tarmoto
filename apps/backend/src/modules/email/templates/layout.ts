/**
 * Shared chrome for every transactional template. Templates supply
 * the body fragment; the layout wraps it with a branded header,
 * preheader, and footer.
 *
 * Per the AC, transactional emails are exempt from CAN-SPAM-style
 * unsubscribe requirements but the footer still includes a
 * "manage notification preferences" link pointing at the companion
 * settings page so riders have one consistent place to opt out of
 * digests when those ship.
 */

const BRAND = {
  name: 'Tarmoto',
  primary: '#06b6d4', // tarmoto-cyan
  bg: '#0f172a', // slate-950
  fg: '#f8fafc',
};

export interface LayoutContext {
  preheader: string;
  bodyHtml: string;
  preferencesUrl: string;
  /** Footer text for marketing/digest mails. Transactional mails omit it. */
  marketingFooter?: boolean;
}

export const escapeHtml = (raw: string): string =>
  raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const renderLayout = (ctx: LayoutContext): string => {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(BRAND.name)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.bg};color:${BRAND.fg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;font-size:0;">${escapeHtml(ctx.preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1e293b;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 32px;border-bottom:1px solid #334155;">
                <span style="color:${BRAND.primary};font-weight:700;font-size:20px;letter-spacing:0.02em;">${escapeHtml(BRAND.name)}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;color:${BRAND.fg};font-size:15px;line-height:1.6;">
                ${ctx.bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px;border-top:1px solid #334155;color:#94a3b8;font-size:12px;line-height:1.5;">
                ${
                  ctx.marketingFooter
                    ? `You're receiving this digest as part of your Tarmoto subscription. <a href="${escapeHtml(ctx.preferencesUrl)}" style="color:${BRAND.primary};">Unsubscribe from marketing emails</a>.`
                    : `This is a transactional message about your Tarmoto account. <a href="${escapeHtml(ctx.preferencesUrl)}" style="color:${BRAND.primary};">Manage notifications</a>.`
                }
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
};

export const renderTextFooter = (
  preferencesUrl: string,
  marketing = false,
): string => {
  // Marketing/digest mail must carry the unsubscribe language in the text part
  // too — a text-only client never sees the HTML `marketingFooter`.
  if (marketing) {
    return `\n\n—\nTarmoto · weekly digest\nYou're receiving this as part of your Tarmoto subscription.\nUnsubscribe from marketing emails: ${preferencesUrl}\n`;
  }
  return `\n\n—\nTarmoto · transactional email\nManage notifications: ${preferencesUrl}\n`;
};
