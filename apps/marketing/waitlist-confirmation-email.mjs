export const WAITLIST_CONFIRMATION_SUBJECT = "You're on the Tarmoto waitlist";

// Logo mark for the email header. Inlined as a base64 data URI so the
// image is shipped with the email itself — no dependency on a public
// asset URL that has to be reachable from every recipient client at
// open time. Regenerate when the brand mark changes:
//   base64 -i apps/marketing/public/brand/logo-mark-on-accent.png \
//     | tr -d '\n'
// Source SVG: docs/design/brand/logo-mark-on-accent.svg (160×160 PNG
// export via macOS Quick Look at 4× the 40×40 display size).
const LOGO_MARK_PNG_BASE64 =
  "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";

const WAITLIST_CONFIRMATION_TEXT = `You're on the list.

Thanks for joining the Tarmoto waitlist. Your spot is saved.

Tarmoto is a desktop-first motorcycle route planner. Built for twisty roads, surface awareness, and fewer surprises. Sync the route to your phone companion and ride.

We'll write once — when your invite is ready. No drip campaign. No marketing list.

—

What's next

Beta access will roll out gradually in small batches.

—

Pass it on
Know a rider who plans Saturdays around the road? Send them our way: https://tarmoto.app

—

tarmoto.app — route planning for riders.
You're receiving this because you joined the waitlist at tarmoto.app.
© {{year}} Tarmoto · Studio81 Labs, s.r.o.

Unsubscribe: {{unsubscribe_url}}
Contact: https://tarmoto.app/contact`;

const WAITLIST_CONFIRMATION_HTML = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>You're on the Tarmoto waitlist</title>

  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <style>
    * { font-family: 'Segoe UI', Tahoma, sans-serif !important; }
    .serif { font-family: Georgia, 'Times New Roman', serif !important; }
    .mono  { font-family: 'Courier New', Courier, monospace !important; }
  </style>
  <![endif]-->

  <!-- Web fonts (ignored by Outlook + Gmail; honoured by Apple Mail / iOS) -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;1,9..144,400;1,9..144,500&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap"
    rel="stylesheet"
  />

  <style>
    body, table, td, p, a, li { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { -ms-interpolation-mode: bicubic; border: 0; line-height: 100%; outline: none; text-decoration: none; }
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; }
    a { text-decoration: none; }

    @media only screen and (max-width: 620px) {
      .container       { width: 100% !important; max-width: 100% !important; }
      .px-outer        { padding-left: 16px !important; padding-right: 16px !important; }
      .px-inner        { padding-left: 24px !important; padding-right: 24px !important; }
      .display         { font-size: 32px !important; line-height: 1.12 !important; letter-spacing: -0.02em !important; }
      .body-copy       { font-size: 15px !important; line-height: 1.6 !important; }
      .stamp-stack     { display: block !important; width: 100% !important; text-align: left !important; padding-top: 4px !important; }
      .footer-row      { display: block !important; width: 100% !important; padding-bottom: 12px !important; }
    }

    :root { color-scheme: dark; supported-color-schemes: dark; }
  </style>
</head>

