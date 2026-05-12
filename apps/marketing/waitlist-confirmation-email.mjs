export const WAITLIST_CONFIRMATION_SUBJECT = "You're on the Tarmoto waitlist";

const WAITLIST_CONFIRMATION_TEXT = `You're on the list.

Thanks for joining the Tarmoto waitlist. Your spot is saved.

Tarmoto is a desktop-first motorcycle route planner. Built for twisty roads, surface awareness, and fewer surprises. Sync the route to your phone companion and ride.

We'll write once — when your invite is ready. No drip campaign. No marketing list.

—

What's planned

  First   Private beta, in small batches
  Next    Wider European beta
  Then    v1.0

We're a small team building Tarmoto in the open. Beta is free.

—

Pass it on
Know a rider who plans Saturdays around the road? Send them our way: https://tarmoto.app

—

tarmoto.app — early beta · prelaunch
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

    /* Tokens mirrored from apps/marketing/app/globals.css :root.
       --accent       #FF6A1A   --bg          #0B0D10
       --accent-top   #FF7A26   --panel       #12161B
       --accent-deep  #D94F08   --panel-2     #171C22
       --ink-warm     #1A120D   --text        #E8E5DE
       --dim solid    #918F89   --mute solid  #686661
       --line         rgba(232,229,222,0.08)
    */

    @media only screen and (max-width: 620px) {
      .container       { width: 100% !important; max-width: 100% !important; }
      .px-outer        { padding-left: 16px !important; padding-right: 16px !important; }
      .px-inner        { padding-left: 24px !important; padding-right: 24px !important; }
      .display         { font-size: 32px !important; line-height: 1.12 !important; letter-spacing: -0.02em !important; }
      .body-copy       { font-size: 15px !important; line-height: 1.6 !important; }
      .timeline-cell   { display: block !important; width: 100% !important; padding: 14px 0 !important; border-right: 0 !important; border-bottom: 1px solid rgba(232,229,222,0.08) !important; }
      .timeline-cell-last { border-bottom: 0 !important; }
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

          <!-- HEADER: T-on-accent + Tarmoto wordmark + stamp -->
          <tr>
            <td style="padding:0 0 28px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" align="left" style="font-size:0;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block; vertical-align:middle;">
                      <tr>
                        <!-- Logo cell:
                             - When images load (Apple Mail, iOS, most clients):
                               the PNG renders the same road-mark on the
                               orange square that the marketing nav uses.
                             - When images are blocked (some Outlook configs,
                               first paint in Gmail web): the bgcolor + cell
                               text styling fall back to a bold "T" on the
                               orange tile, matching the previous template. -->
                        <td width="40" height="40" align="center" valign="middle"
                            bgcolor="#FF6A1A"
                            style="width:40px; height:40px; background-color:#FF6A1A; background:linear-gradient(180deg,#FF7A26 0%,#FF6A1A 100%); border-radius:10px; color:#1A120D; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-weight:700; font-size:22px; line-height:40px; text-align:center;">
                          <img src="https://tarmoto.app/brand/logo-mark-on-accent.png"
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

                <!-- What's planned — sequence only, no dates -->
                <tr>
                  <td class="px-inner" style="padding:28px 40px 0 40px;">
                    <p class="mono" style="margin:0 0 18px 0; font-family:'JetBrains Mono', 'Courier New', Courier, monospace; font-size:11px; font-weight:500; letter-spacing:0.15em; text-transform:uppercase; color:#686661;">
                      § 02 &nbsp;What's planned
                    </p>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td valign="top" class="timeline-cell" width="33%"
                            style="width:33%; padding:0 16px 0 0; border-right:1px solid rgba(232,229,222,0.08);">
                          <p class="mono" style="margin:0 0 8px 0; font-family:'JetBrains Mono', 'Courier New', Courier, monospace; font-size:10px; font-weight:600; letter-spacing:0.15em; text-transform:uppercase; color:#FF6A1A;">
                            First
                          </p>
                          <p style="margin:0; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-size:14px; line-height:1.45; color:#E8E5DE;">
                            Private beta, in small batches
                          </p>
                        </td>
                        <td valign="top" class="timeline-cell" width="33%"
                            style="width:33%; padding:0 16px; border-right:1px solid rgba(232,229,222,0.08);">
                          <p class="mono" style="margin:0 0 8px 0; font-family:'JetBrains Mono', 'Courier New', Courier, monospace; font-size:10px; font-weight:600; letter-spacing:0.15em; text-transform:uppercase; color:#686661;">
                            Next
                          </p>
                          <p style="margin:0; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-size:14px; line-height:1.45; color:#E8E5DE;">
                            Wider European beta
                          </p>
                        </td>
                        <td valign="top" class="timeline-cell timeline-cell-last" width="34%"
                            style="width:34%; padding:0 0 0 16px;">
                          <p class="mono" style="margin:0 0 8px 0; font-family:'JetBrains Mono', 'Courier New', Courier, monospace; font-size:10px; font-weight:600; letter-spacing:0.15em; text-transform:uppercase; color:#686661;">
                            Then
                          </p>
                          <p style="margin:0; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-size:14px; line-height:1.45; color:#E8E5DE;">
                            v1.0
                          </p>
                        </td>
                      </tr>
                    </table>

                    <p style="margin:18px 0 0 0; font-family:'Space Grotesk', 'Segoe UI', Helvetica, Arial, sans-serif; font-size:13px; line-height:1.55; color:#686661;">
                      We're a small team building Tarmoto in the open. Beta is free.
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
                    <span style="color:#686661;">Early beta · prelaunch</span>
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
