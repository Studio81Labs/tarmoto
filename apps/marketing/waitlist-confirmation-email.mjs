export const WAITLIST_CONFIRMATION_SUBJECT = "You're on the Tarmoto waitlist";

// Logo mark for the email header. Inlined as a base64 data URI so the
// image is shipped with the email itself — no dependency on a public
// asset URL that has to be reachable from every recipient client at
// open time.
//
// Regenerate when the brand mark changes. Use rsvg-convert (not
// macOS Quick Look — `qlmanage` letterboxes the SVG inside the
// target raster, which left ~20px of transparent padding around the
// orange tile and rendered as a tiny logo-in-a-white-frame at 40×40
// in real email clients):
//
//   rsvg-convert -w 160 -h 160 \
//     docs/design/brand/logo-mark-on-accent.svg \
//     -o apps/marketing/public/brand/logo-mark-on-accent.png
//   base64 -i apps/marketing/public/brand/logo-mark-on-accent.png \
//     | tr -d '\n'
//
// Source SVG: docs/design/brand/logo-mark-on-accent.svg.
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