<body style="margin:0; padding:0; background-color:#0B0D10; color:#E8E5DE; font-family:'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">

  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#0B0D10; opacity:0;">
    You're on the list. We'll write once — when your beta invite is ready. No marketing list.
  </div>
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#0B0D10; opacity:0;">
    &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0B0D10;">
    <tr>
      <td align="center" class="px-outer" style="padding:32px 24px 48px 24px;">

        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px;">

          <!-- HEADER: brand-mark image (with letter "T" alt fallback) + Tarmoto wordmark + stamp -->
          <tr>
            <td style="padding:0 0 28px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" align="left" style="font-size:0;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block; vertical-align:middle;">
                      <tr>
                        <!-- Logo cell:
                             - When images load (Apple Mail, iOS, most clients):
                               the inlined road-mark PNG renders on the orange
                               square, matching the marketing-site nav.
                             - When images are blocked (some Outlook configs,
                               first paint in Gmail web): the bgcolor + cell
                               text styling fall back to a bold "T" on the
                               orange tile. -->
                        <td width="40" height="40" align="center" valign="middle"
                            bgcolor="#FF6A1A"
                            style="width:40px; height:40px; background-color:#FF6A1A; background:linear-gradient(180deg,#FF7A26 0%,#FF6A1A 100%); border-radius:10px; color:#1A120D; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-weight:700; font-size:22px; line-height:40px; text-align:center;">
                          <img src="data:image/png;base64,${LOGO_MARK_PNG_BASE64}"
                               alt="T"
                               width="40" height="40"
                               style="display:block; width:40px; height:40px; border:0; border-radius:10px;" />
                        </td>
                        <td width="12" style="width:12px;">&nbsp;</td>
                        <td valign="middle" style="font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-weight:600; font-size:18px; color:#E8E5DE; letter-spacing:-0.01em;">
                          Tarmoto
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td valign="middle" align="right" class="stamp-stack"
                      style="font-family:'JetBrains Mono', 'Courier New', Courier, monospace; font-size:11px; font-weight:500; letter-spacing:0.15em; text-transform:uppercase; color:#918F89;">
                    § Waitlist · Confirmed
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- MAIN PANEL -->
          <tr>
            <td style="background-color:#12161B; border:1px solid rgba(232,229,222,0.08); border-radius:14px;">

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="px-inner" style="padding:40px 40px 8px 40px;">
                    <p class="mono" style="margin:0 0 18px 0; font-family:'JetBrains Mono', 'Courier New', Courier, monospace; font-size:11px; font-weight:500; letter-spacing:0.15em; text-transform:uppercase; color:#FF6A1A;">
                      § 01 &nbsp;You're in
                    </p>
                    <h1 class="display serif"
                        style="margin:0; font-family:'Fraunces', Georgia, 'Times New Roman', serif; font-weight:400; font-size:40px; line-height:1.1; letter-spacing:-0.025em; color:#E8E5DE;">
                      You're <em style="font-style:italic; color:#FF6A1A;">on the list.</em>
                    </h1>
                  </td>
                </tr>

                <tr>
                  <td class="px-inner" style="padding:24px 40px 8px 40px;">
                    <p class="body-copy" style="margin:0 0 16px 0; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-size:16px; line-height:1.65; color:#E8E5DE;">
                      Thanks for joining the Tarmoto waitlist. Your spot is saved.
                    </p>
                    <p class="body-copy" style="margin:0 0 16px 0; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-size:16px; line-height:1.65; color:#918F89;">
                      Tarmoto is a desktop-first motorcycle route planner. Built for twisty roads, surface awareness, and fewer surprises. Sync the route to your phone companion and ride.
                    </p>
                    <p class="body-copy" style="margin:0; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-size:16px; line-height:1.65; color:#918F89;">
                      We'll write once &mdash; when your invite is ready. No drip campaign. No marketing list.
                    </p>
                  </td>
                </tr>

                <tr>
                  <td class="px-inner" style="padding:32px 40px 0 40px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td height="1" style="height:1px; line-height:1px; font-size:1px; background-color:rgba(232,229,222,0.08);">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- What's next — one line, no timeline -->
                <tr>
                  <td class="px-inner" style="padding:28px 40px 0 40px;">
                    <p class="mono" style="margin:0 0 14px 0; font-family:'JetBrains Mono', 'Courier New', Courier, monospace; font-size:11px; font-weight:500; letter-spacing:0.15em; text-transform:uppercase; color:#686661;">
                      § 02 &nbsp;What's next
                    </p>
                    <p class="body-copy" style="margin:0; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-size:16px; line-height:1.6; color:#918F89;">
                      Beta access will roll out gradually in small batches.
                    </p>
                  </td>
                </tr>

                <tr>
                  <td class="px-inner" style="padding:32px 40px 0 40px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td height="1" style="height:1px; line-height:1px; font-size:1px; background-color:rgba(232,229,222,0.08);">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Pass it on -->
                <tr>
                  <td class="px-inner" style="padding:28px 40px 40px 40px;">
                    <p class="mono" style="margin:0 0 14px 0; font-family:'JetBrains Mono', 'Courier New', Courier, monospace; font-size:11px; font-weight:500; letter-spacing:0.15em; text-transform:uppercase; color:#686661;">
                      § 03 &nbsp;Pass it on
                    </p>
                    <p class="body-copy" style="margin:0 0 22px 0; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-size:16px; line-height:1.6; color:#918F89;">
                      Know a rider who plans Saturdays around the road? Send them our way.
                    </p>

                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center"
                            style="background-color:#FF6A1A; background:linear-gradient(180deg,#FF7A26 0%,#FF6A1A 100%); border-radius:10px;">
                          <!--[if mso]>
                          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                                       href="mailto:?subject=A%20motorcycle%20app%20worth%20a%20look%20%E2%80%94%20Tarmoto&amp;body=Tarmoto%20is%20a%20desktop-first%20motorcycle%20route%20planner.%20Built%20for%20twisty%20roads%2C%20surface%20awareness%2C%20and%20fewer%20surprises.%20Join%20the%20waitlist%3A%20https%3A%2F%2Ftarmoto.app"
                                       style="height:46px;v-text-anchor:middle;width:220px;" arcsize="22%" stroke="f" fillcolor="#FF6A1A">
                            <w:anchorlock/>
                            <center style="color:#1A120D;font-family:'Segoe UI', Tahoma, sans-serif;font-size:15px;font-weight:600;">Forward to a friend &rarr;</center>
                          </v:roundrect>
                          <![endif]-->
                          <!--[if !mso]><!-- -->
                          <a href="mailto:?subject=A%20motorcycle%20app%20worth%20a%20look%20%E2%80%94%20Tarmoto&body=Tarmoto%20is%20a%20desktop-first%20motorcycle%20route%20planner.%20Built%20for%20twisty%20roads%2C%20surface%20awareness%2C%20and%20fewer%20surprises.%20Join%20the%20waitlist%3A%20https%3A%2F%2Ftarmoto.app"
                             style="display:inline-block; padding:14px 26px; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-size:15px; font-weight:600; color:#1A120D; line-height:1; border-radius:10px; text-decoration:none; letter-spacing:-0.005em;">
                            Forward to a friend &rarr;
                          </a>
                          <!--<![endif]-->
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding:28px 8px 0 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="footer-row" valign="top" align="left"
                      style="font-family:'JetBrains Mono', 'Courier New', Courier, monospace; font-size:11px; font-weight:500; letter-spacing:0.15em; text-transform:uppercase; color:#918F89;">
                    <a href="https://tarmoto.app" style="color:#E8E5DE; text-decoration:none; letter-spacing:0.15em;">tarmoto.app</a>
                    <span style="color:#686661;">&nbsp;·&nbsp;</span>
                    <span style="color:#686661;">Route planning for riders.</span>
                  </td>
                  <td class="footer-row" valign="top" align="right"
                      style="font-family:'JetBrains Mono', 'Courier New', Courier, monospace; font-size:11px; font-weight:500; letter-spacing:0.15em; text-transform:uppercase;">
                    <a href="{{unsubscribe_url}}" style="color:#918F89; text-decoration:underline;">Unsubscribe</a>
                    <span style="color:#686661;">&nbsp;·&nbsp;</span>
                    <a href="https://tarmoto.app/contact" style="color:#918F89; text-decoration:underline;">Contact</a>
                  </td>
                </tr>
                <tr>
                  <td colspan="2" style="padding-top:14px;">
                    <p style="margin:0; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-size:12px; line-height:1.5; color:#686661;">
                      You're receiving this because you joined the waitlist at tarmoto.app. &copy; {{year}} Tarmoto · Studio81 Labs, s.r.o.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;

export function renderWaitlistConfirmationHtml(unsubscribeUrl) {
  return WAITLIST_CONFIRMATION_HTML.replaceAll(
    "{{unsubscribe_url}}",
    escapeHtmlAttribute(unsubscribeUrl),
  ).replaceAll("{{year}}", String(new Date().getUTCFullYear()));
}

export function renderWaitlistConfirmationText(unsubscribeUrl) {
  return WAITLIST_CONFIRMATION_TEXT.replaceAll(
    "{{unsubscribe_url}}",
    unsubscribeUrl,
  ).replaceAll("{{year}}", String(new Date().getUTCFullYear()));
}

function escapeHtmlAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
